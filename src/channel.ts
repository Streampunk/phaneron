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
import { ChanLayer, ChanProperties } from './chanLayer'
import { ProducerRegistry } from './producer/producer'
import { Layer } from './layer'
import { ConsumerRegistry, Consumer } from './consumer/consumer'
import { Mixer } from './mixer'

export class Channel {
	private readonly channel: number
	private readonly consumerRegistry: ConsumerRegistry
	private readonly producerRegistry: ProducerRegistry
	private readonly chanProperties: ChanProperties
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
		this.chanProperties = { audioTimebase: [1, 48000], videoTimebase: [1, 50] }
		this.mixer = new Mixer(clContext, 1920, 1080)
		this.layers = new Map<number, Layer>()
	}

	async loadSource(
		chanLay: ChanLayer,
		params: string[],
		preview = false,
		autoPlay = false
	): Promise<boolean> {
		const producer = await this.producerRegistry.createSource(chanLay, params, this.chanProperties)
		if (producer === null) {
			console.log(`Failed to create source for params ${params}`)
			return false
		}

		const layer = new Layer()
		layer.load(producer, preview, autoPlay)
		this.layers.set(chanLay.layer, layer)
		const srcAudio = producer.getSourceAudio()
		const srcVideo = producer.getSourceVideo()
		if (!(srcVideo !== undefined && srcAudio !== undefined)) {
			console.log(`Failed to create sources for params ${params}`)
			return false
		}

		await this.mixer.init([srcAudio], [srcVideo])
		const mixAudio = this.mixer.getMixAudio()
		const mixVideo = this.mixer.getMixVideo()
		if (!(mixVideo !== undefined && mixAudio !== undefined)) {
			console.log(`Failed to create mixer for params ${params}`)
			return false
		}

		this.consumer = await this.consumerRegistry.createSpout(
			this.channel,
			mixAudio,
			mixVideo,
			this.chanProperties
		)
		if (!this.consumer) console.log(`Failed to create spout for channel ${this.channel}`)

		return true
	}

	play(chanLay: ChanLayer): boolean {
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

	anchor(chanLay: ChanLayer, params: string[]): boolean {
		if (params.length) {
			this.mixer.setAnchor(chanLay.layer, +params[0], +params[1])
		} else {
			this.mixer.showAnchor(chanLay.layer)
		}
		return true
	}

	rotation(chanLay: ChanLayer, params: string[]): boolean {
		if (params.length) {
			this.mixer.setRotation(chanLay.layer, +params[0])
		} else {
			this.mixer.showRotation(chanLay.layer)
		}
		return true
	}

	fill(chanLay: ChanLayer, params: string[]): boolean {
		if (params.length) {
			this.mixer.setFill(chanLay.layer, +params[0], +params[1], +params[2], +params[3])
		} else {
			this.mixer.showFill(chanLay.layer)
		}
		return true
	}
}
