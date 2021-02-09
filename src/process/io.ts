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

import { clContext as nodenCLContext, OpenCLBuffer, ImageDims } from 'nodencl'
import { Loader, Saver } from './loadSave'
import { PackImpl, Interlace } from './packer'
import { ClJobs } from '../clJobQueue'

export class ToRGBA {
	private readonly clContext: nodenCLContext
	private readonly loader: Loader
	private readonly numBytes: Array<number>
	private readonly numBytesRGBA: number
	private readonly totalBytes: number

	constructor(
		clContext: nodenCLContext,
		colSpecRead: string,
		colSpecWrite: string,
		readImpl: PackImpl,
		clJobs: ClJobs
	) {
		this.clContext = clContext
		this.loader = new Loader(this.clContext, colSpecRead, colSpecWrite, readImpl, clJobs)
		this.numBytes = readImpl.getNumBytes()
		this.numBytesRGBA = readImpl.getNumBytesRGBA()
		this.totalBytes = readImpl.getTotalBytes()
	}

	async init(): Promise<void> {
		await this.loader.init()
	}

	getNumBytes(): Array<number> {
		return this.numBytes
	}
	getNumBytesRGBA(): number {
		return this.numBytesRGBA
	}
	getTotalBytes(): number {
		return this.totalBytes
	}

	async createSources(): Promise<Array<OpenCLBuffer>> {
		return Promise.all(
			this.numBytes.map((bytes) =>
				this.clContext.createBuffer(bytes, 'readonly', 'coarse', undefined, 'ToRGBA src')
			)
		)
	}

	async createDest(imageDims: ImageDims): Promise<OpenCLBuffer> {
		return this.clContext.createBuffer(this.numBytesRGBA, 'readonly', 'coarse', imageDims, 'ToRGBA')
	}

	async loadFrame(
		input: Buffer | Array<Buffer>,
		sources: Array<OpenCLBuffer>,
		clQueue?: number | undefined
	): Promise<void> {
		const inputs = Array.isArray(input) ? input : [input]
		if (sources.length !== inputs.length)
			throw new Error(`Expected buffer array of ${sources.length} sources, found ${inputs.length}`)

		for (let i = 0; i < inputs.length; ++i) {
			await sources[i].hostAccess(
				'writeonly',
				clQueue ? clQueue : 0,
				inputs[i].slice(0, this.numBytes[i])
			)
			await sources[i].hostAccess('none', clQueue ? clQueue : 0)
		}

		return Promise.resolve()
	}

	processFrame(sourceID: string, sources: Array<OpenCLBuffer>, dest: OpenCLBuffer): void {
		return this.loader.run(
			{ sources: sources, dest: dest },
			{
				source: sourceID,
				timestamp: sources[0].timestamp
			},
			() => sources.forEach((s) => s.release())
		)
	}

	finish(): void {
		this.loader.releaseRefs()
	}
}

export class FromRGBA {
	private readonly clContext: nodenCLContext
	private readonly saver: Saver
	private readonly numBytes: Array<number>
	private readonly numBytesRGBA: number
	private readonly totalBytes: number

	constructor(clContext: nodenCLContext, colSpecRead: string, writeImpl: PackImpl, clJobs: ClJobs) {
		this.clContext = clContext
		this.saver = new Saver(this.clContext, colSpecRead, writeImpl, clJobs)
		this.numBytes = writeImpl.getNumBytes()
		this.numBytesRGBA = writeImpl.getNumBytesRGBA()
		this.totalBytes = writeImpl.getTotalBytes()
	}

	async init(): Promise<void> {
		await this.saver.init()
	}

	getNumBytes(): Array<number> {
		return this.numBytes
	}
	getNumBytesRGBA(): number {
		return this.numBytesRGBA
	}
	getTotalBytes(): number {
		return this.totalBytes
	}

	async createDests(): Promise<Array<OpenCLBuffer>> {
		return Promise.all(
			this.numBytes.map((bytes) =>
				this.clContext.createBuffer(bytes, 'writeonly', 'coarse', undefined, 'FromRGBA')
			)
		)
	}

	processFrame(
		sourceID: string,
		source: OpenCLBuffer,
		dests: Array<OpenCLBuffer>,
		interlace?: Interlace
	): void {
		this.saver.run(
			{ source: source, dests: dests, interlace: interlace },
			{ source: sourceID, timestamp: source.timestamp },
			() => source.release()
		)
	}

	async saveFrame(
		output: OpenCLBuffer | Array<OpenCLBuffer>,
		clQueue?: number | undefined
	): Promise<void> {
		const outputs = Array.isArray(output) ? output : [output]
		for (let o = 0; o < outputs.length; ++o)
			await outputs[o].hostAccess('readonly', clQueue ? clQueue : 0)
		return Promise.resolve()
	}

	finish(): void {
		this.saver.releaseRefs()
	}
}
