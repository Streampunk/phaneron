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

import { EventEmitter } from 'events'
import { clContext as nodenCLContext, KernelParams, OpenCLProgram, RunTimings } from 'nodencl'

export type JobCB = () => void

interface ClJob {
	name: string
	program: OpenCLProgram
	params: KernelParams
	cb: JobCB
}

type JobsRequest = { timestamp: number; jobs: ClJob[]; done: () => void }

export type QueueRunner = (
	clContext: nodenCLContext,
	channel: number,
	tsJobs: ClJob[],
	clQueue: number
) => void

export class ClJobs {
	private readonly channel: number
	private readonly processJobs: ClProcessJobs
	private jobs: Map<number, ClJob[]>

	constructor(channel: number, processJobs: ClProcessJobs) {
		this.channel = channel
		this.processJobs = processJobs
		this.jobs = new Map<number, ClJob[]>()
	}

	add(ts: number, name: string, program: OpenCLProgram, params: KernelParams, cb: JobCB): void {
		let tsJobs = this.jobs.get(ts)
		if (!tsJobs) {
			this.jobs.set(ts, [])
			tsJobs = this.jobs.get(ts) as ClJob[]
		}
		tsJobs.push({ name: name, program: program, params: params, cb: cb })
	}

	get(ts: number): ClJob[] | undefined {
		return this.jobs.get(ts)
	}

	delete(ts: number): void {
		this.jobs.delete(ts)
	}

	clear(): void {
		this.jobs.clear()
	}

	async runQueue(ts: number): Promise<void> {
		const tsJobs = this.jobs.get(ts)
		if (!tsJobs) throw new Error(`Failed to run queue for timestamp ${ts}`)

		return new Promise<void>((resolve) => {
			const jobsRequest = { timestamp: ts, jobs: tsJobs, done: resolve }
			this.processJobs.requestRun(this.channel, jobsRequest)
			this.delete(ts)
		})
	}
}

export class ClProcessJobs {
	private readonly clContext: nodenCLContext
	private readonly requests: Map<number, JobsRequest>
	private readonly runEvents: EventEmitter
	private readonly showTimings = 0

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
		this.requests = new Map<number, JobsRequest>()
		this.runEvents = new EventEmitter()

		this.runEvents.once('run', async () => this.processQueue())
	}

	async processQueue(): Promise<void> {
		const reqIt = this.requests.entries()
		let curReq = reqIt.next()
		while (!curReq.done) {
			const chan = curReq.value[0]
			const req = curReq.value[1]
			const timings = new Map<string, RunTimings>()
			const start = process.hrtime()
			for (let i = 0; i < req.jobs.length; ++i) {
				const job = req.jobs[i]
				timings.set(
					job.name,
					await this.clContext.runProgram(job.program, job.params, this.clContext.queue.process)
				)
			}

			await this.clContext.waitFinish(this.clContext.queue.process)
			req.jobs.forEach((j) => j.cb())
			const end = process.hrtime(start)
			this.logTimings(chan, req.timestamp, end, timings)
			req.done()
			this.requests.delete(chan)
			curReq = reqIt.next()
		}

		this.runEvents.once('run', async () => this.processQueue())
	}

	add(channel: number): ClJobs {
		return new ClJobs(channel, this)
	}

	requestRun(channel: number, request: JobsRequest): void {
		this.requests.set(channel, request)
		this.runEvents.emit('run')
	}

	logTimings(channel: number, ts: number, end: number[], timings: Map<string, RunTimings>): void {
		if (this.showTimings > 1) {
			const tsIt = timings.entries()
			let curTs = tsIt.next()
			const tsSp = new Array(16 - 8 - ts.toString().length).fill(' ').join('')
			console.log(`\nChan ${channel}: ${ts}${tsSp}|   toGPU | process |   total (microseconds)`)
			console.log(new Array(45).fill('—').join(''))
			let d2kTotal = 0
			let keTotal = 0
			let ttTotal = 0
			while (!curTs.done) {
				const process = curTs.value[0]
				const t = curTs.value[1]
				const pSp = new Array(16 - process.length).fill(' ').join('')
				const d2kSp = new Array(7 - t.dataToKernel.toString().length).fill(' ').join('')
				const keSp = new Array(7 - t.kernelExec.toString().length).fill(' ').join('')
				const ttSp = new Array(7 - t.totalTime.toString().length).fill(' ').join('')
				// eslint-disable-next-line prettier/prettier
				console.log(`${process}${pSp}| ${d2kSp}${t.dataToKernel} | ${keSp}${t.kernelExec} | ${ttSp}${t.totalTime}`)
				d2kTotal += t.dataToKernel
				keTotal += t.kernelExec
				ttTotal += t.totalTime
				curTs = tsIt.next()
			}
			const tSp = new Array(16 - 'TOTALS'.length).fill(' ').join('')
			const d2kSp = new Array(7 - d2kTotal.toString().length).fill(' ').join('')
			const keSp = new Array(7 - keTotal.toString().length).fill(' ').join('')
			const ttSp = new Array(7 - ttTotal.toString().length).fill(' ').join('')
			console.log(new Array(45).fill('—').join(''))
			console.log(`TOTALS${tSp}| ${d2kSp}${d2kTotal} | ${keSp}${keTotal} | ${ttSp}${ttTotal}`)
		}

		if (this.showTimings > 0)
			console.log(`Chan ${channel}: ${ts}  ${(end[0] * 1000.0 + end[1] / 1000000.0).toFixed(2)}ms`)
	}
}
