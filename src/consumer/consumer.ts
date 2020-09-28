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
import { MacadamConsumerFactory } from './macadamConsumer'
import { RedioPipe, RedioEnd } from 'redioactive'
import { Frame } from 'beamcoder'
import { ConsumerConfig } from '../config'
import { ClJobs } from '../clJobQueue'

export interface Consumer {
	initialise(clJobs: ClJobs): Promise<void>
	connect(mixAudio: RedioPipe<Frame | RedioEnd>, mixVideo: RedioPipe<OpenCLBuffer | RedioEnd>): void
}

export interface ConsumerFactory<T extends Consumer> {
	createConsumer(config: ConsumerConfig): T
}

export class ConsumerRegistry {
	private readonly consumerFactories: Map<string, ConsumerFactory<Consumer>>

	constructor(clContext: nodenCLContext) {
		this.consumerFactories = new Map()
		this.consumerFactories.set('decklink', new MacadamConsumerFactory(clContext))
	}

	createConsumer(config: ConsumerConfig): Consumer {
		const factory = this.consumerFactories.get(config.device.name)
		if (!factory) throw new Error(`Failed to create consumer for device '${config.device.name}'`)
		return factory.createConsumer(config)
	}
}
