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
import { RedioPipe, RedioEnd, isValue, Valve, nil } from 'redioactive'
import ImageProcess from './process/imageProcess'
import Transform from './process/transform'
import { Frame, Filterer, filterer } from 'beamcoder'

interface AnchorParams {
	x: number
	y: number
}

interface FillParams {
	xOffset: number
	yOffset: number
	xScale: number
	yScale: number
}

export class Mixer {
	private readonly clContext: nodenCLContext
	private readonly width: number
	private readonly height: number
	private transform: ImageProcess | null
	// private black: OpenCLBuffer | null = null
	private mixAudio: RedioPipe<Frame | RedioEnd> | undefined
	private mixVideo: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private audMixFilterer: Filterer | undefined

	anchorParams: AnchorParams = { x: 0, y: 0 }
	rotation = 0
	fillParams: FillParams = { xOffset: 0, yOffset: 0, xScale: 1, yScale: 1 }
	volume = 1.0

	constructor(clContext: nodenCLContext, width: number, height: number) {
		this.clContext = clContext
		this.width = width
		this.height = height
		this.transform = new ImageProcess(
			this.clContext,
			new Transform(this.clContext, this.width, this.height)
		)
	}

	async init(
		srcAudio: RedioPipe<Frame | RedioEnd>[],
		srcVideo: RedioPipe<OpenCLBuffer | RedioEnd>[]
	): Promise<void> {
		const sampleRate = 48000
		const layout = 'octagonal'
		this.audMixFilterer = await filterer({
			filterType: 'audio',
			inputParams: [
				{
					name: 'in0:a',
					timeBase: [1, sampleRate],
					sampleRate: sampleRate,
					sampleFormat: 's32',
					channelLayout: layout
				}
			],
			outputParams: [
				{
					name: 'out0:a',
					sampleRate: sampleRate,
					sampleFormat: 's32',
					channelLayout: layout
				}
			],
			filterSpec: `[in0:a] volume=1.0:eval=frame:precision=fixed [out0:a]`
		})
		// console.log('\nMixer audio:\n', this.audMixFilterer.graph.dump())

		const audMixFilter: Valve<Frame | RedioEnd, Frame | RedioEnd> = async (frame) => {
			if (isValue(frame) && this.audMixFilterer) {
				const ff = await this.audMixFilterer.filter([{ name: 'in0:a', frames: [frame] }])
				return ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				return frame
			}
		}

		await this.transform?.init()
		const numBytesRGBA = this.width * this.height * 4 * 4
		// this.black = await this.clContext.createBuffer(
		// 	numBytesRGBA,
		// 	'readwrite',
		// 	'coarse',
		// 	{
		// 		width: this.width,
		// 		height: this.height
		// 	},
		// 	'mixer'
		// )

		// let off = 0
		// const blackFloat = new Float32Array(this.width * this.height * 4)
		// for (let y = 0; y < this.height; ++y) {
		// 	for (let x = 0; x < this.width * 4; x += 4) {
		// 		blackFloat[off + x + 0] = 0.0
		// 		blackFloat[off + x + 1] = 0.0
		// 		blackFloat[off + x + 2] = 0.0
		// 		blackFloat[off + x + 3] = 0.0
		// 	}
		// 	off += this.width * 4
		// }
		// await this.black.hostAccess('writeonly')
		// Buffer.from(blackFloat.buffer).copy(this.black)

		const mixVidValve: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const xfDest = await this.clContext.createBuffer(
					numBytesRGBA,
					'readwrite',
					'coarse',
					{
						width: this.width,
						height: this.height
					},
					'switch'
				)
				xfDest.timestamp = frame.timestamp

				await this.transform?.run(
					{
						input: frame,
						flipH: false,
						flipV: false,
						anchorX: this.anchorParams.x - 0.5,
						anchorY: this.anchorParams.y - 0.5,
						scaleX: this.fillParams.xScale,
						scaleY: this.fillParams.yScale,
						rotate: -this.rotation / 360.0,
						offsetX: -this.fillParams.xOffset,
						offsetY: -this.fillParams.yOffset,
						output: xfDest
					},
					this.clContext.queue.process
				)

				await this.clContext.waitFinish(this.clContext.queue.process)
				frame.release()
				return xfDest
			} else {
				// this.black?.release()
				this.transform = null
				return frame
			}
		}

		// eslint-disable-next-line prettier/prettier
		this.mixAudio = srcAudio[0]
			.valve(audMixFilter, { bufferSizeMax: 1, oneToMany: true })

		// eslint-disable-next-line prettier/prettier
		this.mixVideo = srcVideo[0]
			.valve(mixVidValve, { bufferSizeMax: 1, oneToMany: false })
	}

	setAnchor(_layer: number, x: number, y: number): boolean {
		this.anchorParams = { x: x, y: y }
		return true
	}

	setRotation(_layer: number, angle: number): boolean {
		this.rotation = angle
		return true
	}

	setFill(_layer: number, xPos: number, yPos: number, xScale: number, yScale: number): boolean {
		this.fillParams = { xOffset: xPos, yOffset: yPos, xScale: xScale, yScale: yScale }
		return true
	}

	setVolume(_layer: number, volume: number): boolean {
		this.volume = volume
		const volFilter = this.audMixFilterer?.graph.filters.find((f) => f.filter.name === 'volume')
		if (volFilter && volFilter.priv) volFilter.priv = { volume: this.volume.toString() }
		return true
	}

	getMixAudio(): RedioPipe<Frame | RedioEnd> | undefined {
		return this.mixAudio
	}
	getMixVideo(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined {
		return this.mixVideo
	}
}
