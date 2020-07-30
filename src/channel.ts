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
import { ChanLayer, LoadParams, ChanProperties } from './chanLayer'
import { ProducerRegistry, Producer } from './producer/producer'
import { Layer } from './layer'
import { ConsumerRegistry, Consumer } from './consumer/consumer'
import { Mixer } from './mixer'

export class Channel {
	private readonly clContext: nodenCLContext
	private readonly channel: number
	private readonly consumerRegistry: ConsumerRegistry
	private readonly producerRegistry: ProducerRegistry
	private readonly chanProperties: ChanProperties
	private producer: Producer | null = null
	private consumer: Consumer | null = null
	private mixer: Mixer | null = null
	private layers: Map<number, Layer>

	constructor(
		clContext: nodenCLContext,
		channel: number,
		consumerRegistry: ConsumerRegistry,
		producerRegistry: ProducerRegistry
	) {
		this.clContext = clContext
		this.channel = channel
		this.consumerRegistry = consumerRegistry
		this.producerRegistry = producerRegistry
		this.chanProperties = { audioTimebase: [1, 48000], videoTimebase: [1, 50] }
		this.layers = new Map<number, Layer>()
	}

	async loadSource(chanLay: ChanLayer, params: LoadParams, preview = false): Promise<boolean> {
		if (this.producer) this.producer.release()
		this.producer = await this.producerRegistry.createSource(chanLay, params, this.chanProperties)
		if (this.producer === null) {
			console.log(`Failed to create source for params ${params}`)
			return false
		}

		const layer = new Layer()
		layer.load(this.producer, preview, params.autoPlay as boolean)
		this.layers.set(chanLay.layer, layer)
		const srcAudio = this.producer.getSourceAudio()
		const srcVideo = this.producer.getSourceVideo()
		if (!(srcVideo !== undefined && srcAudio !== undefined)) {
			console.log(`Failed to create sources for params ${params}`)
			return false
		}

		this.mixer = new Mixer(this.clContext, 1920, 1080)
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
		const layer = this.layers.get(chanLay.layer) as Layer // !!! TODO
		layer.stop()
		return true
	}

	clear(chanLay: ChanLayer): boolean {
		if (chanLay.layer === 0) this.layers.clear()
		else {
			this.stop(chanLay)
			this.layers.delete(chanLay.layer)
			this.consumer = null
		}
		return true
	}

	anchor(chanLay: ChanLayer, params: string[]): boolean {
		if (params.length) {
			this.mixer?.setAnchor(chanLay.layer, +params[0], +params[1])
		} else {
			console.dir(this.mixer?.anchorParams, { colors: true })
		}
		return true
	}

	rotation(chanLay: ChanLayer, params: string[]): boolean {
		if (params.length) {
			this.mixer?.setRotation(chanLay.layer, +params[0])
		} else {
			console.dir(this.mixer?.rotation, { colors: true })
		}
		return true
	}

	fill(chanLay: ChanLayer, params: string[]): boolean {
		if (params.length) {
			this.mixer?.setFill(chanLay.layer, +params[0], +params[1], +params[2], +params[3])
		} else {
			console.dir(this.mixer?.fillParams, { colors: true })
		}
		return true
	}

	volume(chanLay: ChanLayer, params: string[]): boolean {
		if (params.length) {
			this.mixer?.setVolume(chanLay.layer, +params[0])
		} else {
			console.dir(this.mixer?.volume, { colors: true })
		}
		return true
	}
}
