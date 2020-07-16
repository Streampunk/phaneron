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
import { RedioPipe, RedioEnd, nil, isValue, isEnd } from 'redioactive'
import * as Macadam from 'macadam'
import { FromRGBA } from '../process/io'
import { Writer } from '../process/v210'
import { Frame } from 'beamcoder'
import { ChanProperties } from '../chanLayer'

export class MacadamConsumer implements Consumer {
	private readonly channel: number
	private clContext: nodenCLContext
	private playback: Macadam.PlaybackChannel | null = null
	private fromRGBA: FromRGBA | null = null
	private clDests: OpenCLBuffer[] = []
	private audField: number
	private vidField: number
	private frameNumber: number
	private readonly latency: number
	private readonly audioChannels = 2
	private chanProperties: ChanProperties | null = null
	private curAudBuf: Buffer | null = null
	private lastAudio: Buffer[] = []
	private vidTimestamp = 0

	constructor(channel: number, context: nodenCLContext) {
		this.channel = channel
		this.clContext = context
		this.audField = 0
		this.vidField = 0
		this.frameNumber = 0
		this.latency = 3
	}

	async initialise(chanProperties: ChanProperties): Promise<boolean> {
		this.chanProperties = chanProperties
		// This consumer removes interlace
		this.chanProperties.videoTimebase[1] /= 2

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

	wait = async (timeout: number): Promise<void> =>
		new Promise((resolve) => setTimeout(() => resolve(), timeout))

	connect(
		mixAudio: RedioPipe<Frame | RedioEnd> | undefined,
		mixVideo: RedioPipe<OpenCLBuffer | RedioEnd>
	): void {
		this.audField = 0
		this.vidField = 0
		this.frameNumber = 0

		if (mixAudio) {
			mixAudio.spout(
				async (frame: Frame | RedioEnd) => {
					if (isValue(frame)) {
						const tb = this.chanProperties?.audioTimebase as number[]
						const audTimestamp = (frame.pts * tb[0]) / tb[1]
						// console.log('Audio spout:', audTimestamp, ' samples:', frame.nb_samples)
						while (audTimestamp > this.vidTimestamp) await this.wait(10)
						const frameBytes = frame.nb_samples * this.audioChannels * 4
						if (this.audField === 0) this.curAudBuf = Buffer.alloc(frameBytes * 2, 0)
						const destStart = this.audField === 0 ? 0 : frameBytes
						frame.data[0].copy(this.curAudBuf as Buffer, destStart, 0, frameBytes)
						if (this.audField === 1 && this.curAudBuf) this.lastAudio.push(this.curAudBuf)
						this.audField = 1 - this.audField
						return Promise.resolve()
					} else {
						return Promise.resolve()
					}
				},
				{ bufferSizeMax: 2, oneToMany: false }
			)
		}

		const vidProcess = mixVideo.valve<OpenCLBuffer | RedioEnd>(
			async (frame: OpenCLBuffer | RedioEnd) => {
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
			},
			{ bufferSizeMax: 1, oneToMany: false }
		)

		const vidSaver = vidProcess.valve<OpenCLBuffer | RedioEnd>(
			async (frame: OpenCLBuffer | RedioEnd) => {
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
			},
			{ bufferSizeMax: 1, oneToMany: false }
		)

		vidSaver.spout(
			async (frame: OpenCLBuffer | RedioEnd) => {
				if (isValue(frame)) {
					const tb = this.chanProperties?.videoTimebase as number[]
					const timestamp = (frame.timestamp * tb[0]) / tb[1]
					this.vidTimestamp = timestamp
					// console.log('Video spout:', timestamp, ' pts:', frame.timestamp)
					const audioBuf = this.lastAudio.pop()
					if (audioBuf) {
						this.playback?.schedule({
							video: frame,
							audio: audioBuf,
							time: 1000 * this.frameNumber
						})
						if (this.frameNumber === this.latency) this.playback?.start({ startTime: 0 })
						if (this.frameNumber >= this.latency)
							await this.playback?.played((this.frameNumber - this.latency) * 1000)
						this.frameNumber++
					}

					frame.release()
					return Promise.resolve()
				} else {
					if (isEnd(frame)) this.playback?.stop()
					this.clContext.logBuffers()
					return Promise.resolve()
				}
			},
			{ bufferSizeMax: 2, oneToMany: false }
		)
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

	createConsumer(channel: number): MacadamConsumer {
		const oldConsumer = this.consumers.get(channel)
		if (oldConsumer) oldConsumer.release()
		this.consumers.delete(channel)

		const consumer = new MacadamConsumer(channel, this.clContext)
		this.consumers.set(channel, consumer)
		return consumer
	}
}
