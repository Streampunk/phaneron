/*
  Phaneron - Clustered, accelerated and cloud-fit video server, pre-assembled and in kit form.
  Copyright (C) 2020 Streampunk Media Ltd.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
  https://www.streampunk.media/ mailto:furnace@streampunk.media
  14 Ormiscaig, Aultbea, Achnasheen, IV22 2JJ  U.K.
*/

import { clContext as nodenCLContext, OpenCLBuffer } from 'nodencl'
import { RedioPipe, RedioEnd, nil, isValue, Valve, Spout } from 'redioactive'
import { muxer, Muxer, encoder, Encoder, Frame, frame, Filterer, filterer, Packet } from 'beamcoder'
import { ConsumerFactory, Consumer } from './consumer'
import { FromRGBA } from '../process/io'
import { Writer } from '../process/yuv422p8'
import { ConfigParams, VideoFormat, DeviceConfig } from '../config'
import { ClJobs } from '../clJobQueue'

interface AudioBuffer {
	buffer: Buffer
	timestamp: number
}

export class FFmpegConsumer implements Consumer {
	private readonly clContext: nodenCLContext
	private readonly chanID: string
	private readonly params: ConfigParams
	private readonly format: VideoFormat
	private readonly device: DeviceConfig
	private readonly clJobs: ClJobs
	private readonly filename: string
	private fromRGBA: FromRGBA | undefined
	private readonly audioOutChannels: number
	private readonly audioTimebase: number[]
	private readonly videoTimebase: number[]
	private audFilterer: Filterer | undefined
	private muxer: Muxer
	private encoder: Encoder
	private combineAudio: RedioPipe<Frame | RedioEnd> | undefined
	private combineVideo: RedioPipe<OpenCLBuffer | RedioEnd> | undefined

	constructor(
		context: nodenCLContext,
		chanID: string,
		params: ConfigParams,
		format: VideoFormat,
		device: DeviceConfig,
		clJobs: ClJobs
	) {
		this.clContext = context
		this.params = params
		this.format = format
		this.device = device
		this.chanID = `${chanID} ffmpeg-${this.device.deviceIndex}`
		this.clJobs = clJobs
		this.audioOutChannels = 2
		this.audioTimebase = [1, this.format.audioSampleRate]
		this.videoTimebase = [this.format.duration, this.format.timescale]

		this.filename = (this.params.stream as string) || 'http://localhost:3000/'
		const muxFormat = (this.params.f as string) || 'mpjpeg'
		const encoderName = 'mjpeg'
		const pixFmt = encoderName === 'mjpeg' ? 'yuvj422p' : 'yuv422p'

		this.muxer = muxer({
			filename: this.filename,
			format_name: muxFormat
		})

		this.encoder = encoder({
			name: encoderName,
			width: this.format.width,
			height: this.format.height,
			pix_fmt: pixFmt,
			sample_aspect_ratio: [1, 1],
			time_base: this.videoTimebase
		})
		const encoderParams = { ...this.params }
		delete encoderParams['stream']
		delete encoderParams['f']
		delete encoderParams['multiple_requests']
		Object.assign(this.encoder, encoderParams)

		const stream = this.muxer.newStream({
			name: encoderName,
			time_base: this.videoTimebase
		})
		Object.assign(stream.codecpar, {
			width: this.format.width,
			height: this.format.height,
			sample_aspect_ratio: [1, 1],
			interleaved: true
		})
	}

	async initialise(): Promise<void> {
		const sampleRate = this.audioTimebase[1]
		const audInLayout = `${this.format.audioChannels}c`
		const audOutLayout = `${this.audioOutChannels}c`
		// !!! Needs more work to handle 59.94 frame rates !!!
		const samplesPerFrame =
			(this.format.audioSampleRate * this.format.duration) / this.format.timescale
		const outSampleFormat = 'flt'

		this.audFilterer = await filterer({
			filterType: 'audio',
			inputParams: [
				{
					name: 'in0:a',
					timeBase: this.audioTimebase,
					sampleRate: sampleRate,
					sampleFormat: 'fltp',
					channelLayout: audInLayout
				}
			],
			outputParams: [
				{
					name: 'out0:a',
					sampleRate: this.format.audioSampleRate,
					sampleFormat: outSampleFormat,
					channelLayout: audOutLayout
				}
			],
			filterSpec: `[in0:a] aformat=sample_fmts=${outSampleFormat}:sample_rates=${this.format.audioSampleRate}:channel_layouts=${audOutLayout}, asetnsamples=n=${samplesPerFrame}:p=1 [out0:a]`
		})
		// console.log('\FFmpeg consumer audio:\n', this.audFilterer.graph.dump())

		const width = this.format.width
		const height = this.format.height
		this.fromRGBA = new FromRGBA(
			this.clContext,
			'709',
			new Writer(width, height, false),
			this.clJobs
		)
		await this.fromRGBA.init()

		await this.muxer.openIO({
			url: this.filename,
			options: { multiple_requests: (this.params.multiple_requests as number) || 0 }
		})
		await this.muxer.writeHeader()

		console.log('Created FFmpeg consumer')
		return Promise.resolve()
	}

	deviceConfig(): DeviceConfig {
		return this.device
	}

	connect(
		combineAudio: RedioPipe<Frame | RedioEnd>,
		combineVideo: RedioPipe<OpenCLBuffer | RedioEnd>
	): void {
		this.combineAudio = combineAudio
		this.combineVideo = combineVideo

		const audFilter: Valve<Frame | RedioEnd, AudioBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const audFilt = this.audFilterer as Filterer
				const ff = await audFilt.filter([{ name: 'in0:a', frames: [frame] }])
				const result: AudioBuffer[] = ff[0].frames.map((f) => ({
					buffer: f.data[0],
					timestamp: f.pts
				}))
				return result.length > 0 ? result : nil
			} else {
				return frame
			}
		}

		const vidProcess: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer[] | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const fromRGBA = this.fromRGBA as FromRGBA
				const clDests = await fromRGBA.createDests()
				clDests.forEach((d) => (d.timestamp = frame.timestamp))
				fromRGBA.processFrame(this.chanID, frame, clDests, 0)
				await this.clJobs.runQueue({ source: this.chanID, timestamp: frame.timestamp })
				return clDests
			} else {
				this.clJobs.clearQueue(this.chanID)
				return frame
			}
		}

		const vidSaver: Valve<OpenCLBuffer[] | RedioEnd, OpenCLBuffer[] | RedioEnd> = async (
			frames
		) => {
			if (isValue(frames)) {
				const fromRGBA = this.fromRGBA as FromRGBA
				await Promise.all(frames.map((f) => fromRGBA.saveFrame(f, this.clContext.queue.unload)))
				await this.clContext.waitFinish(this.clContext.queue.unload)
				return frames
			} else {
				return frames
			}
		}

		const vidEncode: Valve<OpenCLBuffer[] | RedioEnd, Packet | RedioEnd> = async (frames) => {
			if (isValue(frames)) {
				const filtFrame = frame({
					width: this.format.width,
					height: this.format.height,
					pict_type: 'P',
					format: 'yuvj422p',
					sample_aspect_ratio: [1, 1],
					pts: frames[0].timestamp,
					dts: frames[0].timestamp,
					data: frames
				})
				const encPackets = await this.encoder.encode(filtFrame)
				frames.forEach((f) => f.release())
				return encPackets.packets
			} else {
				return frames
			}
		}

		const ffmpegSpout: Spout<
			[(Packet | RedioEnd | undefined)?, (AudioBuffer | RedioEnd | undefined)?] | RedioEnd
		> = async (frame) => {
			if (isValue(frame)) {
				const vidBuf = frame[0]
				const audBuf = frame[1]
				if (!(audBuf && isValue(audBuf) && vidBuf && isValue(vidBuf))) {
					console.log('One-legged zipper:', audBuf, vidBuf)
					return Promise.resolve()
				}

				const atb = this.audioTimebase
				const ats = (audBuf.timestamp * atb[0]) / atb[1]
				const vtb = this.videoTimebase
				const vts = (vidBuf.pts * vtb[0]) / vtb[1]
				if (Math.abs(ats - vts) > 0.1)
					console.log('MJPEG audio and video timestamp mismatch - aud:', ats, ' vid:', vts)

				await this.muxer.writeFrame(vidBuf)
			} else {
				// this.clContext.logBuffers()
				return Promise.resolve()
			}
		}

		this.combineVideo
			.valve(vidProcess)
			.valve(vidSaver)
			.valve(vidEncode, { oneToMany: true })
			.zip(this.combineAudio.valve(audFilter, { oneToMany: true }))
			.spout(ffmpegSpout)
	}

	release(audio: RedioPipe<Frame | RedioEnd>, video: RedioPipe<OpenCLBuffer | RedioEnd>): void {
		if (this.combineAudio !== undefined && this.combineVideo !== undefined) {
			audio.unfork(this.combineAudio)
			video.unfork(this.combineVideo)
		}
	}
}

export class FFmpegConsumerFactory implements ConsumerFactory<FFmpegConsumer> {
	private readonly clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createConsumer(
		chanID: string,
		params: ConfigParams,
		format: VideoFormat,
		device: DeviceConfig,
		clJobs: ClJobs
	): FFmpegConsumer {
		const consumer = new FFmpegConsumer(this.clContext, chanID, params, format, device, clJobs)
		return consumer
	}
}
