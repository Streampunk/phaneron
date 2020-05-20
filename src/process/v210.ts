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

import { PackImpl, Interlace } from './packer'
import { KernelParams, OpenCLBuffer } from 'nodencl'

const v210Kernel = `
  __kernel void read(__global uint4* restrict input,
                     __global float4* restrict output,
                     __private unsigned int width,
                     __constant float4* restrict colMatrix,
                     __global float* restrict gammaLut,
                     __constant float4* restrict gamutMatrix) {
    uint item = get_global_id(0);
    bool lastItemOnLine = get_local_id(0) == get_local_size(0) - 1;

    // 48 pixels per workItem = 8 input uint4s per work item
    uint numPixels = lastItemOnLine && (0 != width % 48) ? width % 48 : 48;
    uint numLoops = numPixels / 6;
    uint remain = numPixels % 6;

    uint inOff = 8 * item;
    uint outOff = width * get_group_id(0) + get_local_id(0) * 48;

    float4 colMatR = colMatrix[0];
    float4 colMatG = colMatrix[1];
    float4 colMatB = colMatrix[2];

    // optimise loading of the 3x3 gamut matrix
    float4 gamutMat0 = gamutMatrix[0];
    float4 gamutMat1 = gamutMatrix[1];
    float4 gamutMat2 = gamutMatrix[2];
    float3 gamutMatR = (float3)(gamutMat0.s0, gamutMat0.s1, gamutMat0.s2);
    float3 gamutMatG = (float3)(gamutMat0.s3, gamutMat1.s0, gamutMat1.s1);
    float3 gamutMatB = (float3)(gamutMat1.s2, gamutMat1.s3, gamutMat2.s0);

    for (uint i=0; i<numLoops; ++i) {
      uint4 w = input[inOff];

      ushort4 yuva[6];
      yuva[0] = (ushort4)((w.s0 >> 10) & 0x3ff, w.s0 & 0x3ff, (w.s0 >> 20) & 0x3ff, 1);
      yuva[1] = (ushort4)(w.s1 & 0x3ff, yuva[0].s1, yuva[0].s2, 1);
      yuva[2] = (ushort4)((w.s1 >> 20) & 0x3ff, (w.s1 >> 10) & 0x3ff, w.s2 & 0x3ff, 1);
      yuva[3] = (ushort4)((w.s2 >> 10) & 0x3ff, yuva[2].s1, yuva[2].s2, 1);
      yuva[4] = (ushort4)(w.s3 & 0x3ff, (w.s2 >> 20) & 0x3ff, (w.s3 >> 10) & 0x3ff, 1);
      yuva[5] = (ushort4)((w.s3 >> 20) & 0x3ff, yuva[4].s1, yuva[4].s2, 1);

      for (uint p=0; p<6; ++p) {
        float4 yuva_f = convert_float4(yuva[p]);
        float3 rgb;
        rgb.s0 = gammaLut[convert_ushort_sat_rte(dot(yuva_f, colMatR) * 65535.0f)];
        rgb.s1 = gammaLut[convert_ushort_sat_rte(dot(yuva_f, colMatG) * 65535.0f)];
        rgb.s2 = gammaLut[convert_ushort_sat_rte(dot(yuva_f, colMatB) * 65535.0f)];

        float4 rgba;
        rgba.s0 = dot(rgb, gamutMatR);
        rgba.s1 = dot(rgb, gamutMatG);
        rgba.s2 = dot(rgb, gamutMatB);
        rgba.s3 = 1.0f;
        output[outOff+p] = rgba;
      }

      inOff++;
      outOff+=6;
    }

    if (remain > 0) {
      uint4 w = input[inOff];

      ushort4 yuva[4];
      yuva[0] = (ushort4)((w.s0 >> 10) & 0x3ff, w.s0 & 0x3ff, (w.s0 >> 20) & 0x3ff, 0);
      yuva[1] = (ushort4)(w.s1 & 0x3ff, yuva[0].s1, yuva[0].s2, 0);

      if (4 == remain) {
        yuva[2] = (ushort4)((w.s1 >> 20) & 0x3ff, (w.s1 >> 10) & 0x3ff, w.s2 & 0x3ff, 0);
        yuva[3] = (ushort4)((w.s2 >> 10) & 0x3ff, yuva[2].s1, yuva[2].s2, 0);
      }

      for (uint p=0; p<remain; ++p) {
        float4 yuva_f = convert_float4(yuva[p]);
        float3 rgb;
        rgb.s0 = gammaLut[convert_ushort_sat_rte(dot(yuva_f, colMatR) * 65535.0f)];
        rgb.s1 = gammaLut[convert_ushort_sat_rte(dot(yuva_f, colMatG) * 65535.0f)];
        rgb.s2 = gammaLut[convert_ushort_sat_rte(dot(yuva_f, colMatB) * 65535.0f)];

        float4 rgba;
        rgba.s0 = dot(rgb, gamutMatR);
        rgba.s1 = dot(rgb, gamutMatG);
        rgba.s2 = dot(rgb, gamutMatB);
        rgba.s3 = 1.0f;
        output[outOff+p] = rgba;
      }
    }
  }

  __kernel void write(__global float4* restrict input,
                      __global uint4* restrict output,
                      __private unsigned int width,
                      __private unsigned int interlace,
                      __constant float4* restrict colMatrix,
                      __global float* restrict gammaLut) {
    bool lastItemOnLine = get_local_id(0) == get_local_size(0) - 1;

    // 48 pixels per workItem = 8 output uint4s per work item
    uint numPixels = lastItemOnLine && (0 != width % 48) ? width % 48 : 48;
    uint numLoops = numPixels / 6;
    uint remain = numPixels % 6;

		uint interlaceOff = (3 == interlace) ? 1 : 0;
		uint line = get_group_id(0) * ((0 == interlace) ? 1 : 2) + interlaceOff;
    uint inOff = width * line + get_local_id(0) * 48;
		uint outOff = width * line / 6 + get_local_id(0) * 8;

    if (48 != numPixels) {
      // clear the output buffer for the last item, partially overwritten below
      uint clearOff = outOff;
      for (uint i=0; i<8; ++i)
        output[clearOff++] = (uint4)(0, 0, 0, 0);
    }

    float4 matY = colMatrix[0];
    float4 matU = colMatrix[1];
    float4 matV = colMatrix[2];

    for (uint i=0; i<numLoops; ++i) {
      ushort3 yuv[6];

      for (uint p=0; p<6; ++p) {
        float4 rgba_l = input[inOff+p];
        float4 rgba;
        rgba.s0 = gammaLut[convert_ushort_sat_rte(rgba_l.s0 * 65535.0f)];
        rgba.s1 = gammaLut[convert_ushort_sat_rte(rgba_l.s1 * 65535.0f)];
        rgba.s2 = gammaLut[convert_ushort_sat_rte(rgba_l.s2 * 65535.0f)];
        rgba.s3 = 1.0f;

        yuv[p].s0 = convert_ushort_sat_rte(dot(rgba, matY));
        yuv[p].s1 = convert_ushort_sat_rte(dot(rgba, matU));
        yuv[p].s2 = convert_ushort_sat_rte(dot(rgba, matV));
      }

      uint4 w;
      w.s0 = yuv[0].s2 << 20 | yuv[0].s0 << 10 | yuv[0].s1;
      w.s1 = yuv[2].s0 << 20 | yuv[2].s1 << 10 | yuv[1].s0;
      w.s2 = yuv[4].s1 << 20 | yuv[3].s0 << 10 | yuv[2].s2;
      w.s3 = yuv[5].s0 << 20 | yuv[4].s2 << 10 | yuv[4].s0;
      output[outOff] = w;

      inOff+=6;
      outOff++;
    }

    if (remain > 0) {
      uint4 w = (uint4)(0, 0, 0, 0);

      ushort3 yuv[4];
      for (uint p=0; p<remain; ++p) {
        float4 rgba_l = input[inOff+p];
        float4 rgba;
        rgba.s0 = gammaLut[convert_ushort_sat_rtz(rgba_l.s0 * 65535.0f)];
        rgba.s1 = gammaLut[convert_ushort_sat_rtz(rgba_l.s1 * 65535.0f)];
        rgba.s2 = gammaLut[convert_ushort_sat_rtz(rgba_l.s2 * 65535.0f)];
        rgba.s3 = 1.0;

        yuv[p].s0 = convert_ushort_sat(round(dot(rgba, matY)));
        yuv[p].s1 = convert_ushort_sat(round(dot(rgba, matU)));
        yuv[p].s2 = convert_ushort_sat(round(dot(rgba, matV)));
      }

      w.s0 = yuv[0].s2 << 20 | yuv[0].s0 << 10 | yuv[0].s1;
      if (2 == remain) {
        w.s1 = yuv[1].s0;
      } else if (4 == remain) {
        w.s1 = yuv[2].s0 << 20 | yuv[2].s1 << 10 | yuv[1].s0;
        w.s2 = yuv[3].s0 << 10 | yuv[2].s2;
      }
      output[outOff] = w;
    }
  }
`

function getPitch(width: number): number {
	return width + 47 - ((width - 1) % 48)
}

function getPitchBytes(width: number): number {
	return (getPitch(width) * 8) / 3
}

export function fillBuf(buf: Buffer, width: number, height: number): void {
	const pitchBytes = getPitchBytes(width)
	buf.fill(0)
	let Y = 64
	const Cb = 512
	const Cr = 512
	let yOff = 0
	for (let y = 0; y < height; ++y) {
		let xOff = 0
		for (let x = 0; x < (width - (width % 6)) / 6; ++x) {
			buf.writeUInt32LE((Cr << 20) | (Y << 10) | Cb, yOff + xOff)
			buf.writeUInt32LE((Y << 20) | (Cb << 10) | Y, yOff + xOff + 4)
			buf.writeUInt32LE((Cb << 20) | (Y << 10) | Cr, yOff + xOff + 8)
			buf.writeUInt32LE((Y << 20) | (Cr << 10) | Y, yOff + xOff + 12)
			xOff += 16
			Y = 940 == Y ? 64 : ++Y
		}

		const remain = width % 6
		if (remain) {
			buf.writeUInt32LE((Cr << 20) | (Y << 10) | Cb, yOff + xOff)
			if (2 === remain) {
				buf.writeUInt32LE(Y, yOff + xOff + 4)
			} else if (4 === remain) {
				buf.writeUInt32LE((Y << 20) | (Cb << 10) | Y, yOff + xOff + 4)
				buf.writeUInt32LE((Y << 10) | Cr, yOff + xOff + 8)
			}
		}
		yOff += pitchBytes
	}
}

export function dumpBufUnpack(
	buf: OpenCLBuffer,
	width: number,
	numPixels: number,
	numLines: number
): void {
	const pitchBytes = getPitchBytes(width)
	let yOff = 0
	for (let y = 0; y < numLines; ++y) {
		let xOff = 0
		let s = `Line ${y}: `
		for (let x = 0; x < numPixels / 6; ++x) {
			const w0 = buf.readUInt32LE(yOff + xOff)
			const w1 = buf.readUInt32LE(yOff + xOff + 4)
			const w2 = buf.readUInt32LE(yOff + xOff + 8)
			const w3 = buf.readUInt32LE(yOff + xOff + 12)
			s += `${w0 & 0x3ff} ${(w0 >> 10) & 0x3ff} ${(w0 >> 20) & 0x3ff} ${w1 & 0x3ff}, `
			s += `${(w1 >> 10) & 0x3ff} ${(w1 >> 20) & 0x3ff} ${w2 & 0x3ff} ${(w2 >> 10) & 0x3ff}, `
			s += `${(w2 >> 20) & 0x3ff} ${w3 & 0x3ff} ${(w3 >> 10) & 0x3ff} ${(w3 >> 20) & 0x3ff}`
			xOff += 16
		}
		console.log(s)
		yOff += pitchBytes
	}
}

export function dumpBuf(buf: Buffer, width: number, numLines: number): void {
	let lineOff = 0
	function getHex(off: number): string {
		return buf.readUInt32LE(lineOff + off).toString(16)
	}

	const pitch = getPitchBytes(width)
	for (let l = 0; l < numLines; ++l) {
		lineOff = l * pitch
		console.log(
			`Line ${l}: ${getHex(0)}, ${getHex(4)}, ${getHex(8)}, ${getHex(12)} ... ${getHex(
				128 + 0
			)}, ${getHex(128 + 4)}, ${getHex(128 + 8)}, ${getHex(128 + 12)}`
		)
	}
}

// process one image line per work group
const pixelsPerWorkItem = 48

export class Reader extends PackImpl {
	constructor(width: number, height: number) {
		super('v210', width, height, v210Kernel, 'read')
		this.numBits = 10
		this.lumaBlack = 64
		this.lumaWhite = 940
		this.chromaRange = 896
		this.isRGB = false
		this.numBytes = [getPitchBytes(this.width) * this.height]
		this.workItemsPerGroup = getPitch(this.width) / pixelsPerWorkItem
		this.globalWorkItems = this.workItemsPerGroup * this.height
	}

	getKernelParams(params: KernelParams): KernelParams {
		const srcArray: Array<OpenCLBuffer> = params.sources as Array<OpenCLBuffer>
		if (srcArray.length !== 1)
			throw new Error(`Reader for ${this.name} requires sources parameter with 1 OpenCL buffer`)
		return {
			input: srcArray[0],
			output: params.dest,
			width: this.width,
			colMatrix: params.colMatrix,
			gammaLut: params.gammaLut,
			gamutMatrix: params.gamutMatrix
		}
	}
}

export class Writer extends PackImpl {
	constructor(width: number, height: number, interlaced: boolean) {
		super('v210', width, height, v210Kernel, 'write')
		this.interlaced = interlaced
		this.numBits = 10
		this.lumaBlack = 64
		this.lumaWhite = 940
		this.chromaRange = 896
		this.isRGB = false
		this.numBytes = [getPitchBytes(this.width) * this.height]
		this.workItemsPerGroup = getPitch(this.width) / pixelsPerWorkItem
		this.globalWorkItems = (this.workItemsPerGroup * this.height) / (this.interlaced ? 2 : 1)
	}

	getKernelParams(params: KernelParams): KernelParams {
		const dstArray: Array<OpenCLBuffer> = params.dests as Array<OpenCLBuffer>
		if (dstArray.length !== 1)
			throw new Error(`Writer for ${this.name} requires dests parameter with 1 OpenCL buffer`)
		return {
			input: params.source,
			output: dstArray[0],
			width: this.width,
			interlace: this.interlaced ? (params.interlace as Interlace) : Interlace.Progressive,
			colMatrix: params.colMatrix,
			gammaLut: params.gammaLut
		}
	}
}
