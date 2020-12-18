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
import { Frame, Filterer, filterer } from 'beamcoder'
import Koa from 'koa'
import cors from '@koa/cors'
import { ConsumerFactory, Consumer } from '../consumer'
import { FromRGBA } from '../../process/io'
import { Writer } from '../../process/rgba8'
import { ConfigParams, VideoFormat, DeviceConfig } from '../../config'
import { ClJobs } from '../../clJobQueue'

interface AudioBuffer {
	buffer: Buffer
	timestamp: number
}

export class WebRTCConsumer implements Consumer {
	private readonly clContext: nodenCLContext
	private readonly chanID: string
	private readonly params: ConfigParams
	private readonly format: VideoFormat
	private readonly clJobs: ClJobs
	private fromRGBA: FromRGBA | undefined
	private readonly audioOutChannels: number
	private readonly audioTimebase: number[]
	private readonly videoTimebase: number[]
	// private audioOut: IoStreamWrite
	private audFilterer: Filterer | undefined
	private readonly kapp: Koa<Koa.DefaultState, Koa.DefaultContext>
	private readonly lastWeb: Buffer

	constructor(
		context: nodenCLContext,
		chanID: string,
		params: ConfigParams,
		format: VideoFormat,
		clJobs: ClJobs
	) {
		this.clContext = context
		this.chanID = `${chanID} screen`
		this.params = params
		this.format = format
		this.clJobs = clJobs
		this.audioOutChannels = 2
		this.audioTimebase = [1, this.format.audioSampleRate]
		this.videoTimebase = [this.format.duration, this.format.timescale]
		// this.audioOut = AudioIO({
		// 	outOptions: {
		// 		channelCount: this.audioOutChannels,
		// 		sampleFormat: SampleFormatFloat32,
		// 		sampleRate: this.format.audioSampleRate,
		// 		closeOnError: false
		// 	}
		// })

		if (Object.keys(this.params).length > 1)
			console.log('Screen consumer - unused params', this.params)

		this.lastWeb = Buffer.alloc(this.format.width * this.format.height * 4)
		this.kapp = new Koa()
		this.kapp.use(cors())
		this.kapp.use(async (ctx) => (ctx.body = this.lastWeb))

		const server = this.kapp.listen(3001)
		process.on('SIGHUP', server.close)
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
					sampleFormat: 'flt',
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
		// console.log('\nScreen consumer audio:\n', this.audFilterer.graph.dump())

		const width = this.format.width
		const height = this.format.height
		this.fromRGBA = new FromRGBA(
			this.clContext,
			'sRGB',
			new Writer(width, height, false),
			this.clJobs
		)
		await this.fromRGBA.init()

		console.log('Created Screen consumer')
		return Promise.resolve()
	}

	connect(
		combineAudio: RedioPipe<Frame | RedioEnd>,
		combineVideo: RedioPipe<OpenCLBuffer | RedioEnd>
	): void {
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

		const vidProcess: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const fromRGBA = this.fromRGBA as FromRGBA
				const clDests = await fromRGBA.createDests()
				clDests.forEach((d) => (d.timestamp = frame.timestamp))
				fromRGBA.processFrame(this.chanID, frame, clDests, 0)
				await this.clJobs.runQueue({ source: this.chanID, timestamp: frame.timestamp })
				return clDests[0]
			} else {
				return frame
			}
		}

		const vidSaver: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const fromRGBA = this.fromRGBA as FromRGBA
				await fromRGBA.saveFrame(frame, this.clContext.queue.unload)
				await this.clContext.waitFinish(this.clContext.queue.unload)
				return frame
			} else {
				return frame
			}
		}

		const screenSpout: Spout<
			[(OpenCLBuffer | RedioEnd | undefined)?, (AudioBuffer | RedioEnd | undefined)?] | RedioEnd
		> = async (frame) => {
			if (isValue(frame)) {
				const vidBuf = frame[0]
				const audBuf = frame[1]
				if (!(audBuf && isValue(audBuf) && vidBuf && isValue(vidBuf))) {
					console.log('One-legged zipper:', audBuf, vidBuf)
					if (vidBuf && isValue(vidBuf)) vidBuf.release()
					return Promise.resolve()
				}

				const atb = this.audioTimebase
				const ats = (audBuf.timestamp * atb[0]) / atb[1]
				const vtb = this.videoTimebase
				const vts = (vidBuf.timestamp * vtb[0]) / vtb[1]
				if (Math.abs(ats - vts) > 0.1)
					console.log('Screen audio and video timestamp mismatch - aud:', ats, ' vid:', vts)

				const write = (data: Buffer, cb: () => void) => {
					// if (
					// !this.audioOut.write(data, (err: Error | null | undefined) => {
					// 	if (err) console.log('Write Error:', err)
					// })
					// ) {
					// this.audioOut.once('drain', cb)
					// } else {
					process.nextTick(cb)
					// }
				}

				return new Promise((resolve) => {
					vidBuf.copy(this.lastWeb)
					write(audBuf.buffer, () => {
						vidBuf.release()
						resolve()
					})
				})
			} else {
				// this.clContext.logBuffers()
				return Promise.resolve()
			}
		}

		// this.audioOut.start()

		combineVideo
			.valve(vidProcess)
			.valve(vidSaver)
			.zip(combineAudio.valve(audFilter, { oneToMany: true }))
			.spout(screenSpout)
	}
}

export class WebRTCConsumerFactory implements ConsumerFactory<WebRTCConsumer> {
	private readonly clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createConsumer(
		chanID: string,
		params: ConfigParams,
		format: VideoFormat,
		_device: DeviceConfig,
		clJobs: ClJobs
	): WebRTCConsumer {
		const consumer = new WebRTCConsumer(this.clContext, chanID, params, format, clJobs)
		return consumer
	}
}
