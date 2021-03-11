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
import { ClJobs } from '../clJobQueue'
import { LoadParams } from '../chanLayer'
import { VideoFormat } from '../config'
import { FFmpegProducerFactory } from './ffmpegProducer'
import { MacadamProducerFactory } from './macadamProducer'
import { RedioPipe, RedioEnd } from 'redioactive'
import { AudioMixFrame } from '../mixer'
import { GrandioseProducerFactory } from './grandioseProducer'

export interface Producer {
	initialise(consumerFormat: VideoFormat): void
	getSourceID(): string
	getFormat(): VideoFormat
	getSourceAudio(): RedioPipe<AudioMixFrame | RedioEnd> | undefined
	getSourceVideo(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	setPaused(pause: boolean): void
	release(): void
}

export interface ProducerFactory<T extends Producer> {
	createProducer(id: number, params: LoadParams, clJobs: ClJobs): T
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
	private producerID = 0

	constructor(clContext: nodenCLContext) {
		this.producerFactories = []
		this.producerFactories.push(new GrandioseProducerFactory(clContext))
		this.producerFactories.push(new MacadamProducerFactory(clContext))
		this.producerFactories.push(new FFmpegProducerFactory(clContext))
	}

	async createSource(
		params: LoadParams,
		consumerFormat: VideoFormat,
		clJobs: ClJobs
	): Promise<Producer | null> {
		let producerErr = ''
		for (const f of this.producerFactories) {
			try {
				const producer = f.createProducer(this.producerID, params, clJobs)
				await producer.initialise(consumerFormat)
				this.producerID++
				return producer
			} catch (err) {
				producerErr = err.message
				if (!(err instanceof InvalidProducerError)) {
					throw err
				}
			}
		}

		if (producerErr !== '') console.log(producerErr)
		console.log(`Failed to find producer for params: '${params}'`)
		return null
	}
}
