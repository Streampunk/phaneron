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

const nv12Kernel = `
	__kernel void read(__global uchar8* restrict inputY,
								  	 __global uchar8* restrict inputC,
										 __global float4* restrict output,
										 __private unsigned int width,
										 __constant float4* restrict colMatrix,
										 __global float* restrict gammaLut,
										 __constant float4* restrict gamutMatrix) {
		bool lastItemOnLine = get_local_id(0) == get_local_size(0) - 1;

		// 64 output pixels per workItem = 8 input luma uchar8s per work item, 8 input chroma uchar8s per work item
		uint numPixels = lastItemOnLine && (0 != width % 64) ? width % 64 : 64;
		uint numLoops = numPixels / 8;
		uint remain = numPixels % 8;

		uint pitchReads = (width + 7) / 8;
		uint inOffY[2];
		inOffY[0] = 8 * get_local_id(0) + pitchReads * get_group_id(0) * 2;
		inOffY[1] = inOffY[0] + pitchReads;
		uint inOffC = 8 * get_local_id(0) + pitchReads * get_group_id(0);

		uint outOff[2];
		outOff[0] = 64 * get_local_id(0) + width * get_group_id(0) * 2;
		outOff[1] = outOff[0] + width;

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
			uchar8 c = inputC[inOffC];

			for (uint l=0; l<2; ++l) {
				uchar8 y = inputY[inOffY[l]];
				uchar4 yuva[8];
				yuva[0] = (uchar4)(y.s0, c.s0, c.s1, 1);
				yuva[1] = (uchar4)(y.s1, c.s0, c.s1, 1);
				yuva[2] = (uchar4)(y.s2, c.s2, c.s3, 1);
				yuva[3] = (uchar4)(y.s3, c.s2, c.s3, 1);
				yuva[4] = (uchar4)(y.s4, c.s4, c.s5, 1);
				yuva[5] = (uchar4)(y.s5, c.s4, c.s5, 1);
				yuva[6] = (uchar4)(y.s6, c.s6, c.s7, 1);
				yuva[7] = (uchar4)(y.s7, c.s6, c.s7, 1);

				for (uint p=0; p<8; ++p) {
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

					output[outOff[l]+p] = rgba;
				}

				inOffY[l]++;
				outOff[l]+=8;
			}

			inOffC++;
		}

		if (remain > 0) {
			uchar8 c = inputC[inOffC];

			for (uint l=0; l<2; ++l) {
				uchar8 y = inputY[inOffY[l]];
				uchar4 yuva[6];
				yuva[0] = (uchar4)(y.s0, c.s0, c.s1, 1);
				yuva[1] = (uchar4)(y.s1, c.s0, c.s1, 1);

				if (remain > 2) {
					yuva[2] = (uchar4)(y.s2, c.s2, c.s3, 1);
					yuva[3] = (uchar4)(y.s3, c.s2, c.s3, 1);

					if (remain > 4) {
						yuva[4] = (uchar4)(y.s4, c.s4, c.s5, 1);
						yuva[5] = (uchar4)(y.s5, c.s4, c.s5, 1);
					}
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

					output[outOff[l]+p] = rgba;
				}
			}
		}
	}

	__kernel void write(__global float4* restrict input,
											__global uchar8* restrict outputY,
											__global uchar8* restrict outputC,
											__private unsigned int width,
											__private unsigned int interlace,
											__constant float4* restrict colMatrix,
											__global float* restrict gammaLut) {
		bool lastItemOnLine = get_local_id(0) == get_local_size(0) - 1;

		// 64 input pixels per workItem = 8 input luma uchar8s per work item, 8 each u & v uchar4s per work item
		uint numPixels = lastItemOnLine && (0 != width % 64) ? width % 64 : 64;
		uint numLoops = numPixels / 8;
		uint remain = numPixels % 8;

		uint interlaceOff = (3 == interlace) ? 1 : 0;
		uint line = get_group_id(0) * 2 + interlaceOff;
		uint numLines = (0 == interlace) ? 2 : 1;

		uint inOff[2];
		inOff[0] = 64 * get_local_id(0) + width * line;
		inOff[1] = inOff[0] + width;

		uint pitchReads = (width + 7) / 8;
		uint outOffY[2];
		outOffY[0] = 8 * get_local_id(0) + pitchReads * line;
		outOffY[1] = outOffY[0] + pitchReads;
		uint outOffC = 8 * get_local_id(0) + pitchReads * get_group_id(0);

		float4 matY = colMatrix[0];
		float4 matU = colMatrix[1];
		float4 matV = colMatrix[2];

		for (uint l=0; l<numLines; ++l) {
			for (uint i=0; i<numLoops; ++i) {
				uchar3 yuv[8];

				for (uint p=0; p<8; ++p) {
					float4 rgba_l = input[inOff[l]+p];
					float4 rgba;
					rgba.s0 = gammaLut[convert_ushort_sat_rte(rgba_l.s0 * 65535.0f)];
					rgba.s1 = gammaLut[convert_ushort_sat_rte(rgba_l.s1 * 65535.0f)];
					rgba.s2 = gammaLut[convert_ushort_sat_rte(rgba_l.s2 * 65535.0f)];
					rgba.s3 = 1.0f;

					yuv[p].s0 = convert_ushort_sat_rte(dot(rgba, matY));
					yuv[p].s1 = convert_ushort_sat_rte(dot(rgba, matU));
					yuv[p].s2 = convert_ushort_sat_rte(dot(rgba, matV));
				}
				inOff[l]+=8;

				uchar8 y = (uchar8)(yuv[0].s0, yuv[1].s0, yuv[2].s0, yuv[3].s0, yuv[4].s0, yuv[5].s0, yuv[6].s0, yuv[7].s0);
				uchar8 c = (uchar8)(yuv[0].s1, yuv[0].s2, yuv[2].s1, yuv[2].s2, yuv[4].s1, yuv[4].s2, yuv[6].s1, yuv[6].s2);
				outputY[outOffY[l]] = y;
				outOffY[l]++;

				if (l == 0) {
					outputC[outOffC] = c;
					outOffC++;
				}
			}
		}

		if (remain > 0) {
			for (uint l=0; l<numLines; ++l) {
				uchar8 y = (uchar8)(16, 16, 16, 16, 16, 16, 16, 16);
				uchar8 c = (uchar8)(128, 128, 128, 128, 128, 128, 128, 128);

				uchar3 yuv[6];
				for (uint p=0; p<remain; ++p) {
					float4 rgba_l = input[inOff[l]+p];
					float4 rgba;
					rgba.s0 = gammaLut[convert_ushort_sat_rte(rgba_l.s0 * 65535.0f)];
					rgba.s1 = gammaLut[convert_ushort_sat_rte(rgba_l.s1 * 65535.0f)];
					rgba.s2 = gammaLut[convert_ushort_sat_rte(rgba_l.s2 * 65535.0f)];
					rgba.s3 = 1.0;

					yuv[p].s0 = convert_ushort_sat_rte(round(dot(rgba, matY)));
					yuv[p].s1 = convert_ushort_sat_rte(round(dot(rgba, matU)));
					yuv[p].s2 = convert_ushort_sat_rte(round(dot(rgba, matV)));
				}

				y.s0 = yuv[0].s0;
				y.s1 = yuv[1].s0;
				c.s0 = yuv[0].s1;
				c.s1 = yuv[0].s2;
				if (remain > 2) {
					y.s2 = yuv[2].s0;
					y.s3 = yuv[3].s0;
					c.s2 = yuv[2].s1;
					c.s3 = yuv[2].s2;
					if (remain > 4) {
						y.s4 = yuv[4].s0;
						y.s5 = yuv[5].s0;
						c.s4 = yuv[4].s1;
						c.s5 = yuv[4].s2;
					}
				}

				outputY[outOffY[l]] = y;
				if (l == 0) {
					outputC[outOffC] = c;
				}
			}
		}
	}
`

const getPitch = (width: number): number => width + 7 - ((width - 1) % 8)
const getPitchBytes = (width: number): number => getPitch(width)

export const fillBuf = (buf: Buffer, width: number, height: number): void => {
	const lumaPitchBytes = getPitchBytes(width)
	const chromaPitchBytes = lumaPitchBytes
	let lOff = 0
	let cOff = lumaPitchBytes * height

	buf.fill(16, lOff)
	buf.fill(128, cOff) // fills both u and v
	let Y0 = 16
	let Y1 = 234
	const Cb = 128
	const Cr = 128
	for (let y = 0; y < height; y += 2) {
		let xlOff = 0
		let xcOff = 0
		for (let x = 0; x < width; x += 2) {
			buf.writeUInt8(Y0, lOff + xlOff)
			buf.writeUInt8(Y0 + 1, lOff + xlOff + 1)
			buf.writeUInt8(Y1 + 1, lumaPitchBytes + lOff + xlOff)
			buf.writeUInt8(Y1, lumaPitchBytes + lOff + xlOff + 1)
			xlOff += 2

			buf.writeUInt8(Cb, cOff + xcOff)
			buf.writeUInt8(Cr, cOff + xcOff + 1)
			xcOff += 2

			Y0 = 234 == Y0 ? 16 : (Y0 += 2)
			Y1 = 16 == Y1 ? 234 : (Y1 -= 2)
		}
		lOff += lumaPitchBytes * 2
		cOff += chromaPitchBytes
	}
}

export const dumpBuf = (
	buf: Buffer,
	width: number,
	height: number,
	numLines: number,
	lineEnds?: boolean
): void => {
	console.log()

	const lumaPitchBytes = getPitchBytes(width)
	const chromaPitchBytes = lumaPitchBytes

	let y0LineOff = 0
	let y1LineOff = 0
	let cLineOff = lumaPitchBytes * height

	const getYHex = (line: number, off: number): string =>
		buf.readUInt8((line % 2 ? y1LineOff : y0LineOff) + off).toString(16)
	const getUHex = (off: number): string => buf.readUInt8(cLineOff + off).toString(16)
	const getVHex = (off: number): string => buf.readUInt8(cLineOff + off + 1).toString(16)

	const numPixels = 8
	const endOffset = lineEnds ? lumaPitchBytes - numPixels : 0
	for (let line = 0; line < numLines; line += 2) {
		y0LineOff = lumaPitchBytes * line + endOffset
		y1LineOff = lumaPitchBytes * (line + 1) + endOffset
		cLineOff = lumaPitchBytes * height + chromaPitchBytes * (line / 2) + endOffset / 2
		for (let l = line; l < line + 2; ++l) {
			let s = `Line ${l}:`
			for (let p = 0; p < numPixels; p += 2)
				s += ` ${getUHex(p)}, ${getYHex(l, p)}, ${getVHex(p)}, ${getYHex(l, p + 1)};`
			console.log(s)
		}
	}
}

// process one image line pair per work group
const pixelsPerWorkItem = 64

export class Reader extends PackImpl {
	constructor(width: number, height: number) {
		super('nv12', width, height, nv12Kernel, 'read')
		this.numBits = 8
		this.lumaBlack = 16
		this.lumaWhite = 235
		this.chromaRange = 224
		this.isRGB = false
		const lumaBytes = getPitchBytes(this.width) * this.height
		this.numBytes = [lumaBytes, lumaBytes / 2]
		this.workItemsPerGroup = Math.ceil(getPitch(this.width) / pixelsPerWorkItem)
		// Halve total items as each item processes two lines
		this.globalWorkItems = (this.workItemsPerGroup * this.height) / 2
	}

	getKernelParams(params: KernelParams): KernelParams {
		const srcArray: Array<OpenCLBuffer> = params.sources as Array<OpenCLBuffer>
		if (srcArray.length !== 2)
			throw new Error(`Reader for ${this.name} requires 'sources' parameter with 2 OpenCL buffers`)
		return {
			inputY: srcArray[0],
			inputC: srcArray[1],
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
		super('nv12', width, height, nv12Kernel, 'write')
		this.interlaced = interlaced
		this.numBits = 8
		this.lumaBlack = 16
		this.lumaWhite = 235
		this.chromaRange = 224
		this.isRGB = false
		const lumaBytes = getPitchBytes(this.width) * this.height
		this.numBytes = [lumaBytes, lumaBytes / 2]
		this.workItemsPerGroup = Math.ceil(getPitch(this.width) / pixelsPerWorkItem)
		// Halve total items as each item processes two lines
		this.globalWorkItems = (this.workItemsPerGroup * this.height) / 2
	}

	getKernelParams(params: KernelParams): KernelParams {
		const dstArray: Array<OpenCLBuffer> = params.dests as Array<OpenCLBuffer>
		if (dstArray.length !== 2)
			throw new Error(`Writer for ${this.name} requires 'dests' parameter with 2 OpenCL buffers`)
		return {
			input: params.source,
			outputY: dstArray[0],
			outputC: dstArray[1],
			width: this.width,
			interlace: this.interlaced ? (params.interlace as Interlace) : Interlace.Progressive,
			colMatrix: params.colMatrix,
			gammaLut: params.gammaLut
		}
	}
}
