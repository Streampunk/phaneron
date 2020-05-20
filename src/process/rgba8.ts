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

const rgba8Kernel = `
  __kernel void read(__global uchar4* restrict input,
                     __global float4* restrict output,
                     __private unsigned int width,
                     __global float* restrict gammaLut,
                     __constant float4* restrict gamutMatrix) {
    uint item = get_global_id(0);
    bool lastItemOnLine = get_local_id(0) == get_local_size(0) - 1;

    // 64 output pixels per workItem
    uint numPixels = lastItemOnLine && (0 != width % 64) ? width % 64 : 64;
    uint numLoops = numPixels;

    uint inOff = 64 * item;
    uint outOff = width * get_group_id(0) + get_local_id(0) * 64;

    // optimise loading of the 3x3 gamut matrix
    float4 gamutMat0 = gamutMatrix[0];
    float4 gamutMat1 = gamutMatrix[1];
    float4 gamutMat2 = gamutMatrix[2];
    float3 gamutMatR = (float3)(gamutMat0.s0, gamutMat0.s1, gamutMat0.s2);
    float3 gamutMatG = (float3)(gamutMat0.s3, gamutMat1.s0, gamutMat1.s1);
    float3 gamutMatB = (float3)(gamutMat1.s2, gamutMat1.s3, gamutMat2.s0);

    for (uint i=0; i<numLoops; ++i) {
      uchar4 rgba8 = input[inOff];
      float4 rgba_f = convert_float4(rgba8);

      float3 rgb;
      rgb.s0 = gammaLut[convert_ushort_sat_rte(rgba_f.s0 * 65535.0f / 255.0f)];
      rgb.s1 = gammaLut[convert_ushort_sat_rte(rgba_f.s1 * 65535.0f / 255.0f)];
      rgb.s2 = gammaLut[convert_ushort_sat_rte(rgba_f.s2 * 65535.0f / 255.0f)];

      float4 rgba;
      rgba.s0 = dot(rgb, gamutMatR);
      rgba.s1 = dot(rgb, gamutMatG);
      rgba.s2 = dot(rgb, gamutMatB);
      rgba.s3 = gammaLut[convert_ushort_sat_rte(rgba_f.s3 * 65535.0f / 255.0f)];
      output[outOff] = rgba;

      inOff++;
      outOff++;
    }
  }

  __kernel void write(__global float4* restrict input,
                      __global uchar4* restrict output,
                      __private unsigned int width,
                      __private unsigned int interlace,
                      __global float* restrict gammaLut) {
    bool lastItemOnLine = get_local_id(0) == get_local_size(0) - 1;

    // 64 input pixels per workItem
    uint numPixels = lastItemOnLine && (0 != width % 64) ? width % 64 : 64;
    uint numLoops = numPixels;

    uint interlaceOff = (3 == interlace) ? 1 : 0;
		uint line = get_group_id(0) * ((0 == interlace) ? 1 : 2) + interlaceOff;
    uint inOff = width * line + get_local_id(0) * 64;
		uint outOff = width * line + get_local_id(0) * 64;

    for (uint i=0; i<numLoops; ++i) {
      uchar4 rgba;

      float4 rgba_l = input[inOff];
      float3 rgb_f;
      rgb_f.s0 = gammaLut[convert_ushort_sat_rte(rgba_l.s0 * 65535.0f)];
      rgb_f.s1 = gammaLut[convert_ushort_sat_rte(rgba_l.s1 * 65535.0f)];
      rgb_f.s2 = gammaLut[convert_ushort_sat_rte(rgba_l.s2 * 65535.0f)];

      rgba.s0 = convert_uchar_sat_rte(rgb_f.s0 * 255.0f);
      rgba.s1 = convert_uchar_sat_rte(rgb_f.s1 * 255.0f);
      rgba.s2 = convert_uchar_sat_rte(rgb_f.s2 * 255.0f);
      rgba.s3 = 255;
      output[outOff] = rgba;

      inOff++;
      outOff++;
    }
  }
`

function getPitch(width: number): number {
	return width
}

export function getPitchBytes(width: number): number {
	return getPitch(width) * 4
}

export function fillBuf(buf: OpenCLBuffer, width: number, height: number): void {
	const pitchBytes = getPitchBytes(width)
	let off = 0

	buf.fill(0)
	const R = 16
	const G = 32
	const B = 64
	const A = 255
	for (let y = 0; y < height; ++y) {
		let xOff = 0
		for (let x = 0; x < width; ++x) {
			buf.writeUInt8(R, off + xOff++)
			buf.writeUInt8(G, off + xOff++)
			buf.writeUInt8(B, off + xOff++)
			buf.writeUInt8(A, off + xOff++)
		}
		off += pitchBytes
	}
}

export function dumpBuf(buf: OpenCLBuffer, width: number, numLines: number): void {
	const pitchBytes = getPitchBytes(width)

	let lineOff = 0
	function getRHex(off: number): string {
		return buf.readUInt8(lineOff + off * 4 + 0).toString(16)
	}
	function getGHex(off: number): string {
		return buf.readUInt8(lineOff + off * 4 + 1).toString(16)
	}
	function getBHex(off: number): string {
		return buf.readUInt8(lineOff + off * 4 + 2).toString(16)
	}
	function getAHex(off: number): string {
		return buf.readUInt8(lineOff + off * 4 + 3).toString(16)
	}

	for (let l = 0; l < numLines; ++l) {
		lineOff = pitchBytes * l
		console.log(
			`Line ${l}: ${getRHex(0)}, ${getGHex(0)}, ${getBHex(0)}, ${getAHex(0)}; ${getRHex(
				1
			)}, ${getGHex(1)}, ${getBHex(1)}, ${getAHex(1)}; ${getRHex(2)}, ${getGHex(2)}, ${getBHex(
				2
			)}, ${getAHex(2)}; ${getRHex(3)}, ${getGHex(3)}, ${getBHex(3)}, ${getAHex(3)}`
		)
	}
}

// process one image line per work group
const pixelsPerWorkItem = 64

export class Reader extends PackImpl {
	constructor(width: number, height: number) {
		super('rgba8', width, height, rgba8Kernel, 'read')
		this.numBits = 8
		this.numBytes = [getPitchBytes(this.width) * this.height]
		this.workItemsPerGroup = getPitch(this.width) / pixelsPerWorkItem
		this.globalWorkItems = this.workItemsPerGroup * this.height
	}

	getKernelParams(params: KernelParams): KernelParams {
		const srcArray: Array<OpenCLBuffer> = params.sources as Array<OpenCLBuffer>
		if (srcArray.length !== 1)
			throw new Error(`Reader for ${this.name} requires 'sources' parameter with 1 OpenCL buffer`)
		return {
			input: srcArray[0],
			output: params.dest,
			width: this.width,
			gammaLut: params.gammaLut,
			gamutMatrix: params.gamutMatrix
		}
	}
}

export class Writer extends PackImpl {
	constructor(width: number, height: number, interlaced: boolean) {
		super('rgba8', width, height, rgba8Kernel, 'write')
		this.interlaced = interlaced
		this.numBits = 8
		this.numBytes = [getPitchBytes(this.width) * this.height]
		this.workItemsPerGroup = getPitch(this.width) / pixelsPerWorkItem
		this.globalWorkItems = (this.workItemsPerGroup * this.height) / (this.interlaced ? 2 : 1)
	}

	getKernelParams(params: KernelParams): KernelParams {
		const dstArray: Array<OpenCLBuffer> = params.dests as Array<OpenCLBuffer>
		if (dstArray.length !== 1)
			throw new Error(`Writer for ${this.name} requires 'dests' parameter with 1 OpenCL buffer`)
		return {
			input: params.source,
			output: dstArray[0],
			width: this.width,
			interlace: this.interlaced ? (params.interlace as Interlace) : Interlace.Progressive,
			gammaLut: params.gammaLut
		}
	}
}
