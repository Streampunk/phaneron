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

export abstract class ProcessImpl {
	protected readonly name: string
	protected readonly width: number
	protected readonly height: number
	readonly kernel: string
	readonly programName: string
	readonly globalWorkItems = 0

	constructor(name: string, width: number, height: number, kernel: string, programName: string) {
		this.name = name
		this.width = width
		this.height = height
		this.kernel = kernel
		this.programName = programName
	}

	abstract async init(): Promise<void>

	getName(): string {
		return this.name
	}
	getNumBytesRGBA(): number {
		return this.width * this.height * 4 * 4
	}
	getGlobalWorkItems(): Uint32Array {
		return Uint32Array.from([this.width, this.height])
	}

	abstract async getKernelParams(params: KernelParams): Promise<KernelParams>
}

export default class ImageProcess {
	private readonly clContext: nodenCLContext
	private readonly processImpl: ProcessImpl
	protected readonly clJobs: ClJobs
	private program: OpenCLProgram | null = null

	constructor(clContext: nodenCLContext, processImpl: ProcessImpl, clJobs: ClJobs) {
		this.clContext = clContext
		this.processImpl = processImpl
		this.clJobs = clJobs
	}

	async init(): Promise<void> {
		this.program = await this.clContext.createProgram(this.processImpl.kernel, {
			name: this.processImpl.programName,
			globalWorkItems: this.processImpl.getGlobalWorkItems()
		})
		return this.processImpl.init()
	}

	async run(params: KernelParams, timestamp: number, cb: JobCB): Promise<void> {
		if (this.program == null) throw new Error('Loader.run failed with no program available')
		const kernelParams = await this.processImpl.getKernelParams(params)
		this.clJobs.add(timestamp, this.processImpl.getName(), this.program, kernelParams, cb)
	}
}
