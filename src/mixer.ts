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

import { clContext as nodenCLContext } from 'nodencl'
import { SourceFrame } from './chanLayer'
import { RedioPipe, RedioEnd, isValue, isEnd } from 'redioactive'
import ImageProcess from './process/imageProcess'
import Transform from './process/transform'

export class Mixer {
	private readonly clContext: nodenCLContext
	private readonly width: number
	private readonly height: number
	private transform: ImageProcess | null
	// private black: OpenCLBuffer | null = null

	constructor(clContext: nodenCLContext, width: number, height: number) {
		this.clContext = clContext
		this.width = width
		this.height = height
		this.transform = new ImageProcess(
			this.clContext,
			new Transform(this.clContext, this.width, this.height)
		)
	}

	async init(src: RedioPipe<SourceFrame | RedioEnd>): Promise<RedioPipe<SourceFrame | RedioEnd>> {
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

		const mixValve = src.valve<SourceFrame | RedioEnd>(
			async (frame: SourceFrame | RedioEnd) => {
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

					await this.transform?.run(
						{
							input: frame.video,
							scale: 1.0, //0.5,
							offsetX: 0.0, //0.5,
							offsetY: 0.0, //0.5,
							flipH: false,
							flipV: false,
							rotate: 0.0,
							output: xfDest
						},
						this.clContext.queue.process
					)

					await this.clContext.waitFinish(this.clContext.queue.process)
					frame.video.release()

					const sourceFrame: SourceFrame = {
						video: xfDest,
						audio: Buffer.alloc(0),
						timestamp: 0
					}
					return sourceFrame
				} else {
					if (isEnd(frame)) {
						// this.black?.release()
						this.transform = null
					}
					return frame
				}
			},
			{ bufferSizeMax: 1, oneToMany: false }
		)

		return mixValve
	}
}
