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

import { clContext as nodenCLContext, OpenCLBuffer, KernelParams, RunTimings } from 'nodencl'
import ImageProcess from './imageProcess'
import Transform from './transform'
import Mix from './mix'
import Wipe from './wipe'
import Combine from './combine'

export default class Switch {
	private readonly clContext: nodenCLContext
	private readonly width: number
	private readonly height: number
	private readonly numInputs: number
	private readonly numOverlays: number
	private xform0: ImageProcess | null = null
	private xform1: ImageProcess | null = null
	private rgbaXf0: OpenCLBuffer | null = null
	private rgbaXf1: OpenCLBuffer | null = null
	private rgbaMx: OpenCLBuffer | null = null
	private mixer: ImageProcess | null = null
	private wiper: ImageProcess | null = null
	private combiner: ImageProcess | null = null

	constructor(
		clContext: nodenCLContext,
		width: number,
		height: number,
		numInputs: number,
		numOverlays: number
	) {
		this.clContext = clContext
		this.width = width
		this.height = height
		this.numInputs = numInputs
		this.numOverlays = numOverlays
	}

	async init(): Promise<void> {
		const numBytesRGBA = this.width * this.height * 4 * 4

		this.xform0 = new ImageProcess(
			this.clContext,
			new Transform(this.clContext, this.width, this.height)
		)
		await this.xform0.init()

		this.rgbaXf0 = await this.clContext.createBuffer(
			numBytesRGBA,
			'readwrite',
			'coarse',
			{
				width: this.width,
				height: this.height
			},
			'switch'
		)

		if (this.numInputs > 1) {
			this.xform1 = new ImageProcess(
				this.clContext,
				new Transform(this.clContext, this.width, this.height)
			)
			await this.xform1.init()

			this.rgbaXf1 = await this.clContext.createBuffer(
				numBytesRGBA,
				'readwrite',
				'coarse',
				{
					width: this.width,
					height: this.height
				},
				'switch'
			)

			this.mixer = new ImageProcess(this.clContext, new Mix(this.width, this.height))
			await this.mixer.init()

			this.wiper = new ImageProcess(this.clContext, new Wipe(this.width, this.height))
			await this.wiper.init()
		}

		this.combiner = new ImageProcess(
			this.clContext,
			new Combine(this.width, this.height, this.numOverlays)
		)
		await this.combiner.init()

		this.rgbaMx = await this.clContext.createBuffer(
			numBytesRGBA,
			'readwrite',
			'coarse',
			{
				width: this.width,
				height: this.height
			},
			'switch'
		)
	}

	async processFrame(
		inParams: Array<KernelParams>,
		mixParams: KernelParams,
		overlays: Array<OpenCLBuffer>,
		output: OpenCLBuffer,
		clQueue: number
	): Promise<RunTimings> {
		if (
			!(
				this.xform0 &&
				(this.numInputs === 1 || (this.xform1 && this.mixer && this.wiper)) &&
				this.combiner
			)
		)
			throw new Error(`Switch needs to be initialised ${this.numInputs}`)

		inParams[0].output = this.rgbaXf0
		await this.xform0.run(inParams[0], clQueue)

		if (this.numInputs > 1) {
			inParams[1].output = this.rgbaXf1
			await this.xform1?.run(inParams[1], clQueue)
			if (mixParams.wipe) {
				await this.wiper?.run(
					{ input0: this.rgbaXf0, input1: this.rgbaXf1, wipe: mixParams.frac, output: this.rgbaMx },
					clQueue
				)
			} else {
				await this.mixer?.run(
					{ input0: this.rgbaXf0, input1: this.rgbaXf1, mix: mixParams.frac, output: this.rgbaMx },
					clQueue
				)
			}
		} else {
			this.rgbaMx = this.rgbaXf0
		}

		return await this.combiner.run({ bgIn: this.rgbaMx, ovIn: overlays, output: output }, clQueue)
	}
}
