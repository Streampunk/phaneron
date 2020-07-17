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
import { ConsumerFactory, Consumer } from './consumer'
import { RedioPipe, RedioEnd, nil, isValue, isEnd, Valve, Spout } from 'redioactive'
import * as Macadam from 'macadam'
import { FromRGBA } from '../process/io'
import { Writer } from '../process/v210'
import { Frame } from 'beamcoder'
import { ChanProperties } from '../chanLayer'

interface AudioBuffer {
	buffer: Buffer
	timestamp: number
}

export class MacadamConsumer implements Consumer {
	private readonly channel: number
	private clContext: nodenCLContext
	private playback: Macadam.PlaybackChannel | null = null
	private fromRGBA: FromRGBA | null = null
	private clDests: OpenCLBuffer[] = []
	private vidField: number
	private frameNumber: number
	private readonly latency: number
	private readonly audioChannels: number
	private readonly frameSamples: number
	private readonly chanProperties: ChanProperties
	private curAudBufs: Buffer[] = []
	private remAudBuf: AudioBuffer
	private audBufOff = 0
	private remBufBytes = 0

	constructor(channel: number, context: nodenCLContext, chanProperties: ChanProperties) {
		this.channel = channel
		this.clContext = context
		this.vidField = 0
		this.frameNumber = 0
		this.latency = 3
		this.audioChannels = 8
		this.frameSamples = 1920
		this.chanProperties = chanProperties
		// This consumer removes interlace
		this.chanProperties.videoTimebase[1] /= 2

		const atb = this.chanProperties.audioTimebase
		const vtb = this.chanProperties.videoTimebase
		this.frameSamples = (vtb[0] * atb[1]) / (vtb[1] * atb[0])
		this.remAudBuf = { buffer: Buffer.alloc(0), timestamp: 0 }
	}

	async initialise(): Promise<boolean> {
		this.playback = await Macadam.playback({
			deviceIndex: this.channel - 1,
			channels: this.audioChannels,
			sampleRate: Macadam.bmdAudioSampleRate48kHz,
			sampleType: Macadam.bmdAudioSampleType32bitInteger,
			displayMode: Macadam.bmdModeHD1080i50,
			pixelFormat: Macadam.bmdFormat10BitYUV
		})

		this.fromRGBA = new FromRGBA(
			this.clContext,
			'709',
			new Writer(
				this.playback.width,
				this.playback.height,
				this.playback.fieldDominance != 'progressiveFrame'
			)
		)
		await this.fromRGBA.init()

		console.log(`Created Macadam consumer for Blackmagic id: ${this.channel - 1}`)
		return this.playback !== null
	}

	connect(
		mixAudio: RedioPipe<Frame | RedioEnd>,
		mixVideo: RedioPipe<OpenCLBuffer | RedioEnd>
	): void {
		this.vidField = 0
		this.frameNumber = 0

		const audioFramer: Valve<Frame | RedioEnd, AudioBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				if (frame.channels !== this.audioChannels) console.log('Macadam channels mismatch')
				const result: AudioBuffer[] = []
				const curFrameBytes = frame.nb_samples * this.audioChannels * 4
				const frameBytes = this.frameSamples * this.audioChannels * 4

				if (this.remBufBytes > 0) {
					let copyBytes = this.remBufBytes
					if (copyBytes + this.audBufOff > frameBytes) copyBytes = frameBytes - this.audBufOff
					this.curAudBufs.push(this.remAudBuf.buffer.slice(0, copyBytes))
					if (copyBytes + this.audBufOff === frameBytes) {
						result.push({
							buffer: Buffer.concat(this.curAudBufs),
							timestamp: this.remAudBuf.timestamp
						})
						this.audBufOff = 0
						this.curAudBufs = []
					} else this.audBufOff += copyBytes

					this.remBufBytes -= copyBytes
					if (this.remBufBytes > 0) {
						this.remAudBuf.buffer = this.remAudBuf.buffer.slice(copyBytes)
						this.remAudBuf.timestamp += copyBytes / (this.audioChannels * 4)
					}
				}

				let copyBytes = curFrameBytes
				if (copyBytes + this.audBufOff > frameBytes) {
					copyBytes = frameBytes - this.audBufOff
					this.remAudBuf = {
						buffer: frame.data[0].slice(copyBytes),
						timestamp: frame.pts + copyBytes / (this.audioChannels * 4)
					}
					this.remBufBytes = curFrameBytes + this.audBufOff - frameBytes
				}
				this.curAudBufs.push(frame.data[0].slice(0, copyBytes))

				if (copyBytes + this.audBufOff === frameBytes) {
					result.push({
						buffer: Buffer.concat(this.curAudBufs),
						timestamp: frame.pts - this.audBufOff / (this.audioChannels * 4)
					})
					this.audBufOff = 0
					this.curAudBufs = []
				} else this.audBufOff += copyBytes

				return result.length > 0 ? result : nil
			} else {
				return frame
			}
		}

		const vidProcess: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const fromRGBA = this.fromRGBA as FromRGBA
				if (this.vidField === 0) {
					this.clDests = await fromRGBA.createDests()
					this.clDests.forEach((d) => (d.timestamp = (frame.timestamp / 2) << 0))
				}
				const queue = this.clContext.queue.process
				const interlace = 0x1 | (this.vidField << 1)
				await fromRGBA.processFrame(frame, this.clDests, queue, interlace)
				await this.clContext.waitFinish(queue)
				frame.release()
				this.vidField = 1 - this.vidField
				return this.vidField === 1 ? nil : this.clDests[0]
			} else {
				return frame
			}
		}

		const vidSaver: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const fromRGBA = this.fromRGBA as FromRGBA
				await fromRGBA.saveFrame(frame, this.clContext.queue.unload)
				await this.clContext.waitFinish(this.clContext.queue.unload)
				return frame
			} else {
				if (isEnd(frame)) {
					this.clDests.forEach((d) => d.release())
					this.fromRGBA = null
				}
				return frame
			}
		}

		const macadamSpout: Spout<
			[(OpenCLBuffer | RedioEnd | undefined)?, (AudioBuffer | RedioEnd | undefined)?] | RedioEnd
		> = async (frame) => {
			if (isValue(frame)) {
				const vidBuf = frame[0]
				const audBuf = frame[1]
				if (!(audBuf && isValue(audBuf) && vidBuf && isValue(vidBuf))) {
					if (vidBuf && isValue(vidBuf)) vidBuf.release()
					return Promise.resolve()
				}

				// const atb = this.chanProperties.audioTimebase
				// const audTimestamp = (audBuf.timestamp * atb[0]) / atb[1]
				// const vtb = this.chanProperties.videoTimebase
				// const vidTimestamp = (vidBuf.timestamp * vtb[0]) / vtb[1]
				// console.log('aud:', audTimestamp, ' vid:', vidTimestamp)

				this.playback?.schedule({
					video: vidBuf as OpenCLBuffer,
					audio: audBuf.buffer,
					time: 1000 * this.frameNumber
				})
				if (this.frameNumber === this.latency) this.playback?.start({ startTime: 0 })
				if (this.frameNumber >= this.latency)
					await this.playback?.played((this.frameNumber - this.latency) * 1000)
				this.frameNumber++
				vidBuf.release()
				return Promise.resolve()
			} else {
				if (isEnd(frame)) this.playback?.stop()
				this.clContext.logBuffers()
				return Promise.resolve()
			}
		}

		mixVideo
			.valve(vidProcess, { bufferSizeMax: 1 })
			.valve(vidSaver, { bufferSizeMax: 1 })
			.zip(mixAudio.valve(audioFramer, { bufferSizeMax: 1, oneToMany: true }), { bufferSizeMax: 1 })
			.spout(macadamSpout, { bufferSizeMax: 2 })
	}

	release(): void {
		// this.playback?.stop()
		// this.playback = null
	}
}

export class MacadamConsumerFactory implements ConsumerFactory<MacadamConsumer> {
	private readonly clContext: nodenCLContext
	private readonly consumers: Map<number, MacadamConsumer>

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
		this.consumers = new Map<number, MacadamConsumer>()
	}

	createConsumer(channel: number, chanProperties: ChanProperties): MacadamConsumer {
		const oldConsumer = this.consumers.get(channel)
		if (oldConsumer) oldConsumer.release()
		this.consumers.delete(channel)

		const consumer = new MacadamConsumer(channel, this.clContext, chanProperties)
		this.consumers.set(channel, consumer)
		return consumer
	}
}
