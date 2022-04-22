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

import { ProducerFactory, Producer, InvalidProducerError } from './producer'
import { chanLayerFromString } from '../chanLayer'
import { channels } from '../index'
import { RedioPipe, RedioEnd, isValue, Valve, nil } from 'redioactive'
import { OpenCLBuffer } from 'nodencl'
import { Frame, filterer, FilterContext } from 'beamcoder'
import { LoadParams } from '../chanLayer'
import { VideoFormat } from '../config'
import { SourcePipes } from '../routeSource'

export class RouteProducer implements Producer {
	private readonly sourceID: string
	private readonly params: LoadParams
	private srcPipes: SourcePipes | undefined
	private audSource: RedioPipe<Frame | RedioEnd> | undefined
	private vidSource: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private srcFormat: VideoFormat | undefined
	private numForks = 0
	private paused = true
	private running = true
	private volFilter: FilterContext | undefined

	constructor(id: number, params: LoadParams) {
		this.sourceID = `P${id} ${params.url} L${params.layer}`
		this.params = params

		if (this.params.url.slice(0, 5).toUpperCase() !== 'ROUTE')
			throw new InvalidProducerError('Route producer supports route command')
	}

	async initialise(): Promise<void> {
		const routeIndex = this.params.url.indexOf('://')
		if (routeIndex < 0) throw new Error('Route producer failed to find route source in parameters')

		const chanLayer = chanLayerFromString(this.params.url.substring(routeIndex + 3))
		if (!chanLayer.valid)
			throw new Error(
				`Route producer failed to parse channel and layer from params ${this.params.url.substring(
					routeIndex + 3
				)}`
			)

		const channel = channels[chanLayer.channel - 1]
		if (!channel)
			throw new Error(`Route producer failed to find source of channel ${chanLayer.channel}`)

		const filtStr = `[in${0}:a]asetnsamples=n=1024:p=1, volume=0.0:eval=frame:precision=float[out${0}:a]`
		// console.log(filtStr)

		this.srcPipes = await channel.getRoutePipes(chanLayer.layer)
		this.srcFormat = this.srcPipes.format
		const audLayout = `${this.srcFormat.audioChannels}c`
		const audFilterer = await filterer({
			filterType: 'audio',
			inputParams: [
				{
					name: 'in0:a',
					timeBase: [1, this.srcFormat.audioSampleRate],
					sampleRate: this.srcFormat.audioSampleRate,
					sampleFormat: 'fltp',
					channelLayout: audLayout
				}
			],
			outputParams: [
				{
					name: 'out0:a',
					sampleRate: this.srcFormat.audioSampleRate,
					sampleFormat: 'fltp',
					channelLayout: audLayout
				}
			],
			filterSpec: filtStr
		})
		// console.log('\nRoute producer audio:\n', audFilterer.graph.dump())
		this.volFilter = audFilterer.graph.filters.find((f) => f.filter.name === 'volume')

		const audFilter: Valve<Frame | RedioEnd, Frame | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const ff = await audFilterer.filter([{ name: 'in0:a', frames: [frame] }])
				return ff[0] && ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				return frame
			}
		}

		const vidForkRef: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				for (let f = 1; f < this.numForks; ++f) frame.addRef()
				return frame
			} else {
				return frame
			}
		}

		this.audSource = this.srcPipes.audio
			.pause(() => this.paused && this.running)
			.valve(audFilter, { bufferSizeMax: 2, oneToMany: true })

		this.vidSource = this.srcPipes.video.valve(vidForkRef).pause((frame) => {
			if (!this.running) {
				frame = nil
				return false
			}
			if (this.paused && isValue(frame)) (frame as OpenCLBuffer).addRef()
			return this.paused
		})

		console.log(
			`Created Route producer from channel ${chanLayer.channel}`,
			chanLayer.layer > 0 ? `layer ${chanLayer.layer}` : ''
		)
	}

	getSourcePipes(): SourcePipes {
		if (!(this.audSource && this.vidSource && this.srcFormat))
			throw new Error(`Route producer failed to find source pipes for route`)

		this.numForks++
		const audFork = this.audSource.fork()
		const vidFork = this.vidSource.fork()
		return {
			audio: audFork,
			video: vidFork,
			format: this.srcFormat,
			release: () => {
				try {
					this.audSource?.unfork(audFork)
					this.vidSource?.unfork(vidFork)
					this.numForks--
					// eslint-disable-next-line no-empty
				} catch (err) {}
			}
		}
	}

	srcID(): string {
		return this.sourceID
	}

	setPaused(pause: boolean): void {
		this.paused = pause
		if (this.volFilter && this.volFilter.priv)
			this.volFilter.priv = { volume: this.paused ? '0.0' : '1.0' }
	}

	release(): void {
		this.srcPipes?.release()
		this.running = false
	}
}

export class RouteProducerFactory implements ProducerFactory<RouteProducer> {
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	constructor() {}

	createProducer(id: number, params: LoadParams): RouteProducer {
		return new RouteProducer(id, params)
	}
}
