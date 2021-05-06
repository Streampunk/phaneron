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

const getTransitionKernel = (type: string): string => {
	if (!['dissolve', 'wipe'].includes(type))
		throw new Error(
			`Transition requires a 'type' parameter that is either 'dissolve' or 'wipe' - found '${type}'`
		)

	let kernel = `
		__constant sampler_t sampler1 =
			CLK_NORMALIZED_COORDS_FALSE
			| CLK_ADDRESS_CLAMP_TO_EDGE
			| CLK_FILTER_NEAREST;

		__kernel void transition_${type}(
			__read_only image2d_t input0,
			__read_only image2d_t input1,
	`

	if (type === 'dissolve') {
		kernel += `
			__private float mix,
		`
	} else {
		kernel += `
			__read_only image2d_t maskIn,
		`
	}

	kernel += `
			__write_only image2d_t output
		) {
			int x = get_global_id(0);
			int y = get_global_id(1);
			float4 in0 = read_imagef(input0, sampler1, (int2)(x,y));
			float4 in1 = read_imagef(input1, sampler1, (int2)(x,y));
		`

	if (type === 'dissolve') {
		kernel += `
			float4 mix4 = (float4)(mix, mix, mix, mix);
			float rmix = 1.0f - mix;
  	  float4 out = fma(in0, mix4, in1 * rmix);
		`
	} else {
		kernel += `
			float4 mask = read_imagef(maskIn, sampler1, (int2)(x,y));
			float m = mask.s0;
			float rm = 1.0f - m;
			float4 m4 = (float4)(m, m, m, m);
			float4 out = fma(in1, m4, in0 * rm);
		`
	}

	kernel += `
			write_imagef(output, (int2)(x, y), out);
		};
	`
	return kernel
}

export default class Transition extends ProcessImpl {
	constructor(type: string, width: number, height: number) {
		super(type, width, height, getTransitionKernel(type), `transition_${type}`)
	}

	async init(): Promise<void> {
		return Promise.resolve()
	}

	async getKernelParams(params: KernelParams): Promise<KernelParams> {
		const kernelParams: KernelParams = {
			output: params.output
		}

		const inArray = params.inputs as Array<OpenCLBuffer>
		if (inArray.length !== 2)
			throw new Error(`Transition requires an 'inputs' array parameter with 2 OpenCL buffers`)

		for (let i = 0; i < inArray.length; ++i) {
			kernelParams[`input${i}`] = inArray[i]
		}

		if (this.name === 'dissolve') {
			kernelParams.mix = params.mix
		} else {
			kernelParams.maskIn = params.mask
		}
		return Promise.resolve(kernelParams)
	}

	releaseRefs(): void {
		return
	}
}
