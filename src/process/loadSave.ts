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

import Packer, { PackImpl } from './packer'
import { clContext as nodenCLContext, OpenCLBuffer, KernelParams } from 'nodencl'
import {
	gamma2linearLUT,
	ycbcr2rgbMatrix,
	matrixFlatten,
	rgb2rgbMatrix,
	linear2gammaLUT,
	rgb2ycbcrMatrix
} from './colourMaths'
import { ClJobs, JobCB, JobID } from '../clJobQueue'

export class Loader extends Packer {
	private readonly gammaArray: Float32Array
	private readonly colMatrixArray: Float32Array | null = null
	private readonly gamutMatrixArray: Float32Array
	private gammaLut: OpenCLBuffer | null = null
	private colMatrix: OpenCLBuffer | null = null
	private gamutMatrix: OpenCLBuffer | null = null

	constructor(
		clContext: nodenCLContext,
		colSpec: string,
		outColSpec: string,
		packImpl: PackImpl,
		clJobs: ClJobs
	) {
		super(clContext, packImpl, clJobs)

		this.gammaArray = gamma2linearLUT(colSpec)
		if (!this.packImpl.getIsRGB()) {
			const colMatrix2d = ycbcr2rgbMatrix(
				colSpec,
				this.packImpl.numBits,
				this.packImpl.lumaBlack,
				this.packImpl.lumaWhite,
				this.packImpl.chromaRange
			)
			this.colMatrixArray = matrixFlatten(colMatrix2d)
		}

		const gamutMatrix2d = rgb2rgbMatrix(colSpec, outColSpec)
		this.gamutMatrixArray = matrixFlatten(gamutMatrix2d)
	}

	async init(): Promise<void> {
		await super.init()

		this.gammaLut = await this.clContext.createBuffer(
			this.gammaArray.byteLength,
			'readonly',
			'coarse',
			undefined,
			'loader gammaLut'
		)
		await this.gammaLut.hostAccess('writeonly')
		Buffer.from(this.gammaArray.buffer).copy(this.gammaLut)

		if (this.colMatrixArray) {
			this.colMatrix = await this.clContext.createBuffer(
				this.colMatrixArray.byteLength,
				'readonly',
				'none',
				undefined,
				'loader colMatrix'
			)
			await this.colMatrix.hostAccess('writeonly')
			Buffer.from(this.colMatrixArray.buffer).copy(this.colMatrix)
		}

		this.gamutMatrix = await this.clContext.createBuffer(
			this.gamutMatrixArray.byteLength,
			'readonly',
			'none',
			undefined,
			'loader gamutMatrix'
		)
		await this.gamutMatrix.hostAccess('writeonly')
		Buffer.from(this.gamutMatrixArray.buffer).copy(this.gamutMatrix)
	}

	addRefs(): void {
		this.gammaLut?.addRef()
		this.colMatrix?.addRef()
		this.gamutMatrix?.addRef()
	}

	releaseRefs(): void {
		this.gammaLut?.release()
		this.colMatrix?.release()
		this.gamutMatrix?.release()
	}

	run(params: KernelParams, id: JobID, cb: JobCB): void {
		if (this.program === null) throw new Error('Loader.run failed with no program available')

		this.addRefs()
		const kernelParams = this.packImpl.getKernelParams(params)
		kernelParams.gammaLut = this.gammaLut
		kernelParams.gamutMatrix = this.gamutMatrix
		if (this.colMatrix) kernelParams.colMatrix = this.colMatrix

		this.clJobs.add(id, this.packImpl.getName(), this.program, kernelParams, () => {
			this.releaseRefs()
			cb()
		})
	}
}

export class Saver extends Packer {
	private readonly gammaArray: Float32Array
	private readonly colMatrixArray: Float32Array | null = null
	private gammaLut: OpenCLBuffer | null = null
	private colMatrix: OpenCLBuffer | null = null

	constructor(clContext: nodenCLContext, colSpec: string, packImpl: PackImpl, clJobs: ClJobs) {
		super(clContext, packImpl, clJobs)

		this.gammaArray = linear2gammaLUT(colSpec)
		if (!this.packImpl.getIsRGB()) {
			const colMatrix2d = rgb2ycbcrMatrix(
				colSpec,
				this.packImpl.numBits,
				this.packImpl.lumaBlack,
				this.packImpl.lumaWhite,
				this.packImpl.chromaRange
			)
			this.colMatrixArray = matrixFlatten(colMatrix2d)
		}
	}

	async init(): Promise<void> {
		await super.init()

		this.gammaLut = await this.clContext.createBuffer(
			this.gammaArray.byteLength,
			'readonly',
			'coarse',
			undefined,
			'saver gammaLut'
		)
		await this.gammaLut.hostAccess('writeonly')

		Buffer.from(this.gammaArray.buffer).copy(this.gammaLut)
		if (this.colMatrixArray) {
			this.colMatrix = await this.clContext.createBuffer(
				this.colMatrixArray.byteLength,
				'readonly',
				'none',
				undefined,
				'saver colMatrix'
			)
			await this.colMatrix.hostAccess('writeonly')
			Buffer.from(this.colMatrixArray.buffer).copy(this.colMatrix)
		}
	}

	addRefs(): void {
		this.gammaLut?.addRef()
		this.colMatrix?.addRef()
	}

	releaseRefs(): void {
		this.gammaLut?.release()
		this.colMatrix?.release()
	}

	run(params: KernelParams, id: JobID, cb: JobCB): void {
		if (this.program === null) throw new Error('Saver.run failed with no program available')

		this.addRefs()
		const kernelParams = this.packImpl.getKernelParams(params)
		kernelParams.gammaLut = this.gammaLut
		if (this.colMatrix) kernelParams.colMatrix = this.colMatrix

		this.clJobs.add(id, this.packImpl.getName(), this.program, kernelParams, () => {
			this.releaseRefs()
			cb()
		})
	}
}
