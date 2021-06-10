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
import { DefaultTransitionSpec, Layer } from './layer'
import { ConsumerRegistry, Consumer } from './consumer/consumer'
import { CombineLayer, Combiner } from './combiner'
import { ClJobs } from './clJobQueue'
import { TransitionSpec } from './transitioner'

export class Channel {
	private readonly clContext: nodenCLContext
	private readonly chanID: string
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
		this.consumers = this.consumerRegistry.createConsumers(
			chanNum,
			this.chanID,
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

	getConfig(): ConsumerConfig {
		return this.consumerConfig
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

	updateLayers(): void {
		const layerNums: number[] = []
		const layerIter = this.layers.keys()
		let next = layerIter.next()
		while (!next.done) {
			layerNums.push(next.value)
			next = layerIter.next()
		}
		// sort layers from low to high for combining bottom to top
		layerNums.sort((a, b) => a - b)

		const curLayers = this.combiner.getLayers()
		const newLayers: CombineLayer[] = []
		layerNums.forEach((l) => {
			const layer = this.layers.get(l)
			if (layer) {
				const audPipe = layer.getAudioPipe()
				const vidPipe = layer.getVideoPipe()
				if (audPipe && vidPipe) {
					const aid = audPipe.fittingId
					const curLayer = curLayers.find((cl) => aid === cl.getAudioPipe().fittingId)
					if (curLayer) newLayers.push(curLayer)
					else newLayers.push(new CombineLayer(layer, audPipe, vidPipe))
				}
			}
		})

		this.combiner.updateLayers(newLayers)
	}

	async loadSource(params: LoadParams): Promise<boolean> {
		let producer: Producer | undefined
		const transitionSpec: TransitionSpec = JSON.parse(DefaultTransitionSpec)
		let error = ''
		try {
			producer = await this.producerRegistry.createSource(
				params,
				this.consumerConfig.format,
				this.clJobs
			)

			if (params.transition) {
				transitionSpec.type = params.transition.type
				if (params.transition.type === 'wipe' && params.transition.url)
					transitionSpec.mask = await this.producerRegistry.createSource(
						{
							url: params.transition.url,
							streams: params.transition.streams,
							layer: params.layer,
							length: params.transition.length
						},
						this.consumerConfig.format,
						this.clJobs
					)
				transitionSpec.len = params.transition.length
			}
		} catch (err) {
			error = err
		}

		if (!producer || error.length > 0) {
			console.log(`Failed to create source for params ${params}`)
			return false
		}

		let layer = this.layers.get(params.layer)
		if (!layer) {
			layer = new Layer(
				this.clContext,
				`${this.chanID}-l${params.layer}`,
				this.consumerConfig,
				this.clJobs
			)
			await layer.initialise()
			this.layers.set(params.layer, layer)
		}

		return layer.load(
			producer,
			transitionSpec,
			params.preview ? true : false,
			params.autoPlay ? true : false,
			this.updateLayers.bind(this)
		)
	}

	async play(layerNum: number, ticker?: () => void): Promise<boolean> {
		const layer = this.layers.get(layerNum)
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		await layer?.play(async (t: string) => {
			if (t === 'end') {
				await layer?.release()
				this.layers.delete(layerNum)
				this.updateLayers()
			} else if (ticker) ticker()
		})
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
			await Promise.all(
				layerNums.map((n) => this.stop(n).then(() => this.layers.get(n)?.release()))
			)
			for (const n of layerNums) this.layers.delete(n)
		} else {
			result = await this.stop(layerNum)
			await this.layers.get(layerNum)?.release()
			this.layers.delete(layerNum)
		}

		this.updateLayers()
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
