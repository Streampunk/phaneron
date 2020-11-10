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

const getCombineKernel = (numLayers: number): string => {
	let kernel = `
		__constant sampler_t sampler1 =
			CLK_NORMALIZED_COORDS_FALSE
			| CLK_ADDRESS_CLAMP_TO_EDGE
			| CLK_FILTER_NEAREST;

		__kernel void combine_${numLayers}(
			__read_only image2d_t l0In,
			__read_only image2d_t l1In,
	`

	for (let i = 2; i < numLayers; ++i) {
		kernel += `
			__read_only image2d_t l${i}In,
		`
	}

	kernel += `
			__write_only image2d_t output
		) {
			int x = get_global_id(0);
			int y = get_global_id(1);
			float4 l0 = read_imagef(l0In, sampler1, (int2)(x,y));
			float4 l1 = read_imagef(l1In, sampler1, (int2)(x,y));
			float k = 1.0f - l1.s3;
			float4 k4 = (float4)(k, k, k, 0.0f);
			float4 out0 = fma(l0, k4, l1);
	`

	for (let i = 2; i < numLayers; ++i) {
		kernel += `
			float4 l${i} = read_imagef(l${i}In, sampler1, (int2)(x,y));
			k = 1.0f - l${i}.s3;
			k4 = (float4)(k, k, k, 0.0f);
			float4 out${i - 1} = fma(out${i - 2}, k4, l${i});
		`
	}

	kernel += `
			write_imagef(output, (int2)(x, y), out${numLayers - 2});
		};
	`
	return kernel
}

export default class Combine extends ProcessImpl {
	constructor(numLayers: number, width: number, height: number) {
		super(
			`combine-${numLayers}`,
			width,
			height,
			getCombineKernel(numLayers < 2 ? 2 : numLayers),
			`combine_${numLayers < 2 ? 2 : numLayers}` // combine will not actually be used if numLayers < 2
		)
	}

	async init(): Promise<void> {
		return Promise.resolve()
	}

	async getKernelParams(params: KernelParams): Promise<KernelParams> {
		const kernelParams: KernelParams = {
			output: params.output
		}

		const inArray = params.inputs as Array<OpenCLBuffer>
		if (inArray.length < 2)
			throw new Error("Combine requires an 'inputs' array parameter with at least 2 OpenCL buffers")

		for (let i = 0; i < inArray.length; ++i) {
			kernelParams[`l${i}In`] = inArray[i]
		}

		return Promise.resolve(kernelParams)
	}
}
