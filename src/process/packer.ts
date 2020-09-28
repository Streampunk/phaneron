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

import { clContext as nodenCLContext, OpenCLProgram, KernelParams } from 'nodencl'
import { ClJobs, JobCB } from '../clJobQueue'

export enum Interlace {
	Progressive = 0,
	TopField = 1,
	BottomField = 3
}

export abstract class PackImpl {
	protected readonly name: string
	protected readonly width: number
	protected readonly height: number
	protected interlaced = false
	readonly kernel: string
	readonly programName: string
	numBits = 10
	lumaBlack = 64
	lumaWhite = 940
	chromaRange = 896
	protected isRGB = true
	protected numBytes: Array<number> = [0]
	protected globalWorkItems = 0
	protected workItemsPerGroup = 0

	constructor(name: string, width: number, height: number, kernel: string, programName: string) {
		this.name = name
		this.width = width
		this.height = height
		this.kernel = kernel
		this.programName = programName
	}

	getName(): string {
		return this.name
	}
	getWidth(): number {
		return this.width
	}
	getHeight(): number {
		return this.height
	}
	getNumBytes(): Array<number> {
		return this.numBytes
	}
	getNumBytesRGBA(): number {
		return this.width * this.height * 4 * 4
	}
	getIsRGB(): boolean {
		return this.isRGB
	}
	getTotalBytes(): number {
		return this.numBytes.reduce((acc, n) => acc + n, 0)
	}
	getGlobalWorkItems(): number {
		return this.globalWorkItems
	}
	getWorkItemsPerGroup(): number {
		return this.workItemsPerGroup
	}

	abstract getKernelParams(params: KernelParams): KernelParams
}

export default abstract class Packer {
	protected readonly clContext: nodenCLContext
	protected readonly packImpl: PackImpl
	protected readonly clJobs: ClJobs
	protected program: OpenCLProgram | null = null

	constructor(clContext: nodenCLContext, packImpl: PackImpl, clJobs: ClJobs) {
		this.clContext = clContext
		this.packImpl = packImpl
		this.clJobs = clJobs
	}

	async init(): Promise<void> {
		this.program = await this.clContext.createProgram(this.packImpl.kernel, {
			name: this.packImpl.programName,
			globalWorkItems: this.packImpl.getGlobalWorkItems(),
			workItemsPerGroup: this.packImpl.getWorkItemsPerGroup()
		})
	}

	abstract run(params: KernelParams, timestamp: number, cb: JobCB): void
}
