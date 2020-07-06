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
import { ChanLayer } from './chanLayer'
import { ProducerRegistry } from './producer/producer'
import { Layer } from './layer'
import { ConsumerRegistry, Consumer } from './consumer/consumer'
import { Mixer } from './mixer'

export class Channel {
	private readonly channel: number
	private readonly consumerRegistry: ConsumerRegistry
	private readonly producerRegistry: ProducerRegistry
	private consumer: Consumer | null = null
	private readonly mixer: Mixer
	private layers: Map<number, Layer>

	constructor(
		clContext: nodenCLContext,
		channel: number,
		consumerRegistry: ConsumerRegistry,
		producerRegistry: ProducerRegistry
	) {
		this.channel = channel
		this.consumerRegistry = consumerRegistry
		this.producerRegistry = producerRegistry
		this.mixer = new Mixer(clContext, 1920, 1080)
		this.layers = new Map<number, Layer>()
	}

	async loadSource(
		chanLay: ChanLayer,
		params: string[],
		preview = false,
		autoPlay = false
	): Promise<boolean> {
		const producer = await this.producerRegistry.createSource(chanLay, params)
		if (producer === null) {
			console.log(`Failed to create source for params ${params}`)
			return false
		}

		const layer = new Layer()
		layer.load(producer, preview, autoPlay)
		this.layers.set(chanLay.layer, layer)
		const srcPipe = producer.getSourcePipe()
		if (srcPipe === undefined) {
			console.log(`Failed to create source pipe for params ${params}`)
			return false
		}

		const mixerPipe = await this.mixer.init(srcPipe)
		if (mixerPipe === undefined) {
			console.log(`Failed to create mixer pipe for params ${params}`)
			return false
		}

		this.consumer = await this.consumerRegistry.createSpout(this.channel, mixerPipe)
		if (!this.consumer) console.log(`Failed to create spout for channel ${this.channel}`)

		return true
	}

	async play(chanLay: ChanLayer): Promise<boolean> {
		const layer = this.layers.get(chanLay.layer) as Layer // !!! TODO
		layer.play()
		return true
	}

	pause(chanLay: ChanLayer): boolean {
		const layer = this.layers.get(chanLay.layer) as Layer // !!! TODO
		layer.pause()
		return true
	}

	resume(chanLay: ChanLayer): boolean {
		const layer = this.layers.get(chanLay.layer) as Layer // !!! TODO
		layer.resume()
		return true
	}

	stop(chanLay: ChanLayer): boolean {
		this.consumer?.release()
		const layer = this.layers.get(chanLay.layer) as Layer // !!! TODO
		layer.stop()
		return true
	}

	clear(chanLay: ChanLayer): boolean {
		this.consumer?.release()
		if (chanLay.layer === 0) this.layers.clear()
		else {
			this.stop(chanLay)
			this.layers.delete(chanLay.layer)
		}
		return true
	}
}
