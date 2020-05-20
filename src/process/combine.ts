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
import { OpenCLBuffer, KernelParams } from 'nodencl'

const combineKernel = `
  __constant sampler_t sampler1 =
      CLK_NORMALIZED_COORDS_FALSE
    | CLK_ADDRESS_CLAMP_TO_EDGE
    | CLK_FILTER_NEAREST;

  __kernel void
    twoInputs(__read_only image2d_t bgIn,
              __read_only image2d_t ovIn,
              __write_only image2d_t output) {

    int x = get_global_id(0);
    int y = get_global_id(1);
    float4 bg = read_imagef(bgIn, sampler1, (int2)(x,y));
    float4 ov = read_imagef(ovIn, sampler1, (int2)(x,y));
    float k = 1.0f - ov.s3;
    float4 k4 = (float4)(k, k, k, 0.0f);
    float4 out = fma(bg, k4, ov);
    write_imagef(output, (int2)(x, y), out);
  };

  __kernel void
    threeInputs(__read_only image2d_t bgIn,
                __read_only image2d_t ov0In,
                __read_only image2d_t ov1In,
                __write_only image2d_t output) {

    int x = get_global_id(0);
    int y = get_global_id(1);
    float4 bg = read_imagef(bgIn, sampler1, (int2)(x,y));

    float4 ov0 = read_imagef(ov0In, sampler1, (int2)(x,y));
    float k = 1.0f - ov0.s3;
    float4 k4 = (float4)(k, k, k, 0.0f);
    float4 out0 = fma(bg, k4, ov0);

    float4 ov1 = read_imagef(ov1In, sampler1, (int2)(x,y));
    k = 1.0f - ov1.s3;
    k4 = (float4)(k, k, k, 0.0f);
    float4 out1 = fma(out0, k4, ov1);
    write_imagef(output, (int2)(x, y), out1);
  };
`

export default class Combine extends ProcessImpl {
	private readonly numOverlays: number

	constructor(width: number, height: number, numOverlays: number) {
		super(
			numOverlays === 1 ? 'combine-1' : 'combine-2',
			width,
			height,
			combineKernel,
			numOverlays === 1 ? 'twoInputs' : 'threeInputs'
		)
		this.numOverlays = numOverlays
		if (!(this.numOverlays > 0 && this.numOverlays < 3))
			throw new Error(`Combine supports one or two overlays, ${this.numOverlays} requested`)
	}

	async init(): Promise<void> {
		return Promise.resolve()
	}

	async getKernelParams(params: KernelParams): Promise<KernelParams> {
		const kernelParams: KernelParams = {
			bgIn: params.bgIn,
			output: params.output
		}

		const ovArray = params.ovIn as Array<OpenCLBuffer>
		if (ovArray.length !== 1 && ovArray.length !== 2)
			throw new Error("Combine requires 'ovIn' array parameter with 1 or 2 OpenCL buffers")

		switch (this.numOverlays) {
			case 1:
				kernelParams.ovIn = ovArray[0]
				break
			case 2:
				kernelParams.ov0In = ovArray[0]
				kernelParams.ov1In = ovArray[1]
				break
		}

		return Promise.resolve(kernelParams)
	}
}
