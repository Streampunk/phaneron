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
import { RedioEnd, nil, end, isValue, Valve, Spout } from 'redioactive'
import * as Macadam from 'macadam'
import { FromRGBA } from '../process/io'
import { Writer } from '../process/v210'
import { Frame, Filterer, filterer } from 'beamcoder'
import { ConfigParams, VideoFormat, DeviceConfig } from '../config'
import { SourcePipes } from '../routeSource'
import { ClJobs } from '../clJobQueue'

interface DecklinkConfig extends DeviceConfig {
	keyDeviceIndex: number
	embeddedAudio: boolean
	latency: 'normal' | 'low' | 'default'
	keyer: 'external' | 'external_separate_device' | 'internal' | 'default'
	keyOnly: boolean
	bufferDepth: number
}

const decklinkDefaults: DecklinkConfig = {
	name: 'decklink',
	deviceIndex: 1,
	keyDeviceIndex: 0,
	embeddedAudio: false,
	latency: 'normal',
	keyer: 'external',
	keyOnly: false,
	bufferDepth: 3
}

interface AudioBuffer {
	buffer: Buffer
	timestamp: number
}

const bmdSampleRates = new Map([[48000, Macadam.bmdAudioSampleRate48kHz]])
const bmdDisplayMode = new Map([
	['720p5000', Macadam.bmdModeHD1080p50],
	['1080i5000', Macadam.bmdModeHD1080i50],
	['1080p5000', Macadam.bmdModeHD1080p50]
])

export class MacadamConsumer implements Consumer {
	private readonly clContext: nodenCLContext
	private readonly chanID: string
	private readonly params: ConfigParams
	private readonly format: VideoFormat
	private readonly device: DeviceConfig
	private readonly clJobs: ClJobs
	private readonly logTimings = false
	private playback: Macadam.PlaybackChannel | null = null
	private fromRGBA: FromRGBA | null = null
	private clDests: OpenCLBuffer[] = []
	private vidField: number
	private readonly audioChannels: number
	private readonly audioTimebase: number[]
	private readonly videoTimebase: number[]
	private audFilterer: Filterer | null = null
	private sourcePipes: SourcePipes | undefined

	constructor(
		context: nodenCLContext,
		chanID: string,
		params: ConfigParams,
		format: VideoFormat,
		device: DeviceConfig,
		clJobs: ClJobs
	) {
		this.clContext = context
		this.params = params
		this.format = format
		this.device = device
		this.chanID = `${chanID} decklink-${this.device.deviceIndex - 1}`
		this.clJobs = clJobs
		this.vidField = 0
		this.audioChannels = this.format.audioChannels
		this.audioTimebase = [1, this.format.audioSampleRate]
		this.videoTimebase = [this.format.duration, this.format.timescale / this.format.fields]

		if (Object.keys(this.params).length > 1)
			console.log('Macadam consumer - unused params', this.params)

		const defaultConfig: DeviceConfig = { name: 'decklink', deviceIndex: 0 }
		this.device = Object.assign(defaultConfig, { ...decklinkDefaults }, this.device)

		// Turn off single field output flag
		//  - have to thump it twice to get it to change!!
		const macadamIndex = this.device.deviceIndex - 1
		for (let x = 0; x < 2; ++x)
			Macadam.setDeviceConfig({
				deviceIndex: macadamIndex,
				fieldFlickerRemoval: false
			})
		if (Macadam.getDeviceConfig(macadamIndex).fieldFlickerRemoval)
			console.log(
				// eslint-disable-next-line prettier/prettier
				`Macadam consumer ${this.device.deviceIndex - 1} - failed to turn off single field output mode`
			)
	}

	async initialise(): Promise<void> {
		this.playback = await Macadam.playback({
			deviceIndex: this.device.deviceIndex - 1,
			channels: this.audioChannels,
			sampleRate: bmdSampleRates.get(this.format.audioSampleRate),
			sampleType: Macadam.bmdAudioSampleType32bitInteger,
			displayMode: bmdDisplayMode.get(this.format.name),
			pixelFormat: Macadam.bmdFormat10BitYUV
		})

		const sampleRate = this.audioTimebase[1]
		const audLayout = `${this.audioChannels}c`
		// !!! Needs more work to handle 59.94 frame rates !!!
		const samplesPerFrame =
			(this.format.audioSampleRate * this.format.duration * this.format.fields) /
			this.format.timescale

		this.audFilterer = await filterer({
			filterType: 'audio',
			inputParams: [
				{
					name: 'in0:a',
					timeBase: this.audioTimebase,
					sampleRate: sampleRate,
					sampleFormat: 'fltp',
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
			filterSpec: `[in0:a] asetnsamples=n=${samplesPerFrame}:p=1 [out0:a]`
		})
		// console.log('\nMacadam consumer audio:\n', this.audFilterer.graph.dump())

		this.fromRGBA = new FromRGBA(
			this.clContext,
			'709',
			new Writer(this.playback.width, this.playback.height, this.format.fields === 2),
			this.clJobs
		)
		await this.fromRGBA.init()

		console.log(`Created Macadam consumer for Blackmagic id: ${this.device.deviceIndex - 1}`)
		return Promise.resolve()
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
							// eslint-disable-next-line prettier/prettier
							`Macadam consumer ${this.device.deviceIndex - 1} - frame may be delayed (${hwDelay} ticks)`
						)
				}
				resolve()
			}, delay)
		)
	}

	deviceConfig(): DeviceConfig {
		return this.device
	}

	connect(sourcePipes: SourcePipes): void {
		this.sourcePipes = sourcePipes
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
				return end
			}
		}

		const vidProcess: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const start = process.hrtime()
				const fromRGBA = this.fromRGBA as FromRGBA
				if (this.vidField === 0) {
					this.clDests = await fromRGBA.createDests()
					this.clDests.forEach((d) => {
						// d.loadstamp = frame.loadstamp
						d.timestamp = (frame.timestamp / this.format.fields) << 0
					})
				}
				const interlace = this.format.fields ? 0x1 | (this.vidField << 1) : 0
				fromRGBA.processFrame(this.chanID, frame, this.clDests, interlace)
				await this.clJobs.runQueue({ source: this.chanID, timestamp: frame.timestamp })
				const end = process.hrtime(start)
				if (this.logTimings)
					console.log(
						`Macadam channel ${this.device.deviceIndex}: ${frame.timestamp}  ${(
							end[0] * 1000.0 +
							end[1] / 1000000.0
						).toFixed(2)}ms processing total`
					)
				if (this.format.fields === 2) this.vidField = 1 - this.vidField
				else this.vidField = 0
				return this.vidField === 1 ? nil : this.clDests[0]
			} else {
				this.clJobs.clearQueue(this.chanID)
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

				const atb = this.audioTimebase
				const ats = (audBuf.timestamp * atb[0]) / atb[1]
				const vtb = this.videoTimebase
				const vts = (vidBuf.timestamp * vtb[0]) / vtb[1]
				if (Math.abs(ats - vts) > 0.1)
					console.log('Macadam audio and video timestamp mismatch - aud:', ats, ' vid:', vts)

				await this.waitHW()
				await this.playback?.displayFrame(vidBuf, audBuf.buffer)
				vidBuf.release()
				return Promise.resolve()
			} else {
				// this.clContext.logBuffers()
				return Promise.resolve()
			}
		}

		this.sourcePipes.video
			.valve(vidProcess)
			.valve(vidSaver)
			.zip(this.sourcePipes.audio.valve(audFilter, { oneToMany: true }))
			.spout(macadamSpout)
	}

	release(): void {
		this.sourcePipes?.release()
	}
}

export class MacadamConsumerFactory implements ConsumerFactory<MacadamConsumer> {
	private readonly clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createConsumer(
		chanID: string,
		params: ConfigParams,
		format: VideoFormat,
		device: DeviceConfig,
		clJobs: ClJobs
	): MacadamConsumer {
		const consumer = new MacadamConsumer(this.clContext, chanID, params, format, device, clJobs)
		return consumer
	}
}
