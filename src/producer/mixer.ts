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

import { clContext as nodenCLContext, OpenCLBuffer } from 'nodencl'
import { RedioPipe, RedioEnd, isValue, Valve, nil } from 'redioactive'
import { Frame, Filterer, filterer } from 'beamcoder'
import { VideoFormat } from '../config'
import { ClJobs } from '../clJobQueue'
import ImageProcess from '../process/imageProcess'
import Transform from '../process/transform'

export interface AnchorParams {
	x: number
	y: number
}

export interface FillParams {
	xOffset: number
	yOffset: number
	xScale: number
	yScale: number
}

export type MixerParams = {
	anchor: AnchorParams
	rotation: number
	fill: FillParams
	volume: number
}

export const MixerDefaults =
	'{\
		"anchor": { "x": 0, "y": 0 },\
		"rotation": 0,\
		"fill": { "xOffset": 0, "yOffset": 0, "xScale": 1, "yScale": 1 },\
		"volume": 1\
	}'

// const getFilters = (filterer: Filterer): string[] => {
// 	const filters: string[] = []
// 	filterer.graph.filters.forEach((f) => filters.push(f.name))
// 	return filters
// }

// type optionSpec = {
// 	name: string
// 	optionType: string
// 	readonly: boolean
// 	value: string | undefined
// }

// type optionSpecs = Map<string, optionSpec[] | undefined>

// const getFilterParams = (filter: FilterContext): optionSpecs => {
// 	const specs: optionSpecs = new Map()
// 	const priv_class = filter.filter.priv_class
// 	if (priv_class) {
// 		const optionsKeys = Object.keys(priv_class.options)
// 		const options: optionSpec[] = []
// 		optionsKeys.forEach((k) => {
// 			const opt = priv_class.options[k]
// 			if (filter.priv) {
// 				options.push({
// 					name: opt.name,
// 					optionType: opt.option_type,
// 					readonly: opt.flags.READONLY,
// 					value: filter.priv[opt.name]
// 				})
// 			} else {
// 				console.log(`No entry found for parameter '${k}' in filter '${filter.name}'`)
// 				const opt = priv_class.options[k]
// 				options.push({
// 					name: opt.name,
// 					optionType: opt.option_type,
// 					readonly: opt.flags.READONLY,
// 					value: undefined
// 				})
// 			}
// 		})
// 		specs.set(filter.name, options)
// 	}
// 	return specs
// }

export class Mixer {
	private readonly clContext: nodenCLContext
	private readonly consumerFormat: VideoFormat
	private readonly clJobs: ClJobs
	private transform: ImageProcess | null
	private mixAudio!: RedioPipe<Frame | RedioEnd>
	private mixVideo!: RedioPipe<OpenCLBuffer | RedioEnd>
	private audMixFilterer: Filterer | null = null
	private mixParams = JSON.parse(MixerDefaults)
	private srcLevels: number[] = []
	private running = true
	private audDone = false
	private vidDone = false

	constructor(clContext: nodenCLContext, consumerFormat: VideoFormat, clJobs: ClJobs) {
		this.clContext = clContext
		this.consumerFormat = consumerFormat
		this.clJobs = clJobs
		this.transform = new ImageProcess(
			this.clContext,
			new Transform(this.clContext, this.consumerFormat.width, this.consumerFormat.height),
			clJobs
		)
	}

	async init(
		sourceID: string,
		srcAudio: RedioPipe<Frame | RedioEnd>,
		srcVideo: RedioPipe<OpenCLBuffer | RedioEnd>,
		srcFormat: VideoFormat
	): Promise<void> {
		const srcSampleRate = srcFormat.audioSampleRate
		const srcAudChannels = srcFormat.audioChannels

		const dstSampleRate = this.consumerFormat.audioSampleRate
		const dstAudChannels = this.consumerFormat.audioChannels
		const dstAudLayout = `${dstAudChannels}c`

		let panStr = ''
		panStr += `pan=${dstAudChannels}c`
		for (let c = 0; c < dstAudChannels; ++c) {
			this.srcLevels.push(1.0)
			panStr += `| c${c % dstAudChannels}=${this.srcLevels[c]}*c${c}`
		}
		const filtSpec = `[in${0}:a]${panStr}, highpass=mix=0, adelay=delays='', acompressor=threshold=1:mix=0, aformat=sample_fmts=fltp, volume=1.0:eval=frame:precision=float[out0:a]`
		// console.log(`mixer:\n${filtSpec}`)

		this.audMixFilterer = await filterer({
			filterType: 'audio',
			inputParams: [
				{
					name: 'in0:a',
					timeBase: [1, srcSampleRate],
					sampleRate: srcSampleRate,
					sampleFormat: 'fltp',
					channelLayout: `${srcAudChannels}c`
				}
			],
			outputParams: [
				{
					name: 'out0:a',
					sampleRate: dstSampleRate,
					sampleFormat: 'fltp',
					channelLayout: dstAudLayout
				}
			],
			filterSpec: filtSpec
		})
		// console.log('\nMixer audio:\n', this.audMixFilterer.graph.dump())

		const audMixFilter: Valve<Frame | RedioEnd, Frame | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				if (!this.running) return nil
				if (!this.audMixFilterer) return nil
				const ff = await this.audMixFilterer.filter([{ name: 'in0:a', frames: [frame] }])
				return ff[0] && ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				this.audMixFilterer = null
				this.audDone = true
				if (this.audDone && this.vidDone) this.running = false
				return frame
			}
		}

		await this.transform?.init()
		const numBytesRGBA = this.consumerFormat.width * this.consumerFormat.height * 4 * 4

		const mixVidValve: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				if (!this.running) {
					frame.release()
					return nil
				}
				const timestamp = frame.timestamp
				const xfDest = await this.clContext.createBuffer(
					numBytesRGBA,
					'readwrite',
					'coarse',
					{
						width: this.consumerFormat.width,
						height: this.consumerFormat.height
					},
					`mixer ${sourceID} ${timestamp}`
				)
				// xfDest.loadstamp = frame.loadstamp
				xfDest.timestamp = timestamp

				await this.transform?.run(
					{
						input: frame,
						flipH: false,
						flipV: false,
						anchorX: this.mixParams.anchor.x - 0.5,
						anchorY: this.mixParams.anchor.y - 0.5,
						scaleX: this.mixParams.fill.xScale,
						scaleY: this.mixParams.fill.yScale,
						rotate: -this.mixParams.rotation / 360.0,
						offsetX: -this.mixParams.fill.xOffset,
						offsetY: -this.mixParams.fill.yOffset,
						output: xfDest
					},
					{ source: sourceID, timestamp: timestamp },
					() => frame.release()
				)
				await this.clJobs.runQueue({ source: sourceID, timestamp: timestamp })
				return xfDest
			} else {
				this.clJobs.clearQueue(sourceID)
				this.transform?.finish()
				this.transform = null
				this.vidDone = true
				if (this.audDone && this.vidDone) this.running = false
				return frame
			}
		}

		// eslint-disable-next-line prettier/prettier
		this.mixAudio = srcAudio
			.valve(audMixFilter, { oneToMany: true })

		// eslint-disable-next-line prettier/prettier
		this.mixVideo = srcVideo
			.valve(mixVidValve)
	}

	release(): void {
		this.running = false
	}

	setMixParams(mixParams: MixerParams): void {
		this.mixParams = mixParams
		this.setVolume(this.mixParams.volume)
	}

	setVolume(volume: number): boolean {
		this.mixParams.volume = volume
		const volFilter = this.audMixFilterer?.graph.filters.find((f) => f.filter.name === 'volume')
		if (volFilter && volFilter.priv) volFilter.priv = { volume: this.mixParams.volume.toString() }
		return true
	}

	getAudioPipe(): RedioPipe<Frame | RedioEnd> {
		return this.mixAudio
	}
	getVideoPipe(): RedioPipe<OpenCLBuffer | RedioEnd> {
		return this.mixVideo
	}
}
