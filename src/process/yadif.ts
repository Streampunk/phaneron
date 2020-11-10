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

import { clContext as nodenCLContext, OpenCLBuffer } from 'nodencl'
import { ClJobs } from '../clJobQueue'
import ImageProcess from './imageProcess'
import YadifCl from './yadifCl'

// eslint-disable-next-line prettier/prettier
export type YadifMode = 'send_frame' | 'send_field' | 'send_frame_nospatial' | 'send_field_nospatial'
export type YadifConfig = { mode: YadifMode; tff: boolean }

export default class Yadif {
	private readonly clContext: nodenCLContext
	private readonly clJobs: ClJobs
	private readonly width: number
	private readonly height: number
	private readonly config: YadifConfig
	private readonly interlaced: boolean
	private readonly sendField: boolean
	private readonly skipSpatial: boolean
	private yadifCl: ImageProcess | null = null
	private prev: OpenCLBuffer | null = null
	private cur: OpenCLBuffer | null = null
	private next: OpenCLBuffer | null = null
	private out: OpenCLBuffer | null = null
	private framePending = false

	constructor(
		clContext: nodenCLContext,
		clJobs: ClJobs,
		width: number,
		height: number,
		config: YadifConfig,
		interlaced: boolean
	) {
		this.clContext = clContext
		this.clJobs = clJobs
		this.width = width
		this.height = height
		this.config = config
		this.interlaced = interlaced

		this.sendField =
			this.interlaced &&
			(this.config.mode === 'send_field' || this.config.mode === 'send_field_nospatial')
		this.skipSpatial =
			this.config.mode === 'send_frame_nospatial' || this.config.mode === 'send_field_nospatial'
	}

	async init(): Promise<void> {
		this.yadifCl = new ImageProcess(
			this.clContext,
			new YadifCl(this.width, this.height),
			this.clJobs
		)
		await this.yadifCl.init()
	}

	private async makeOutput(): Promise<void> {
		const numBytesRGBA = this.width * this.height * 4 * 4
		this.out = await this.clContext.createBuffer(
			numBytesRGBA,
			'readwrite',
			'coarse',
			{
				width: this.width,
				height: this.height
			},
			'yadif'
		)
	}

	private async runYadif(isSecond: boolean, input: OpenCLBuffer, sourceID: string): Promise<void> {
		if (!this.yadifCl) throw new Error('Yadif needs to be initialised')

		if (isSecond) await this.makeOutput()
		const out = this.out as OpenCLBuffer
		out.timestamp = this.cur ? this.cur.timestamp + (isSecond ? 1 : 0) : 0

		await this.yadifCl.run(
			{
				prev: this.prev,
				cur: this.cur,
				next: this.next,
				parity: (this.config.tff ? 1 : 0) ^ (!isSecond ? 1 : 0),
				tff: this.config.tff,
				skipSpatial: this.skipSpatial,
				output: out
			},
			{ source: sourceID, timestamp: out.timestamp },
			() => {
				if (!isSecond) input.release()
			}
		)

		this.framePending = this.sendField && !isSecond
		return
	}

	async processFrame(
		input: OpenCLBuffer,
		outputs: Array<OpenCLBuffer>,
		sourceID: string
	): Promise<void> {
		if (this.framePending) {
			await this.runYadif(true, input, sourceID)
			outputs.push(this.out as OpenCLBuffer)
		}

		input.addRef()
		if (this.prev) this.prev.release()
		this.prev = this.cur
		this.cur = this.next
		this.next = input

		if (!this.cur) {
			this.cur = this.next
			this.next.addRef()
		}
		if (!this.prev) return

		if (!this.interlaced) {
			this.out = this.cur
			this.cur.addRef()
			this.prev.release()
			outputs.push(this.out as OpenCLBuffer)
			return
		}

		await this.makeOutput()
		await this.runYadif(false, input, sourceID)
		outputs.push(this.out as OpenCLBuffer)
	}

	release(): void {
		if (this.prev) this.prev.release()
		if (this.cur) this.cur.release()
		if (this.next) this.next.release()
	}
}
