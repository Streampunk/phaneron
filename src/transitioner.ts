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

import { clContext as nodenCLContext, KernelParams } from 'nodencl'
import { RedioPipe, RedioEnd, isValue, Valve, nil, isEnd, RedioNil, end } from 'redioactive'
import { OpenCLBuffer } from 'nodencl'
import { AudioInputParam, filterer, Filterer, Frame } from 'beamcoder'
import { VideoFormat } from './config'
import { ClJobs } from './clJobQueue'
import ImageProcess from './process/imageProcess'
import Transition from './process/transition'
import { Silence, Black } from './blackSilence'
import { EventEmitter, once } from 'events'

export class Transitioner {
	private readonly clContext: nodenCLContext
	private readonly layerID: string
	private readonly consumerFormat: VideoFormat
	private readonly clJobs: ClJobs
	private readonly endEvent: EventEmitter
	private readonly layerUpdate: (ts: number[]) => void
	private silence: Silence | null
	private black: Black | null
	private audType: string
	private vidType: string
	private numFrames: number
	private curFrame: number
	private nextType: string
	private nextNumFrames: number
	private audTransition: Filterer | null = null
	private vidTransition: ImageProcess | null = null
	private audioPipe: RedioPipe<Frame | RedioEnd> | undefined
	private videoPipe: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private readonly audSourcePipes: RedioPipe<Frame | RedioEnd>[] = []
	private readonly vidSourcePipes: RedioPipe<OpenCLBuffer | RedioEnd>[] = []
	private updating = true

	constructor(
		clContext: nodenCLContext,
		layerID: string,
		consumerFormat: VideoFormat,
		clJobs: ClJobs,
		endEvent: EventEmitter,
		layerUpdate: (ts: number[]) => void
	) {
		this.clContext = clContext
		this.layerID = `${layerID} transition`
		this.consumerFormat = consumerFormat
		this.clJobs = clJobs
		this.endEvent = endEvent
		this.silence = new Silence(this.consumerFormat)
		this.black = new Black(this.clContext, this.consumerFormat, this.layerID)
		this.layerUpdate = layerUpdate
		this.audType = 'cut'
		this.vidType = 'cut'
		this.numFrames = 0
		this.curFrame = 0
		this.nextType = 'cut'
		this.nextNumFrames = 0
	}

	async initialise(): Promise<void> {
		const silencePipe = (await this.silence?.initialise()) as RedioPipe<Frame | RedioEnd>
		const blackPipe = (await this.black?.initialise()) as RedioPipe<OpenCLBuffer | RedioEnd>

		const transitionAudValve: Valve<
			[Frame | RedioEnd, ...(Frame | RedioEnd)[]],
			Frame | RedioEnd
		> = async (frames) => {
			if (isValue(frames)) {
				const srcFrames = frames.slice(1, 3)
				if (srcFrames.length === 0) return frames[0]

				if (this.audType !== this.nextType && srcFrames.length === this.audSourcePipes.length) {
					this.audType = this.nextType
					await this.makeAudTransition()
				}

				let transitionResult: (Frame | RedioEnd | RedioNil)[] = [srcFrames[0]]
				if (srcFrames.reduce((acc, f) => acc && isValue(f), true)) {
					if (srcFrames.length > 1) {
						const srcs = srcFrames as Frame[]
						const pts = srcs[0].pts
						const filterFrames = srcs.map((f, i) => {
							f.pts = pts
							return {
								name: `in${i}:a`,
								frames: [f]
							}
						})
						const ff = await this.audTransition?.filter(filterFrames)
						transitionResult = ff && ff[0] && ff[0].frames.length > 0 ? ff[0].frames : [nil]
					}
				} else {
					transitionResult =
						srcFrames.length > 1 && isValue(srcFrames[1]) ? [srcFrames[1]] : [srcFrames[0]]
				}

				if (isEnd(transitionResult[0])) transitionResult = [frames[0]]
				return transitionResult
			} else {
				return frames
			}
		}

		const transitionVidValve: Valve<
			[OpenCLBuffer | RedioEnd, ...(OpenCLBuffer | RedioEnd)[]],
			OpenCLBuffer | RedioEnd
		> = async (frames) => {
			let transitionResult: OpenCLBuffer | RedioEnd = end
			if (isValue(frames) && isValue(frames[0])) {
				const srcFrames = frames.slice(1)
				const numSrcs = srcFrames.length

				this.layerUpdate(srcFrames.map((f) => (isValue(f) ? f.timestamp : this.updating ? 0 : -1)))

				if (numSrcs === 0) {
					transitionResult = frames[0]
					transitionResult.addRef()
				} else {
					if (this.vidType !== this.nextType && numSrcs === this.vidSourcePipes.length) {
						this.vidType = this.nextType
						this.numFrames = this.nextNumFrames
						this.curFrame = 0
						await this.makeVidTransition()
					}

					if (srcFrames.reduce((acc, f) => acc && isValue(f), true)) {
						this.updating = false
						if (numSrcs === 1) {
							transitionResult = srcFrames[0] as OpenCLBuffer
							transitionResult.addRef()
						} else {
							const transitionDest = await this.clContext.createBuffer(
								this.consumerFormat.width * this.consumerFormat.height * 4 * 4,
								'readwrite',
								'coarse',
								{
									width: this.consumerFormat.width,
									height: this.consumerFormat.height
								},
								'transition'
							)

							const timestamp = (srcFrames[1] as OpenCLBuffer).timestamp
							// transitionDest.loadstamp = Math.min(...srcFrames.map((f) => f.loadstamp))
							transitionDest.timestamp = timestamp

							const params: KernelParams = {
								inputs: srcFrames.slice(0, 2),
								output: transitionDest
							}
							if (numSrcs === 2) {
								params.mix = this.numFrames > 0 ? 1.0 - this.curFrame / this.numFrames : 0.0
							} else {
								params.mask = srcFrames[2]
							}

							this.curFrame++
							await this.vidTransition?.run(
								params,
								{ source: this.layerID, timestamp: timestamp },
								// eslint-disable-next-line @typescript-eslint/no-empty-function
								() => {}
							)
							await this.clJobs.runQueue({ source: this.layerID, timestamp: timestamp })
							transitionResult = transitionDest
						}
					} else {
						transitionResult = numSrcs > 1 && isValue(srcFrames[1]) ? srcFrames[1] : srcFrames[0]
						if (isValue(transitionResult)) transitionResult.addRef()
					}

					if (isEnd(transitionResult)) {
						transitionResult = frames[0]
						if (isValue(transitionResult)) transitionResult.addRef()
					}
				}
				frames.forEach((f) => (isValue(f) ? f.release() : {}))
			} else {
				this.layerUpdate([])
			}

			return transitionResult
		}

		this.audioPipe = silencePipe
			.zipEach(this.audSourcePipes)
			.valve(transitionAudValve, { oneToMany: true })

		// eslint-disable-next-line prettier/prettier
		this.videoPipe = blackPipe
			.zipEach(this.vidSourcePipes)
			.valve(transitionVidValve)
	}

	async makeAudTransition(): Promise<void> {
		if (this.audType === 'cut') this.audTransition = null
		else {
			const sampleRate = this.consumerFormat.audioSampleRate
			const numAudChannels = this.consumerFormat.audioChannels
			const audLayout = `${numAudChannels}c`
			const inParams: Array<AudioInputParam> = []

			let inStr = ''
			for (let s = 0; s < this.audSourcePipes.length; ++s) {
				inStr += `[in${s}:a]`
				inParams.push({
					name: `in${s}:a`,
					timeBase: [1, sampleRate],
					sampleRate: sampleRate,
					sampleFormat: 'fltp',
					channelLayout: audLayout
				})
			}

			this.audTransition = await filterer({
				filterType: 'audio',
				inputParams: inParams,
				outputParams: [
					{
						name: 'out0:a',
						sampleRate: sampleRate,
						sampleFormat: 'fltp',
						channelLayout: audLayout
					}
				],
				filterSpec: `${inStr}amix=inputs=${this.audSourcePipes.length}:duration=shortest[out0:a]`
			})
			// console.log('\nTransition audio:\n', this.audTransition.graph.dump())
		}
	}

	async makeVidTransition(): Promise<void> {
		if (this.vidType === 'cut') this.vidTransition = null
		else {
			this.vidTransition = new ImageProcess(
				this.clContext,
				new Transition(this.vidType, this.consumerFormat.width, this.consumerFormat.height),
				this.clJobs
			)
			await this.vidTransition.init()
		}
	}

	update(
		type: string,
		numFrames: number,
		audioSrcPipes: RedioPipe<Frame | RedioEnd>[],
		videoSrcPipes: RedioPipe<OpenCLBuffer | RedioEnd>[]
	): void {
		this.nextType = type
		this.nextNumFrames = numFrames > 0 ? numFrames - 1 : 0
		this.updating = true

		this.audSourcePipes.splice(0)
		audioSrcPipes.forEach((p) => this.audSourcePipes.push(p))
		this.vidSourcePipes.splice(0)
		videoSrcPipes.forEach((p) => this.vidSourcePipes.push(p))
	}

	getAudioPipe(): RedioPipe<Frame | RedioEnd> | undefined {
		return this.audioPipe
	}
	getVideoPipe(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined {
		return this.videoPipe
	}

	async release(): Promise<void> {
		this.silence?.release()
		this.black?.release()
		await once(this.endEvent, 'end')
		this.silence = null
		this.black = null
		this.audTransition = null
		this.vidTransition?.finish()
		this.vidTransition = null
		this.audioPipe = undefined
		this.videoPipe = undefined
	}
}
