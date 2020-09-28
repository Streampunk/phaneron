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
import { RedioPipe, RedioEnd, isValue, Valve, nil } from 'redioactive'
import { OpenCLBuffer } from 'nodencl'
import { filterer, Filterer, Frame } from 'beamcoder'
import { VideoFormat } from './config'
import { ClJobs } from './clJobQueue'
import ImageProcess from './process/imageProcess'
import Combine from './process/combine'

export class Combiner {
	private readonly clContext: nodenCLContext
	private readonly consumerFormat: VideoFormat
	private layers: Map<number, Layer>
	private combiner: ImageProcess
	private audioPipe: RedioPipe<Frame | RedioEnd> | undefined
	private videoPipe: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private audCombineFilterer: Filterer | undefined
	private combineAudValve: Valve<Frame | RedioEnd, Frame | RedioEnd> | undefined
	private combineVidValve: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> | undefined

	constructor(clContext: nodenCLContext, consumerFormat: VideoFormat, clJobs: ClJobs) {
		this.clContext = clContext
		this.consumerFormat = consumerFormat
		this.layers = new Map<number, Layer>()
		this.combiner = new ImageProcess(
			this.clContext,
			new Combine(this.consumerFormat.width, this.consumerFormat.height, 1),
			clJobs
		)
	}

	async initialise(): Promise<void> {
		await this.combiner.init()

		const sampleRate = this.consumerFormat.audioSampleRate
		const numAudChannels = this.consumerFormat.audioChannels
		const audLayout = `${numAudChannels}c`
		this.audCombineFilterer = await filterer({
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
		// console.log('\nCombine audio:\n', this.audCombineFilterer.graph.dump())

		this.combineAudValve = async (frame) => {
			if (isValue(frame) && this.audCombineFilterer) {
				const ff = await this.audCombineFilterer.filter([
					{ name: 'in0:a', frames: [frame] },
					{ name: 'in1:a', frames: [frame] }
				])
				return ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				return frame
			}
		}

		const numBytesRGBA = this.consumerFormat.width * this.consumerFormat.height * 4 * 4
		this.combineVidValve = async (frame) => {
			if (isValue(frame)) {
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
				combineDest.timestamp = frame.timestamp

				await this.combiner.run(
					{
						bgIn: frame,
						ovIn: [frame],
						output: combineDest
					},
					frame.timestamp,
					() => frame.release()
				)
				return combineDest
			} else {
				return frame
			}
		}
	}

	update(): void {
		// !! Only handles the first layer at the moment !!
		const layerObj = Array.from(this.layers)[0]
		let layer = null
		if (layerObj) layer = layerObj[1]
		if (layer && this.combineAudValve)
			this.audioPipe = layer.getAudioPipe()?.valve(this.combineAudValve, { oneToMany: true })
		else this.audioPipe = undefined
		if (layer && this.combineVidValve)
			this.videoPipe = layer.getVideoPipe()?.valve(this.combineVidValve)
		else this.audioPipe = undefined
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
