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
import { Frame, Filterer, filterer } from 'beamcoder'
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
	private readonly audioChannels: number
	private readonly chanProperties: ChanProperties
	private audFilterer: Filterer | null = null

	constructor(channel: number, context: nodenCLContext, chanProperties: ChanProperties) {
		this.channel = channel
		this.clContext = context
		this.vidField = 0
		this.audioChannels = 8
		this.chanProperties = chanProperties
		// This consumer removes interlace
		this.chanProperties.videoTimebase[1] /= 2

		// Turn off single field output flag
		//  - have to thump it twice to get it to change!!
		for (let x = 0; x < 2; ++x)
			Macadam.setDeviceConfig({
				deviceIndex: this.channel - 1,
				fieldFlickerRemoval: false
			})
		if (Macadam.getDeviceConfig(this.channel - 1).fieldFlickerRemoval)
			console.log(`Macadam consumer ${this.channel} - failed to turn off single field output mode`)
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

		const sampleRate = this.chanProperties.audioTimebase[1]
		const audLayout = `${this.audioChannels}c`
		this.audFilterer = await filterer({
			filterType: 'audio',
			inputParams: [
				{
					name: 'in0:a',
					timeBase: this.chanProperties.audioTimebase,
					sampleRate: sampleRate,
					sampleFormat: 's32',
					channelLayout: audLayout
				}
			],
			outputParams: [
				{
					name: 'out0:a',
					sampleRate: sampleRate,
					sampleFormat: 's32',
					channelLayout: audLayout
				}
			],
			filterSpec: `[in0:a] asetnsamples=n=1920:p=1 [out0:a]`
		})
		// console.log('\nMacadam consumer audio:\n', this.audFilterer.graph.dump())

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

	async waitHW(): Promise<void> {
		let delay = 0
		const hwTime = this.playback?.hardwareTime()
		if (hwTime) {
			const nominalDelayMs = (1000 * hwTime.ticksPerFrame) / hwTime.timeScale
			const targetTimeInFrame = nominalDelayMs * 0.05
			const curTimeInFrame = ((nominalDelayMs * hwTime.timeInFrame) / hwTime.ticksPerFrame) >>> 0
			delay = nominalDelayMs + targetTimeInFrame - curTimeInFrame
		}
		return new Promise((resolve) =>
			setTimeout(() => {
				const hwTimeNow = this.playback?.hardwareTime()
				if (hwTime && hwTimeNow) {
					const hwDelay = hwTimeNow.hardwareTime - hwTime.hardwareTime - hwTimeNow.ticksPerFrame
					if (hwDelay > hwTimeNow.ticksPerFrame * 0.9)
						console.log(
							`Macadam consumer ${this.channel} - frame may be delayed (${hwDelay} ticks)`
						)
				}
				resolve()
			}, delay)
		)
	}

	connect(
		mixAudio: RedioPipe<Frame | RedioEnd>,
		mixVideo: RedioPipe<OpenCLBuffer | RedioEnd>
	): void {
		this.vidField = 0

		const audFilter: Valve<Frame | RedioEnd, AudioBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame) && this.audFilterer) {
				const ff = await this.audFilterer.filter([{ name: 'in0:a', frames: [frame] }])
				const result: AudioBuffer[] = ff[0].frames.map((f) => ({
					buffer: f.data[0],
					timestamp: f.pts
				}))
				return result.length > 0 ? result : nil
			} else {
				this.audFilterer = null
				return nil
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
					console.log('One-legged zipper:', audBuf, vidBuf)
					if (vidBuf && isValue(vidBuf)) vidBuf.release()
					return Promise.resolve()
				}

				const atb = this.chanProperties.audioTimebase
				const ats = (audBuf.timestamp * atb[0]) / atb[1]
				const vtb = this.chanProperties.videoTimebase
				const vts = (vidBuf.timestamp * vtb[0]) / vtb[1]
				if (Math.abs(ats - vts) > 0.1)
					console.log('Audio and Video timestamp mismatch - aud:', ats, ' vid:', vts)

				await this.waitHW()
				this.playback?.displayFrame(vidBuf, audBuf.buffer)
				vidBuf.release()
				return Promise.resolve()
			} else {
				// this.clContext.logBuffers()
				this.playback?.stop()
				this.playback = null
				return Promise.resolve()
			}
		}

		mixVideo
			.valve(vidProcess, { bufferSizeMax: 1 })
			.valve(vidSaver, { bufferSizeMax: 1 })
			.zip(mixAudio.valve(audFilter, { bufferSizeMax: 1, oneToMany: true }), { bufferSizeMax: 1 })
			.spout(macadamSpout, { bufferSizeMax: 1 })
	}
}

export class MacadamConsumerFactory implements ConsumerFactory<MacadamConsumer> {
	private readonly clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createConsumer(channel: number, chanProperties: ChanProperties): MacadamConsumer {
		const consumer = new MacadamConsumer(channel, this.clContext, chanProperties)
		return consumer
	}
}
