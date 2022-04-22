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
import { Frame, frame, Filterer, filterer, FilterContext } from 'beamcoder'
import { ClJobs } from '../clJobQueue'
import { LoadParams } from '../chanLayer'
import { VideoFormat } from '../config'
import * as Macadam from 'macadam'
import { ToRGBA } from '../process/io'
import { Reader as v210Reader } from '../process/v210'
import Yadif from '../process/yadif'
import { SourcePipes } from '../routeSource'

export class MacadamProducer implements Producer {
	private readonly sourceID: string
	private readonly params: LoadParams
	private readonly clContext: nodenCLContext
	private readonly clJobs: ClJobs
	private readonly consumerFormat: VideoFormat
	private capture: Macadam.CaptureChannel | null = null
	private audSource: RedioPipe<Frame | RedioEnd> | undefined
	private vidSource: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private srcFormat: VideoFormat | undefined
	private numForks = 0
	private paused = true
	private running = true
	private volFilter: FilterContext | undefined

	constructor(
		id: number,
		params: LoadParams,
		context: nodenCLContext,
		clJobs: ClJobs,
		consumerFormat: VideoFormat
	) {
		this.sourceID = `P${id} Macadam ${params.url} L${params.layer}`
		this.params = params
		this.clContext = context
		this.clJobs = clJobs
		this.consumerFormat = consumerFormat

		if (this.params.url.toUpperCase() !== 'DECKLINK')
			throw new InvalidProducerError('Macadam producer supports decklink devices')
	}

	async initialise(): Promise<void> {
		let width = 0
		let height = 0
		let progressive = false
		const displayMode = Macadam.bmdModeHD1080i50
		const tff = true
		let toRGBA: ToRGBA | null = null
		let yadif: Yadif | null = null
		let audFilterer: Filterer | null = null
		const sampleRate = Macadam.bmdAudioSampleRate48kHz
		const numAudChannels = this.consumerFormat.audioChannels
		const audLayout = `${numAudChannels}c`
		try {
			progressive = !Macadam.modeInterlace(displayMode)
			this.capture = await Macadam.capture({
				deviceIndex: (this.params.channel as number) - 1,
				channels: numAudChannels,
				sampleRate: sampleRate,
				sampleType: Macadam.bmdAudioSampleType32bitInteger,
				displayMode: displayMode,
				pixelFormat: Macadam.bmdFormat10BitYUV
			})

			const filtStr = `[in${0}:a]asetnsamples=n=1024:p=1, volume=0.0:eval=frame:precision=float[out${0}:a]`
			// console.log(filtStr)

			audFilterer = await filterer({
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
						sampleRate: this.consumerFormat.audioSampleRate,
						sampleFormat: 'fltp',
						channelLayout: audLayout
					}
				],
				filterSpec: filtStr
			})
			// console.log('\nMacadam producer audio:\n', audFilterer.graph.dump())
			this.volFilter = audFilterer.graph.filters.find((f) => f.filter.name === 'volume')

			width = this.capture.width
			height = this.capture.height

			toRGBA = new ToRGBA(this.clContext, '709', '709', new v210Reader(width, height), this.clJobs)
			await toRGBA.init()

			const yadifMode = progressive ? 'send_frame' : 'send_field'
			yadif = new Yadif(
				this.clContext,
				this.clJobs,
				width,
				height,
				{ mode: yadifMode, tff: tff },
				!progressive
			)
			await yadif.init()
		} catch (err) {
			console.log(
				`Error in Macadam producer initialise: ${
					err instanceof Error ? err.message : 'Unknown error'
				}`
			)
			throw err
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

		const audFilter: Valve<Macadam.CaptureFrame | RedioEnd, Frame | RedioEnd> = async (
			captureFrame
		) => {
			if (isValue(captureFrame) && audFilterer) {
				const ffFrame = frame({
					nb_samples: captureFrame.audio.sampleFrameCount,
					format: 's32',
					pts: captureFrame.audio.packetTime,
					sample_rate: sampleRate,
					channels: numAudChannels,
					channel_layout: audLayout,
					data: [captureFrame.audio.data]
				})
				const ff = await audFilterer.filter([{ name: 'in0:a', frames: [ffFrame] }])
				return ff[0] && ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				return captureFrame as RedioEnd
			}
		}

		const vidLoader: Valve<Macadam.CaptureFrame | RedioEnd, OpenCLBuffer[] | RedioEnd> = async (
			frame
		) => {
			if (isValue(frame)) {
				const convert = toRGBA as ToRGBA
				const clSources = await convert.createSources()
				// const now = process.hrtime()
				// const nowms = now[0] * 1000.0 + now[1] / 1000000.0
				const timestamp =
					(frame.video.frameTime / frame.video.frameDuration) * (progressive ? 1 : 2)
				clSources.forEach((s) => {
					// s.loadstamp = nowms
					s.timestamp = timestamp
				})
				await convert.loadFrame(frame.video.data, clSources, this.clContext.queue.load)
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
				const convert = toRGBA as ToRGBA
				const clDest = await convert.createDest({ width: width, height: height })
				// clDest.loadstamp = clSources[0].loadstamp
				clDest.timestamp = clSources[0].timestamp
				convert.processFrame(this.sourceID, clSources, clDest)
				return clDest
			} else {
				if (isEnd(clSources)) toRGBA = null
				return clSources
			}
		}

		const vidDeint: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const yadifDests: OpenCLBuffer[] = []
				await yadif?.processFrame(frame, yadifDests, this.sourceID)
				yadifDests.forEach((d) => {
					for (let f = 1; f < this.numForks; ++f) d.addRef()
				})
				return yadifDests.length > 0 ? yadifDests : nil
			} else {
				if (isEnd(frame)) {
					yadif?.release()
					yadif = null
				}
				return frame
			}
		}

		this.srcFormat = {
			name: 'macadam',
			fields: 1,
			width: width,
			height: height,
			squareWidth: width,
			squareHeight: height,
			timescale: this.consumerFormat.timescale,
			duration: this.consumerFormat.duration,
			audioSampleRate: this.consumerFormat.audioSampleRate,
			audioChannels: this.consumerFormat.audioChannels
		}

		const macadamFrames = redio(frameSource, { bufferSizeMax: 2 })

		this.audSource = macadamFrames
			.fork({ bufferSizeMax: 1 })
			.pause(() => this.paused && this.running)
			.valve(audFilter, { bufferSizeMax: 2, oneToMany: true })

		this.vidSource = macadamFrames
			.fork({ bufferSizeMax: 1 })
			.valve(vidLoader, { bufferSizeMax: 1 })
			.valve(vidProcess, { bufferSizeMax: 1 })
			.valve(vidDeint, { bufferSizeMax: 1, oneToMany: true })
			.pause((frame) => {
				if (!this.running) {
					frame = nil
					return false
				}
				if (this.paused && isValue(frame)) (frame as OpenCLBuffer).addRef()
				return this.paused
			})

		console.log(`Created Macadam producer for channel ${this.params.channel}`)
	}

	getSourcePipes(): SourcePipes {
		if (!(this.audSource && this.vidSource && this.srcFormat))
			throw new Error(`Macadam producer failed to find source pipes for route`)

		this.numForks++
		const audFork = this.audSource.fork()
		const vidFork = this.vidSource.fork()
		return {
			audio: audFork,
			video: vidFork,
			format: this.srcFormat,
			release: () => {
				try {
					this.audSource?.unfork(audFork)
					this.vidSource?.unfork(vidFork)
					this.numForks--
					// eslint-disable-next-line no-empty
				} catch (err) {}
			}
		}
	}

	srcID(): string {
		return this.sourceID
	}

	setPaused(pause: boolean): void {
		this.paused = pause
		if (this.volFilter && this.volFilter.priv)
			this.volFilter.priv = { volume: this.paused ? '0.0' : '1.0' }
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

	createProducer(
		id: number,
		params: LoadParams,
		clJobs: ClJobs,
		consumerFormat: VideoFormat
	): MacadamProducer {
		return new MacadamProducer(id, params, this.clContext, clJobs, consumerFormat)
	}
}
