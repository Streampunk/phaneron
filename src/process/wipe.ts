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
import { KernelParams } from 'nodencl'

const wipeKernel = `
  __constant sampler_t sampler1 =
      CLK_NORMALIZED_COORDS_FALSE
    | CLK_ADDRESS_CLAMP_TO_EDGE
    | CLK_FILTER_NEAREST;

  __kernel void wipe(
    __read_only image2d_t input0,
    __read_only image2d_t input1,
    __private float wipe,
    __write_only image2d_t output) {

    int w = get_image_width(output);
    int h = get_image_height(output);

    int x = get_global_id(0);
    int y = get_global_id(1);
    float4 in0 = read_imagef(input0, sampler1, (int2)(x,y));
    float4 in1 = read_imagef(input1, sampler1, (int2)(x,y));

    float4 out = x > w * wipe ? in1 : in0;

    write_imagef(output, (int2)(x, y), out);
  };
`
export default class Wipe extends ProcessImpl {
	constructor(width: number, height: number) {
		super('wipe', width, height, wipeKernel, 'wipe')
	}

	async init(): Promise<void> {
		return Promise.resolve()
	}

	async getKernelParams(params: KernelParams): Promise<KernelParams> {
		return Promise.resolve({
			input0: params.input0,
			input1: params.input1,
			wipe: params.wipe,
			output: params.output
		})
	}
}
