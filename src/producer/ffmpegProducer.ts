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
import {
	Demuxer,
	demuxer,
	Decoder,
	decoder,
	Filterer,
	filterer,
	Stream,
	Packet,
	Frame,
	AudioInputParam
} from 'beamcoder'
import redio, { RedioPipe, nil, end, isValue, RedioEnd, isEnd } from 'redioactive'
import { ChanProperties } from '../chanLayer'
import { ToRGBA } from '../process/io'
import { Reader as yuv422p10Reader } from '../process/yuv422p10'
import { Reader as yuv422p8Reader } from '../process/yuv422p8'
import { Reader as v210Reader } from '../process/v210'
import { Reader as rgba8Reader } from '../process/rgba8'
import { Reader as bgra8Reader } from '../process/bgra8'
import Yadif from '../process/yadif'
import { EventEmitter } from 'events'

interface DecodedFrames {
	streamIndex: number
	frame: Frame
}

interface AudioChannel {
	name: string
	frames: Frame[]
}

export class FFmpegProducer implements Producer {
	private readonly id: string
	private params: string[]
	private clContext: nodenCLContext
	private demuxer: Demuxer | null = null
	private readonly streams: Stream[]
	private readonly decoders: Decoder[]
	private audFilterer: Filterer | null = null
	private vidFilterer: Filterer | null = null
	private audFilter: RedioPipe<Frame | RedioEnd> | undefined
	private makeSource: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private toRGBA: ToRGBA | null = null
	private yadif: Yadif | null = null
	private running = true
	private paused = false
	private pauseEvent: EventEmitter

	constructor(id: string, params: string[], context: nodenCLContext) {
		this.id = id
		this.params = params
		this.clContext = context
		this.streams = []
		this.decoders = []
		this.pauseEvent = new EventEmitter()
	}

	async initialise(chanProperties: ChanProperties): Promise<void> {
		const url = this.params[0]
		let width = 0
		let height = 0
		const audioStreams: number[] = []
		const videoStreams: number[] = []
		const audioChannels: AudioChannel[] = []

		try {
			this.demuxer = await demuxer(url)
			await this.demuxer.seek({ time: 40 })

			this.demuxer.streams.forEach((s) => {
				this.streams.push(s)
				if (s.codecpar.codec_type === 'audio' && audioStreams.length < 2) audioStreams.push(s.index)
				if (s.codecpar.codec_type === 'video' && videoStreams.length === 0)
					videoStreams.push(s.index)
				this.decoders.push(decoder({ demuxer: this.demuxer as Demuxer, stream_index: s.index }))
			})

			const audStream = this.streams[audioStreams[0]]
			const inParams: AudioInputParam[] = []
			let inStr = ''
			audioStreams.forEach((_s, i) => {
				inParams.push({
					name: `in${i}:a`,
					timeBase: audStream.time_base,
					sampleRate: audStream.codecpar.sample_rate,
					sampleFormat: audStream.codecpar.format,
					channelLayout: audStream.codecpar.channel_layout
				})
				inStr += `[in${i}:a]`
			})
			this.audFilterer = await filterer({
				filterType: 'audio',
				inputParams: inParams,
				outputParams: [
					{
						name: 'out0:a',
						sampleRate: audStream.codecpar.sample_rate,
						sampleFormat: audStream.codecpar.format,
						channelLayout: 'stereo'
					}
				],
				filterSpec: `${inStr} amerge=inputs=${audioStreams.length}, asetnsamples=n=960:p=1 [out0:a]`
			})
			console.log(this.audFilterer.graph.dump())

			const vidStream = this.streams[videoStreams[0]]
			width = vidStream.codecpar.width
			height = vidStream.codecpar.height

			let filterOutputFormat = vidStream.codecpar.format
			switch (vidStream.codecpar.format) {
				case 'yuv422p':
					this.toRGBA = new ToRGBA(this.clContext, '709', '709', new yuv422p8Reader(width, height))
					break
				case 'yuv422p10le':
					this.toRGBA = new ToRGBA(this.clContext, '709', '709', new yuv422p10Reader(width, height))
					break
				case 'v210':
					this.toRGBA = new ToRGBA(this.clContext, '709', '709', new v210Reader(width, height))
					break
				case 'rgba':
					this.toRGBA = new ToRGBA(this.clContext, '709', '709', new rgba8Reader(width, height))
					break
				case 'bgra':
					this.toRGBA = new ToRGBA(this.clContext, '709', '709', new bgra8Reader(width, height))
					break
				default:
					if (vidStream.codecpar.format.includes('yuv')) {
						filterOutputFormat = 'yuv422p10le'
						this.toRGBA = new ToRGBA(
							this.clContext,
							'709',
							'709',
							new yuv422p10Reader(width, height)
						)
					} else if (vidStream.codecpar.format.includes('rgb')) {
						filterOutputFormat = 'rgba'
						this.toRGBA = new ToRGBA(this.clContext, '709', '709', new rgba8Reader(width, height))
					} else
						throw new Error(
							`Unsupported video format '${vidStream.codecpar.format}' from FFmpeg decoder`
						)
			}
			await this.toRGBA.init()
			this.vidFilterer = await filterer({
				filterType: 'video',
				inputParams: [
					{
						timeBase: vidStream.time_base,
						width: width,
						height: height,
						pixelFormat: vidStream.codecpar.format,
						pixelAspect: vidStream.codecpar.sample_aspect_ratio
					}
				],
				outputParams: [
					{
						pixelFormat: filterOutputFormat
					}
				],
				filterSpec: `fps=fps=${chanProperties.videoTimebase[1] / 2}/${
					chanProperties.videoTimebase[0]
				}`
			})

			this.yadif = new Yadif(this.clContext, width, height, 'send_field', 'tff', 'all')
			await this.yadif.init()
		} catch (err) {
			console.log(err)
			throw new InvalidProducerError(err)
		}

		const demux = redio<Packet | RedioEnd>(
			async (push, next) => {
				if (this.demuxer && this.running) {
					const packet = await this.demuxer.read()
					push(packet)
					next()
				} else if (this.demuxer) {
					push(end)
					next()
					this.demuxer = null
				}
			},
			{ bufferSizeMax: 20 }
		)

		const decode = demux.valve<DecodedFrames | RedioEnd>(
			async (packet: Packet | RedioEnd) => {
				if (isValue(packet)) {
					const frm = await this.decoders[packet.stream_index].decode(packet)
					const frames: DecodedFrames[] = []
					frm.frames.forEach((f) => frames.push({ streamIndex: packet.stream_index, frame: f }))
					return frames
				} else {
					return packet
				}
			},
			{ bufferSizeMax: 20, oneToMany: true }
		)

		const audFrames = decode.fork()
		const vidFrames = decode.fork()

		const audChannels = audFrames.valve<AudioChannel[] | RedioEnd>(
			async (decFrame: DecodedFrames | RedioEnd) => {
				if (isValue(decFrame)) {
					if (audioStreams.includes(decFrame.streamIndex)) {
						audioChannels.push({ name: `in${audioChannels.length}:a`, frames: [decFrame.frame] })
						if (audioChannels.length === audioStreams.length) {
							const audioFrames = [...audioChannels]
							audioChannels.length = 0
							return audioFrames
						} else {
							return nil
						}
					} else {
						return nil
					}
				} else {
					return decFrame
				}
			},
			{ bufferSizeMax: 2, oneToMany: false }
		)

		this.audFilter = audChannels.valve<Frame | RedioEnd>(
			async (frames: AudioChannel[] | RedioEnd) => {
				if (isValue(frames) && this.audFilterer) {
					const ff = await this.audFilterer.filter(frames)
					return ff[0].frames.length > 0 ? ff[0].frames : nil
				} else {
					return frames as RedioEnd
				}
			},
			{ bufferSizeMax: 4, oneToMany: true }
		)

		const vidFilter = vidFrames.valve<Frame | RedioEnd>(
			async (decFrame: DecodedFrames | RedioEnd) => {
				if (isValue(decFrame)) {
					if (videoStreams.includes(decFrame.streamIndex) && this.vidFilterer) {
						const ff = await this.vidFilterer.filter([decFrame.frame])
						return ff[0].frames.length > 0 ? ff[0].frames : nil
					} else {
						return nil
					}
				} else {
					return decFrame
				}
			},
			{ bufferSizeMax: 2, oneToMany: true }
		)

		const vidLoader = vidFilter.valve<OpenCLBuffer[] | RedioEnd>(
			async (frame: Frame | RedioEnd) => {
				if (isValue(frame)) {
					const toRGBA = this.toRGBA as ToRGBA
					const clSources = await toRGBA.createSources()
					clSources.forEach((s) => (s.timestamp = frame.best_effort_timestamp))
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
					clDest.timestamp = clSources[0].timestamp
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
					return yadifDests.length > 1 ? yadifDests : nil
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

		this.makeSource = vidDeint.valve<OpenCLBuffer | RedioEnd>(
			async (frame: OpenCLBuffer | RedioEnd) => {
				if (isValue(frame)) {
					while (this.paused)
						await new Promise((resolve) => this.pauseEvent.once('update', resolve))
					return frame
				} else {
					return frame
				}
			},
			{ bufferSizeMax: 1, oneToMany: false }
		)

		console.log(`Created FFmpeg producer ${this.id} for path ${url}`)
	}

	getSourceAudio(): RedioPipe<Frame | RedioEnd> | undefined {
		return this.audFilter
	}

	getSourceVideo(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined {
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
