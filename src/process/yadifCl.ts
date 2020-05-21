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

/*
 * Based on https://github.com/FFmpeg/FFmpeg/blob/8e50215b5e02074b0773dfcf55867654ee59c179/libavfilter/vf_yadif_cuda.cu
 */

import { ProcessImpl } from './imageProcess'
import { KernelParams } from 'nodencl'

const yadifKernel = `
  __constant sampler_t sampler1 =
      CLK_NORMALIZED_COORDS_FALSE
    | CLK_ADDRESS_CLAMP_TO_EDGE
    | CLK_FILTER_NEAREST;

	float4 spatial_predictor(
    float4 a, float4 b, float4 c, float4 d,
    float4 e, float4 f, float4 g, float4 h,
    float4 i, float4 j, float4 k, float4 l,
    float4 m, float4 n
  ) {
    float4 spatialPred = (d + k) / 2.0f;
    float4 spatialScore = fabs(c - j) + fabs(d - k) + fabs(e - l);

		float4 score = fabs(b - k) + fabs(c - l) + fabs(d - m);
    int4 compareScore = score < spatialScore;
    spatialPred = compareScore ? (c + l) / 2.0f : spatialPred;
    spatialScore = compareScore ? score : spatialScore;
    score = compareScore ? fabs(a - l) + fabs(b - m) + fabs(c - n) : score;
    compareScore = compareScore && (score < spatialScore);
    spatialPred = compareScore ? (b + m) / 2.0f : spatialPred;
    spatialScore = compareScore ? score : spatialScore;

		score = fabs(d - i) + fabs(e - j) + fabs(f - k);
    compareScore = score < spatialScore;
    spatialPred = compareScore ? (e + j) / 2.0f : spatialPred;
    spatialScore = compareScore ? score : spatialScore;
    score = compareScore ? fabs(e - h) + fabs(f - i) + fabs(g - j) : score;
    compareScore = compareScore && (score < spatialScore);
    spatialPred = compareScore ? (f + i) / 2.0f : spatialPred;
    spatialScore = compareScore ? score : spatialScore;

		return spatialPred;
  }

	float4 fmax3(float4 a, float4 b, float4 c) {
    return fmax(fmax(a, b), c);
  }

	float4 fmin3(float4 a, float4 b, float4 c) {
    return fmin(fmin(a, b), c);
  }

	float4 temporal_predictor(
    float4 A, float4 B, float4 C, float4 D,
    float4 E, float4 F, float4 G, float4 H,
    float4 I, float4 J, float4 K, float4 L,
    float4 spatialPred, int skipCheck
  ) {
    float4 p0 = (C + H) / 2.0f;
    float4 p1 = F;
    float4 p2 = (D + I) / 2.0f;
    float4 p3 = G;
    float4 p4 = (E + J) / 2.0f;

		float4 tdiff0 = fabs(D - I);
    float4 tdiff1 = (fabs(A - F) + fabs(B - G)) / 2.0f;
    float4 tdiff2 = (fabs(K - F) + fabs(G - L)) / 2.0f;

		float4 diff = fmax3(tdiff0, tdiff1, tdiff2);

		if (!skipCheck) {
      float4 p2mp3 = p2 - p3;
      float4 p2mp1 = p2 - p1;
      float4 p0mp1 = p0 - p1;
      float4 p4mp3 = p4 - p3;
      float4 maxi = fmax3(p2mp3, p2mp1, fmin(p0mp1, p4mp3));
      float4 mini = fmin3(p2mp3, p2mp1, fmax(p0mp1, p4mp3));
      diff = fmax3(diff, mini, -maxi);
    }

		spatialPred = (spatialPred > (p2 + diff)) ? p2 + diff : spatialPred;
    spatialPred = (spatialPred < (p2 - diff)) ? p2 - diff : spatialPred;
    return spatialPred;
  }

	__kernel void yadif(
    __read_only image2d_t prev,
    __read_only image2d_t cur,
    __read_only image2d_t next,
    __private int parity,
    __private int tff,
    __private int skipSpatial,
    __write_only image2d_t output) {

		int xo = get_global_id(0);
    int yo = get_global_id(1);

		// Don't modify the primary field
    if (yo % 2 == parity) {
      write_imagef(output, (int2)(xo, yo), read_imagef(cur, sampler1, (int2) (xo, yo)));
      return;
    }

		// Calculate spatial prediction
    float4 a = read_imagef(cur, sampler1, (int2) (xo - 3, yo - 1));
    float4 b = read_imagef(cur, sampler1, (int2) (xo - 2, yo - 1));
    float4 c = read_imagef(cur, sampler1, (int2) (xo - 1, yo - 1));
    float4 d = read_imagef(cur, sampler1, (int2) (xo - 0, yo - 1));
    float4 e = read_imagef(cur, sampler1, (int2) (xo + 1, yo - 1));
    float4 f = read_imagef(cur, sampler1, (int2) (xo + 2, yo - 1));
    float4 g = read_imagef(cur, sampler1, (int2) (xo + 3, yo - 1));

		float4 h = read_imagef(cur, sampler1, (int2) (xo - 3, yo + 1));
    float4 i = read_imagef(cur, sampler1, (int2) (xo - 2, yo + 1));
    float4 j = read_imagef(cur, sampler1, (int2) (xo - 1, yo + 1));
    float4 k = read_imagef(cur, sampler1, (int2) (xo - 0, yo + 1));
    float4 l = read_imagef(cur, sampler1, (int2) (xo + 1, yo + 1));
    float4 m = read_imagef(cur, sampler1, (int2) (xo + 2, yo + 1));
    float4 n = read_imagef(cur, sampler1, (int2) (xo + 3, yo + 1));

		float4 spatialPred =
      spatial_predictor(a, b, c, d, e, f, g, h, i, j, k, l, m, n);

		// Calculate temporal prediction
    int isSecondField = !(parity ^ tff);

		float4 A = read_imagef(prev, sampler1, (int2) (xo, yo - 1));
		float4 B = read_imagef(prev, sampler1, (int2) (xo, yo + 1));
		float4 C = isSecondField ? read_imagef(cur, sampler1, (int2) (xo, yo - 2)) : read_imagef(prev, sampler1, (int2) (xo, yo - 2));
    float4 D = isSecondField ? read_imagef(cur, sampler1, (int2) (xo, yo + 0)) : read_imagef(prev, sampler1, (int2) (xo, yo + 0));
    float4 E = isSecondField ? read_imagef(cur, sampler1, (int2) (xo, yo + 2)) : read_imagef(prev, sampler1, (int2) (xo, yo + 2));
    float4 F = read_imagef(cur, sampler1, (int2) (xo, yo - 1));
    float4 G = read_imagef(cur, sampler1, (int2) (xo, yo + 1));
    float4 H = isSecondField ? read_imagef(next, sampler1, (int2) (xo, yo - 2)) : read_imagef(cur, sampler1, (int2) (xo, yo - 2));
    float4 I = isSecondField ? read_imagef(next, sampler1, (int2) (xo, yo + 0)) : read_imagef(cur, sampler1, (int2) (xo, yo + 0));
    float4 J = isSecondField ? read_imagef(next, sampler1, (int2) (xo, yo + 2)) : read_imagef(cur, sampler1, (int2) (xo, yo + 2));
    float4 K = read_imagef(next, sampler1, (int2) (xo, yo - 1));
    float4 L = read_imagef(next, sampler1, (int2) (xo, yo + 1));

		spatialPred = temporal_predictor(
      A, B, C, D, E, F, G, H, I, J, K, L,
      spatialPred, skipSpatial
    );
		// Reset Alpha
    spatialPred.s3 = read_imagef(cur, sampler1, (int2) (xo, yo)).s3;

		write_imagef(output, (int2)(xo, yo), spatialPred);
  };
`

export default class YadifCL extends ProcessImpl {
	constructor(width: number, height: number) {
		super('yadif', width, height, yadifKernel, 'yadif')
	}

	async init(): Promise<void> {
		return Promise.resolve()
	}

	async getKernelParams(params: KernelParams): Promise<KernelParams> {
		return Promise.resolve({
			prev: params.prev,
			cur: params.cur,
			next: params.next,
			parity: params.parity,
			tff: params.tff,
			skipSpatial: (params.skipSpatial as boolean) ? 1 : 0,
			output: params.output
		})
	}
}
