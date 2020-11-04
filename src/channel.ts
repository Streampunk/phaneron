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
import { LoadParams } from './chanLayer'
import { ProducerRegistry } from './producer/producer'
import { ConsumerConfig } from './config'
import { Layer } from './layer'
import { ConsumerRegistry, Consumer } from './consumer/consumer'
import { Combiner } from './combiner'
import { ClJobs } from './clJobQueue'

export class Channel {
	private readonly clContext: nodenCLContext
	private readonly chanID: string
	private readonly consumerConfig: ConsumerConfig
	private readonly consumerRegistry: ConsumerRegistry
	private readonly producerRegistry: ProducerRegistry
	private readonly clJobs: ClJobs
	private readonly combiner: Combiner
	private readonly consumer: Consumer

	constructor(
		clContext: nodenCLContext,
		chanID: string,
		consumerConfig: ConsumerConfig,
		consumerRegistry: ConsumerRegistry,
		producerRegistry: ProducerRegistry,
		clJobs: ClJobs
	) {
		this.clContext = clContext
		this.chanID = chanID
		this.consumerConfig = consumerConfig
		this.consumerRegistry = consumerRegistry
		this.producerRegistry = producerRegistry
		this.clJobs = clJobs
		this.combiner = new Combiner(
			this.clContext,
			this.chanID,
			this.consumerConfig.format,
			this.clJobs
		)
		this.consumer = this.consumerRegistry.createConsumer(
			this.chanID,
			this.consumerConfig,
			this.clJobs
		)
	}

	async initialise(): Promise<void> {
		await this.combiner.initialise()
		await this.consumer.initialise()

		const combinerAudio = this.combiner.getAudioPipe()
		const combinerVideo = this.combiner.getVideoPipe()
		if (!(combinerAudio !== undefined && combinerVideo !== undefined)) {
			throw new Error('Failed to get combiner connection pipes')
		}
		this.consumer.connect(combinerAudio, combinerVideo)

		return Promise.resolve()
	}

	async loadSource(params: LoadParams, preview = false): Promise<boolean> {
		this.clear(params.layer)

		const producer = await this.producerRegistry.createSource(
			params,
			this.consumerConfig.format,
			this.clJobs
		)
		if (producer === null) {
			console.log(`Failed to create source for params ${params}`)
			return false
		}

		const layer = new Layer(this.clContext, this.consumerConfig.format, this.clJobs)
		await layer.load(producer, preview, params.autoPlay as boolean)
		this.combiner.setLayer(params.layer, layer)

		return true
	}

	play(layerNum: number): boolean {
		const layer = this.combiner.getLayer(layerNum)
		layer?.play()
		return layer !== undefined
	}

	pause(layerNum: number): boolean {
		const layer = this.combiner.getLayer(layerNum)
		layer?.pause()
		return layer !== undefined
	}

	resume(layerNum: number): boolean {
		const layer = this.combiner.getLayer(layerNum)
		layer?.resume()
		return layer !== undefined
	}

	stop(layerNum: number): boolean {
		const layer = this.combiner.getLayer(layerNum)
		let result = layer !== undefined
		if (layer) {
			layer.stop()
			result &&= this.combiner.delLayer(layerNum)
		}
		return result
	}

	clear(layerNum: number): boolean {
		let result = true
		if (layerNum === 0) this.combiner.clearLayers()
		else {
			result = this.stop(layerNum)
			result &&= this.combiner.delLayer(layerNum)
		}
		return result
	}

	anchor(layerNum: number, params: string[]): boolean {
		const layer = this.combiner.getLayer(layerNum)
		layer?.anchor(params)
		return layer !== undefined
	}

	rotation(layerNum: number, params: string[]): boolean {
		const layer = this.combiner.getLayer(layerNum)
		layer?.rotation(params)
		return layer !== undefined
	}

	fill(layerNum: number, params: string[]): boolean {
		const layer = this.combiner.getLayer(layerNum)
		layer?.fill(params)
		return layer !== undefined
	}

	volume(layerNum: number, params: string[]): boolean {
		const layer = this.combiner.getLayer(layerNum)
		layer?.volume(params)
		return layer !== undefined
	}
}
