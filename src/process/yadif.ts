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
	private in: OpenCLBuffer[] = []
	private out: OpenCLBuffer | null = null

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

	private async makeOutput(isSecond: boolean): Promise<void> {
		const numBytesRGBA = this.width * this.height * 4 * 4
		this.out = await this.clContext.createBuffer(
			numBytesRGBA,
			'readwrite',
			'coarse',
			{
				width: this.width,
				height: this.height
			},
			`yadif ${isSecond ? '2' : '1'}`
		)
	}

	private async runYadif(isSecond: boolean, sourceID: string): Promise<void> {
		if (!this.yadifCl) throw new Error('Yadif needs to be initialised')

		// make a copy of in array for async release
		const srcs = this.in.slice(0)
		srcs.forEach((s) => s.addRef())

		const out = this.out as OpenCLBuffer
		// out.loadstamp = srcs[1].loadstamp
		out.timestamp = srcs[1].timestamp + (isSecond ? 1 : 0)

		await this.yadifCl.run(
			{
				prev: srcs[0],
				cur: srcs[1],
				next: srcs[2],
				parity: (this.config.tff ? 1 : 0) ^ (!isSecond ? 1 : 0),
				tff: this.config.tff,
				skipSpatial: this.skipSpatial,
				output: out
			},
			{ source: sourceID, timestamp: out.timestamp },
			() => srcs.forEach((s) => s.release())
		)
	}

	async processFrame(
		input: OpenCLBuffer,
		outputs: Array<OpenCLBuffer>,
		sourceID: string
	): Promise<void> {
		if (!this.interlaced) {
			outputs.push(input)
			return
		}

		this.in.push(input)
		if (this.in.length < 3) {
			// complete any processing queued for input so the sources are released
			await this.clJobs.runQueue({ source: sourceID, timestamp: input.timestamp })
			return
		}
		if (this.in.length > 3) {
			const old = this.in.shift()
			old?.release()
		}

		await this.makeOutput(false)
		await this.runYadif(false, sourceID)
		outputs.push(this.out as OpenCLBuffer)

		if (this.sendField) {
			await this.makeOutput(true)
			await this.runYadif(true, sourceID)
			outputs.push(this.out as OpenCLBuffer)
		}
	}

	release(): void {
		this.in.forEach((i) => i.release())
	}
}
