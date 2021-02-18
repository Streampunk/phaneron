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
import { Producer, ProducerRegistry } from './producer/producer'
import { ConsumerConfig } from './config'
import { Layer } from './layer'
import { ConsumerRegistry, Consumer } from './consumer/consumer'
import { Combiner } from './combiner'
import { ClJobs } from './clJobQueue'

export class Channel {
	private readonly clContext: nodenCLContext
	private readonly consumerConfig: ConsumerConfig
	private readonly consumerRegistry: ConsumerRegistry
	private readonly producerRegistry: ProducerRegistry
	private readonly clJobs: ClJobs
	private readonly combiner: Combiner
	private readonly consumers: Consumer[]
	private readonly layers: Map<number, Layer>

	constructor(
		clContext: nodenCLContext,
		chanID: string,
		chanNum: number,
		consumerConfig: ConsumerConfig,
		consumerRegistry: ConsumerRegistry,
		producerRegistry: ProducerRegistry,
		clJobs: ClJobs
	) {
		this.clContext = clContext
		this.consumerConfig = consumerConfig
		this.consumerRegistry = consumerRegistry
		this.producerRegistry = producerRegistry
		this.clJobs = clJobs
		this.combiner = new Combiner(this.clContext, chanID, this.consumerConfig.format, this.clJobs)
		this.consumers = this.consumerRegistry.createConsumers(
			chanNum,
			chanID,
			this.consumerConfig,
			this.clJobs
		)
		this.layers = new Map<number, Layer>()
	}

	async initialise(): Promise<void> {
		await this.combiner.initialise()
		await Promise.all(this.consumers.map((c) => c.initialise()))
		this.consumers.forEach((c) => this.addConsumer(c))
		return Promise.resolve()
	}

	addConsumer(consumer: Consumer): void {
		if (!this.consumers.find((c) => c === consumer)) this.consumers.push(consumer)

		const combinerAudio = this.combiner.getAudioPipe()
		const combinerVideo = this.combiner.getVideoPipe()
		if (!(combinerAudio !== undefined && combinerVideo !== undefined)) {
			throw new Error('Failed to get combiner connection pipes')
		}
		consumer.connect(combinerAudio.fork(), combinerVideo.fork())
		this.combiner.addConsumer()
	}

	removeConsumer(consumer: Consumer): void {
		if (!this.consumers.some((c) => c === consumer))
			throw new Error('remove consumer - consumer not found')
		const i = this.consumers.indexOf(consumer)
		this.consumers.splice(i, i + 1) // should be consumer.destroy()
		this.combiner.removeConsumer()
	}

	async loadSource(params: LoadParams): Promise<boolean> {
		let producer: Producer | null = null
		let error = ''
		try {
			producer = await this.producerRegistry.createSource(
				params,
				this.consumerConfig.format,
				this.clJobs
			)
		} catch (err) {
			error = err
		}

		if (producer === null || error.length > 0) {
			console.log(`Failed to create source for params ${params}`)
			return false
		}

		let layer = this.layers.get(params.layer)
		if (!layer) {
			layer = new Layer()
			this.layers.set(params.layer, layer)
		}

		return layer.load(producer, params.preview ? true : false, params.autoPlay ? true : false, () =>
			this.combiner.updateLayers(this.layers)
		)
	}

	async play(layerNum: number): Promise<boolean> {
		const layer = this.layers.get(layerNum)
		await layer?.play()
		return layer !== undefined
	}

	pause(layerNum: number): boolean {
		const layer = this.layers.get(layerNum)
		layer?.pause()
		return layer !== undefined
	}

	resume(layerNum: number): boolean {
		const layer = this.layers.get(layerNum)
		layer?.resume()
		return layer !== undefined
	}

	async stop(layerNum: number): Promise<boolean> {
		const layer = this.layers.get(layerNum)
		await layer?.stop()
		return layer !== undefined
	}

	async clear(layerNum: number): Promise<boolean> {
		let result = true
		if (layerNum === 0) {
			const layerNums: number[] = []
			const layerIter = this.layers.keys()
			let next = layerIter.next()
			while (!next.done) {
				layerNums.push(next.value)
				next = layerIter.next()
			}
			await Promise.all(layerNums.map((n) => this.stop(n)))
			layerNums.map((n) => this.layers.delete(n))
		} else {
			result = await this.stop(layerNum)
			this.layers.delete(layerNum)
		}

		this.combiner.updateLayers(this.layers)
		return result
	}

	anchor(layerNum: number, params: string[]): boolean {
		const layer = this.layers.get(layerNum)
		layer?.anchor(params)
		return layer !== undefined
	}

	rotation(layerNum: number, params: string[]): boolean {
		const layer = this.layers.get(layerNum)
		layer?.rotation(params)
		return layer !== undefined
	}

	fill(layerNum: number, params: string[]): boolean {
		const layer = this.layers.get(layerNum)
		layer?.fill(params)
		return layer !== undefined
	}

	volume(layerNum: number, params: string[]): boolean {
		const layer = this.layers.get(layerNum)
		layer?.volume(params)
		return layer !== undefined
	}
}
