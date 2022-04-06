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
import { clContext as nodenCLContext } from 'nodencl'
import { Layer } from './layer'
import { RedioPipe, RedioEnd, isValue, isEnd, Valve, nil, end } from 'redioactive'
import { OpenCLBuffer } from 'nodencl'
import { AudioInputParam, filterer, Filterer, Frame } from 'beamcoder'
import { VideoFormat } from './config'
import { ClJobs } from './clJobQueue'
import ImageProcess from './process/imageProcess'
import Combine from './process/combine'
import { Silence, Black } from './blackSilence'
import { SourcePipes, RouteSource } from './routeSource'
import { Consumer } from './consumer/consumer'

export class CombineLayer {
	private readonly audioPipe: RedioPipe<Frame | RedioEnd>
	private readonly videoPipe: RedioPipe<OpenCLBuffer | RedioEnd>
	private readonly endEvent: EventEmitter
	private audioState: 'start' | 'run' | 'end' = 'start'
	private videoState: 'start' | 'run' | 'end' = 'start'

	constructor(
		layer: Layer,
		audPipe: RedioPipe<Frame | RedioEnd>,
		vidPipe: RedioPipe<OpenCLBuffer | RedioEnd>
	) {
		this.audioPipe = audPipe
		this.videoPipe = vidPipe
		this.endEvent = layer.getEndEvent()
	}

	getAudioPipe(): RedioPipe<Frame | RedioEnd> {
		return this.audioPipe
	}

	getVideoPipe(): RedioPipe<OpenCLBuffer | RedioEnd> {
		return this.videoPipe
	}

	checkAudio(frame: Frame | RedioEnd): boolean {
		let result = true
		if (isValue(frame)) {
			if (this.audioState === 'start') this.audioState = 'run'
		} else {
			if (this.audioState === 'run') {
				this.audioState = 'end'
				if (this.audioState === 'end' && this.videoState === 'end') this.endEvent.emit('end')
			}
			result = false
		}
		return result
	}

	checkVideo(frame: OpenCLBuffer | RedioEnd): boolean {
		let result = true
		if (isValue(frame)) {
			if (this.videoState === 'start') this.videoState = 'run'
		} else {
			if (this.videoState === 'run') {
				this.videoState = 'end'
				if (this.audioState === 'end' && this.videoState === 'end') this.endEvent.emit('end')
			}
			result = false
		}
		return result
	}
}

export class Combiner implements RouteSource {
	private readonly clContext: nodenCLContext
	private readonly chanID: string
	private readonly consumerFormat: VideoFormat
	private readonly clJobs: ClJobs
	private lastNumAudLayers = 0
	private lastNumVidLayers = 0
	private numConsumers = 0
	private audCombiner: Filterer | undefined
	private vidCombiner: ImageProcess | undefined
	private audioPipe: RedioPipe<Frame | RedioEnd> | undefined
	private videoPipe: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private combineLayers: CombineLayer[] = []
	private audLayerPipes: RedioPipe<Frame | RedioEnd>[] = []
	private vidLayerPipes: RedioPipe<OpenCLBuffer | RedioEnd>[] = []
	private audRoutePipe: RedioPipe<Frame[] | RedioEnd> | undefined
	private vidTimestamp = 0
	private numForks = 0

	constructor(
		clContext: nodenCLContext,
		chanID: string,
		consumerFormat: VideoFormat,
		clJobs: ClJobs
	) {
		this.clContext = clContext
		this.chanID = `${chanID} combine`
		this.consumerFormat = consumerFormat
		this.clJobs = clJobs
	}

	async initialise(): Promise<void> {
		const silence = new Silence(this.consumerFormat)
		const silencePipe = await silence.initialise()
		const black = new Black(this.clContext, this.consumerFormat, this.chanID)
		const blackPipe = await black.initialise()

		const audEndValve: Valve<
			[Frame | RedioEnd, ...(Frame | RedioEnd)[]],
			[Frame | RedioEnd, ...(Frame | RedioEnd)[]]
		> = async (frames) => {
			if (isValue(frames)) {
				return frames.filter((f, i) =>
					i > 0
						? this.combineLayers.length > i - 1
							? this.combineLayers[i - 1].checkAudio(f)
							: false
						: true
				) as [Frame | RedioEnd, ...(Frame | RedioEnd)[]]
			} else {
				return frames
			}
		}

		const combineAudValve: Valve<
			[Frame | RedioEnd, ...(Frame | RedioEnd)[]],
			Frame | RedioEnd
		> = async (frames) => {
			if (isValue(frames)) {
				const numLayers = frames.length - 1
				const layerFrames = frames.slice(1) as Frame[]
				const doFilter = layerFrames.reduce((acc, f) => acc && isValue(f), true)

				const numCombineLayers = numLayers < 2 ? 0 : numLayers
				if (numCombineLayers && this.lastNumAudLayers !== numCombineLayers) {
					await this.makeAudCombiner(numCombineLayers)
					this.lastNumAudLayers = numCombineLayers
				}

				const srcFrames = frames as Frame[]
				if (!isValue(frames[0])) return end
				const refFrame = srcFrames[0]

				if (numLayers === 0) {
					return srcFrames[0]
				} else if (numLayers === 1) {
					if (isValue(srcFrames[1])) srcFrames[1].pts = refFrame.pts
					return srcFrames[1]
				} else if (doFilter && this.audCombiner) {
					const filterFrames = layerFrames.map((f, i) => {
						f.pts = refFrame.pts
						return {
							name: `in${i}:a`,
							frames: [f]
						}
					})
					const ff = await this.audCombiner.filter(filterFrames)
					return ff[0].frames.length > 0 ? ff[0].frames : nil
				} else {
					return end
				}
			} else {
				this.audCombiner = undefined
				silence.release()
				return frames
			}
		}

		const vidEndValve: Valve<
			[OpenCLBuffer | RedioEnd, ...(OpenCLBuffer | RedioEnd)[]],
			[OpenCLBuffer | RedioEnd, ...(OpenCLBuffer | RedioEnd)[]]
		> = async (frames) => {
			if (isValue(frames)) {
				return frames.filter((f, i) =>
					i > 0
						? this.combineLayers.length > i - 1
							? this.combineLayers[i - 1].checkVideo(f)
							: false
						: true
				) as [OpenCLBuffer | RedioEnd, ...(OpenCLBuffer | RedioEnd)[]]
			} else {
				return frames
			}
		}

		// let lastTime: [number, number] = [0, 0]
		const combineVidValve: Valve<
			[OpenCLBuffer | RedioEnd, ...(OpenCLBuffer | RedioEnd)[]],
			OpenCLBuffer | RedioEnd
		> = async (frames) => {
			let result: OpenCLBuffer | RedioEnd = end
			if (isValue(frames) && isValue(frames[0])) {
				const layerFrames = frames.slice(1)
				const numLayers = layerFrames.length

				const timestamp = this.vidTimestamp++

				const numCombineLayers = numLayers < 2 ? 0 : numLayers
				if (numCombineLayers && this.lastNumVidLayers !== numCombineLayers) {
					await this.makeVidCombiner(numCombineLayers)
					this.lastNumVidLayers = numCombineLayers
				}

				if (numLayers === 0) {
					frames[0].timestamp = timestamp
					frames[0].addRef()
					result = frames[0]
				} else if (numLayers === 1) {
					if (!isEnd(frames[1])) {
						frames[1].timestamp = timestamp
						frames[1].addRef()
					}
					result = frames[1]
				} else if (layerFrames.reduce((acc, f) => acc && isValue(f), true)) {
					const combineDest = await this.clContext.createBuffer(
						this.consumerFormat.width * this.consumerFormat.height * 4 * 4,
						'readwrite',
						'coarse',
						{
							width: this.consumerFormat.width,
							height: this.consumerFormat.height
						},
						'combine'
					)
					// combineDest.loadstamp = Math.min(...layerFrames.map((f) => f.loadstamp))
					combineDest.timestamp = timestamp

					await this.vidCombiner?.run(
						{
							inputs: layerFrames,
							output: combineDest
						},
						{ source: this.chanID, timestamp: timestamp },
						// eslint-disable-next-line @typescript-eslint/no-empty-function
						() => {}
					)
					await this.clJobs.runQueue({ source: this.chanID, timestamp: timestamp })
					result = combineDest
				}

				if (isValue(result))
					for (let d = 1; d < this.numConsumers + this.numForks; ++d) result.addRef()
				frames.forEach((f) => (isValue(f) ? f.release() : {}))
			} else {
				if (this.vidCombiner) {
					this.clJobs.clearQueue(this.chanID)
					black.release()
					this.vidCombiner = undefined
				}
			}

			return result
		}

		this.audioPipe = silencePipe
			.zipEach(this.audLayerPipes)
			.valve(audEndValve)
			.valve(combineAudValve, { oneToMany: true })

		// eslint-disable-next-line prettier/prettier
		this.videoPipe = blackPipe
			.zipEach(this.vidLayerPipes)
			.valve(vidEndValve)
			.valve(combineVidValve)
	}

	async makeAudCombiner(numLayers: number): Promise<void> {
		const sampleRate = this.consumerFormat.audioSampleRate
		const numAudChannels = this.consumerFormat.audioChannels
		const audLayout = `${numAudChannels}c`
		const inParams: Array<AudioInputParam> = []

		let inStr = ''
		const filtLayers = numLayers > 0 ? numLayers : 1
		for (let i = 0; i < filtLayers; i++) {
			inStr += `[in${i}:a]`
			inParams.push({
				name: `in${i}:a`,
				timeBase: [1, sampleRate],
				sampleRate: sampleRate,
				sampleFormat: 'fltp',
				channelLayout: `${numAudChannels}c`
			})
		}

		this.audCombiner = await filterer({
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
			filterSpec: `${inStr}amix=inputs=${filtLayers}:duration=shortest[out0:a]`
		})
		// console.log('\nCombine audio:\n', this.audCombiner.graph.dump())
	}

	async makeVidCombiner(numLayers: number): Promise<void> {
		this.vidCombiner = new ImageProcess(
			this.clContext,
			new Combine(numLayers, this.consumerFormat.width, this.consumerFormat.height),
			this.clJobs
		)
		await this.vidCombiner.init()
	}

	getLayers(): CombineLayer[] {
		return this.combineLayers
	}

	updateLayers(layers: CombineLayer[]): void {
		this.combineLayers = layers.slice(0)
		this.audLayerPipes.splice(0)
		this.vidLayerPipes.splice(0)
		layers.forEach((l) => {
			this.audLayerPipes.push(l.getAudioPipe())
			this.vidLayerPipes.push(l.getVideoPipe())
		})
	}

	connect(consumer: Consumer): void {
		if (!(this.audioPipe !== undefined && this.videoPipe !== undefined)) {
			throw new Error('Failed to get combiner connection pipes')
		}
		consumer.connect(this.audioPipe.fork(), this.videoPipe.fork())
		this.numConsumers++
	}

	release(consumer: Consumer): void {
		if (!(this.audioPipe !== undefined && this.videoPipe !== undefined)) {
			throw new Error('Failed to get combiner connection pipes')
		}
		consumer.release(this.audioPipe, this.videoPipe)
		this.numConsumers--
	}

	async getSourcePipes(): Promise<SourcePipes> {
		if (!(this.audioPipe && this.videoPipe && this.consumerFormat))
			throw new Error(`Combiner failed to find source pipes for route`)
		if (this.numForks === 0) {
			let audFilterer: Filterer | null = null
			let filtStr = ''
			const numAudChannels = this.consumerFormat.audioChannels
			const sampleRate = this.consumerFormat.audioSampleRate
			filtStr += `[in${0}:a]channelsplit=channel_layout=${numAudChannels}c`
			for (let s = 0; s < numAudChannels; ++s) filtStr += `[out${s}:a]`
			// console.log(filtStr)

			const outParams = []
			for (let s = 0; s < numAudChannels; ++s) {
				outParams.push({
					name: `out${s}:a`,
					sampleRate: this.consumerFormat.audioSampleRate,
					sampleFormat: 'fltp',
					channelLayout: '1c'
				})
			}

			audFilterer = await filterer({
				filterType: 'audio',
				inputParams: [
					{
						name: 'in0:a',
						timeBase: [1, sampleRate],
						sampleRate: sampleRate,
						sampleFormat: 'fltp',
						channelLayout: `${numAudChannels}c`
					}
				],
				outputParams: outParams,
				filterSpec: filtStr
			})
			// console.log('\nCombiner route source audio:\n', audFilterer.graph.dump())

			const audFilter: Valve<Frame | RedioEnd, Frame[] | RedioEnd> = async (frame) => {
				if (isValue(frame)) {
					if (!audFilterer) return nil
					const ff = await audFilterer.filter([{ name: 'in0:a', frames: [frame] }])
					if (ff.reduce((acc, f) => acc && f.frames && f.frames.length > 0, true)) {
						return ff.map((f) => f.frames[0])
					} else return nil
				} else {
					return frame
				}
			}

			this.audRoutePipe = this.audioPipe.fork().valve(audFilter)
		}
		this.numForks++

		if (!this.audRoutePipe) throw new Error(`Combiner failed to create audio filter for route`)
		return {
			audio: this.audRoutePipe,
			video: this.videoPipe,
			format: this.consumerFormat,
			release: () => this.numForks--
		}
	}

	getAudioPipe(): RedioPipe<Frame | RedioEnd> | undefined {
		return this.audioPipe
	}
	getVideoPipe(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined {
		return this.videoPipe
	}
}
