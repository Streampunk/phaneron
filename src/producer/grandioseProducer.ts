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

import { ProducerFactory, Producer, InvalidProducerError } from './producer'
import { clContext as nodenCLContext, OpenCLBuffer } from 'nodencl'
import redio, { RedioPipe, nil, end, isValue, RedioEnd, Generator, Valve, isEnd } from 'redioactive'
import { frame, Filterer, filterer } from 'beamcoder'
import { ClJobs } from '../clJobQueue'
import { LoadParams } from '../chanLayer'
import { VideoFormat, VideoFormats } from '../config'
import { ToRGBA } from '../process/io'
import { Reader as RGBAReader } from '../process/rgba8'
import Yadif from '../process/yadif'
import { AudioMixFrame } from '../mixer'
import * as Grandiose from 'grandiose'
import { PackImpl } from '../process/packer'
// import { Reader as yuv422p10Reader } from '../process/yuv422p10'
// import { Reader as yuv422p8Reader } from '../process/yuv422p8'
// import { Reader as yuv420p8Reader } from '../process/yuv420p8'
// import { Reader as v210Reader } from '../process/v210'
import { Reader as rgba8Reader } from '../process/rgba8'
import { Reader as bgra8Reader } from '../process/bgra8'
import { Reader as uyvy422Reader } from '../process/uyvy422'


export class GrandioseProducer implements Producer {
	private readonly sourceID: string
	private readonly params: LoadParams
	private readonly clContext: nodenCLContext
	private readonly clJobs: ClJobs
	private capture: Grandiose.Receiver | null = null
	private audFilterer: Filterer | null = null
	private format: VideoFormat
	private audSource: RedioPipe<AudioMixFrame | RedioEnd> | undefined
	private vidSource: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private toRGBA: ToRGBA | null = null
	private yadif: Yadif | null = null
	private running = true
	private paused = false
	private fourCC: Grandiose.FourCC | null = null
	//private numAudChannels: number = 8

	constructor(id: number, params: LoadParams, context: nodenCLContext, clJobs: ClJobs) {
		this.sourceID = `P${id} Grandiose ${params.url} L${params.layer}`
		this.params = params
		this.clContext = context
		this.clJobs = clJobs
		this.format = new VideoFormats().get('1080p5000') // default
	}

	async initialise(consumerFormat: VideoFormat): Promise<void> {
		if (this.params.url !== 'NDI')
			throw new InvalidProducerError('Grandiose producer supports NDI sources')

		let width = 0
		let height = 0
		const progressive = false
		const tff = true
		const sampleRate = consumerFormat.audioSampleRate
		//this.numAudChannels = consumerFormat.audioChannels
		const audLayout = `8c`
		try {
			this.capture = await Grandiose.receive({
				source: {
					name: 'SOURCE (NAME)' // TODO
				},
				colorFormat: Grandiose.ColorFormat.UYVY_RGBA
			})

			this.audFilterer = await filterer({
				filterType: 'audio',
				inputParams: [
					{
						name: 'in0:a',
						timeBase: [1, sampleRate],
						sampleRate: sampleRate,
						sampleFormat: 's32',
						channelLayout: audLayout
					}
				],
				outputParams: [
					{
						name: 'out0:a',
						sampleRate: consumerFormat.audioSampleRate,
						sampleFormat: 'flt',
						channelLayout: audLayout
					}
				],
				filterSpec: `[in0:a] aresample=${consumerFormat.audioSampleRate}, asetnsamples=n=1024:p=1 [out0:a]`
			})

			width = 1920 // TODO
			height = 1080 // TODO

			this.toRGBA = new ToRGBA(
				this.clContext,
				'709',
				'709',
				new RGBAReader(width, height),
				this.clJobs
			)
			await this.toRGBA.init()

			const yadifMode = progressive ? 'send_frame' : 'send_field'
			this.yadif = new Yadif(
				this.clContext,
				this.clJobs,
				width,
				height,
				{ mode: yadifMode, tff: tff },
				!progressive
			)
			await this.yadif.init()
		} catch (err) {
			console.log(err)
			throw new Error(err)
		}

		const videoFrameSource: Generator<Grandiose.VideoFrame | RedioEnd> = async () => {
			let result: Promise<Grandiose.VideoFrame | RedioEnd> = Promise.resolve(end)
			if (this.capture && this.running) result = this.capture.video()
			else if (this.capture) {
				this.capture = null
			}
			return result
		}

		const audioFrameSource: Generator<Grandiose.AudioFrame | RedioEnd> = async () => {
			let result: Promise<Grandiose.AudioFrame | RedioEnd> = Promise.resolve(end)
			if (this.capture && this.running) result = this.capture.audio({
				audioFormat: Grandiose.AudioFormat.Float32Separate,
				referenceLevel: 0
			})
			else if (this.capture) {
				this.capture = null
			}
			return result
		}

		const audFilter: Valve<Grandiose.AudioFrame | RedioEnd, AudioMixFrame | RedioEnd> = async (
			captureFrame
		) => {
			if (isValue(captureFrame) && this.audFilterer) {
				const ffFrame = frame({
					nb_samples: captureFrame.samples,
					format: 's32',
					pts: captureFrame.timestamp[0] * 10 + captureFrame.timestamp[1] / 1000000,
					sample_rate: captureFrame.sampleRate,
					channels: 8,
					channel_layout: `8c`,
					data: [Buffer.alloc(captureFrame.samples * 8 * 4)]
				})
				console.log('a', captureFrame)
				const ff = await this.audFilterer.filter([{ name: 'in0:a', frames: [ffFrame] }])
				const audMixFrames =
					ff[0].frames.length > 0 ? ff[0].frames.map((f) => ({ frame: f, mute: false })) : nil
				return audMixFrames
			} else {
				return captureFrame as RedioEnd
			}
		}

		const vidLoader: Valve<Grandiose.VideoFrame | RedioEnd, OpenCLBuffer[] | RedioEnd> = async (
			frame
		) => {
			if (isValue(frame)) {
				if (frame.fourCC !== this.fourCC)
				{
					let readImpl: PackImpl | null = null
					switch (frame.fourCC) {
						case Grandiose.FourCC.BGRA:
							readImpl = new bgra8Reader(width, height)
							break
						case Grandiose.FourCC.BGRX:
							readImpl = new bgra8Reader(width, height)
							break
						case Grandiose.FourCC.RGBA:
							readImpl = new rgba8Reader(width, height)
							break
						case Grandiose.FourCC.RGBX:
							readImpl = new rgba8Reader(width, height)
							break
						case Grandiose.FourCC.UYVA:
							readImpl = new uyvy422Reader(width, height, true)
							break
						case Grandiose.FourCC.UYVY:
							readImpl = new uyvy422Reader(width, height, false)
							break
						default:
					}
					if (!readImpl) {
						return nil
					}
					this.fourCC = frame.fourCC
					this.toRGBA = new ToRGBA(
						this.clContext,
						'709',
						'709',
						readImpl,
						this.clJobs
					)
					await this.toRGBA.init()
				}
				const toRGBA = this.toRGBA as ToRGBA
				const clSources = await toRGBA.createSources()
				const timestamp = frame.timestamp[0] * 10 + frame.timestamp[1] / 1000000
				clSources.forEach((s) => (s.timestamp = timestamp))
				await toRGBA.loadFrame(frame.data, clSources, this.clContext.queue.load)
				await this.clContext.waitFinish(this.clContext.queue.load)
				return clSources
			} else {
				return frame
			}
		}

		const vidProcess: Valve<OpenCLBuffer[] | RedioEnd, OpenCLBuffer | RedioEnd> = async (
			clSources
		) => {
			if (isValue(clSources)) {
				const toRGBA = this.toRGBA as ToRGBA
				const clDest = await toRGBA.createDest({ width: width, height: height })
				clDest.timestamp = clSources[0].timestamp
				toRGBA.processFrame(this.sourceID, clSources, clDest)
				return clDest
			} else {
				if (isEnd(clSources)) this.toRGBA = null
				return clSources
			}
		}

		const vidDeint: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const yadif = this.yadif as Yadif
				const yadifDests: OpenCLBuffer[] = []
				await yadif.processFrame(frame, yadifDests, this.sourceID)
				return yadifDests.length > 1 ? yadifDests : nil
			} else {
				if (isEnd(frame)) {
					this.yadif?.release()
					this.yadif = null
				}
				return frame
			}
		}

		this.format = {
			name: 'grandiose',
			fields: 1,
			width: width,
			height: height,
			squareWidth: width,
			squareHeight: height,
			timescale: 50,
			duration: 1,
			audioSampleRate: 48000,
			audioChannels: 8
		}

		const grandioseVideoFrames = redio(videoFrameSource, { bufferSizeMax: 2 })
		const grandioseAudioFrames = redio(audioFrameSource, { bufferSizeMax: 2 })

		this.audSource = grandioseAudioFrames
			.valve(audFilter, { bufferSizeMax: 2, oneToMany: true })
			.pause((frame) => {
				if (this.paused && isValue(frame)) (frame as AudioMixFrame).mute = true
				return this.paused
			})

		this.vidSource = grandioseVideoFrames
			.valve(vidLoader, { bufferSizeMax: 1 })
			.valve(vidProcess, { bufferSizeMax: 1 })
			.valve(vidDeint, { bufferSizeMax: 1, oneToMany: true })
			.pause((frame) => {
				if (this.paused && isValue(frame)) (frame as OpenCLBuffer).addRef()
				return this.paused
			})

		console.log(`Created Grandiose producer for channel ${this.params.channel}`)
	}

	getSourceID(): string {
		return this.sourceID
	}

	getFormat(): VideoFormat {
		return this.format
	}

	getSourceAudio(): RedioPipe<AudioMixFrame | RedioEnd> | undefined {
		return this.audSource
	}

	getSourceVideo(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined {
		return this.vidSource
	}

	setPaused(pause: boolean): void {
		this.paused = pause
	}

	release(): void {
		this.running = false
	}
}

export class GrandioseProducerFactory implements ProducerFactory<GrandioseProducer> {
	private clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createProducer(id: number, params: LoadParams, clJobs: ClJobs): GrandioseProducer {
		return new GrandioseProducer(id, params, this.clContext, clJobs)
	}
}
