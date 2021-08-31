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
import { RedioPipe, RedioEnd, isValue, Valve } from 'redioactive'
import { clContext as nodenCLContext, OpenCLBuffer } from 'nodencl'
import { Frame } from 'beamcoder'
import { ClJobs } from '../clJobQueue'
import { LoadParams } from '../chanLayer'
import { VideoFormat } from '../config'
import { Mixer } from './mixer'
import { SourcePipes } from '../routeSource'

export class RouteProducer implements Producer {
	private readonly sourceID: string
	private readonly params: LoadParams
	private readonly clContext: nodenCLContext
	private readonly clJobs: ClJobs
	private readonly consumerFormat: VideoFormat
	private readonly mixer: Mixer
	private srcPipes: SourcePipes | undefined
	private routeAudSource: RedioPipe<Frame[] | RedioEnd> | undefined
	private routeVidSource: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private audSource: RedioPipe<Frame[] | RedioEnd> | undefined
	private vidSource: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private vidFork: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private srcFormat: VideoFormat | undefined
	private numForks = 0

	constructor(
		id: number,
		params: LoadParams,
		context: nodenCLContext,
		clJobs: ClJobs,
		consumerFormat: VideoFormat
	) {
		this.sourceID = `P${id} ${params.url} L${params.layer}`
		this.params = params
		this.clContext = context
		this.clJobs = clJobs
		this.consumerFormat = consumerFormat
		this.mixer = new Mixer(this.clContext, this.consumerFormat, this.clJobs)

		if (this.params.url.slice(0, 5) !== 'ROUTE')
			throw new InvalidProducerError('Route producer supports route command')
	}

	async initialise(): Promise<void> {
		const routeIndex = this.params.url.indexOf('://')
		if (routeIndex < 0) throw new Error('Route producer failed to find route source in parameters')

		const chanLayer = chanLayerFromString(this.params.url.substr(routeIndex + 3))
		if (!chanLayer.valid)
			throw new Error(
				`Route producer failed to parse channel and layer from params ${this.params.url.substr(
					routeIndex + 3
				)}`
			)

		const channel = channels[chanLayer.channel - 1]
		if (!channel)
			throw new Error(`Route producer failed to find source of channel ${chanLayer.channel}`)

		this.srcPipes = await channel.getRoutePipes(chanLayer.layer)

		this.routeAudSource = this.srcPipes.audio
		this.audSource = this.routeAudSource.fork()

		const vidForkRef: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				for (let f = 0; f < this.numForks; ++f) frame.addRef()
				return frame
			} else {
				return frame
			}
		}
		this.routeVidSource = this.srcPipes.video
		this.vidFork = this.routeVidSource.fork()
		this.vidSource = this.vidFork.valve(vidForkRef)

		this.srcFormat = this.srcPipes.format

		await this.mixer.init(
			this.sourceID,
			this.audSource.fork(),
			this.vidSource.fork(),
			this.srcFormat
		)

		console.log(
			`Created Route producer from channel ${chanLayer.channel}`,
			chanLayer.layer > 0 ? `layer ${chanLayer.layer}` : ''
		)
	}

	async getSourcePipes(): Promise<SourcePipes> {
		if (!(this.audSource && this.vidSource && this.srcFormat))
			throw new Error(`Route producer failed to find source pipes for route`)
		this.numForks++
		return Promise.resolve({
			audio: this.audSource,
			video: this.vidSource,
			format: this.srcFormat,
			release: () => this.numForks--
		})
	}

	getMixer(): Mixer {
		return this.mixer
	}

	setPaused(pause: boolean): void {
		this.mixer.setPaused(pause)
	}

	release(): void {
		if (this.audSource) this.routeAudSource?.unfork(this.audSource)
		if (this.vidFork) this.routeVidSource?.unfork(this.vidFork)
		this.srcPipes?.release()
		this.mixer.release()
	}
}

export class RouteProducerFactory implements ProducerFactory<RouteProducer> {
	private clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createProducer(
		id: number,
		params: LoadParams,
		clJobs: ClJobs,
		consumerFormat: VideoFormat
	): RouteProducer {
		return new RouteProducer(id, params, this.clContext, clJobs, consumerFormat)
	}
}
