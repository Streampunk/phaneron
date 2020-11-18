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
import redio, { RedioPipe, nil, end, isValue, RedioEnd, isEnd, Generator, Valve } from 'redioactive'
import { frame, Filterer, filterer } from 'beamcoder'
import { ClJobs } from '../clJobQueue'
import { LoadParams } from '../chanLayer'
import { VideoFormat, VideoFormats } from '../config'
import * as Macadam from 'macadam'
import { ToRGBA } from '../process/io'
import { Reader as v210Reader } from '../process/v210'
import Yadif from '../process/yadif'
import { AudioMixFrame } from '../mixer'

export class MacadamProducer implements Producer {
	private readonly sourceID: string
	private readonly params: LoadParams
	private readonly clContext: nodenCLContext
	private readonly clJobs: ClJobs
	private capture: Macadam.CaptureChannel | null = null
	private audFilterer: Filterer | null = null
	private format: VideoFormat
	private audSource: RedioPipe<AudioMixFrame | RedioEnd> | undefined
	private vidSource: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private toRGBA: ToRGBA | null = null
	private yadif: Yadif | null = null
	private running = true
	private paused = false

	constructor(id: number, params: LoadParams, context: nodenCLContext, clJobs: ClJobs) {
		this.sourceID = `P${id} Macadam ${params.url} L${params.layer}`
		this.params = params
		this.clContext = context
		this.clJobs = clJobs
		this.format = new VideoFormats().get('1080p5000') // default
	}

	async initialise(consumerFormat: VideoFormat): Promise<void> {
		if (this.params.url !== 'DECKLINK')
			throw new InvalidProducerError('Macadam producer supports decklink devices')

		let width = 0
		let height = 0
		const progressive = false
		const tff = true
		const sampleRate = consumerFormat.audioSampleRate
		const numAudChannels = consumerFormat.audioChannels
		const audLayout = `${numAudChannels}c`
		try {
			this.capture = await Macadam.capture({
				deviceIndex: (this.params.channel as number) - 1,
				channels: numAudChannels,
				sampleRate: Macadam.bmdAudioSampleRate48kHz,
				sampleType: Macadam.bmdAudioSampleType32bitInteger,
				displayMode: Macadam.bmdModeHD1080i50,
				pixelFormat: Macadam.bmdFormat10BitYUV
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
				filterSpec: `[in0:a] asetnsamples=n=1024:p=1 [out0:a]`
			})
			// console.log('\nMacadam producer audio:\n', this.audFilterer.graph.dump())

			width = this.capture.width
			height = this.capture.height

			this.toRGBA = new ToRGBA(
				this.clContext,
				'709',
				'709',
				new v210Reader(width, height),
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
			throw new Error(err)
		}

		const frameSource: Generator<Macadam.CaptureFrame | RedioEnd> = async () => {
			let result: Promise<Macadam.CaptureFrame | RedioEnd> = Promise.resolve(end)
			if (this.capture && this.running) result = this.capture.frame()
			else if (this.capture) {
				this.capture.stop()
				this.capture = null
			}
			return result
		}

		const audFilter: Valve<Macadam.CaptureFrame | RedioEnd, AudioMixFrame | RedioEnd> = async (
			captureFrame
		) => {
			if (isValue(captureFrame) && this.audFilterer) {
				const ffFrame = frame({
					nb_samples: captureFrame.audio.sampleFrameCount,
					format: 's32',
					pts: captureFrame.audio.packetTime,
					sample_rate: sampleRate,
					channels: numAudChannels,
					channel_layout: audLayout,
					data: [captureFrame.audio.data]
				})
				const ff = await this.audFilterer.filter([{ name: 'in0:a', frames: [ffFrame] }])
				const audMixFrames =
					ff[0].frames.length > 0 ? ff[0].frames.map((f) => ({ frame: f, mute: false })) : nil
				return audMixFrames
			} else {
				return captureFrame as RedioEnd
			}
		}

		const vidLoader: Valve<Macadam.CaptureFrame | RedioEnd, OpenCLBuffer[] | RedioEnd> = async (
			frame
		) => {
			if (isValue(frame)) {
				const toRGBA = this.toRGBA as ToRGBA
				const clSources = await toRGBA.createSources()
				const timestamp = frame.video.frameTime / frame.video.frameDuration
				clSources.forEach((s) => (s.timestamp = timestamp))
				await toRGBA.loadFrame(frame.video.data, clSources, this.clContext.queue.load)
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
			name: 'macadam',
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

		const macadamFrames = redio(frameSource, { bufferSizeMax: 2 })

		this.audSource = macadamFrames
			.fork({ bufferSizeMax: 1 })
			.valve(audFilter, { bufferSizeMax: 2, oneToMany: true })
			.pause((frame) => {
				if (this.paused && isValue(frame)) (frame as AudioMixFrame).mute = true
				return this.paused
			})

		this.vidSource = macadamFrames
			.fork({ bufferSizeMax: 1 })
			.valve(vidLoader, { bufferSizeMax: 1 })
			.valve(vidProcess, { bufferSizeMax: 1 })
			.valve(vidDeint, { bufferSizeMax: 1, oneToMany: true })
			.pause((frame) => {
				if (this.paused && isValue(frame)) (frame as OpenCLBuffer).addRef()
				return this.paused
			})

		console.log(`Created Macadam producer for channel ${this.params.channel}`)
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

export class MacadamProducerFactory implements ProducerFactory<MacadamProducer> {
	private clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createProducer(id: number, params: LoadParams, clJobs: ClJobs): MacadamProducer {
		return new MacadamProducer(id, params, this.clContext, clJobs)
	}
}
