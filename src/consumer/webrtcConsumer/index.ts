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
import { RedioPipe, RedioEnd, nil, isValue, Valve, Spout } from 'redioactive'
import { Frame, Filterer, filterer } from 'beamcoder'
import { ConsumerFactory, Consumer } from '../consumer'
import { FromRGBA } from '../../process/io'
import { Writer } from '../../process/rgba8'
import { ConfigParams, VideoFormat, DeviceConfig } from '../../config'
import { ClJobs } from '../../clJobQueue'
import {
	MediaStreamTrack,
	nonstandard as WebRTCNonstandard,
	RTCAudioData,
	RTCPeerConnection,
	RTCVideoFrame,
	MediaStream
} from 'wrtc'
import { PeerManager } from './peerManager'
const { RTCVideoSource, rgbaToI420, RTCAudioSource } = WebRTCNonstandard
import { v4 as uuidv4 } from 'uuid'

interface AudioBuffer {
	buffer: Buffer
	timestamp: number
}

export class WebRTCConsumer implements Consumer {
	private readonly clContext: nodenCLContext
	private readonly chanID: string
	private readonly rtcUuid: string
	private readonly params: ConfigParams
	private readonly format: VideoFormat
	private readonly clJobs: ClJobs
	private fromRGBA: FromRGBA | undefined
	private readonly audioOutChannels: number
	private readonly audioTimebase: number[]
	private readonly videoTimebase: number[]
	private audFilterer: Filterer | undefined
	private peerManager: PeerManager
	// private rtcVideoSources: Map<
	//  	RTCPeerConnection,
	//  	{ source: WebRTCNonstandard.RTCVideoSource; track: MediaStreamTrack }
	// > = new Map()
	private rtcVideoSource: WebRTCNonstandard.RTCVideoSource
	private rtcVideoTrack: MediaStreamTrack
	private rtcAudioSource: WebRTCNonstandard.RTCAudioSource
	private rtcAudioTrack: MediaStreamTrack
	private mediaStream: MediaStream

	constructor(
		context: nodenCLContext,
		chanID: string,
		params: ConfigParams,
		format: VideoFormat,
		clJobs: ClJobs
	) {
		this.clContext = context
		this.chanID = `${chanID} WebRTC`
		this.rtcUuid = `${chanID}-${uuidv4()}`
		this.params = params
		this.format = format
		this.clJobs = clJobs
		this.audioOutChannels = 2
		this.audioTimebase = [1, this.format.audioSampleRate]
		this.videoTimebase = [this.format.duration, this.format.timescale]

		if (Object.keys(this.params).length > 1)
			console.log('WebRTC consumer - unused params', this.params)

		this.rtcVideoSource = new RTCVideoSource()
		console.log(this.rtcVideoSource)
		this.rtcVideoTrack = this.rtcVideoSource.createTrack()
		console.log(this.rtcVideoTrack)
		this.rtcAudioSource = new RTCAudioSource()
		this.rtcAudioTrack = this.rtcAudioSource.createTrack()

		this.mediaStream = new MediaStream({ id: `phaneron` })
		this.mediaStream.addTrack(this.rtcVideoTrack)
		this.mediaStream.addTrack(this.rtcAudioTrack)

		this.peerManager = PeerManager.singleton()
		this.peerManager.registerSource({ id: this.rtcUuid, description: this.chanID, newPeer: this.newPeer, peerClose: this.peerClose})
			
		// this.peerManager.on('newPeer', this.newPeer)
		// this.peerManager.on('peerClose', this.peerClose)
	}

	// TODO - hook this up to be called frm somewhere
	async destroy(): Promise<void> {
		this.peerManager.destroySource(this.rtcUuid)
		this.rtcVideoTrack.stop()
	}

	async initialise(): Promise<void> {
		const sampleRate = this.audioTimebase[1]
		const audInLayout = `${this.format.audioChannels}c`
		const audOutLayout = `${this.audioOutChannels}c`
		// !!! Needs more work to handle 59.94 frame rates !!!
		const samplesPerFrame =
			(this.format.audioSampleRate * this.format.duration) / this.format.timescale
		console.log('samplesPerFrame', samplesPerFrame)
		const outSampleFormat = 's16'

		this.audFilterer = await filterer({
			filterType: 'audio',
			inputParams: [
				{
					name: 'in0:a',
					timeBase: this.audioTimebase,
					sampleRate: sampleRate,
					sampleFormat: 'fltp',
					channelLayout: audInLayout
				}
			],
			outputParams: [
				{
					name: 'out0:a',
					sampleRate: this.format.audioSampleRate,
					sampleFormat: outSampleFormat,
					channelLayout: audOutLayout
				}
			],
			filterSpec: `[in0:a] aformat=sample_fmts=${outSampleFormat}:sample_rates=${this.format.audioSampleRate}:channel_layouts=${audOutLayout},asetnsamples=n=${samplesPerFrame}:p=1 [out0:a]`
		})
		console.log('\nScreen consumer audio:\n', this.audFilterer.graph.dump())

		const width = this.format.width
		const height = this.format.height
		this.fromRGBA = new FromRGBA(
			this.clContext,
			'sRGB',
			new Writer(width, height, false),
			this.clJobs
		)
		await this.fromRGBA.init()

		// console.log(this.rtcVideoTrack.getConstraints())
		// console.log(this.rtcVideoTrack.getConstraints())

		console.log('Created WebRTC consumer')
		return Promise.resolve()
	}

	newPeer = ({ peerConnection }: { peerConnection: RTCPeerConnection }) => {
		// const source = new RTCVideoSource()
		// const track = source.createTrack()
		peerConnection.addTrack(this.rtcVideoTrack, this.mediaStream)
		peerConnection.addTrack(this.rtcAudioTrack, this.mediaStream)
		// this.rtcVideoSources.set(peerConnection, { source: this.rtcVideoSource, track: this.rtcVideoTrack })
	}
	peerClose = ({}: { peerConnection: RTCPeerConnection }) => {
		// const descriptor = this.rtcVideoSources.get(peerConnection)
		// if (descriptor) {
		// 	// descriptor.track.stop()
		// 	this.rtcVideoSources.delete(peerConnection)
		// }
	}

	connect(
		combineAudio: RedioPipe<Frame | RedioEnd>,
		combineVideo: RedioPipe<OpenCLBuffer | RedioEnd>
	): void {
		const audFilter: Valve<Frame | RedioEnd, AudioBuffer | RedioEnd> = async (frame) => {
			// console.log('Hello from aud filterer', isValue(frame), isValue(frame) && { 
			// 	format: frame.format, sample_rate: frame.sample_rate,
			// 	layout: frame.channel_layout, channels: frame.channels })
			if (isValue(frame)) {
				if (!this.audFilterer) return nil
				const audFilt = this.audFilterer as Filterer
				const ff = await audFilt.filter([{ name: 'in0:a', frames: [frame] }])
				// console.log(ff)
				const result: AudioBuffer[] = ff[0].frames.map((f) => ({
					buffer: f.data[0],
					timestamp: f.pts
				}))
				// console.log("<<<", result.map(x => x.buffer.length))
				return result.length > 0 ? result : nil
			} else {
				return frame
			}
		}

		const vidProcess: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			// console.log('Hello from vid process', isValue(frame))
			if (isValue(frame)) {
				const fromRGBA = this.fromRGBA as FromRGBA
				const clDests = await fromRGBA.createDests()
				clDests.forEach((d) => (d.timestamp = frame.timestamp))
				fromRGBA.processFrame(this.chanID, frame, clDests, 0)
				await this.clJobs.runQueue({ source: this.chanID, timestamp: frame.timestamp })
				return clDests[0]
			} else {
				return frame
			}
		}

		const vidSaver: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			// console.log('Hello from vid saver', isValue(frame))
			if (isValue(frame)) {
				const fromRGBA = this.fromRGBA as FromRGBA
				await fromRGBA.saveFrame(frame, this.clContext.queue.unload)
				await this.clContext.waitFinish(this.clContext.queue.unload)
				return frame
			} else {
				return frame
			}
		}

		const screenSpout: Spout<
			[(OpenCLBuffer | RedioEnd | undefined)?, (AudioBuffer | RedioEnd | undefined)?] | RedioEnd
		> = async (frame) => {
			// console.log('Hello from screen spout', isValue(frame))
			if (isValue(frame)) {
				const vidBuf = frame[0]
				const audBuf = frame[1]
				if (!(audBuf && isValue(audBuf) && vidBuf && isValue(vidBuf))) {
					console.log('One-legged zipper:', audBuf, vidBuf)
					if (vidBuf && isValue(vidBuf)) vidBuf.release()
					return Promise.resolve()
				}

				const atb = this.audioTimebase
				const ats = (audBuf.timestamp * atb[0]) / atb[1]
				const vtb = this.videoTimebase
				const vts = (vidBuf.timestamp * vtb[0]) / vtb[1]
				if (Math.abs(ats - vts) > 0.1)
					console.log('WebRTC audio and video timestamp mismatch - aud:', ats, ' vid:', vts)

				// const write = (_data: Buffer, cb: () => void) => {
				// 	// if (
				// 	// !this.audioOut.write(data, (err: Error | null | undefined) => {
				// 	// 	if (err) console.log('Write Error:', err)
				// 	// })
				// 	// ) {
				// 	// this.audioOut.once('drain', cb)
				// 	// } else {
				// 	process.nextTick(cb)
				// 	// }
				// }

				return new Promise((resolve) => {
					const frame = Buffer.alloc(this.format.width * this.format.height * 4)
					vidBuf.copy(frame)
					vidBuf.release()

					const i420frame: RTCVideoFrame = {
						width: this.format.width,
						height: this.format.height,
						data: new Uint8ClampedArray(1.5 * this.format.width * this.format.height)
					}
					rgbaToI420(
						{
							width: this.format.width,
							height: this.format.height,
							data: new Uint8ClampedArray(frame)
						},
						i420frame
					)

					// console.log('Calling rtcVideoSource.onFrame()', i420frame)
					this.rtcVideoSource.onFrame(i420frame)

					// new Int16Array(
					// 	floatBuffer,
					// 	(i * floatBuffer.length) / 4,
					// 	floatBuffer.length / 4

					// const samples =
					// 	(this.format.audioSampleRate * this.format.duration) / this.format.timescale
					// console.log(`SAMPLES: ${samples}`)
					// console.log(`CHANNELS: ${this.format.audioChannels}`)
					// console.log(`BUFFER: ${audBuf.buffer.length}`)
					for (let i = 0; i < 2; i++) {
						const start = (i * audBuf.buffer.length) / 2
						const end = start + audBuf.buffer.length / 2
						const slicedAudio = audBuf.buffer.buffer.slice(start, end)
						// console.log(">>>", slicedAudio.byteLength)
						const audioBuffer: RTCAudioData = {
							samples: slicedAudio,
							sampleRate: this.format.audioSampleRate,
							// // bitsPerSample default is 16
							bitsPerSample: 16,
							channelCount: 2,
							// number of frames
							numberOfFrames: this.format.audioSampleRate / 100
						}
						this.rtcAudioSource.onData(audioBuffer)
					}

					resolve()

					// write(audBuf.buffer, () => {
					// 	vidBuf.release()
					// 	resolve()
					// })
				})
			} else {
				// this.clContext.logBuffers()
				return Promise.resolve()
			}
		}

		// this.audioOut.start()

		combineVideo
			.valve(vidProcess)
			// .doto(x => console.log(x))
			.valve(vidSaver)
			// .doto(x => console.log(x))
			.zip(combineAudio.valve(audFilter, { oneToMany: true }))
			// .doto(x => console.log(x))
			.spout(screenSpout)
	}
}

export class WebRTCConsumerFactory implements ConsumerFactory<WebRTCConsumer> {
	private readonly clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createConsumer(
		chanID: string,
		params: ConfigParams,
		format: VideoFormat,
		_device: DeviceConfig,
		clJobs: ClJobs
	): WebRTCConsumer {
		const consumer = new WebRTCConsumer(this.clContext, chanID, params, format, clJobs)
		return consumer
	}
}
