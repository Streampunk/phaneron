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
import { ConsumerFactory, Consumer } from './consumer'
import { RedioPipe, RedioEnd, nil, end, isValue, Valve, Spout } from 'redioactive'
import * as Grandiose from 'grandiose'
import { FromRGBA } from '../process/io'
import { Writer } from '../process/uyvy422'
import { Frame, Filterer } from 'beamcoder'
import { ConfigParams, VideoFormat, DeviceConfig } from '../config'
import { ClJobs } from '../clJobQueue'

interface AudioBuffer {
	buffer: Buffer
	timestamp: number
	samples: number
}

export class GrandioseConsumer implements Consumer {
	private readonly clContext: nodenCLContext
	private readonly chanID: string
	private readonly params: ConfigParams
	private readonly format: VideoFormat
	private readonly device: DeviceConfig
	private readonly clJobs: ClJobs
	private readonly logTimings = false
	private sender: Grandiose.Sender | null = null
	private fromRGBA: FromRGBA | null = null
	private clDests: OpenCLBuffer[] = []
	private vidField: number
	// private readonly audioChannels: number
	// private readonly audioTimebase: number[]
	// private readonly videoTimebase: number[]
	private audFilterer: Filterer | null = null

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
		this.chanID = `${chanID} ndi-${this.device.deviceIndex - 1}`
		this.clJobs = clJobs
		this.vidField = 0
		// this.audioChannels = 8
		// this.audioTimebase = [1, this.format.audioSampleRate]
		// this.videoTimebase = [this.format.duration, this.format.timescale / this.format.fields]

		if (Object.keys(this.params).length > 1)
			console.log('Grandiose consumer - unused params', this.params)

	}

	async initialise(): Promise<void> {
		this.sender = await Grandiose.send({
			name: `Phaneron ${this.chanID}`,
			clockVideo: false,
			clockAudio: false
		})

		// console.log('\nMacadam consumer audio:\n', this.audFilterer.graph.dump())

		this.fromRGBA = new FromRGBA(
			this.clContext,
			'709',
			new Writer(this.format.width, this.format.height, this.format.fields === 2, true),
			this.clJobs
		)
		await this.fromRGBA.init()

		console.log(`Created Grandiose consumer id: ${this.device.deviceIndex - 1}`)
		return Promise.resolve()
	}

	connect(
		combineAudio: RedioPipe<Frame | RedioEnd>,
		combineVideo: RedioPipe<OpenCLBuffer | RedioEnd>
	): void {
		this.vidField = 0

		const audFilter: Valve<Frame | RedioEnd, AudioBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame) && this.audFilterer) {
				const ff = await this.audFilterer.filter([{ name: 'in0:a', frames: [frame] }])
				const result: AudioBuffer[] = ff[0].frames.map((f) => ({
					buffer: f.data[0],
					timestamp: f.pts,
					samples: f.nb_samples
				}))
				return result.length > 0 ? result : nil
			} else {
				return end
			}
		}

		const vidProcess: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const start = process.hrtime()
				const fromRGBA = this.fromRGBA as FromRGBA
				if (this.vidField === 0) {
					this.clDests = await fromRGBA.createDests()
					this.clDests.forEach((d) => (d.timestamp = (frame.timestamp / this.format.fields) << 0))
				}
				const interlace = this.format.fields ? 0x1 | (this.vidField << 1) : 0
				fromRGBA.processFrame(this.chanID, frame, this.clDests, interlace)
				await this.clJobs.runQueue({ source: this.chanID, timestamp: frame.timestamp })
				const end = process.hrtime(start)
				if (this.logTimings)
					console.log(
						`NDI channel ${this.device.deviceIndex}: ${frame.timestamp}  ${(
							end[0] * 1000.0 +
							end[1] / 1000000.0
						).toFixed(2)}ms processing total`
					)
				if (this.format.fields === 2) this.vidField = 1 - this.vidField
				else this.vidField = 0
				return this.vidField === 1 ? nil : this.clDests[0]
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

		const vidSpout: Spout<OpenCLBuffer | RedioEnd> = async (vidBuf) => {
			if (isValue(vidBuf)) {
				// const vtb = this.videoTimebase
				// const vts = (vidBuf.timestamp * vtb[0]) / vtb[1]
				const frame: Grandiose.VideoFrame = {
					type: 'video',
					xres: this.format.width,
					yres: this.format.height / this.format.fields,
					frameRateN: 50,
					frameRateD: this.format.fields,
					pictureAspectRatio: 0,
					timestamp: [0, 0],
					frameFormatType: this.format.fields === 2 ? this.vidField === 0 ? Grandiose.FrameType.Field0 : Grandiose.FrameType.Field1 : Grandiose.FrameType.Progressive,
					timecode: [0, 0],
					lineStrideBytes: this.format.width * 2,
					data: vidBuf,
					fourCC: Grandiose.FourCC.UYVY
				}
				await this.sender?.video(frame)
				vidBuf.release()
				return Promise.resolve()
			} else {
				// this.clContext.logBuffers()
				return Promise.resolve()
			}
		}

		const audSpout: Spout<AudioBuffer | RedioEnd> = async (audBuf) => {
			if (isValue(audBuf)) {
				//const atb = this.audioTimebase
				//const ats = (audBuf.timestamp * atb[0]) / atb[1]

				// await this.sender?.audio({
				// 	type: 'audio',
				// 	audioFormat: Grandiose.AudioFormat.Float32Separate,
				// 	referenceLevel: 0,
				// 	sampleRate: this.format.audioSampleRate,
				// 	channels: this.format.audioChannels,
				// 	samples: audBuf.samples,
				// 	channelStrideInBytes: 4*audBuf.samples,
				// 	timestamp: [0, 0],
				// 	timecode: [0, 0],
				// 	data: audBuf.buffer
				// })
				return Promise.resolve()
			} else {
				// this.clContext.logBuffers()
				return Promise.resolve()
			}
		}

		combineVideo
			.valve(vidProcess)
			.valve(vidSaver)
			.spout(vidSpout)

		combineAudio
			.valve(audFilter)
			.spout(audSpout)
	}
}

export class GrandioseConsumerFactory implements ConsumerFactory<GrandioseConsumer> {
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
	): GrandioseConsumer {
		const consumer = new GrandioseConsumer(this.clContext, chanID, params, format, device, clJobs)
		return consumer
	}
}
