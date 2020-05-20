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
import { matrixFlatten, matrixMultiply } from './colourMaths'

const transformKernel = `
  __constant sampler_t samplerIn =
    CLK_NORMALIZED_COORDS_TRUE |
    CLK_ADDRESS_CLAMP |
    CLK_FILTER_LINEAR;

  __constant sampler_t samplerOut =
    CLK_NORMALIZED_COORDS_FALSE |
    CLK_ADDRESS_CLAMP |
    CLK_FILTER_NEAREST;

  __kernel void transform(
    __read_only image2d_t input,
    __global float4* restrict transformMatrix,
    __write_only image2d_t output) {

    int w = get_image_width(output);
    int h = get_image_height(output);

    // Load two rows of the 3x3 transform matrix via two float4s
    float4 tmpMat0 = transformMatrix[0];
    float4 tmpMat1 = transformMatrix[1];
    float3 mat0 = (float3)(tmpMat0.s0, tmpMat0.s1, tmpMat0.s2);
    float3 mat1 = (float3)(tmpMat0.s3, tmpMat1.s0, tmpMat1.s1);

    int outX = get_global_id(0);
    int outY = get_global_id(1);
    int2 posOut = {outX, outY};

    float3 inPos = (float3)(outX / (float) w - 0.5f, outY / (float) h - 0.5f, 1.0f);
    float2 posIn = (float2)(dot(mat0, inPos) + 0.5f, dot(mat1, inPos) + 0.5f);

    float4 in = read_imagef(input, samplerIn, posIn);
    write_imagef(output, posOut, in);
  }
`

export default class Transform extends ProcessImpl {
	clContext: nodenCLContext
	transformMatrix: Array<Float32Array>
	transformArray: Float32Array
	matrixBuffer: OpenCLBuffer | null = null

	constructor(clContext: nodenCLContext, width: number, height: number) {
		super('transform', width, height, transformKernel, 'transform')

		this.clContext = clContext
		this.transformMatrix = [...new Array(3)].map(() => new Float32Array(3))
		this.transformMatrix[0] = Float32Array.from([1.0, 0.0, 0.0])
		this.transformMatrix[1] = Float32Array.from([0.0, 1.0, 0.0])
		this.transformMatrix[2] = Float32Array.from([0.0, 0.0, 1.0])
		this.transformArray = matrixFlatten(this.transformMatrix)
	}

	private async updateMatrix(clQueue: number): Promise<void> {
		if (!this.matrixBuffer) throw new Error('Transform needs to be initialised')

		this.transformArray = matrixFlatten(this.transformMatrix)
		await this.matrixBuffer.hostAccess(
			'writeonly',
			clQueue,
			Buffer.from(this.transformArray.buffer)
		)
		return this.matrixBuffer.hostAccess('none', clQueue)
	}

	async init(): Promise<void> {
		this.matrixBuffer = await this.clContext.createBuffer(
			this.transformArray.byteLength,
			'readonly',
			'coarse'
		)
		return this.updateMatrix(this.clContext.queue.load)
	}

	async getKernelParams(params: KernelParams, clQueue: number): Promise<KernelParams> {
		const aspect = this.width / this.height
		const flipX = (params.flipH as boolean) || false ? -1.0 : 1.0
		const flipY = (params.flipV as boolean) || false ? -1.0 : 1.0
		const scaleX = ((params.scale as number) || 1.0) * flipX * aspect
		const scaleY = ((params.scale as number) || 1.0) * flipY
		const offsetX = (params.offsetX as number) || 0.0
		const offsetY = (params.offsetY as number) || 0.0
		const rotate = (params.rotate as number) || 0.0

		const scaleMatrix = [...new Array(3)].map(() => new Float32Array(3))
		scaleMatrix[0] = Float32Array.from([1.0 / scaleX, 0.0, 0.0])
		scaleMatrix[1] = Float32Array.from([0.0, 1.0 / scaleY, 0.0])
		scaleMatrix[2] = Float32Array.from([0.0, 0.0, 1.0])

		const translateMatrix = [...new Array(3)].map(() => new Float32Array(3))
		translateMatrix[0] = Float32Array.from([1.0, 0.0, offsetX])
		translateMatrix[1] = Float32Array.from([0.0, 1.0, offsetY])
		translateMatrix[2] = Float32Array.from([0.0, 0.0, 1.0])

		const rotateMatrix = [...new Array(3)].map(() => new Float32Array(3))
		rotateMatrix[0] = Float32Array.from([Math.cos(rotate), -Math.sin(rotate), 0.0])
		rotateMatrix[1] = Float32Array.from([Math.sin(rotate), Math.cos(rotate), 0.0])
		rotateMatrix[2] = Float32Array.from([0.0, 0.0, 1.0])

		const projectMatrix = [...new Array(3)].map(() => new Float32Array(3))
		projectMatrix[0] = Float32Array.from([aspect, 0.0, 0.0])
		projectMatrix[1] = Float32Array.from([0.0, 1.0, 0.0])
		projectMatrix[2] = Float32Array.from([0.0, 0.0, 1.0])

		this.transformMatrix = matrixMultiply(
			matrixMultiply(matrixMultiply(scaleMatrix, translateMatrix), rotateMatrix),
			projectMatrix
		)

		await this.updateMatrix(clQueue)
		return Promise.resolve({
			input: params.input,
			transformMatrix: this.matrixBuffer,
			output: params.output
		})
	}
}
