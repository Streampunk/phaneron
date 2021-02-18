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

export type JobID = {
	source: string
	timestamp: number
}

type JobsRequest = { id: string; jobs: ClJob[]; done: () => void }

export class ClJobs {
	private readonly processJobs: ClProcessJobs
	private jobs: Map<string, ClJob[]>

	constructor(processJobs: ClProcessJobs) {
		this.processJobs = processJobs
		this.jobs = new Map<string, ClJob[]>()
	}

	makeKey(id: JobID): string {
		return `${id.source} ts ${id.timestamp}`
	}

	add(id: JobID, name: string, program: OpenCLProgram, params: KernelParams, cb: JobCB): void {
		const key = this.makeKey(id)
		let tsJobs = this.jobs.get(key)
		if (!tsJobs) {
			this.jobs.set(key, [])
			tsJobs = this.jobs.get(key) as ClJob[]
		}
		tsJobs.push({ name: name, program: program, params: params, cb: cb })
	}

	get(id: JobID): ClJob[] | undefined {
		return this.jobs.get(this.makeKey(id))
	}

	delete(id: JobID): void {
		this.jobs.delete(this.makeKey(id))
	}

	clear(): void {
		this.jobs.clear()
	}

	async runQueue(id: JobID): Promise<void> {
		const key = this.makeKey(id)
		const tsJobs = this.jobs.get(key)
		if (!tsJobs) throw new Error(`Failed to run queue for id ${key}`)

		return new Promise<void>((resolve) => {
			const jobsRequest = { id: key, jobs: tsJobs, done: resolve }
			this.processJobs.requestRun(key, jobsRequest)
			this.delete(id)
		})
	}

	clearQueue(src: string): void {
		this.jobs.forEach((jobs, key) => {
			if (key.startsWith(src)) {
				// run the callbacks so sources are released
				jobs.forEach((j) => j.cb())
			}
		})
	}
}

export class ClProcessJobs {
	private readonly clContext: nodenCLContext
	private readonly requests: Map<string, JobsRequest>
	private readonly runEvents: EventEmitter
	private readonly clJobs: ClJobs
	private readonly showTimings = 0

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
		this.requests = new Map<string, JobsRequest>()
		this.runEvents = new EventEmitter()
		this.clJobs = new ClJobs(this)

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
			this.logTimings(req.id, end, timings)
			req.done()
			this.requests.delete(chan)
			curReq = reqIt.next()
		}

		this.runEvents.once('run', async () => this.processQueue())
	}

	getJobs(): ClJobs {
		return this.clJobs
	}

	requestRun(id: string, request: JobsRequest): void {
		this.requests.set(id, request)
		this.runEvents.emit('run')
	}

	logTimings(id: string, end: number[], timings: Map<string, RunTimings>): void {
		const idLim = id.slice(-20).concat(':').padEnd(21, ' ')
		const idSp = new Array(25 - idLim.length).fill(' ').join('')
		if (this.showTimings > 1) {
			const tsIt = timings.entries()
			let curTs = tsIt.next()
			console.log(`\n${idLim}${idSp} |   toGPU | process |   total (microseconds)`)
			console.log(new Array(56).fill('—').join(''))
			let d2kTotal = 0
			let keTotal = 0
			let ttTotal = 0
			while (!curTs.done) {
				const process = curTs.value[0]
				const t = curTs.value[1]
				const pSp = new Array(26 - process.length).fill(' ').join('')
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
			const tSp = new Array(26 - 'TOTALS'.length).fill(' ').join('')
			const d2kSp = new Array(7 - d2kTotal.toString().length).fill(' ').join('')
			const keSp = new Array(7 - keTotal.toString().length).fill(' ').join('')
			const ttSp = new Array(7 - ttTotal.toString().length).fill(' ').join('')
			console.log(new Array(56).fill('—').join(''))
			console.log(`TOTALS${tSp}| ${d2kSp}${d2kTotal} | ${keSp}${keTotal} | ${ttSp}${ttTotal}`)
		}

		if (this.showTimings > 0) {
			const elapsed = end[0] * 1000.0 + end[1] / 1000000.0
			console.log(
				`${idLim}${elapsed < 10.0 ? idSp : idSp.slice(1)}  ${elapsed.toFixed(2)}ms elapsed`
			)
		}
	}
}
