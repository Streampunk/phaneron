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
import { ChanLayer, SourceFrame } from '../chanLayer'
import { FFmpegProducerFactory } from './ffmpegProducer'
import { RedioPipe } from 'redioactive'

export interface Producer {
	initialise(): Promise<RedioPipe<SourceFrame> | null>
}

export interface ProducerFactory<T extends Producer> {
	createProducer(id: string, params: string[]): T
}

export class InvalidProducerError extends Error {
	constructor(message?: string) {
		super(message)
		// see: typescriptlang.org/docs/handbook/release-notes/typescript-2-2.html
		Object.setPrototypeOf(this, new.target.prototype) // restore prototype chain
		this.name = InvalidProducerError.name // stack traces display correctly now
	}
}
export class ProducerRegistry {
	private readonly producerFactories: ProducerFactory<Producer>[]

	constructor(clContext: nodenCLContext) {
		this.producerFactories = []
		this.producerFactories.push(new FFmpegProducerFactory(clContext))
	}

	async createSource(chanLay: ChanLayer, params: string[]): Promise<RedioPipe<SourceFrame> | null> {
		const id = `${chanLay.channel}-${chanLay.layer}`
		let p: RedioPipe<SourceFrame> | null = null
		for (const f of this.producerFactories) {
			try {
				const producer = f.createProducer(id, params) as Producer
				if ((p = await producer.initialise()) !== null) break
			} catch (err) {
				if (!(err instanceof InvalidProducerError)) {
					throw err
				}
			}
		}

		if (p === null) {
			console.log(`Failed to find producer for params: '${params}'`)
		}

		return p
	}
}
