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
import { VideoFormat } from './config'
import redio, { RedioPipe, RedioEnd, isValue, Valve, nil, end } from 'redioactive'
import { Filterer, filterer, Frame, frame } from 'beamcoder'

export class Silence {
	private readonly consumerFormat: VideoFormat
	private running: boolean

	constructor(consumerFormat: VideoFormat) {
		this.consumerFormat = consumerFormat
		this.running = true
	}

	async initialise(): Promise<RedioPipe<Frame | RedioEnd>> {
		const sampleRate = this.consumerFormat.audioSampleRate
		const numAudChannels = this.consumerFormat.audioChannels
		const audLayout = `${numAudChannels}c`

		const silenceArr = new Float32Array(1024 * numAudChannels)
		const silence = frame({
			nb_samples: 1024,
			format: 'flt',
			pts: 0,
			sample_rate: sampleRate,
			channels: numAudChannels,
			channel_layout: audLayout,
			data: [Buffer.from(silenceArr.buffer)]
		})

		let audSilenceFilterer: Filterer | null = await filterer({
			filterType: 'audio',
			inputParams: [
				{
					name: 'in0:a',
					timeBase: [1, sampleRate],
					sampleRate: sampleRate,
					sampleFormat: 'flt',
					channelLayout: audLayout
				}
			],
			outputParams: [
				{
					name: 'out0:a',
					sampleRate: sampleRate,
					sampleFormat: 'fltp',
					channelLayout: audLayout
				}
			],
			filterSpec: '[in0:a] asetpts=N/SR/TB [out0:a]'
		})
		// console.log('\nSilence:\n', audSilenceFilterer.graph.dump())

		const silencePipe: RedioPipe<Frame | RedioEnd> = redio(() => (this.running ? silence : end), {
			bufferSizeMax: 1
		})

		const silenceAudValve: Valve<Frame | RedioEnd, Frame | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const ff = await audSilenceFilterer?.filter([{ name: 'in0:a', frames: [frame] }])
				return ff && ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				audSilenceFilterer = null
				return frame
			}
		}

		return silencePipe.valve(silenceAudValve, { oneToMany: true })
	}

	release(): void {
		this.running = false
	}
}

export class Black {
	private readonly clContext: nodenCLContext
	private readonly consumerFormat: VideoFormat
	private readonly id: string
	private running: boolean

	constructor(clContext: nodenCLContext, consumerFormat: VideoFormat, id: string) {
		this.clContext = clContext
		this.consumerFormat = consumerFormat
		this.id = id
		this.running = true
	}

	async initialise(): Promise<RedioPipe<OpenCLBuffer | RedioEnd>> {
		const numBytesRGBA = this.consumerFormat.width * this.consumerFormat.height * 4 * 4
		let black: OpenCLBuffer | null = await this.clContext.createBuffer(
			numBytesRGBA,
			'readwrite',
			'coarse',
			{
				width: this.consumerFormat.width,
				height: this.consumerFormat.height
			},
			`black-${this.id}`
		)

		let off = 0
		const blackFloat = new Float32Array(numBytesRGBA / 4)
		for (let y = 0; y < this.consumerFormat.height; ++y) {
			for (let x = 0; x < this.consumerFormat.width * 4; x += 4) {
				blackFloat[off + x + 0] = 0.0
				blackFloat[off + x + 1] = 0.0
				blackFloat[off + x + 2] = 0.0
				blackFloat[off + x + 3] = 0.0
			}
			off += this.consumerFormat.width * 4
		}
		await black.hostAccess('writeonly')
		Buffer.from(blackFloat.buffer).copy(black)
		black.addRef()

		const blackPipe: RedioPipe<OpenCLBuffer | RedioEnd> = redio(
			() => {
				if (this.running) {
					return black
				} else {
					if (black) {
						black?.release()
						black?.release()
						black = null
					}
					return end
				}
			},
			{ bufferSizeMax: 1 }
		)

		return blackPipe
	}

	release(): void {
		this.running = false
	}
}
