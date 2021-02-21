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
import { VideoFormat, VideoFormats } from '../config'
import { ToRGBA } from '../process/io'
import { Reader as yuv422p10Reader } from '../process/yuv422p10'
import { Reader as yuv422p8Reader } from '../process/yuv422p8'
import { Reader as yuv420p8Reader } from '../process/yuv420p8'
import { Reader as v210Reader } from '../process/v210'
import { Reader as rgba8Reader } from '../process/rgba8'
import { Reader as bgra8Reader } from '../process/bgra8'
import Yadif from '../process/yadif'
import { PackImpl } from '../process/packer'
import { AudioMixFrame } from '../mixer'

interface AudioChannel {
	name: string
	frames: Frame[]
}

export class FFmpegProducer implements Producer {
	private readonly sourceID: string
	private readonly loadParams: LoadParams
	private readonly clContext: nodenCLContext
	private readonly clJobs: ClJobs
	private demuxer: Demuxer | null = null
	private format: VideoFormat
	private audSource: RedioPipe<AudioMixFrame | RedioEnd> | undefined
	private vidSource: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private running = true
	private paused = false

	constructor(id: number, loadParams: LoadParams, context: nodenCLContext, clJobs: ClJobs) {
		this.sourceID = `P${id} FFmpeg ${loadParams.url} L${loadParams.layer}`
		this.loadParams = loadParams
		this.clContext = context
		this.clJobs = clJobs
		this.format = new VideoFormats().get('1080p5000') // default
	}

	async initialise(consumerFormat: VideoFormat): Promise<void> {
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
		const numAudChannels = 8
		const numVidChannels = 1
		this.demuxer.streams.forEach((s) => {
			if (s.codecpar.codec_type === 'audio' && audioStreams.length < numAudChannels) {
				s.discard = 'default'
				audioStreams.push(s)
				audioIndexes.push(s.index)
				decoders.set(s.index, decoder({ demuxer: this.demuxer as Demuxer, stream_index: s.index }))
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
		const audLayout = `${numAudChannels}c`
		// If the file has multiple audio streams each marked as mono then set the channel layout to give them a default position
		const allMono = audioStreams.every((s) => s.codecpar.channel_layout === 'mono')
		const audChanNames = ['FL', 'FR', 'FC', 'SL', 'SR', 'LFE', 'BL', 'BR']
		const audStream = audioStreams[0]
		if (audStream) {
			let inStr = ''
			const inParams = audioStreams.map((_s, i) => {
				inStr += `[in${i}:a]`
				return {
					name: `in${i}:a`,
					timeBase: audStream.time_base,
					sampleRate: audStream.codecpar.sample_rate,
					sampleFormat: audStream.codecpar.format,
					channelLayout: allMono ? audChanNames[i] : audStream.codecpar.channel_layout
				}
			})

			audFilterer = await filterer({
				filterType: 'audio',
				inputParams: inParams,
				outputParams: [
					{
						name: 'out0:a',
						sampleRate: 48000,
						sampleFormat: 'flt',
						channelLayout: audLayout
					}
				],
				filterSpec: `${inStr} amerge=inputs=${audioStreams.length}, asetnsamples=n=1024:p=1 [out0:a]`
			})
		} else {
			silentFrame = frame({
				nb_samples: 1024,
				format: 's32',
				pts: 0,
				sample_rate: 48000,
				channels: numAudChannels,
				channel_layout: audLayout,
				data: [Buffer.alloc(1024 * numAudChannels * 4)]
			})

			audFilterer = await filterer({
				filterType: 'audio',
				inputParams: [
					{
						name: 'in0:a',
						timeBase: [1, 48000],
						sampleRate: 48000,
						sampleFormat: 's32',
						channelLayout: audLayout
					}
				],
				outputParams: [
					{
						name: 'out0:a',
						sampleRate: 48000,
						sampleFormat: 'flt',
						channelLayout: audLayout
					}
				],
				filterSpec: '[in0:a] asetpts=N/SR/TB [out0:a]'
			})
		}
		// console.log('\nFFmpeg producer audio:\n', audFilterer.graph.dump())

		const vidStream = videoStreams[0]
		const width = vidStream.codecpar.width
		const height = vidStream.codecpar.height

		let toRGBA: ToRGBA | null = null
		let filterOutputFormat = vidStream.codecpar.format
		let readImpl: PackImpl
		switch (vidStream.codecpar.format) {
			case 'yuv422p':
				console.log('Using native yuv422p8 loader')
				readImpl = new yuv422p8Reader(width, height)
				break
			case 'yuv420p':
				console.log('Using native yuv420p8 loader')
				readImpl = new yuv420p8Reader(width, height)
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
		const chanTb = [consumerFormat.duration, consumerFormat.timescale]
		const vidFilterer = await filterer({
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

		let yadif: Yadif | null = null
		const fieldOrder = vidStream.codecpar.field_order
		const progressive = fieldOrder === 'progressive'
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

		const demux: Generator<Packet[] | RedioEnd> = async () => {
			let result: Packet[] | RedioEnd = end
			let doneSet = false

			let lastAudTimestamp: number | undefined = undefined
			let lastVidTimestamp: number | undefined = undefined
			const packets: Packet[] = []
			let doBreak = false

			if (this.demuxer && this.running) {
				do {
					const packet = await this.demuxer.read()
					if (packet) {
						if (audioIndexes.includes(packet.stream_index)) {
							if (!lastAudTimestamp) lastAudTimestamp = packet.pts
							else if (packet.pts !== lastAudTimestamp) doBreak = true
							packets.push(packet)
						} else if (videoIndexes.includes(packet.stream_index)) {
							if (!lastVidTimestamp) lastVidTimestamp = packet.pts
							else if (packet.pts !== lastVidTimestamp) doBreak = true
							packets.push(packet)
						}

						if (doBreak || packets.length === audioStreams.length + videoStreams.length) {
							if (doBreak)
								console.log(
									`Timestamp mismatch - sending ${packets.length} packets, ${
										audioStreams.length + videoStreams.length
									} expected`
								)
							doneSet = true
							result = packets
						}
					} else {
						doneSet = true
						result = end
					}
				} while (!doneSet)
			} else this.demuxer = null

			return result
		}

		const audPacketFilter: Valve<Packet[] | RedioEnd, Packet[] | RedioEnd> = async (packets) => {
			if (isValue(packets)) {
				return packets.filter((p) => audioIndexes.includes(p.stream_index))
			} else {
				return packets
			}
		}

		const audDecode: Valve<Packet[] | RedioEnd, AudioChannel[] | RedioEnd> = async (packets) => {
			if (isValue(packets)) {
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
				const ff = await audFilterer.filter(frames)
				if (!ff[0]) return nil
				const audMixFrames =
					ff[0].frames.length > 0 ? ff[0].frames.map((f) => ({ frame: f, mute: false })) : nil
				return audMixFrames
			} else {
				return frames as RedioEnd
			}
		}

		const silence: Generator<AudioChannel[] | RedioEnd> = async () => [
			{ name: 'in0:a', frames: [silentFrame] }
		]

		const vidPacketFilter: Valve<Packet[] | RedioEnd, Packet[] | RedioEnd> = async (packets) => {
			if (isValue(packets)) {
				return packets.filter((p) => videoIndexes.includes(p.stream_index))
			} else {
				return packets
			}
		}

		const vidDecode: Valve<Packet[] | RedioEnd, Frame | RedioEnd> = async (packets) => {
			if (isValue(packets)) {
				if (!packets[0]) return nil
				const frm = await (decoders.get(packets[0].stream_index) as Decoder).decode(packets[0])
				return frm.frames.length > 0 ? frm.frames : nil
			} else {
				return packets
			}
		}

		const vidFilter: Valve<Frame | RedioEnd, Frame | RedioEnd> = async (decFrames) => {
			if (isValue(decFrames)) {
				const ff = await vidFilterer.filter([decFrames])
				if (!ff[0]) return nil
				return ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				return decFrames
			}
		}

		const vidLoader: Valve<Frame | RedioEnd, OpenCLBuffer[] | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
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
				const convert = toRGBA as ToRGBA
				const clDest = await convert.createDest({ width: width, height: height })
				clDest.timestamp = clSources[0].timestamp
				convert.processFrame(this.sourceID, clSources, clDest)
				return clDest
			} else {
				toRGBA = null
				return clSources
			}
		}

		const vidDeint: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const yadifDests: OpenCLBuffer[] = []
				await yadif?.processFrame(frame, yadifDests, this.sourceID)
				return yadifDests.length > 1 ? yadifDests : nil
			} else {
				yadif?.release()
				yadif = null
				return frame
			}
		}

		this.format = {
			name: 'ffmpeg',
			fields: 1,
			width: width,
			height: height,
			squareWidth: (width * vidStream.sample_aspect_ratio[0]) / vidStream.sample_aspect_ratio[1],
			squareHeight: height,
			timescale: vidStream.time_base[1] * (progressive ? 1 : 2),
			duration: vidStream.time_base[0],
			audioSampleRate: 48000,
			audioChannels: numAudChannels
		}

		const ffPackets = redio(demux, { bufferSizeMax: 10 })

		let audSrc: RedioPipe<RedioEnd | AudioMixFrame> | undefined
		if (audioStreams.length) {
			audSrc = ffPackets
				.fork()
				.valve(audPacketFilter)
				.valve(audDecode)
				.valve(audFilter, { oneToMany: true })
		} else {
			// eslint-disable-next-line prettier/prettier
			audSrc = redio(silence, { bufferSizeMax: 10 })
				.valve(audFilter, { oneToMany: true })
		}
		this.audSource = audSrc.pause((frame) => {
			if (this.paused && isValue(frame)) (frame as AudioMixFrame).mute = true
			return this.paused
		})

		this.vidSource = ffPackets
			.fork()
			.valve(vidPacketFilter)
			.valve(vidDecode, { oneToMany: true })
			.valve(vidFilter, { oneToMany: true })
			.valve(vidLoader, { bufferSizeMax: 1 })
			.valve(vidProcess)
			.valve(vidDeint, { oneToMany: true })
			.pause((frame) => {
				if (this.paused && isValue(frame)) (frame as OpenCLBuffer).addRef()
				return this.paused
			})

		console.log(`Created FFmpeg producer for path ${this.loadParams.url}`)
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

export class FFmpegProducerFactory implements ProducerFactory<FFmpegProducer> {
	private clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createProducer(id: number, loadParams: LoadParams, clJobs: ClJobs): FFmpegProducer {
		return new FFmpegProducer(id, loadParams, this.clContext, clJobs)
	}
}
