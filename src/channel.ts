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
import { ChanLayer, SourceFrame } from './chanLayer'
import { ProducerRegistry } from './producer/producer'
import { ConsumerRegistry } from './consumer/consumer'
import { RedioPipe, RedioStream } from 'redioactive'

export class Channel {
	private readonly channel: number
	private readonly producerRegistry: ProducerRegistry
	private readonly consumerRegistry: ConsumerRegistry
	private foreground: RedioPipe<SourceFrame> | null
	private background: RedioPipe<SourceFrame> | null
	private spout: RedioStream<OpenCLBuffer> | null

	constructor(clContext: nodenCLContext, channel: number) {
		this.channel = channel
		this.producerRegistry = new ProducerRegistry(clContext)
		this.consumerRegistry = new ConsumerRegistry(clContext)
		this.foreground = null
		this.background = null
		this.spout = null
	}

	async createSource(chanLay: ChanLayer, params: string[]): Promise<boolean> {
		this.background = await this.producerRegistry.createSource(chanLay, params)
		return this.background != null
	}

	async play(): Promise<boolean> {
		if (this.background !== null) {
			this.foreground = this.background
			this.background = null
		}

		if (this.foreground != null)
			this.spout = await this.consumerRegistry.createSpout(this.channel, this.foreground)

		return Promise.resolve(this.spout != null)
	}
}
