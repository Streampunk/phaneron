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

import { ProducerFactory, Producer, InvalidProducerError, ProducerConfig } from './producer'
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
	frame,
	FilterContext
} from 'beamcoder'
import redio, {
	RedioPipe,
	nil,
	end,
	isValue,
	RedioEnd,
	Generator,
	Valve,
	RedioNil
} from 'redioactive'
import { ClJobs } from '../clJobQueue'
import { LoadParams } from '../chanLayer'
import { VideoFormat } from '../config'
import { ToRGBA } from '../process/io'
import { Reader as nv12Reader } from '../process/nv12'
import { Reader as yuv422p10Reader } from '../process/yuv422p10'
import { Reader as yuv422p8Reader } from '../process/yuv422p8'
import { Reader as yuv420pReader } from '../process/yuv420p'
import { Reader as v210Reader } from '../process/v210'
import { Reader as rgba8Reader } from '../process/rgba8'
import { Reader as bgra8Reader } from '../process/bgra8'
import Yadif from '../process/yadif'
import { PackImpl } from '../process/packer'
import { SourcePipes } from '../routeSource'

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
	private readonly config: ProducerConfig
	private demuxer: Demuxer | null = null
	private audSource: RedioPipe<Frame | RedioEnd> | undefined
	private vidSource: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private srcFormat: VideoFormat | undefined
	private numForks = 0
	private paused = true
	private running = true
	private volFilter: FilterContext | undefined

	constructor(
		id: number,
		loadParams: LoadParams,
		context: nodenCLContext,
		clJobs: ClJobs,
		consumerFormat: VideoFormat,
		config: ProducerConfig
	) {
		this.sourceID = `P${id} FFmpeg ${loadParams.url} L${loadParams.layer}`
		this.loadParams = loadParams
		this.clContext = context
		this.clJobs = clJobs
		this.consumerFormat = consumerFormat
		this.config = config
	}

	async initialise(): Promise<void> {
		try {
			this.demuxer = await demuxer(this.loadParams.url)
		} catch (err) {
			if (typeof err === 'string') throw new InvalidProducerError(err)
			console.log(
				`Error in FFmpeg producer initialise: ${
					err instanceof Error ? err.message : 'Unknown error'
				}`
			)
			throw err
		}

		const audioStreams: Stream[] = []
		const videoStreams: Stream[] = []
		const audioIndexes: number[] = []
		const videoIndexes: number[] = []
		const numVidChannels = 1
		const audioPackets: Packet[] = []
		const videoPackets: Packet[] = []
		let audioDecoder: Decoder | undefined
		let videoDecoder: Decoder | undefined

		const demuxAudioStreams = this.demuxer.streams.filter((s) => s.codecpar.codec_type === 'audio')
		let astreams = this.loadParams.streams === undefined ? demuxAudioStreams : []
		if (this.loadParams.streams && this.loadParams.streams.audio)
			astreams = demuxAudioStreams.filter(
				(_s, i) =>
					this.loadParams.streams?.audio?.find((loadIndex) => loadIndex === i) !== undefined
			)

		const demuxVideoStreams = this.demuxer.streams.filter((s) => s.codecpar.codec_type === 'video')
		let vstreams = this.loadParams.streams === undefined ? demuxVideoStreams : []
		if (this.loadParams.streams && this.loadParams.streams.video)
			vstreams = demuxVideoStreams.filter(
				(_s, i) =>
					this.loadParams.streams?.video?.find((loadIndex) => loadIndex === i) !== undefined
			)

		let monoStreams = true
		astreams.forEach((s) => {
			if (monoStreams) {
				// allow mxf-style mono channel per stream or a single stream of multiple channels
				s.discard = 'default'
				audioStreams.push(s)
				audioIndexes.push(s.index)
				if (!audioDecoder)
					audioDecoder = decoder({ demuxer: this.demuxer as Demuxer, stream_index: s.index })
				monoStreams &&= s.codecpar.channel_layout === 'mono'
			} else {
				s.discard = 'all'
			}
		})

		vstreams.forEach((s) => {
			if (videoStreams.length < numVidChannels) {
				s.discard = 'default'
				videoStreams.push(s)
				videoIndexes.push(s.index)
				if (!videoDecoder) {
					videoDecoder = decoder(
						Object.assign(
							{ demuxer: this.demuxer as Demuxer, stream_index: s.index },
							this.config.ffmpeg.videoDecoder
						)
					)
				}
			} else {
				s.discard = 'all'
			}
		})

		const primaryIndex = videoIndexes.length ? videoIndexes[0] : audioIndexes[0]
		const start = this.loadParams.seek ? this.loadParams.seek : 0
		if (start > 0) await this.demuxer.seek({ stream_index: primaryIndex, frame: start })
		const maxFrame = this.loadParams.length ? this.loadParams.length : Number.MAX_SAFE_INTEGER
		const loop = this.loadParams.loop ? this.loadParams.loop : false

		let silentFrame: Frame | null = null
		let audFilterer: Filterer | null = null
		const audStream = audioStreams[0]
		let srcAudChannels = monoStreams ? audioStreams.length : audStream.codecpar.channels

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
				for (let c = 0; c < srcAudChannels; ++c) filtStr += `[in${c}:a]`
				filtStr += `amerge=inputs=${srcAudChannels}, `
			} else filtStr += `[in0:a]`
			filtStr += `asetnsamples=n=1024:p=1, volume=0.0:eval=frame:precision=float[out0:a]`
			// console.log(`ffmpegProducer:\n${filtStr}`)

			audFilterer = await filterer({
				filterType: 'audio',
				inputParams: inParams,
				outputParams: [
					{
						name: 'out0:a',
						sampleRate: this.consumerFormat.audioSampleRate,
						sampleFormat: 'fltp',
						channelLayout: `${srcAudChannels}c`
					}
				],
				filterSpec: filtStr
			})
		} else {
			srcAudChannels = 1
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
						channelLayout: `${srcAudChannels}c`
					}
				],
				filterSpec: '[in0:a]asetpts=N/SR/TB, volume=0.0:eval=frame:precision=float[out0:a]'
			})
		}
		// console.log('\nFFmpeg producer audio:\n', audFilterer.graph.dump())
		this.volFilter = audFilterer.graph.filters.find((f) => f.filter.name === 'volume')

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
			if (vidStream.codecpar.sample_aspect_ratio[0] && vidStream.codecpar.sample_aspect_ratio[1]) {
				squareWidth =
					(width * vidStream.codecpar.sample_aspect_ratio[0]) /
					vidStream.codecpar.sample_aspect_ratio[1]
			}
			squareHeight = height
			const fieldOrder = vidStream.codecpar.field_order
			progressive = fieldOrder === 'progressive'
			if (!progressive && vidStream.avg_frame_rate[0] / vidStream.avg_frame_rate[1] > 30) {
				console.log('Framerate greater than 30fps - forcing to progressive')
				progressive = true
			}
			vidTimescale = vidStream.avg_frame_rate[0] * (progressive ? 1 : 2)
			vidDuration = vidStream.avg_frame_rate[1]

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

		let packetFrame = 0
		const demux: Generator<Packet | RedioEnd> = async () => {
			let packet: Packet | RedioEnd = end
			if (this.demuxer && this.running) {
				packet = await this.demuxer.read()
				if (packet && packet.stream_index === primaryIndex) {
					packetFrame++
					if (loop && packetFrame === maxFrame) {
						await this.demuxer.seek({ stream_index: primaryIndex, frame: start })
						packetFrame = 0
					}
				}
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
				if (!(this.running && audioDecoder)) return nil
				const decodedFrames = await audioDecoder.decode(packets)
				return decodedFrames.frames.map((f, i) => ({ name: `in${i}:a`, frames: [f] }))
			} else {
				return packets
			}
		}

		const audFilter: Valve<AudioChannel[] | RedioEnd, Frame | RedioEnd> = async (frames) => {
			if (isValue(frames)) {
				if (!(this.running && audFilterer)) return nil
				const ff = await audFilterer.filter(frames)
				return ff[0] && ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				return frames
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

		const makevidLoader = async (format: string) => {
			let filterOutputFormat = format
			let readImpl: PackImpl
			let needFilter = false // !!! needs more - eg fps mismatch?
			switch (format) {
				case 'nv12':
					console.log('Using native nv12 loader')
					readImpl = new nv12Reader(width, height)
					break
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
						needFilter = true
					} else if (vidStream.codecpar.format.includes('rgb')) {
						console.log(`Non-native loader for ${vidStream.codecpar.format} - using rgba8`)
						filterOutputFormat = 'rgba'
						readImpl = new rgba8Reader(width, height)
						needFilter = true
					} else
						throw new Error(
							`Unsupported video format '${vidStream.codecpar.format}' from FFmpeg decoder`
						)
			}
			toRGBA = new ToRGBA(this.clContext, '709', '709', readImpl, this.clJobs)
			await toRGBA.init()
			const chanTb = [this.consumerFormat.duration, this.consumerFormat.timescale]
			if (needFilter) {
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
					filterSpec: `fps=fps=${chanTb[1] / (progressive ? 1 : 2)}/${chanTb[0]}`
				})
				// console.log('\nFFmpeg producer video:\n', vidFilterer.graph.dump())
			}
		}

		const vidDecode: Valve<Packet[] | RedioEnd, Frame | RedioEnd> = async (packets) => {
			if (isValue(packets)) {
				if (!(this.running && videoDecoder)) return nil

				let result: Frame[] | RedioNil = nil
				const frm = await videoDecoder.decode(packets)
				if (frm.frames.length > 0) {
					if (!toRGBA) {
						const decodedFormat = videoDecoder.sw_pix_fmt
							? videoDecoder.sw_pix_fmt
							: vidStream.codecpar.format
						await makevidLoader(decodedFormat)
					}
					result = frm.frames
				}
				return result
			} else {
				return packets
			}
		}

		const vidFilter: Valve<Frame | RedioEnd, Frame | RedioEnd> = async (decFrame) => {
			if (isValue(decFrame)) {
				if (!vidFilterer) return decFrame
				if (!this.running) return nil
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
				const clSources = await convert.createSources(
					`${this.sourceID} ${progressive ? frame.pts : frame.pts * 2}`
				)
				// const now = process.hrtime()
				// const nowms = now[0] * 1000.0 + now[1] / 1000000.0
				clSources.forEach((s) => {
					// s.loadstamp = nowms
					s.timestamp = progressive ? frame.pts : frame.pts * 2
				})
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
				const clDest = await convert.createDest(
					{ width: width, height: height },
					`${this.sourceID} ${clSources[0].timestamp}`
				)
				// clDest.loadstamp = clSources[0].loadstamp
				clDest.timestamp = clSources[0].timestamp
				convert.processFrame(this.sourceID, clSources, clDest)
				return clDest
			} else {
				toRGBA?.finish()
				toRGBA = null
				return clSources
			}
		}

		let curFrame = 0
		const vidDeint: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				if (!this.running) {
					frame.release()
					return nil
				}
				const yadifDests: OpenCLBuffer[] = []
				await yadif?.processFrame(frame, yadifDests, this.sourceID)

				// duplicate frame eg if source is 25fps and consumer is 50fps
				if (
					this.srcFormat &&
					progressive &&
					this.consumerFormat.timescale / vidTimescale === 2 &&
					yadifDests.length === 1
				) {
					const dupDest = yadifDests[0]
					dupDest.addRef()
					yadifDests.push(dupDest)
				}

				if (!loop && maxFrame === curFrame) this.release()
				curFrame += yadifDests.length

				yadifDests.forEach((d) => {
					for (let f = 1; f < this.numForks; ++f) d.addRef()
				})

				return yadifDests.length > 0 ? yadifDests : nil
			} else {
				yadif?.release()
				yadif = null
				this.running = false
				return frame
			}
		}

		let blackCurFrame = 0
		const blackPipe: RedioPipe<OpenCLBuffer | RedioEnd> = redio(
			async () => {
				if (this.running) {
					if (!loop && maxFrame === blackCurFrame) this.release()
					if (black) black.timestamp = blackCurFrame
					blackCurFrame++
					black?.addRef()
					return black
				} else return end
			},
			{ bufferSizeMax: 1 }
		)

		this.srcFormat = {
			name: 'ffmpeg',
			fields: 1,
			width: width,
			height: height,
			squareWidth: squareWidth,
			squareHeight: squareHeight,
			timescale: vidTimescale,
			duration: vidDuration,
			audioSampleRate: this.consumerFormat.audioSampleRate,
			audioChannels: srcAudChannels
		}

		const ffPackets = redio(demux, { bufferSizeMax: this.demuxer.streams.length * 2 })

		if (audioStreams.length) {
			this.audSource = ffPackets
				.fork({ bufferSizeMax: 10 })
				.valve(audPacketFilter)
				.valve(audDecode, { bufferSizeMax: 2 })
				.pause(() => this.paused && this.running)
				.valve(audFilter, { oneToMany: true })
		} else {
			this.audSource = redio(silence, { bufferSizeMax: 2 })
				.pause(() => this.paused && this.running)
				.valve(audFilter, { oneToMany: true })
		}

		if (videoStreams.length) {
			this.vidSource = ffPackets
				.fork({ bufferSizeMax: 10 })
				.valve(vidPacketFilter)
				.valve(vidDecode, { oneToMany: true, bufferSizeMax: 2 })
				.valve(vidFilter, { oneToMany: true })
				.valve(vidLoader, { bufferSizeMax: 1 })
				.valve(vidProcess)
				.valve(vidDeint, { oneToMany: true })
				.pause((frame) => {
					if (!this.running) {
						frame = nil
						return false
					}
					if (this.paused && isValue(frame)) (frame as OpenCLBuffer).addRef()
					return this.paused
				})
		} else {
			// eslint-disable-next-line prettier/prettier
			this.vidSource = blackPipe
				.pause(() => this.paused && this.running)
		}

		console.log(`Created FFmpeg producer for path ${this.loadParams.url}`)
	}

	getSourcePipes(): SourcePipes {
		if (!(this.audSource && this.vidSource && this.srcFormat))
			throw new Error(`FFmpeg producer failed to find source pipes for route`)

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

export class FFmpegProducerFactory implements ProducerFactory<FFmpegProducer> {
	private clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createProducer(
		id: number,
		loadParams: LoadParams,
		clJobs: ClJobs,
		consumerFormat: VideoFormat,
		config: ProducerConfig
	): FFmpegProducer {
		return new FFmpegProducer(id, loadParams, this.clContext, clJobs, consumerFormat, config)
	}
}
