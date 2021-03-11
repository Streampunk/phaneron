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
import redio, { RedioPipe, RedioEnd, isValue, Valve, nil, end } from 'redioactive'
import { OpenCLBuffer } from 'nodencl'
import { AudioInputParam, filterer, Filterer, frame, Frame } from 'beamcoder'
import { VideoFormat } from './config'
import { ClJobs } from './clJobQueue'
import ImageProcess from './process/imageProcess'
import Combine from './process/combine'

export class CombineLayer {
	private readonly layer: Layer
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
		this.layer = layer
		this.audioPipe = audPipe
		this.videoPipe = vidPipe
		this.endEvent = layer.getEndEvent()
	}

	getLayer(): Layer {
		return this.layer
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

export class Combiner {
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
		const sampleRate = this.consumerFormat.audioSampleRate
		const numAudChannels = this.consumerFormat.audioChannels
		const audLayout = `${numAudChannels}c`

		const silenceArr = new Float32Array(1024 * numAudChannels)
		const silence = frame({
			nb_samples: 1024,
			format: 'flt',
			pts: 0,
			sample_rate: sampleRate,
			channels: numAudChannels,
			channel_layout: audLayout,
			data: [Buffer.from(silenceArr.buffer)]
		})

		const audSilenceFilterer = await filterer({
			filterType: 'audio',
			inputParams: [
				{
					name: 'in0:a',
					timeBase: [1, sampleRate],
					sampleRate: sampleRate,
					sampleFormat: 'flt',
					channelLayout: audLayout
				}
			],
			outputParams: [
				{
					name: 'out0:a',
					sampleRate: sampleRate,
					sampleFormat: 'fltp',
					channelLayout: audLayout
				}
			],
			filterSpec: '[in0:a] asetpts=N/SR/TB [out0:a]'
		})
		// console.log('\nSilence:\n', audSilenceFilterer.graph.dump())

		const numBytesRGBA = this.consumerFormat.width * this.consumerFormat.height * 4 * 4
		const black: OpenCLBuffer = await this.clContext.createBuffer(
			numBytesRGBA,
			'readwrite',
			'coarse',
			{
				width: this.consumerFormat.width,
				height: this.consumerFormat.height
			},
			'combinerBlack'
		)

		let off = 0
		const blackFloat = new Float32Array(numBytesRGBA / 4)
		for (let y = 0; y < this.consumerFormat.height; ++y) {
			for (let x = 0; x < this.consumerFormat.width * 4; x += 4) {
				blackFloat[off + x + 0] = 0.0
				blackFloat[off + x + 1] = 0.0
				blackFloat[off + x + 2] = 0.0
				blackFloat[off + x + 3] = 0.0
			}
			off += this.consumerFormat.width * 4
		}
		await black.hostAccess('writeonly')
		Buffer.from(blackFloat.buffer).copy(black)

		const silencePipe: RedioPipe<Frame | RedioEnd> = redio(async () => silence, {
			bufferSizeMax: 1
		})

		const silenceAudValve: Valve<Frame | RedioEnd, Frame | RedioEnd> = async (frame) => {
			if (isValue(frame) && audSilenceFilterer) {
				const ff = await audSilenceFilterer.filter([{ name: 'in0:a', frames: [frame] }])
				return ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				return frame
			}
		}

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
				const layerFrames = frames.slice(1)
				const doFilter = layerFrames.reduce((acc, f) => acc && isValue(f), true)

				const numCombineLayers = numLayers < 2 ? 0 : numLayers
				if (numCombineLayers && this.lastNumAudLayers !== numCombineLayers) {
					await this.makeAudCombiner(numCombineLayers)
					this.lastNumAudLayers = numCombineLayers
				}

				const srcFrames = frames as [Frame | RedioEnd, ...(Frame | RedioEnd)[]]
				if (!isValue(srcFrames[0])) return end
				const refFrame = srcFrames[0]

				if (numLayers === 0) {
					return srcFrames[0]
				} else if (numLayers === 1) {
					if (isValue(srcFrames[1])) srcFrames[1].pts = refFrame.pts
					return srcFrames[1]
				} else if (doFilter && this.audCombiner) {
					const filterFrames = (layerFrames as Frame[]).map((f, i) => {
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
				return end
			}
		}

		const blackPipe: RedioPipe<OpenCLBuffer | RedioEnd> = redio(async () => black, {
			bufferSizeMax: 1
		})

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

		const combineVidValve: Valve<
			[OpenCLBuffer | RedioEnd, ...(OpenCLBuffer | RedioEnd)[]],
			OpenCLBuffer | RedioEnd
		> = async (frames) => {
			if (isValue(frames)) {
				const numLayers = frames.length - 1
				const layerFrames = frames.slice(1) as OpenCLBuffer[]

				if (!isValue(frames[0])) return end
				const timestamp = frames[0].timestamp++

				const numCombineLayers = numLayers < 2 ? 0 : numLayers
				if (numCombineLayers && this.lastNumVidLayers !== numCombineLayers) {
					await this.makeVidCombiner(numCombineLayers)
					this.lastNumVidLayers = numCombineLayers
				}

				if (numLayers === 0) {
					frames[0].addRef()
					return frames[0]
				} else if (numLayers === 1) {
					if (isValue(frames[1])) frames[1].timestamp = timestamp
					return frames[1]
				}

				if (frames.reduce((acc, f) => acc && isValue(f), true)) {
					const combineDest = await this.clContext.createBuffer(
						numBytesRGBA,
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
					for (let d = 1; d < this.numConsumers; ++d) combineDest.addRef()

					await this.vidCombiner?.run(
						{
							inputs: layerFrames,
							output: combineDest
						},
						{ source: this.chanID, timestamp: timestamp },
						() => layerFrames.forEach((f) => f.release())
					)
					await this.clJobs.runQueue({ source: this.chanID, timestamp: timestamp })
					return combineDest
				} else {
					return end
				}
			} else {
				if (this.vidCombiner) {
					this.clJobs.clearQueue(this.chanID)
					black.release()
					this.vidCombiner = undefined
				}
				return end
			}
		}

		this.audioPipe = silencePipe
			.valve(silenceAudValve, { oneToMany: true })
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

	addConsumer(): void {
		this.numConsumers++
	}

	removeConsumer(): void {
		this.numConsumers--
	}

	getAudioPipe(): RedioPipe<Frame | RedioEnd> | undefined {
		return this.audioPipe
	}
	getVideoPipe(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined {
		return this.videoPipe
	}
}
