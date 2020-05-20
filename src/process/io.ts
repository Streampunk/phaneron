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

import { clContext as nodenCLContext, OpenCLBuffer, ImageDims, RunTimings } from 'nodencl'
import { Loader, Saver } from './loadSave'
import { PackImpl, Interlace } from './packer'
import ImageProcess from './imageProcess'
import Resize from './resize'

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
		readImpl: PackImpl
	) {
		this.clContext = clContext
		this.loader = new Loader(this.clContext, colSpecRead, colSpecWrite, readImpl)
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
				this.clContext.createBuffer(bytes, 'readonly', 'coarse', undefined, 'ToRGBA')
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
	): Promise<Array<void>> {
		const inputs = Array.isArray(input) ? input : [input]
		return Promise.all(
			sources.map(async (src, i) => {
				await src.hostAccess(
					'writeonly',
					clQueue ? clQueue : 0,
					inputs[i].slice(0, this.numBytes[i])
				)
				return src.hostAccess('none', clQueue ? clQueue : 0)
			})
		)
	}

	async processFrame(
		sources: Array<OpenCLBuffer>,
		dest: OpenCLBuffer,
		clQueue?: number
	): Promise<RunTimings> {
		return this.loader.run({ sources: sources, dest: dest }, clQueue ? clQueue : 0)
	}
}

export class FromRGBA {
	private readonly clContext: nodenCLContext
	private readonly width: number
	private readonly height: number
	private readonly saver: Saver
	private readonly numBytes: Array<number>
	private readonly numBytesRGBA: number
	private readonly totalBytes: number
	private readonly srcWidth: number
	private readonly srcHeight: number
	private resizer: ImageProcess | null = null
	private rgbaSz: OpenCLBuffer | null = null

	constructor(
		clContext: nodenCLContext,
		colSpecRead: string,
		writeImpl: PackImpl,
		srcWidth?: number,
		srcHeight?: number
	) {
		this.clContext = clContext
		this.width = writeImpl.getWidth()
		this.height = writeImpl.getHeight()
		this.saver = new Saver(this.clContext, colSpecRead, writeImpl)
		this.numBytes = writeImpl.getNumBytes()
		this.numBytesRGBA = writeImpl.getNumBytesRGBA()
		this.totalBytes = writeImpl.getTotalBytes()
		this.srcWidth = srcWidth ? srcWidth : this.width
		this.srcHeight = srcHeight ? srcHeight : this.height
	}

	async init(): Promise<void> {
		await this.saver.init()

		if (!(this.srcWidth === this.width && this.srcHeight === this.height)) {
			this.resizer = new ImageProcess(
				this.clContext,
				new Resize(this.clContext, this.width, this.height)
			)
			await this.resizer.init()

			this.rgbaSz = await this.clContext.createBuffer(
				this.numBytesRGBA,
				'readwrite',
				'coarse',
				{ width: this.width, height: this.height },
				'rgbaSz'
			)
		}
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
				this.clContext.createBuffer(bytes, 'readonly', 'coarse', undefined, 'ToRGBA')
			)
		)
	}

	async processFrame(
		source: OpenCLBuffer,
		dests: Array<OpenCLBuffer>,
		clQueue?: number,
		interlace?: Interlace
	): Promise<RunTimings> {
		let saveSource = source
		if (this.resizer && this.rgbaSz) {
			await this.resizer.run({ input: source, output: this.rgbaSz }, clQueue ? clQueue : 0)
			saveSource = this.rgbaSz
		}

		return this.saver.run(
			{ source: saveSource, dests: dests, interlace: interlace },
			clQueue ? clQueue : 0
		)
	}

	async saveFrame(
		output: OpenCLBuffer | Array<OpenCLBuffer>,
		clQueue?: number | undefined
	): Promise<Array<void>> {
		const outputs = Array.isArray(output) ? output : [output]
		return Promise.all(outputs.map((op) => op.hostAccess('readonly', clQueue ? clQueue : 0)))
	}
}
