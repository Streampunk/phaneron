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
import { Frame, Filterer, filterer /*, FilterContext*/ } from 'beamcoder'
import { VideoFormat } from '../config'
import { ClJobs } from '../clJobQueue'
import ImageProcess from '../process/imageProcess'
import Transform from '../process/transform'

export interface AudioMixFrame {
	frames: Frame[][]
	mute: boolean
}

interface AnchorParams {
	x: number
	y: number
}

interface FillParams {
	xOffset: number
	yOffset: number
	xScale: number
	yScale: number
}

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
	private mixAudio: RedioPipe<Frame | RedioEnd> | undefined
	private mixVideo: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private audMixFilterer: Filterer | null = null
	private muted = false

	anchorParams: AnchorParams = { x: 0, y: 0 }
	rotation = 0
	fillParams: FillParams = { xOffset: 0, yOffset: 0, xScale: 1, yScale: 1 }
	srcLevels: number[] = []
	volume = 1.0

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
		srcAudio: RedioPipe<AudioMixFrame | RedioEnd>,
		srcVideo: RedioPipe<OpenCLBuffer | RedioEnd>,
		srcFormat: VideoFormat
	): Promise<void> {
		const srcSampleRate = srcFormat.audioSampleRate
		const srcAudChannels = srcFormat.audioChannels

		const dstSampleRate = this.consumerFormat.audioSampleRate
		const dstAudChannels = this.consumerFormat.audioChannels
		const dstAudLayout = `${dstAudChannels}c`

		let filtSpec = ''
		for (let c = 0; c < srcAudChannels; ++c) {
			this.srcLevels.push(1.0)
			const panSpec = `pan=${dstAudLayout}|c${c % dstAudChannels}=${this.srcLevels[c]}*c0`
			filtSpec +=
				(c === 0 ? '' : ';\n') +
				`[in${c}:a]highpass=mix=0, adelay=delays='', acompressor=threshold=1:mix=0, aformat=sample_fmts=fltp, ${panSpec}[c${c}:a]`
		}
		filtSpec += ';\n'
		for (let c = 0; c < srcAudChannels; ++c) filtSpec += `[c${c}:a]`
		filtSpec += `amix=inputs=${srcAudChannels}:duration=shortest:weights=`
		for (let c = 0; c < srcAudChannels; ++c)
			filtSpec += (c === 0 ? '' : ' ') + (c < dstAudChannels ? '1' : '0')
		filtSpec += `, volume=1.0:eval=frame:precision=float[out0:a]`
		// console.log(filtSpec)

		const inParams = []
		for (let s = 0; s < srcAudChannels; ++s)
			inParams.push({
				name: `in${s}:a`,
				timeBase: [1, srcSampleRate],
				sampleRate: srcSampleRate,
				sampleFormat: 'fltp',
				channelLayout: '1c'
			})

		this.audMixFilterer = await filterer({
			filterType: 'audio',
			inputParams: inParams,
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
		// console.log('\nChannel audio:\n', this.audMixFilterer.graph.dump())

		// console.log(getFilters(this.audMixFilterer))
		// const filtContexts = this.audMixFilterer.graph.filters.filter(
		// 	(filt) => filt.filter.name === 'pan'
		// )
		// filtContexts.forEach((c) => console.log(getFilterParams(c)))

		const audMixFilter: Valve<AudioMixFrame | RedioEnd, Frame | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				if (!this.audMixFilterer) return nil
				if (frame.mute != this.muted) {
					this.muted = frame.mute
					this.setVolume(this.volume, this.muted)
				}

				const inSpec: { name: string; frames: Frame[] }[] = []
				frame.frames.forEach((f, i) => {
					inSpec.push({ name: `in${i}:a`, frames: f })
				})
				const ff = await this.audMixFilterer.filter(inSpec)
				return ff[0] && ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				this.audMixFilterer = null
				return frame
			}
		}

		await this.transform?.init()
		const numBytesRGBA = this.consumerFormat.width * this.consumerFormat.height * 4 * 4
		const srcXscale = this.consumerFormat.squareWidth / srcFormat.squareWidth
		const srcYscale = this.consumerFormat.squareHeight / srcFormat.squareHeight

		const mixVidValve: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const xfDest = await this.clContext.createBuffer(
					numBytesRGBA,
					'readwrite',
					'coarse',
					{
						width: this.consumerFormat.width,
						height: this.consumerFormat.height
					},
					'transform'
				)
				xfDest.timestamp = frame.timestamp

				await this.transform?.run(
					{
						input: frame,
						flipH: false,
						flipV: false,
						anchorX: this.anchorParams.x - 0.5,
						anchorY: this.anchorParams.y - 0.5,
						scaleX: srcXscale * this.fillParams.xScale,
						scaleY: srcYscale * this.fillParams.yScale,
						rotate: -this.rotation / 360.0,
						offsetX: -this.fillParams.xOffset,
						offsetY: -this.fillParams.yOffset,
						output: xfDest
					},
					{ source: sourceID, timestamp: frame.timestamp },
					() => frame.release()
				)
				await this.clJobs.runQueue({ source: sourceID, timestamp: frame.timestamp })

				return xfDest
			} else {
				this.transform = null
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

	setAnchor(x: number, y: number): boolean {
		this.anchorParams = { x: x, y: y }
		return true
	}

	setRotation(angle: number): boolean {
		this.rotation = angle
		return true
	}

	setFill(xPos: number, yPos: number, xScale: number, yScale: number): boolean {
		this.fillParams = { xOffset: xPos, yOffset: yPos, xScale: xScale, yScale: yScale }
		return true
	}

	setVolume(volume: number, mute?: boolean): boolean {
		this.volume = volume
		const volFilter = this.audMixFilterer?.graph.filters.find((f) => f.filter.name === 'volume')
		if (volFilter && volFilter.priv)
			volFilter.priv = { volume: mute ? '0.0' : this.volume.toString() }
		return true
	}

	getAudioPipe(): RedioPipe<Frame | RedioEnd> | undefined {
		return this.mixAudio
	}
	getVideoPipe(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined {
		return this.mixVideo
	}
}
