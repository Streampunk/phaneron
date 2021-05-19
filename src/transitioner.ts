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
import { RedioPipe, RedioEnd, isValue, Valve, nil, isEnd, end } from 'redioactive'
import { OpenCLBuffer } from 'nodencl'
import { AudioInputParam, filterer, Filterer, Frame } from 'beamcoder'
import { VideoFormat } from './config'
import { ClJobs } from './clJobQueue'
import ImageProcess from './process/imageProcess'
import Transition from './process/transition'
import { Silence, Black } from './blackSilence'
import { Producer } from './producer/producer'
import { EventEmitter, once } from 'events'

export type TransitionSpec = { type: string; len: number; source?: Producer; mask?: Producer }
export type LayerUpdType = 'transitionEnd' | 'sourceEnd' | 'allEnd'

export class Transitioner {
	private readonly clContext: nodenCLContext
	private readonly layerID: string
	private readonly consumerFormat: VideoFormat
	private readonly clJobs: ClJobs
	private readonly endEvent: EventEmitter
	private silence: Silence | null
	private black: Black | null
	private type: string
	private curVidType: string
	private numFrames: number
	private curFrame: number
	private audTransition: Filterer | null = null
	private vidTransition: ImageProcess | null = null
	private audioPipe: RedioPipe<Frame | RedioEnd> | undefined
	private videoPipe: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private readonly audSourcePipes: RedioPipe<Frame | RedioEnd>[] = []
	private readonly vidSourcePipes: RedioPipe<OpenCLBuffer | RedioEnd>[] = []
	private numAudSources: number
	private numVidSources: number
	private audDone = false
	private vidDone = false
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	private layerUpdate: (type: LayerUpdType) => void = () => {}

	constructor(
		clContext: nodenCLContext,
		layerID: string,
		consumerFormat: VideoFormat,
		clJobs: ClJobs,
		endEvent: EventEmitter,
		layerUpdate: (type: LayerUpdType) => void
	) {
		this.clContext = clContext
		this.layerID = `${layerID} transition`
		this.consumerFormat = consumerFormat
		this.clJobs = clJobs
		this.endEvent = endEvent
		this.silence = new Silence(this.consumerFormat)
		this.black = new Black(this.clContext, this.consumerFormat, this.layerID)
		this.layerUpdate = layerUpdate
		this.type = 'cut'
		this.curVidType = 'cut'
		this.numFrames = 0
		this.curFrame = 0
		this.numAudSources = 0
		this.numVidSources = 0
	}

	async initialise(): Promise<void> {
		const silencePipe = (await this.silence?.initialise()) as RedioPipe<Frame | RedioEnd>
		const blackPipe = (await this.black?.initialise()) as RedioPipe<OpenCLBuffer | RedioEnd>

		const transitionAudValve: Valve<
			[Frame | RedioEnd, ...(Frame | RedioEnd)[]],
			Frame | RedioEnd
		> = async (frames) => {
			if (isValue(frames)) {
				if (frames.length === 1) {
					return frames[0]
				}
				const srcFrames = (frames.slice(1) as Frame[]).slice(0, 2)
				if (srcFrames.length !== this.numAudSources) await this.makeAudTransition(srcFrames.length)

				if (srcFrames.length === 1 && !isEnd(srcFrames[0])) {
					return srcFrames[0]
				} else if (srcFrames.reduce((acc, f) => acc && isValue(f), true)) {
					const pts = srcFrames[0].pts
					const filterFrames = srcFrames.map((f, i) => {
						f.pts = pts
						return {
							name: `in${i}:a`,
							frames: [f]
						}
					})
					const ff = await this.audTransition?.filter(filterFrames)
					return ff && ff[0] && ff[0].frames.length > 0 ? ff[0].frames : nil
				} else {
					if (srcFrames.length === 1 && isEnd(srcFrames[0])) {
						this.audDone = true
						if (this.audDone && this.vidDone) {
							await this.layerUpdate('allEnd')
						}
						return frames[0]
					} else {
						let frame: Frame | RedioEnd = end
						const newSrcPipes: RedioPipe<Frame | RedioEnd>[] = []
						if (srcFrames.length === this.audSourcePipes.length) {
							srcFrames.forEach((f, i) => {
								if (isValue(f)) {
									if (isEnd(frame)) frame = f
									newSrcPipes.push(this.audSourcePipes[i])
								}
							})
							this.audSourcePipes.splice(0, this.audSourcePipes.length, ...newSrcPipes)
							return frame
						} else {
							return isValue(srcFrames[1]) ? srcFrames[1] : srcFrames[0]
						}
					}
				}
			} else {
				return frames
			}
		}

		const transitionVidValve: Valve<
			[OpenCLBuffer | RedioEnd, ...(OpenCLBuffer | RedioEnd)[]],
			OpenCLBuffer | RedioEnd
		> = async (frames) => {
			if (isValue(frames)) {
				if (frames.length === 1) {
					if (isValue(frames[0])) frames[0].addRef()
					return frames[0]
				}

				const srcFrames = frames.slice(1) as OpenCLBuffer[]
				if (srcFrames.length !== this.numVidSources) await this.makeVidTransition(srcFrames.length)

				if (this.numFrames > 0 && this.curFrame === this.numFrames) {
					this.numFrames = 0
					this.curFrame = 0
					this.layerUpdate('transitionEnd')
				} else if (this.numFrames !== 0 && this.curFrame !== this.numFrames) {
					this.curFrame = this.curFrame + 1
				}

				const timestamp = srcFrames[0].timestamp
				if (srcFrames.length === 1 && !isEnd(srcFrames[0])) {
					return srcFrames[0]
				} else if (srcFrames.reduce((acc, f) => acc && isValue(f), true)) {
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

					// transitionDest.loadstamp = Math.min(...srcFrames.map((f) => f.loadstamp))
					transitionDest.timestamp = timestamp

					const params: KernelParams = {
						inputs: srcFrames.slice(0, 2),
						output: transitionDest
					}
					if (this.curVidType === 'dissolve') {
						params.mix = this.numFrames > 0 ? 1.0 - this.curFrame / this.numFrames : 0.0
					} else {
						params.mask = srcFrames[2]
					}

					await this.vidTransition?.run(
						params,
						{ source: this.layerID, timestamp: timestamp },
						() => srcFrames.forEach((f) => f.release())
					)
					await this.clJobs.runQueue({ source: this.layerID, timestamp: timestamp })

					return transitionDest
				} else {
					if (srcFrames.length === 1 && isEnd(srcFrames[0])) {
						this.vidDone = true
						if (this.audDone && this.vidDone) {
							await this.layerUpdate('allEnd')
						}
						if (isValue(frames[0])) frames[0].addRef()
						return frames[0]
					} else {
						let frame: OpenCLBuffer | RedioEnd = end
						const newSrcPipes: RedioPipe<OpenCLBuffer | RedioEnd>[] = []
						if (srcFrames.length === this.vidSourcePipes.length) {
							srcFrames.forEach((f, i) => {
								if (isValue(f)) {
									if (isEnd(frame)) frame = f
									newSrcPipes.push(this.vidSourcePipes[i])
								}
							})
							this.vidSourcePipes.splice(0, this.vidSourcePipes.length, ...newSrcPipes)
							return frame
						} else {
							return isValue(srcFrames[1]) ? srcFrames[1] : srcFrames[0]
						}
					}
				}
			} else {
				return frames
			}
		}

		this.audioPipe = silencePipe
			.zipEach(this.audSourcePipes)
			.valve(transitionAudValve, { oneToMany: true })

		// eslint-disable-next-line prettier/prettier
		this.videoPipe = blackPipe
			.zipEach(this.vidSourcePipes)
			.valve(transitionVidValve)
	}

	async makeAudTransition(numSources: number): Promise<void> {
		if (numSources > 1) {
			const sampleRate = this.consumerFormat.audioSampleRate
			const numAudChannels = this.consumerFormat.audioChannels
			const audLayout = `${numAudChannels}c`
			const inParams: Array<AudioInputParam> = []

			let inStr = ''
			for (let s = 0; s < numSources; ++s) {
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
				filterSpec: `${inStr}amix=inputs=${numSources}:duration=shortest[out0:a]`
			})
			// console.log('\nTransition audio:\n', this.audTransition.graph.dump())
		} else {
			this.audTransition = null
		}
		this.numAudSources = numSources
	}

	async makeVidTransition(numSources: number): Promise<void> {
		if (numSources > 1) {
			this.vidTransition = new ImageProcess(
				this.clContext,
				new Transition(this.type, this.consumerFormat.width, this.consumerFormat.height),
				this.clJobs
			)
			await this.vidTransition.init()
			this.curVidType = this.type
		} else {
			this.vidTransition = null
			this.curVidType = 'cut'
		}
		this.numVidSources = numSources
	}

	update(
		type: string,
		numFrames: number,
		audioSrcPipes: RedioPipe<Frame | RedioEnd>[],
		videoSrcPipes: RedioPipe<OpenCLBuffer | RedioEnd>[]
	): void {
		this.type = type
		this.numFrames = numFrames > 0 ? numFrames - 1 : 0
		this.curFrame = 0

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
