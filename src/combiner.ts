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
import redio, { RedioPipe, RedioEnd, isValue, Valve, nil } from 'redioactive'
import { OpenCLBuffer } from 'nodencl'
import { filterer, Filterer, frame, Frame } from 'beamcoder'
import { VideoFormat } from './config'
import { ClJobs } from './clJobQueue'
import ImageProcess from './process/imageProcess'
import Combine from './process/combine'

export class Combiner {
	private readonly clContext: nodenCLContext
	private readonly consumerFormat: VideoFormat
	private readonly chanID: string
	private layers: Map<number, Layer>
	private combiner: ImageProcess | undefined
	private audioPipe: RedioPipe<Frame | RedioEnd> | undefined
	private videoPipe: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private silenceAudValve: Valve<Frame | RedioEnd, Frame | RedioEnd> | undefined
	private silencePipe: RedioPipe<Frame | RedioEnd> | undefined
	private blackPipe: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private audLayerPipes: RedioPipe<Frame | RedioEnd>[] = []
	private vidLayerPipes: RedioPipe<OpenCLBuffer | RedioEnd>[] = []
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
		this.consumerFormat = consumerFormat
		this.chanID = chanID
		this.layers = new Map<number, Layer>()
		this.combiner = new ImageProcess(
			this.clContext,
			new Combine(this.consumerFormat.width, this.consumerFormat.height),
			clJobs
		)
	}

	async initialise(): Promise<void> {
		await this.combiner?.init()

		const sampleRate = this.consumerFormat.audioSampleRate
		const numAudChannels = this.consumerFormat.audioChannels
		const audLayout = `${numAudChannels}c`

		let audSilenceFilterer: Filterer | null = null
		let audCombineFilterer: Filterer | null = null

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

		audSilenceFilterer = await filterer({
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

		audCombineFilterer = await filterer({
			filterType: 'audio',
			inputParams: [
				{
					name: 'in0:a',
					timeBase: [1, sampleRate],
					sampleRate: sampleRate,
					sampleFormat: 'flt',
					channelLayout: audLayout
				},
				{
					name: 'in1:a',
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
			filterSpec: `[in0:a][in1:a] amix=inputs=2:duration=shortest [out0:a]`
		})
		// console.log('\nCombine audio:\n', audCombineFilterer.graph.dump())

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

		this.silencePipe = redio(async () => silence, { bufferSizeMax: 1 })

		this.silenceAudValve = async (frame) => {
			if (isValue(frame) && audSilenceFilterer) {
				const ff = await audSilenceFilterer.filter([{ name: 'in0:a', frames: [frame] }])
				return ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				return frame
			}
		}

		this.combineAudValve = async (frames) => {
			if (isValue(frames) && audCombineFilterer) {
				const numLayers = frames.length - 1
				const layerFrames = frames.slice(1) as Frame[]
				if (numLayers < 2) {
					return frames[numLayers === 0 ? 0 : 1]
				} else if (frames.reduce((acc, f) => acc && isValue(f), true)) {
					const ff = await audCombineFilterer.filter([
						{ name: 'in0:a', frames: [layerFrames[0]] },
						{ name: 'in1:a', frames: [layerFrames[1]] }
					])
					return ff[0].frames.length > 0 ? ff[0].frames : nil
				} else {
					return frames[1]
				}
			} else {
				return frames
			}
		}

		this.blackPipe = redio(async () => black, { bufferSizeMax: 1 })

		this.combineVidValve = async (frames) => {
			if (isValue(frames)) {
				const numLayers = frames.length - 1
				const layerFrames = frames.slice(1) as OpenCLBuffer[]
				if (numLayers === 0) {
					if (isValue(frames[0])) {
						frames[0].addRef()
						frames[0].timestamp++
					}
					return frames[0]
				} else if (numLayers === 1) {
					return frames[1]
				} else if (frames.reduce((acc, f) => acc && isValue(f), true)) {
					if (isValue(frames[0])) frames[0].timestamp++
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
					combineDest.timestamp = layerFrames[0].timestamp

					await this.combiner?.run(
						{
							inputs: layerFrames,
							output: combineDest
						},
						{ source: this.chanID, timestamp: layerFrames[0].timestamp },
						() => layerFrames.forEach((f) => f.release())
					)
					return combineDest
				} else {
					console.log('piping ???')
					return layerFrames[0]
				}
			} else {
				if (this.combiner) {
					console.log('combinerVid release')
					black.release()
					this.combiner = undefined
				}
				return frames
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
