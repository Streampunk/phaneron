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

import { ProcessImpl } from './imageProcess'
import { clContext as nodenCLContext, OpenCLBuffer, KernelParams } from 'nodencl'

const resizeKernel = `
  __constant sampler_t samplerIn =
    CLK_NORMALIZED_COORDS_TRUE |
    CLK_ADDRESS_CLAMP |
    CLK_FILTER_LINEAR;

  __constant sampler_t samplerOut =
    CLK_NORMALIZED_COORDS_FALSE |
    CLK_ADDRESS_CLAMP |
    CLK_FILTER_NEAREST;

  __kernel void resize(
    __read_only image2d_t input,
    __private float scale,
    __private float offsetX,
    __private float offsetY,
    __global float* restrict flip,
    __write_only image2d_t output) {

    int w = get_image_width(output);
    int h = get_image_height(output);

    int outX = get_global_id(0);
    int outY = get_global_id(1);
    int2 posOut = {outX, outY};

    float2 inPos = (float2)(outX / (float) w, outY / (float) h);
    float centreOffX = (-0.5f - offsetX) / scale + 0.5f;
    float centreOffY = (-0.5f - offsetY) / scale + 0.5f;
    float2 off = (float2)(fma(centreOffX, flip[1], flip[0]), fma(centreOffY, flip[3], flip[2]));
    float2 mul = (float2)(flip[1] / scale, flip[3] / scale);
    float2 posIn = fma(inPos, mul, off);

    float4 in = read_imagef(input, samplerIn, posIn);
    write_imagef(output, posOut, in);
  }
`
export default class Resize extends ProcessImpl {
	private readonly clContext: nodenCLContext
	private flipH: boolean
	private flipV: boolean
	private flipArr: Float32Array
	private readonly flipArrBytes: number
	private flipVals: OpenCLBuffer | null = null

	constructor(clContext: nodenCLContext, width: number, height: number) {
		super('resize', width, height, resizeKernel, 'resize')

		this.clContext = clContext
		this.flipH = false
		this.flipV = false
		this.flipArr = Float32Array.from([0.0, 1.0, 0.0, 1.0])
		this.flipArrBytes = this.flipArr.length * this.flipArr.BYTES_PER_ELEMENT
	}

	private async updateFlip(flipH: boolean, flipV: boolean, clQueue: number): Promise<void> {
		if (this.flipVals === null)
			throw new Error('Resize.updateFlip failed with no program available')

		this.flipH = flipH
		this.flipV = flipV
		this.flipArr = Float32Array.from([
			this.flipH ? 1.0 : 0.0,
			this.flipH ? -1.0 : 1.0,
			this.flipV ? 1.0 : 0.0,
			this.flipV ? -1.0 : 1.0
		])
		await this.flipVals.hostAccess('writeonly', clQueue, Buffer.from(this.flipArr.buffer))
		return this.flipVals.hostAccess('none', clQueue)
	}

	async init(): Promise<void> {
		this.flipVals = await this.clContext.createBuffer(
			this.flipArrBytes,
			'readonly',
			'coarse',
			undefined,
			'flipVals'
		)
		return this.updateFlip(false, false, this.clContext.queue.load)
	}

	async getKernelParams(params: KernelParams): Promise<KernelParams> {
		const flipH = params.flipH as boolean
		const flipV = params.flipV as boolean
		const scale = params.scale as number
		const offsetX = params.offsetX as number
		const offsetY = params.offsetY as number

		if (!(this.flipH === flipH && this.flipV === flipV))
			await this.updateFlip(flipH, flipV, this.clContext.queue.load)

		if (scale && !(scale > 0.0)) throw 'resize scale factor must be greater than zero'

		if (offsetX && !(offsetX >= -1.0 && offsetX <= 1.0))
			throw 'resize offsetX must be between -1.0 and +1.0'

		if (offsetY && !(offsetY >= -1.0 && offsetY <= 1.0))
			throw 'resize offsetX must be between -1.0 and +1.0'

		return Promise.resolve({
			input: params.input,
			scale: params.scale || 1.0,
			offsetX: params.offsetX || 0.0,
			offsetY: params.offsetY || 0.0,
			flip: this.flipVals,
			output: params.output
		})
	}
}
