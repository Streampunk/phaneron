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
import { ChanProperties } from '../chanLayer'
import * as Macadam from 'macadam'
import { ToRGBA } from '../process/io'
import { Reader as v210Reader } from '../process/v210'
import Yadif from '../process/yadif'
import { Frame, frame, Filterer, filterer } from 'beamcoder'

export class MacadamProducer implements Producer {
	private readonly id: string
	private params: string[]
	private clContext: nodenCLContext
	private capture: Macadam.CaptureChannel | null = null
	private audFilterer: Filterer | null = null
	private audSource: RedioPipe<Frame | RedioEnd> | undefined
	private vidSource: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private toRGBA: ToRGBA | null = null
	private yadif: Yadif | null = null
	private running = true
	private paused = false

	constructor(id: string, params: string[], context: nodenCLContext) {
		this.id = id
		this.params = params
		this.clContext = context
	}

	async initialise(chanProperties: ChanProperties): Promise<void> {
		if (this.params[0] != 'DECKLINK')
			throw new InvalidProducerError('Macadam producer supports decklink devices')

		const channel = +this.params[1]
		let width = 0
		let height = 0
		const sampleRate = 48000
		const channels = 8
		const layout = 'octagonal'
		try {
			this.capture = await Macadam.capture({
				deviceIndex: channel - 1,
				channels: channels,
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
						timeBase: chanProperties.audioTimebase,
						sampleRate: sampleRate,
						sampleFormat: 's32',
						channelLayout: layout
					}
				],
				outputParams: [
					{
						name: 'out0:a',
						sampleRate: sampleRate,
						sampleFormat: 's32',
						channelLayout: layout
					}
				],
				filterSpec: `[in0:a] asetnsamples=n=1024:p=1 [out0:a]`
			})
			console.log(this.audFilterer.graph.dump())

			width = this.capture.width
			height = this.capture.height

			this.toRGBA = new ToRGBA(this.clContext, '709', '709', new v210Reader(width, height))
			await this.toRGBA.init()

			this.yadif = new Yadif(this.clContext, width, height, 'send_field', 'tff', 'all')
			await this.yadif.init()
		} catch (err) {
			throw new InvalidProducerError(err)
		}

		const frameSource: Generator<Macadam.CaptureFrame | RedioEnd> = async (push, next) => {
			if (this.capture && this.running) {
				const frame = await this.capture.frame()
				push(frame)
				next()
			} else if (this.capture) {
				push(end)
				next()
				this.capture.stop()
				this.capture = null
			}
		}

		const audFilter: Valve<Macadam.CaptureFrame | RedioEnd, Frame | RedioEnd> = async (
			captureFrame
		) => {
			if (isValue(captureFrame) && this.audFilterer) {
				const ffFrame = frame({
					nb_samples: captureFrame.audio.sampleFrameCount,
					format: 's32',
					pts: captureFrame.audio.packetTime,
					sample_rate: sampleRate,
					channels: channels,
					channel_layout: layout,
					data: [captureFrame.audio.data]
				})
				const ff = await this.audFilterer.filter([{ name: 'in0:a', frames: [ffFrame] }])
				return ff[0].frames.length > 0 ? ff[0].frames : nil
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
				await toRGBA.processFrame(clSources, clDest, this.clContext.queue.process)
				await this.clContext.waitFinish(this.clContext.queue.process)
				clSources.forEach((s) => s.release())
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
				await yadif.processFrame(frame, yadifDests, this.clContext.queue.process)
				await this.clContext.waitFinish(this.clContext.queue.process)
				frame.release()
				return yadifDests.length > 1 ? yadifDests : nil
			} else {
				if (isEnd(frame)) {
					this.yadif?.release()
					this.yadif = null
				}
				return frame
			}
		}

		const macadamFrames = redio(frameSource, { bufferSizeMax: 2 })

		this.vidSource = macadamFrames
			.fork({ bufferSizeMax: 1 })
			.valve(vidLoader, { bufferSizeMax: 1 })
			.valve(vidProcess, { bufferSizeMax: 1 })
			.valve(vidDeint, { bufferSizeMax: 1, oneToMany: true })

		this.audSource = macadamFrames
			.fork({ bufferSizeMax: 1 })
			.valve(audFilter, { bufferSizeMax: 2, oneToMany: true })

		console.log(`Created Macadam producer ${this.id} for channel ${channel}`)
	}

	getSourceAudio(): RedioPipe<Frame | RedioEnd> | undefined {
		return this.audSource
	}

	getSourceVideo(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined {
		return this.vidSource
	}

	setPaused(pause: boolean): void {
		this.paused = pause
		console.log(this.id, ': setPaused', this.paused)
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

	createProducer(id: string, params: string[]): MacadamProducer {
		return new MacadamProducer(id, params, this.clContext)
	}
}
