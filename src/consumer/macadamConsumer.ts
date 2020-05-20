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

import { SourceFrame } from '../chanLayer'
import { clContext as nodenCLContext, OpenCLBuffer } from 'nodencl'
import { ConsumerFactory, Consumer } from './consumer'
import { RedioPipe, RedioStream, nil, isEnd, isNil } from 'redioactive'
import * as Macadam from 'macadam'
import { FromRGBA } from '../process/io'
import { Writer } from '../process/v210'

export class MacadamConsumer implements Consumer {
	private readonly channel: number
	private clContext: nodenCLContext
	private playback: Macadam.PlaybackChannel | null = null
	private fromRGBA: FromRGBA | undefined
	private vidProcess: RedioPipe<OpenCLBuffer> | undefined
	private vidSaver: RedioPipe<OpenCLBuffer> | undefined
	private spout: RedioStream<OpenCLBuffer> | undefined
	private clDests: Array<OpenCLBuffer> | undefined
	private field: number
	private frameNumber: number
	private readonly latency: number

	constructor(channel: number, context: nodenCLContext) {
		this.channel = channel
		this.clContext = context
		this.field = 0
		this.frameNumber = 0
		this.latency = 3
	}

	async initialise(pipe: RedioPipe<SourceFrame>): Promise<RedioStream<OpenCLBuffer> | null> {
		this.playback = await Macadam.playback({
			deviceIndex: this.channel - 1,
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

		this.vidProcess = pipe.valve<OpenCLBuffer>(
			async (frame) => {
				if (!isEnd(frame) && !isNil(frame)) {
					const fromRGBA = this.fromRGBA as FromRGBA
					if (this.field === 0) this.clDests = await fromRGBA.createDests()
					const clDests = this.clDests as Array<OpenCLBuffer>
					const srcFrame = frame as SourceFrame
					const queue = this.clContext.queue.process
					const interlace = 0x1 | (this.field << 1)
					await fromRGBA.processFrame(srcFrame.video, clDests, queue, interlace)
					await this.clContext.waitFinish(queue)
					srcFrame.video.release()
					this.field = 1 - this.field
					return this.field === 1 ? nil : clDests[0]
				} else {
					return frame
				}
			},
			{ bufferSizeMax: 3, oneToMany: false }
		)

		this.vidSaver = this.vidProcess.valve<OpenCLBuffer>(
			async (frame) => {
				if (!isEnd(frame) && !isNil(frame)) {
					const v210Frame = frame as OpenCLBuffer
					const fromRGBA = this.fromRGBA as FromRGBA
					await fromRGBA.saveFrame(v210Frame, this.clContext.queue.unload)
					await this.clContext.waitFinish(this.clContext.queue.unload)
					return v210Frame
				} else {
					return frame
				}
			},
			{ bufferSizeMax: 3, oneToMany: false }
		)

		this.spout = this.vidSaver.spout(
			async (frame) => {
				if (!isEnd(frame) && !isNil(frame)) {
					const v210Frame = frame as OpenCLBuffer
					this.playback?.schedule({ video: v210Frame, time: 1000 * this.frameNumber })
					if (this.frameNumber === this.latency) this.playback?.start({ startTime: 0 })
					if (this.frameNumber >= this.latency)
						await this.playback?.played((this.frameNumber - this.latency) * 1000)

					this.frameNumber++
					v210Frame.release()
					return Promise.resolve()
				} else {
					return Promise.resolve()
				}
			},
			{ bufferSizeMax: 3, oneToMany: false }
		)

		console.log(`Created Macadam consumer for Blackmagic id: ${this.channel - 1}`)
		return this.spout
	}
}

export class MacadamConsumerFactory implements ConsumerFactory<MacadamConsumer> {
	private clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createConsumer(channel: number): MacadamConsumer {
		return new MacadamConsumer(channel, this.clContext)
	}
}
