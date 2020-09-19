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
import { LoadParams, ChanProperties } from './chanLayer'
import { ProducerRegistry, Producer } from './producer/producer'
import { ConsumerConfig } from './config'
import { Layer } from './layer'
import { ConsumerRegistry, Consumer } from './consumer/consumer'
import { Mixer } from './mixer'

class Combiner {
	private layers: Map<number, Layer>

	constructor() {
		this.layers = new Map<number, Layer>()
	}

	setLayer(layerNum: number, layer: Layer): void {
		this.layers.set(layerNum, layer)
	}

	delLayer(layerNum: number): boolean {
		return this.layers.delete(layerNum)
	}

	getLayer(layerNum: number): Layer | undefined {
		return this.layers.get(layerNum)
	}

	clearLayers(): void {
		this.layers.clear()
	}
}

export class Channel {
	private readonly clContext: nodenCLContext
	private readonly consumerConfig: ConsumerConfig
	private readonly consumerRegistry: ConsumerRegistry
	private readonly producerRegistry: ProducerRegistry
	private readonly chanProperties: ChanProperties
	private readonly combiner: Combiner
	private producer: Producer | null = null
	private consumer: Consumer
	private mixer: Mixer | null = null

	constructor(
		clContext: nodenCLContext,
		consumerConfig: ConsumerConfig,
		consumerRegistry: ConsumerRegistry,
		producerRegistry: ProducerRegistry
	) {
		this.clContext = clContext
		this.consumerConfig = consumerConfig
		this.consumerRegistry = consumerRegistry
		this.producerRegistry = producerRegistry
		this.chanProperties = {
			audioTimebase: [1, this.consumerConfig.format.audioSampleRate],
			videoTimebase: [this.consumerConfig.format.duration, this.consumerConfig.format.timescale]
		}
		this.combiner = new Combiner()
		this.consumer = this.consumerRegistry.createConsumer(this.consumerConfig)
	}

	async initialise(): Promise<void> {
		return this.consumer.initialise()
	}

	async loadSource(layerNum: number, params: LoadParams, preview = false): Promise<boolean> {
		if (this.producer) this.producer.release()
		this.producer = await this.producerRegistry.createSource(params, this.chanProperties)
		if (this.producer === null) {
			console.log(`Failed to create source for params ${params}`)
			return false
		}

		const layer = new Layer()
		layer.load(this.producer, preview, params.autoPlay as boolean)
		this.combiner.setLayer(layerNum, layer)
		const srcAudio = this.producer.getSourceAudio()
		const srcVideo = this.producer.getSourceVideo()
		if (!(srcVideo !== undefined && srcAudio !== undefined)) {
			console.log(`Failed to create sources for params ${params}`)
			return false
		}

		this.mixer = new Mixer(
			this.clContext,
			this.consumerConfig.format.width,
			this.consumerConfig.format.height
		)
		await this.mixer.init([srcAudio], [srcVideo])
		const mixAudio = this.mixer.getMixAudio()
		const mixVideo = this.mixer.getMixVideo()
		if (!(mixVideo !== undefined && mixAudio !== undefined)) {
			console.log(`Failed to create mixer for params ${params}`)
			return false
		}

		this.consumer.connect(mixAudio, mixVideo)

		return true
	}

	play(layerNum: number): boolean {
		const layer = this.combiner.getLayer(layerNum)
		if (layer) layer.play()
		return layer !== undefined
	}

	pause(layerNum: number): boolean {
		const layer = this.combiner.getLayer(layerNum)
		if (layer) layer.pause()
		return layer !== undefined
	}

	resume(layerNum: number): boolean {
		const layer = this.combiner.getLayer(layerNum)
		if (layer) layer.resume()
		return layer !== undefined
	}

	stop(layerNum: number): boolean {
		const layer = this.combiner.getLayer(layerNum)
		if (layer) layer.stop()
		return layer !== undefined
	}

	clear(layerNum: number): boolean {
		let result = true
		if (layerNum === 0) this.combiner.clearLayers()
		else {
			this.stop(layerNum)
			result = this.combiner.delLayer(layerNum)
		}
		return result
	}

	anchor(layerNum: number, params: string[]): boolean {
		if (params.length) {
			this.mixer?.setAnchor(layerNum, +params[0], +params[1])
		} else {
			console.dir(this.mixer?.anchorParams, { colors: true })
		}
		return true
	}

	rotation(layerNum: number, params: string[]): boolean {
		if (params.length) {
			this.mixer?.setRotation(layerNum, +params[0])
		} else {
			console.dir(this.mixer?.rotation, { colors: true })
		}
		return true
	}

	fill(layerNum: number, params: string[]): boolean {
		if (params.length) {
			this.mixer?.setFill(layerNum, +params[0], +params[1], +params[2], +params[3])
		} else {
			console.dir(this.mixer?.fillParams, { colors: true })
		}
		return true
	}

	volume(layerNum: number, params: string[]): boolean {
		if (params.length) {
			this.mixer?.setVolume(layerNum, +params[0])
		} else {
			console.dir(this.mixer?.volume, { colors: true })
		}
		return true
	}
}
