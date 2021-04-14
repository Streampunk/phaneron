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
	frame
} from 'beamcoder'
import redio, { RedioPipe, nil, end, isValue, RedioEnd, Generator, Valve } from 'redioactive'
import { ClJobs } from '../clJobQueue'
import { LoadParams } from '../chanLayer'
import { VideoFormat } from '../config'
import { ToRGBA } from '../process/io'
import { Reader as yuv422p10Reader } from '../process/yuv422p10'
import { Reader as yuv422p8Reader } from '../process/yuv422p8'
import { Reader as yuv420pReader } from '../process/yuv420p'
import { Reader as v210Reader } from '../process/v210'
import { Reader as rgba8Reader } from '../process/rgba8'
import { Reader as bgra8Reader } from '../process/bgra8'
import Yadif from '../process/yadif'
import { PackImpl } from '../process/packer'
import { Mixer, AudioMixFrame } from './mixer'

interface AudioChannel {
	name: string
	frames: Frame[]
}

export class FFmpegProducer implements Producer {
	private readonly sourceID: string
	private readonly loadParams: LoadParams
	private readonly clContext: nodenCLContext
	private readonly clJobs: ClJobs
	private readonly consumerFormat: VideoFormat
	private readonly mixer: Mixer
	private demuxer: Demuxer | null = null
	private audSource: RedioPipe<AudioMixFrame | RedioEnd> | undefined
	private vidSource: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private running = true
	private paused = true

	constructor(
		id: number,
		loadParams: LoadParams,
		context: nodenCLContext,
		clJobs: ClJobs,
		consumerFormat: VideoFormat
	) {
		this.sourceID = `P${id} FFmpeg ${loadParams.url} L${loadParams.layer}`
		this.loadParams = loadParams
		this.clContext = context
		this.clJobs = clJobs
		this.consumerFormat = consumerFormat
		this.mixer = new Mixer(this.clContext, this.consumerFormat, this.clJobs)
	}

	async initialise(): Promise<void> {
		try {
			this.demuxer = await demuxer(this.loadParams.url)
		} catch (err) {
			console.log(err)
			throw new InvalidProducerError(err)
		}
		if (this.loadParams.seek) await this.demuxer.seek({ time: this.loadParams.seek })

		const audioStreams: Stream[] = []
		const videoStreams: Stream[] = []
		const audioIndexes: number[] = []
		const videoIndexes: number[] = []
		const decoders: Map<number, Decoder> = new Map()
		const numVidChannels = 1
		const audioPackets: Packet[] = []
		const videoPackets: Packet[] = []
		let monoStreams = true

		this.demuxer.streams.forEach((s) => {
			if (s.codecpar.codec_type === 'audio' && monoStreams) {
				// allow mxf-style mono channel per stream or a single stream of multiple channels
				s.discard = 'default'
				audioStreams.push(s)
				audioIndexes.push(s.index)
				decoders.set(s.index, decoder({ demuxer: this.demuxer as Demuxer, stream_index: s.index }))
				monoStreams &&= s.codecpar.channel_layout === 'mono'
			} else if (s.codecpar.codec_type === 'video' && videoStreams.length < numVidChannels) {
				s.discard = 'default'
				videoStreams.push(s)
				videoIndexes.push(s.index)
				decoders.set(s.index, decoder({ demuxer: this.demuxer as Demuxer, stream_index: s.index }))
			} else {
				s.discard = 'all'
			}
		})

		let silentFrame: Frame | null = null
		let audFilterer: Filterer | null = null
		const audStream = audioStreams[0]
		let numAudChannels = 0

		if (audStream) {
			const inParams = audioStreams.map((_s, i) => {
				return {
					name: `in${i}:a`,
					timeBase: audStream.time_base,
					sampleRate: audStream.codecpar.sample_rate,
					sampleFormat: audStream.codecpar.format,
					channelLayout: monoStreams ? '1c' : audStream.codecpar.channel_layout
				}
			})

			let filtStr = ''
			if (monoStreams) {
				numAudChannels = audioStreams.length
				for (let c = 0; c < numAudChannels; ++c)
					filtStr += (c === 0 ? '' : ';\n') + `[in${c}:a]asetnsamples=n=1024:p=1[out${c}:a]`
			} else {
				numAudChannels = audStream.codecpar.channels
				filtStr += `[in${0}:a]asetnsamples=n=1024:p=1, channelsplit=channel_layout=${numAudChannels}c`
				for (let s = 0; s < numAudChannels; ++s) filtStr += `[c${s}:a]`
				for (let s = 0; s < numAudChannels; ++s)
					filtStr += `;\n[c${s}:a]aformat=channel_layouts=1c[out${s}:a]`
			}
			// console.log(filtStr)

			const outParams = []
			for (let s = 0; s < numAudChannels; ++s)
				outParams.push({
					name: `out${s}:a`,
					sampleRate: this.consumerFormat.audioSampleRate,
					sampleFormat: 'fltp',
					channelLayout: '1c'
				})

			audFilterer = await filterer({
				filterType: 'audio',
				inputParams: inParams,
				outputParams: outParams,
				filterSpec: filtStr
			})
		} else {
			numAudChannels = 1
			silentFrame = frame({
				nb_samples: 1024,
				format: 's32',
				pts: 0,
				sample_rate: this.consumerFormat.audioSampleRate,
				channels: 1,
				channel_layout: '1c',
				data: [Buffer.alloc(1024 * 4)]
			})

			audFilterer = await filterer({
				filterType: 'audio',
				inputParams: [
					{
						name: 'in0:a',
						timeBase: [1, this.consumerFormat.audioSampleRate],
						sampleRate: this.consumerFormat.audioSampleRate,
						sampleFormat: 's32',
						channelLayout: '1c'
					}
				],
				outputParams: [
					{
						name: 'out0:a',
						sampleRate: this.consumerFormat.audioSampleRate,
						sampleFormat: 'fltp',
						channelLayout: '1c'
					}
				],
				filterSpec: '[in0:a] asetpts=N/SR/TB [out0:a]'
			})
		}
		// console.log('\nFFmpeg producer audio:\n', audFilterer.graph.dump())

		let width = this.consumerFormat.width
		let height = this.consumerFormat.height
		let squareWidth = width
		let squareHeight = height
		let vidTimescale = this.consumerFormat.timescale
		let vidDuration = this.consumerFormat.duration
		let toRGBA: ToRGBA | null = null
		let vidFilterer: Filterer | null = null
		let progressive = true
		let yadif: Yadif | null = null
		let black: OpenCLBuffer | null = null

		const vidStream = videoStreams[0]
		if (vidStream) {
			width = vidStream.codecpar.width
			height = vidStream.codecpar.height
			squareWidth = (width * vidStream.codecpar.sample_aspect_ratio[0]) / vidStream.codecpar.sample_aspect_ratio[1]
			squareHeight = height
			vidTimescale = vidStream.time_base[1] * (progressive ? 1 : 2)
			vidDuration = vidStream.time_base[0]

			let filterOutputFormat = vidStream.codecpar.format
			let readImpl: PackImpl
			switch (vidStream.codecpar.format) {
				case 'yuv420p':
					console.log('Using native yuv420p loader')
					readImpl = new yuv420pReader(width, height)
					break
				case 'yuv422p':
					console.log('Using native yuv422p8 loader')
					readImpl = new yuv422p8Reader(width, height)
					break
				case 'yuv422p10le':
					console.log('Using native yuv422p10 loader')
					readImpl = new yuv422p10Reader(width, height)
					break
				case 'v210':
					console.log('Using native v210 loader')
					readImpl = new v210Reader(width, height)
					break
				case 'rgba':
					console.log('Using native rgba8 loader')
					readImpl = new rgba8Reader(width, height)
					break
				case 'bgra':
					console.log('Using native bgra8 loader')
					readImpl = new bgra8Reader(width, height)
					break
				default:
					if (vidStream.codecpar.format.includes('yuv')) {
						console.log(`Non-native loader for ${vidStream.codecpar.format} - using yuv422p10`)
						filterOutputFormat = 'yuv422p10le'
						readImpl = new yuv422p10Reader(width, height)
					} else if (vidStream.codecpar.format.includes('rgb')) {
						console.log(`Non-native loader for ${vidStream.codecpar.format} - using rgba8`)
						filterOutputFormat = 'rgba'
						readImpl = new rgba8Reader(width, height)
					} else
						throw new Error(
							`Unsupported video format '${vidStream.codecpar.format}' from FFmpeg decoder`
						)
			}
			toRGBA = new ToRGBA(this.clContext, '709', '709', readImpl, this.clJobs)
			await toRGBA.init()
			const chanTb = [this.consumerFormat.duration, this.consumerFormat.timescale]
			vidFilterer = await filterer({
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
				filterSpec: `fps=fps=${chanTb[1] / 2}/${chanTb[0]}`
			})
			// console.log('\nFFmpeg producer video:\n', vidFilterer.graph.dump())

			const fieldOrder = vidStream.codecpar.field_order
			progressive = fieldOrder === 'progressive'
			const tff = fieldOrder === 'unknown' || fieldOrder.split(', ', 2)[1] === 'top displayed first'
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
		} else {
			const numBytesRGBA = width * height * 4 * 4
			black = await this.clContext.createBuffer(
				numBytesRGBA,
				'readwrite',
				'coarse',
				{
					width: width,
					height: height
				},
				'combinerBlack'
			)

			let off = 0
			const blackFloat = new Float32Array(numBytesRGBA / 4)
			for (let y = 0; y < height; ++y) {
				for (let x = 0; x < width * 4; x += 4) {
					blackFloat[off + x + 0] = 0.0
					blackFloat[off + x + 1] = 0.0
					blackFloat[off + x + 2] = 0.0
					blackFloat[off + x + 3] = 0.0
				}
				off += width * 4
			}
			await black.hostAccess('writeonly')
			Buffer.from(blackFloat.buffer).copy(black)
		}

		const demux: Generator<Packet | RedioEnd> = async () => {
			let packet: Packet | RedioEnd = end
			if (this.demuxer && this.running) {
				packet = await this.demuxer.read()
			} else {
				this.demuxer = null
			}
			return packet ? packet : end
		}

		const audPacketFilter: Valve<Packet | RedioEnd, Packet[] | RedioEnd> = async (packet) => {
			if (isValue(packet)) {
				if (!this.running) return nil
				if (audioIndexes.includes(packet.stream_index)) {
					audioPackets.push(packet)
					if (audioPackets.length === audioStreams.length) {
						const result = audioPackets.slice(0)
						audioPackets.splice(0)
						return result
					} else return nil
				} else return nil
			} else {
				return packet
			}
		}

		const audDecode: Valve<Packet[] | RedioEnd, AudioChannel[] | RedioEnd> = async (packets) => {
			if (isValue(packets)) {
				if (!this.running) return nil
				const frames = await Promise.all(
					packets.map((p) => (decoders.get(p.stream_index) as Decoder).decode(p))
				)
				return frames.map((f, i) => ({ name: `in${i}:a`, frames: f.frames }))
			} else {
				return packets
			}
		}

		const audFilter: Valve<AudioChannel[] | RedioEnd, AudioMixFrame | RedioEnd> = async (
			frames
		) => {
			if (isValue(frames) && audFilterer) {
				if (!this.running) return nil
				const ff = await audFilterer.filter(frames)
				if (ff.reduce((acc, f) => acc && f.frames && f.frames.length > 0, true)) {
					return { frames: ff.map((f) => f.frames), mute: false }
				} else return nil
			} else {
				return frames as RedioEnd
			}
		}

		const silence: Generator<AudioChannel[] | RedioEnd> = async () =>
			this.running ? [{ name: 'in0:a', frames: [silentFrame] }] : end

		const vidPacketFilter: Valve<Packet | RedioEnd, Packet[] | RedioEnd> = async (packet) => {
			if (isValue(packet)) {
				if (!this.running) return nil
				if (videoIndexes.includes(packet.stream_index)) {
					videoPackets.push(packet)
					if (videoPackets.length === videoStreams.length) {
						const result = videoPackets.slice(0)
						videoPackets.splice(0)
						return result
					} else return nil
				} else return nil
			} else {
				return packet
			}
		}

		const vidDecode: Valve<Packet[] | RedioEnd, Frame | RedioEnd> = async (packets) => {
			if (isValue(packets)) {
				if (!this.running) return nil
				const frm = await (decoders.get(packets[0].stream_index) as Decoder).decode(packets[0])
				return frm.frames.length > 0 ? frm.frames : nil
			} else {
				return packets
			}
		}

		const vidFilter: Valve<Frame | RedioEnd, Frame | RedioEnd> = async (decFrame) => {
			if (isValue(decFrame)) {
				if (!this.running || !vidFilterer) return nil
				const ff = await vidFilterer.filter([decFrame])
				if (!ff[0]) return nil
				return ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				return decFrame
			}
		}

		const vidLoader: Valve<Frame | RedioEnd, OpenCLBuffer[] | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				if (!this.running) return nil
				const convert = toRGBA as ToRGBA
				const clSources = await convert.createSources()
				clSources.forEach((s) => (s.timestamp = progressive ? frame.pts : frame.pts * 2))
				await convert.loadFrame(frame.data, clSources, this.clContext.queue.load)
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
				if (!this.running) {
					clSources.forEach((s) => s.release())
					return nil
				}
				const convert = toRGBA as ToRGBA
				const clDest = await convert.createDest({ width: width, height: height })
				clDest.timestamp = clSources[0].timestamp
				convert.processFrame(this.sourceID, clSources, clDest)
				return clDest
			} else {
				toRGBA?.finish()
				toRGBA = null
				return clSources
			}
		}

		const vidDeint: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				if (!this.running) {
					frame.release()
					return nil
				}
				const yadifDests: OpenCLBuffer[] = []
				await yadif?.processFrame(frame, yadifDests, this.sourceID)
				return yadifDests.length > 0 ? yadifDests : nil
			} else {
				yadif?.release()
				yadif = null
				this.running = false
				return frame
			}
		}

		const blackPipe: RedioPipe<OpenCLBuffer | RedioEnd> = redio(
			async () => {
				if (this.running) {
					black?.addRef()
					return black
				} else return end
			},
			{ bufferSizeMax: 1 }
		)

		const srcFormat = {
			name: 'ffmpeg',
			fields: 1,
			width: width,
			height: height,
			squareWidth: squareWidth,
			squareHeight: squareHeight,
			timescale: vidTimescale,
			duration: vidDuration,
			audioSampleRate: 48000,
			audioChannels: numAudChannels
		}

		const ffPackets = redio(demux, { bufferSizeMax: this.demuxer.streams.length * 2 })

		let audSrc: RedioPipe<RedioEnd | AudioMixFrame> | undefined
		if (audioStreams.length) {
			audSrc = ffPackets
				.fork({ bufferSizeMax: 10 })
				.valve(audPacketFilter)
				.valve(audDecode, { bufferSizeMax: 2 })
				.valve(audFilter, { oneToMany: true })
		} else {
			// eslint-disable-next-line prettier/prettier
			audSrc = redio(silence, { bufferSizeMax: 2 })
				.valve(audFilter, { oneToMany: true })
		}
		this.audSource = audSrc.pause((frame) => {
			if (!this.running) {
				frame = nil
				return false
			}
			if (this.paused && isValue(frame)) (frame as AudioMixFrame).mute = true
			return this.paused
		})

		let vidSrc: RedioPipe<RedioEnd | OpenCLBuffer> | undefined
		if (videoStreams.length) {
			vidSrc = ffPackets
				.fork({ bufferSizeMax: 10 })
				.valve(vidPacketFilter)
				.valve(vidDecode, { oneToMany: true, bufferSizeMax: 2 })
				.valve(vidFilter, { oneToMany: true })
				.valve(vidLoader, { bufferSizeMax: 1 })
				.valve(vidProcess)
				.valve(vidDeint, { oneToMany: true })
		} else {
			vidSrc = blackPipe
		}

		this.vidSource = vidSrc.pause((frame) => {
			if (!this.running) {
				frame = nil
				return false
			}
			if (this.paused && isValue(frame)) (frame as OpenCLBuffer).addRef()
			return this.paused
		})

		await this.mixer.init(this.sourceID, this.audSource, this.vidSource, srcFormat)

		console.log(`Created FFmpeg producer for path ${this.loadParams.url}`)
	}

	getMixer(): Mixer {
		return this.mixer
	}

	setPaused(pause: boolean): void {
		this.paused = pause
	}

	release(): void {
		this.running = false
		this.mixer.release()
	}
}

export class FFmpegProducerFactory implements ProducerFactory<FFmpegProducer> {
	private clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createProducer(
		id: number,
		loadParams: LoadParams,
		clJobs: ClJobs,
		consumerFormat: VideoFormat
	): FFmpegProducer {
		return new FFmpegProducer(id, loadParams, this.clContext, clJobs, consumerFormat)
	}
}
