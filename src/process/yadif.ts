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

import { clContext as nodenCLContext, OpenCLBuffer, RunTimings } from 'nodencl'
import ImageProcess from './imageProcess'
import YadifCl from './yadifCl'

const modes = ['send_frame', 'send_field', 'send_frame_nospatial', 'send_field_nospatial']
const parities = ['tff', 'bff', 'auto']
const deints = ['all', 'interlaced']

export default class Yadif {
	private readonly clContext: nodenCLContext
	private readonly width: number
	private readonly height: number
	private readonly mode: number = 0
	private readonly parity: number = -1
	private readonly deint: number = 0
	private readonly tff: number
	private readonly skipSpatial: boolean
	private yadifCl: ImageProcess | null = null
	private prev: OpenCLBuffer | null = null
	private cur: OpenCLBuffer | null = null
	private next: OpenCLBuffer | null = null
	private out: OpenCLBuffer | null = null
	private framePending = false

	constructor(
		clContext: nodenCLContext,
		width: number,
		height: number,
		mode?: number | string,
		parity?: number | string,
		deint?: number | string
	) {
		this.clContext = clContext
		this.width = width
		this.height = height
		if (mode) {
			this.mode = isNaN(mode as number) ? modes.indexOf(mode as string) : (mode as number)
			if (!(this.mode >= 0 && this.mode < modes.length))
				throw new Error(`Invalid parameter for yadif mode: '${mode}'`)
		}
		if (parity) {
			this.parity = isNaN(parity as number)
				? parities.indexOf(parity as string)
				: (parity as number)
			if (!(this.parity >= -1 && this.parity < parities.length - 1))
				throw new Error(`Invalid parameter for yadif parity: '${parity}'`)
		}
		if (deint) {
			this.deint = isNaN(deint as number) ? deints.indexOf(deint as string) : (deint as number)
			if (!(this.deint >= 0 && this.deint < deints.length))
				throw new Error(`Invalid parameter for yadif deint: '${deint}'`)
		}
		if (!(this.mode >= 0 && this.deint >= 0)) throw new Error('Invalid parameters for Yadif')

		this.skipSpatial = (this.mode & 2) === 2

		const interlacedFrame = true
		const topFieldFirst = true
		if (this.parity === -1) {
			this.tff = interlacedFrame ? (topFieldFirst ? 1 : 0) : 1
		} else {
			this.tff = this.parity ^ 1
		}
	}

	async init(): Promise<void> {
		this.yadifCl = new ImageProcess(this.clContext, new YadifCl(this.width, this.height))
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

	private async runYadif(isSecond: boolean, clQueue: number): Promise<RunTimings> {
		if (!this.yadifCl) throw new Error('Yadif needs to be initialised')

		if (isSecond) await this.makeOutput()
		const out = this.out as OpenCLBuffer
		out.timestamp = this.cur ? this.cur.timestamp * 2 + (isSecond ? 1 : 0) : 0

		const timings = await this.yadifCl.run(
			{
				prev: this.prev,
				cur: this.cur,
				next: this.next,
				parity: this.tff ^ (!isSecond ? 1 : 0),
				tff: this.tff,
				skipSpatial: this.skipSpatial,
				output: out
			},
			clQueue
		)

		this.framePending = (this.mode & 1) !== 0 && !isSecond
		return timings
	}

	async processFrame(
		input: OpenCLBuffer,
		outputs: Array<OpenCLBuffer>,
		clQueue: number
	): Promise<RunTimings> {
		const timings = { dataToKernel: 0, kernelExec: 0, dataFromKernel: 0, totalTime: 0 }

		if (this.framePending) {
			const t = await this.runYadif(true, clQueue)
			outputs.push(this.out as OpenCLBuffer)
			timings.kernelExec += t.kernelExec
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
		if (!this.prev) return timings

		const interlacedFrame = true
		if (this.deint > 0 && !interlacedFrame) {
			this.out = this.cur
			this.cur.addRef()
			this.prev.release()
			outputs.push(this.out as OpenCLBuffer)
			return timings
		}

		await this.makeOutput()
		const t = await this.runYadif(false, clQueue)
		outputs.push(this.out as OpenCLBuffer)
		timings.kernelExec += t.kernelExec

		return timings
	}

	release(): void {
		if (this.prev) this.prev.release()
		if (this.cur) this.cur.release()
		if (this.next) this.next.release()
	}
}
