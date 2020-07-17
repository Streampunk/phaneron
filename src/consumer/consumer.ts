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
import { ChanProperties } from '../chanLayer'

export interface Consumer {
	initialise(): Promise<boolean>
	connect(mixAudio: RedioPipe<Frame | RedioEnd>, mixVideo: RedioPipe<OpenCLBuffer | RedioEnd>): void
	release(): void
}

export interface ConsumerFactory<T extends Consumer> {
	createConsumer(channel: number, chanProperties: ChanProperties): T
}

export class InvalidConsumerError extends Error {
	constructor(message?: string) {
		super(message)
		// see: typescriptlang.org/docs/handbook/release-notes/typescript-2-2.html
		Object.setPrototypeOf(this, new.target.prototype) // restore prototype chain
		this.name = InvalidConsumerError.name // stack traces display correctly now
	}
}
export class ConsumerRegistry {
	private readonly consumerFactories: ConsumerFactory<Consumer>[]

	constructor(clContext: nodenCLContext) {
		this.consumerFactories = []
		this.consumerFactories.push(new MacadamConsumerFactory(clContext))
	}

	async createSpout(
		channel: number,
		mixAudio: RedioPipe<Frame | RedioEnd>,
		mixVideo: RedioPipe<OpenCLBuffer | RedioEnd>,
		chanProperties: ChanProperties
	): Promise<Consumer | null> {
		let consumerOK = false
		for (const f of this.consumerFactories) {
			try {
				const consumer = f.createConsumer(channel, chanProperties) as Consumer
				consumerOK = await consumer.initialise()
				if (consumerOK) {
					consumer.connect(mixAudio, mixVideo)
					return consumer
				}
			} catch (err) {
				if (!(err instanceof InvalidConsumerError)) {
					throw err
				}
			}
		}

		console.log(`Failed to find consumer for channel: '${channel}'`)
		return null
	}
}
