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

import { clContext as nodenCLContext } from 'nodencl'
import { Layer } from './layer'
import redio, { RedioPipe, RedioEnd, isValue, Valve, nil, end } from 'redioactive'
import { OpenCLBuffer } from 'nodencl'
import { AudioInputParam, filterer, Filterer, frame, Frame } from 'beamcoder'
import { VideoFormat } from './config'
import { ClJobs } from './clJobQueue'
import ImageProcess from './process/imageProcess'
import Combine from './process/combine'

export class Combiner {
	private readonly clContext: nodenCLContext
	private readonly chanID: string
	private readonly consumerFormat: VideoFormat
	private readonly clJobs: ClJobs
	private layers: Map<number, Layer>
	private lastNumAudLayers = 0
	private lastNumVidLayers = 0
	private vidCombiner: ImageProcess | undefined
	private audioPipe: RedioPipe<Frame | RedioEnd> | undefined
	private videoPipe: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private silenceAudValve: Valve<Frame | RedioEnd, Frame | RedioEnd> | undefined
	private silencePipe: RedioPipe<Frame | RedioEnd> | undefined
	private blackPipe: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private audLayerPipes: RedioPipe<Frame | RedioEnd>[] = []
	private vidLayerPipes: RedioPipe<OpenCLBuffer | RedioEnd>[] = []
	private audSilenceFilterer: Filterer | undefined
	private audCombineFilterer: Filterer | undefined
	private combineAudValve:
		| Valve<[Frame | RedioEnd, ...(Frame | RedioEnd)[]], Frame | RedioEnd>
		| undefined
	private combineVidValve:
		| Valve<[OpenCLBuffer | RedioEnd, ...(OpenCLBuffer | RedioEnd)[]], OpenCLBuffer | RedioEnd>
		| undefined

	constructor(
		clContext: nodenCLContext,
		chanID: string,
		consumerFormat: VideoFormat,
		clJobs: ClJobs
	) {
		this.clContext = clContext
		this.chanID = chanID
		this.consumerFormat = consumerFormat
		this.clJobs = clJobs
		this.layers = new Map<number, Layer>()
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

		this.audSilenceFilterer = await filterer({
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
					sampleFormat: 'flt',
					channelLayout: audLayout
				}
			],
			filterSpec: '[in0:a] asetpts=N/SR/TB [out0:a]'
		})
		// console.log('\nSilence:\n', audSilenceFilterer.graph.dump())

		await this.makeCombineAudFilterer(this.lastNumAudLayers)

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

		await this.makeCombineVidProcess(this.lastNumVidLayers)

		this.silencePipe = redio(async () => silence, { bufferSizeMax: 1 })

		this.silenceAudValve = async (frame) => {
			if (isValue(frame) && this.audSilenceFilterer) {
				const ff = await this.audSilenceFilterer.filter([{ name: 'in0:a', frames: [frame] }])
				return ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				return frame
			}
		}

		this.combineAudValve = async (frames) => {
			if (isValue(frames) && this.audCombineFilterer) {
				const numLayers = frames.length - 1
				const layerFrames = frames.slice(1)
				const doFilter = layerFrames.reduce((acc, f) => acc && isValue(f), true)

				if (this.lastNumAudLayers !== numLayers) {
					await this.makeCombineAudFilterer(numLayers)
					this.lastNumAudLayers = numLayers
				}

				const srcFrames = frames as [Frame | RedioEnd, ...(Frame | RedioEnd)[]]
				if (!isValue(srcFrames[0])) return end
				const refFrame = srcFrames[0]

				if (numLayers === 0) {
					return srcFrames[0]
				} else if (numLayers === 1) {
					if (!isValue(srcFrames[1])) return end
					srcFrames[1].pts = refFrame.pts
					return srcFrames[1]
				} else if (doFilter) {
					const filterFrames = (layerFrames as Frame[]).map((f, i) => {
						f.pts = refFrame.pts
						return {
							name: `in${i}:a`,
							frames: [f]
						}
					})
					const ff = await this.audCombineFilterer.filter(filterFrames)
					return ff[0].frames.length > 0 ? ff[0].frames : nil
				} else {
					return end
				}
			} else {
				return end
			}
		}

		this.blackPipe = redio(async () => black, { bufferSizeMax: 1 })

		this.combineVidValve = async (frames) => {
			if (isValue(frames)) {
				const numLayers = frames.length - 1
				const layerFrames = frames.slice(1) as OpenCLBuffer[]

				if (this.lastNumVidLayers !== numLayers) {
					await this.makeCombineVidProcess(numLayers)
					this.lastNumVidLayers = numLayers
				}

				const srcFrames = frames as [OpenCLBuffer | RedioEnd, ...(OpenCLBuffer | RedioEnd)[]]
				if (!isValue(srcFrames[0])) return end
				srcFrames[0].timestamp++

				if (numLayers === 0) {
					srcFrames[0].addRef()
					return frames[0]
				} else if (numLayers === 1) {
					if (!isValue(srcFrames[1])) return end
					srcFrames[1].timestamp = srcFrames[0].timestamp
					return frames[1]
				} else if (frames.reduce((acc, f) => acc && isValue(f), true)) {
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
					combineDest.timestamp = srcFrames[0].timestamp

					await this.vidCombiner?.run(
						{
							inputs: layerFrames,
							output: combineDest
						},
						{ source: this.chanID, timestamp: srcFrames[0].timestamp },
						() => layerFrames.forEach((f) => f.release())
					)
					return combineDest
				} else {
					return end
				}
			} else {
				if (this.vidCombiner) {
					console.log('combinerVid release')
					black.release()
					this.vidCombiner = undefined
				}
				return end
			}
		}

		this.audioPipe = this.silencePipe
			.valve(this.silenceAudValve, { oneToMany: true })
			.zipEach(this.audLayerPipes)
			.valve(this.combineAudValve, { oneToMany: true })

		// eslint-disable-next-line prettier/prettier
		this.videoPipe = this.blackPipe
			.zipEach(this.vidLayerPipes)
			.valve(this.combineVidValve)

		this.update()
	}

	async makeCombineAudFilterer(numLayers: number): Promise<void> {
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
				sampleFormat: 'flt',
				channelLayout: `${numAudChannels}c`
			})
		}

		this.audCombineFilterer = await filterer({
			filterType: 'audio',
			inputParams: inParams,
			outputParams: [
				{
					name: 'out0:a',
					sampleRate: sampleRate,
					sampleFormat: 'flt',
					channelLayout: audLayout
				}
			],
			filterSpec: `${inStr} amix=inputs=${filtLayers}:duration=shortest [out0:a]`
		})
		// console.log('\nCombine audio:\n', this.audCombineFilterer.graph.dump())
	}

	async makeCombineVidProcess(numLayers: number): Promise<void> {
		this.vidCombiner = new ImageProcess(
			this.clContext,
			new Combine(numLayers, this.consumerFormat.width, this.consumerFormat.height),
			this.clJobs
		)
		await this.vidCombiner.init()
	}

	update(): void {
		const layerNums: number[] = []
		const layerIter = this.layers.keys()
		let next = layerIter.next()
		while (!next.done) {
			layerNums.push(next.value)
			next = layerIter.next()
		}
		// sort layers from low to high for combining bottom to top
		layerNums.sort((a, b) => a - b)

		this.audLayerPipes.splice(0)
		this.vidLayerPipes.splice(0)
		layerNums.forEach((l) => {
			const layer = this.layers.get(l) as Layer
			this.audLayerPipes.push(layer.getAudioPipe() as RedioPipe<Frame | RedioEnd>)
			this.vidLayerPipes.push(layer.getVideoPipe() as RedioPipe<OpenCLBuffer | RedioEnd>)
		})
	}

	setLayer(layerNum: number, layer: Layer): void {
		this.layers.set(layerNum, layer)
		this.update()
	}

	delLayer(layerNum: number): boolean {
		const result = this.layers.delete(layerNum)
		this.update()
		return result
	}

	getLayer(layerNum: number): Layer | undefined {
		return this.layers.get(layerNum)
	}

	clearLayers(): void {
		this.layers.clear()
		this.update()
	}

	getAudioPipe(): RedioPipe<Frame | RedioEnd> | undefined {
		return this.audioPipe
	}
	getVideoPipe(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined {
		return this.videoPipe
	}
}
