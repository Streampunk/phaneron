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

import { SourceFrame } from '../chanLayer'
import { ProducerFactory, Producer, InvalidProducerError } from './producer'
import { clContext as nodenCLContext, OpenCLBuffer } from 'nodencl'
import { Demuxer, demuxer, Decoder, decoder, Filterer, filterer, Packet, Frame } from 'beamcoder'
import redio, { RedioPipe, nil, end, isValue, RedioEnd, isEnd } from 'redioactive'
import { ToRGBA } from '../process/io'
import { Reader } from '../process/yuv422p10'
import Yadif from '../process/yadif'
import { EventEmitter } from 'events'

export class FFmpegProducer implements Producer {
	private readonly id: string
	private params: string[]
	private clContext: nodenCLContext
	private demuxer: Demuxer | null = null
	private readonly decoders: Decoder[]
	private readonly filterers: Filterer[]
	private makeSource: RedioPipe<SourceFrame | RedioEnd> | undefined
	private toRGBA: ToRGBA | null = null
	private yadif: Yadif | null = null
	private running = true
	private paused = false
	private pauseEvent: EventEmitter

	constructor(id: string, params: string[], context: nodenCLContext) {
		this.id = id
		this.params = params
		this.clContext = context
		this.decoders = []
		this.filterers = []
		this.pauseEvent = new EventEmitter()
	}

	async initialise(): Promise<void> {
		const url = this.params[0]
		let width = 0
		let height = 0
		try {
			this.demuxer = await demuxer(url)
			await this.demuxer.seek({ time: 20 })
			// console.log('NumStreams:', this.demuxer.streams.length)
			this.demuxer.streams.forEach((_s, i) => {
				this.decoders.push(decoder({ demuxer: this.demuxer as Demuxer, stream_index: i }))
			})

			const vidStream = this.demuxer.streams[0]
			width = vidStream.codecpar.width
			height = vidStream.codecpar.height
			this.filterers[0] = await filterer({
				filterType: 'video',
				inputParams: [
					{
						width: width,
						height: height,
						pixelFormat: vidStream.codecpar.format,
						timeBase: vidStream.time_base,
						pixelAspect: vidStream.codecpar.sample_aspect_ratio
					}
				],
				outputParams: [
					{
						pixelFormat: vidStream.codecpar.format
					}
				],
				filterSpec: 'fps=fps=25/1' // !!! TODO !!!
				// filterSpec: 'fps=fps=25/1:start_time=0' // !!! TODO !!!
			})

			this.toRGBA = new ToRGBA(
				this.clContext,
				'709',
				'709',
				new Reader(vidStream.codecpar.width, vidStream.codecpar.height)
			)
			await this.toRGBA.init()

			this.yadif = new Yadif(this.clContext, width, height, 'send_field', 'tff', 'all')
			await this.yadif.init()
		} catch (err) {
			throw new InvalidProducerError(err)
		}

		const vidSource = redio<Packet | RedioEnd>(
			async (push, next) => {
				if (this.running) {
					const packet = await this.demuxer?.read()
					// console.log('PKT:', packet?.stream_index, packet?.pts)
					if (packet && packet?.stream_index === 0) push(packet)
					else push(nil)
					next()
				} else if (this.demuxer) {
					push(end)
					next()
					this.demuxer = null
				}
			},
			{ bufferSizeMax: 3 }
		)

		const vidDecode = vidSource.valve<Frame | RedioEnd>(
			async (packet: Packet | RedioEnd) => {
				if (isValue(packet)) {
					const frm = await this.decoders[packet.stream_index].decode(packet)
					return frm.frames
				} else {
					return packet
				}
			},
			{ bufferSizeMax: 2, oneToMany: true }
		)

		const vidFilter = vidDecode.valve<Frame | RedioEnd>(
			async (frame: Frame | RedioEnd) => {
				if (isValue(frame)) {
					const ff = await this.filterers[0].filter([frame])
					return ff[0].frames.length > 0 ? ff[0].frames : nil
				} else {
					return frame
				}
			},
			{ bufferSizeMax: 2, oneToMany: true }
		)

		const vidLoader = vidFilter.valve<OpenCLBuffer[] | RedioEnd>(
			async (frame: Frame | RedioEnd) => {
				if (isValue(frame)) {
					const toRGBA = this.toRGBA as ToRGBA
					const clSources = await toRGBA.createSources()
					await toRGBA.loadFrame(frame.data, clSources, this.clContext.queue.load)
					await this.clContext.waitFinish(this.clContext.queue.load)
					return clSources
				} else {
					return frame
				}
			},
			{ bufferSizeMax: 2, oneToMany: false }
		)

		const vidProcess = vidLoader.valve<OpenCLBuffer | RedioEnd>(
			async (clSources: OpenCLBuffer[] | RedioEnd) => {
				if (isValue(clSources)) {
					const toRGBA = this.toRGBA as ToRGBA
					const clDest = await toRGBA.createDest({ width: width, height: height })
					await toRGBA.processFrame(clSources, clDest, this.clContext.queue.process)
					await this.clContext.waitFinish(this.clContext.queue.process)
					clSources.forEach((s) => s.release())
					return clDest
				} else {
					if (isEnd(clSources)) this.toRGBA = null
					return clSources
				}
			},
			{ bufferSizeMax: 1, oneToMany: false }
		)

		const vidDeint = vidProcess.valve<OpenCLBuffer | RedioEnd>(
			async (frame: OpenCLBuffer | RedioEnd) => {
				if (isValue(frame)) {
					const yadif = this.yadif as Yadif
					const yadifDests: OpenCLBuffer[] = []
					await yadif.processFrame(frame, yadifDests, this.clContext.queue.process)
					await this.clContext.waitFinish(this.clContext.queue.process)
					frame.release()
					return yadifDests.length > 0 ? yadifDests : nil
				} else {
					if (isEnd(frame)) {
						this.yadif?.release()
						this.yadif = null
					}
					return frame
				}
			},
			{ bufferSizeMax: 1, oneToMany: true }
		)

		this.makeSource = vidDeint.valve<SourceFrame | RedioEnd>(
			async (frame: OpenCLBuffer | RedioEnd) => {
				if (isValue(frame)) {
					while (this.paused)
						await new Promise((resolve) => this.pauseEvent.once('update', resolve))
					const sourceFrame: SourceFrame = { video: frame, audio: Buffer.alloc(0), timestamp: 0 }
					return sourceFrame
				} else {
					return frame
				}
			},
			{ bufferSizeMax: 1, oneToMany: false }
		)

		console.log(`Created FFmpeg producer ${this.id} for path ${url}`)
	}

	getSourcePipe(): RedioPipe<SourceFrame | RedioEnd> | undefined {
		return this.makeSource
	}

	setPaused(pause: boolean): void {
		this.paused = pause
		this.pauseEvent.emit('update')
	}

	release(): void {
		this.running = false
	}
}

export class FFmpegProducerFactory implements ProducerFactory<FFmpegProducer> {
	private clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createProducer(id: string, params: string[]): FFmpegProducer {
		return new FFmpegProducer(id, params, this.clContext)
	}
}
