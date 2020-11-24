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
import { RedioPipe, RedioEnd, nil, end, isValue, Valve, Spout } from 'redioactive'
import { FromRGBA } from '../process/io'
import { Writer } from '../process/rgba8'
import { Frame, Filterer, filterer } from 'beamcoder'
import { VideoFormat, DeviceConfig } from '../config'
import { ClJobs } from '../clJobQueue'

interface AudioBuffer {
	buffer: Buffer
	timestamp: number
}

export class ScreenConsumer implements Consumer {
	private readonly clContext: nodenCLContext
	private readonly chanID: string
	private readonly format: VideoFormat
	private readonly clJobs: ClJobs
	private fromRGBA: FromRGBA | null = null
	private readonly audioChannels: number
	private readonly audioTimebase: number[]
	private readonly videoTimebase: number[]
	private audFilterer: Filterer | null = null

	constructor(context: nodenCLContext, chanID: string, format: VideoFormat, clJobs: ClJobs) {
		this.clContext = context
		this.chanID = `${chanID} screen`
		this.format = format
		this.clJobs = clJobs
		this.audioChannels = 8
		this.audioTimebase = [1, this.format.audioSampleRate]
		this.videoTimebase = [this.format.duration, this.format.timescale]
	}

	async initialise(): Promise<void> {
		const sampleRate = this.audioTimebase[1]
		const audLayout = `${this.audioChannels}c`
		// !!! Needs more work to handle 59.94 frame rates !!!
		const samplesPerFrame =
			(this.format.audioSampleRate * this.format.duration) / this.format.timescale

		this.audFilterer = await filterer({
			filterType: 'audio',
			inputParams: [
				{
					name: 'in0:a',
					timeBase: this.audioTimebase,
					sampleRate: sampleRate,
					sampleFormat: 'flt',
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
		// console.log('\nScreen consumer audio:\n', this.audFilterer.graph.dump())

		const width = 1920
		const height = 1080
		this.fromRGBA = new FromRGBA(
			this.clContext,
			'sRGB',
			new Writer(width, height, false),
			this.clJobs
		)
		await this.fromRGBA.init()

		console.log('Created Screen consumer')
		return Promise.resolve()
	}

	connect(
		combineAudio: RedioPipe<Frame | RedioEnd>,
		combineVideo: RedioPipe<OpenCLBuffer | RedioEnd>
	): void {
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
					console.log('Screen audio and video timestamp mismatch - aud:', ats, ' vid:', vts)

				return new Promise((resolve) =>
					setTimeout(() => {
						vidBuf.release()
						resolve()
					}, 10)
				)
			} else {
				// this.clContext.logBuffers()
				return Promise.resolve()
			}
		}

		combineVideo
			.valve(vidProcess)
			.valve(vidSaver)
			.zip(combineAudio.valve(audFilter, { oneToMany: true }))
			.spout(screenSpout)
	}
}

export class ScreenConsumerFactory implements ConsumerFactory<ScreenConsumer> {
	private readonly clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createConsumer(
		chanID: string,
		format: VideoFormat,
		_device: DeviceConfig,
		clJobs: ClJobs
	): ScreenConsumer {
		const consumer = new ScreenConsumer(this.clContext, chanID, format, clJobs)
		return consumer
	}
}
