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
import { ScreenConsumerFactory } from './screenConsumer'
import { FFmpegConsumerFactory } from './ffmpegConsumer'
import { RedioPipe, RedioEnd } from 'redioactive'
import { Frame } from 'beamcoder'
import { Channel } from '../channel'
import { ConfigParams, VideoFormat, DeviceConfig, ConsumerConfig } from '../config'
import { ClJobs } from '../clJobQueue'

export interface Consumer {
	initialise(): Promise<void>
	deviceConfig(): DeviceConfig
	connect(
		combineAudio: RedioPipe<Frame | RedioEnd>,
		combineVideo: RedioPipe<OpenCLBuffer | RedioEnd>
	): void
	release(
		combineAudio: RedioPipe<Frame | RedioEnd>,
		combineVideo: RedioPipe<OpenCLBuffer | RedioEnd>
	): void
}

export interface ConsumerFactory<T extends Consumer> {
	createConsumer(
		chanID: string,
		params: ConfigParams,
		format: VideoFormat,
		device: DeviceConfig,
		clJobs: ClJobs
	): T
}

export class ConsumerRegistry {
	private readonly consumerFactories: Map<string, ConsumerFactory<Consumer>>
	private readonly consumers: Map<number, Consumer>
	private readonly chanIDs: Map<number, string>
	private readonly formats: Map<number, VideoFormat>
	private consumerIndex = 0

	constructor(clContext: nodenCLContext) {
		this.consumerFactories = new Map()
		this.consumerFactories.set('decklink', new MacadamConsumerFactory(clContext))
		this.consumerFactories.set('screen', new ScreenConsumerFactory(clContext))
		this.consumerFactories.set('ffmpeg', new FFmpegConsumerFactory(clContext))
		this.consumers = new Map()
		this.chanIDs = new Map()
		this.formats = new Map()
	}

	createConsumer(
		chanNum: number,
		consumerIndex: number,
		params: ConfigParams,
		device: DeviceConfig,
		clJobs: ClJobs
	): Consumer {
		if (this.consumers.get(consumerIndex))
			throw new Error(
				`${device.name} consumer device ${device.deviceIndex} consumerIndex ${consumerIndex} is already registered`
			)

		if (consumerIndex === 0) {
			const indexes: number[] = []
			// find the next available map index
			this.consumers.forEach((_consumer, index) => indexes.push(index))
			consumerIndex = indexes.reduce((prev, cur) => (cur > prev ? cur : prev), 1) + 1
		}

		const factory = this.consumerFactories.get(device.name.toLowerCase())
		if (!factory) throw new Error(`device name '${device.name}' not recognised`)

		const chanID = this.chanIDs.get(chanNum)
		if (!chanID) throw new Error(`channel ID not registered`)

		const format = this.formats.get(chanNum)
		if (!format) throw new Error(`channel format not registered`)

		const consumer = factory.createConsumer(
			chanID,
			params,
			format,
			{ name: device.name.toLowerCase(), deviceIndex: device.deviceIndex },
			clJobs
		)
		this.consumers.set(consumerIndex, consumer)
		return consumer
	}

	removeConsumer(
		chanNum: number,
		channel: Channel,
		consumerIndex: number,
		device: DeviceConfig
	): void {
		const chanID = this.chanIDs.get(chanNum)
		if (!chanID) throw new Error(`channel not found`)

		let consumer: Consumer | undefined = undefined
		if (consumerIndex === 0) {
			if (device.name != '') {
				console.log('Remove consumer with device', device)
				this.consumers.forEach((c, i) => {
					const config = c.deviceConfig()
					if (
						!consumerIndex &&
						config.name === device.name &&
						config.deviceIndex === device.deviceIndex
					) {
						consumer = c
						consumerIndex = i
					}
				})
				if (!consumer) throw new Error(`cannot find consumer with device ${device}`)
			} else throw new Error(`no consumerIndex and no parameters`)
		} else {
			consumer = this.consumers.get(consumerIndex)
			if (!consumer) throw new Error(`consumer index ${consumerIndex} not found`)
		}

		if (consumerIndex && consumer) {
			channel.removeConsumer(consumer)
			this.consumers.delete(consumerIndex)
		} else throw new Error(`consumerIndex ${consumerIndex} and device ${device}`)
	}

	createConsumers(
		chanNum: number,
		chanID: string,
		config: ConsumerConfig,
		clJobs: ClJobs
	): Consumer[] {
		this.chanIDs.set(chanNum, chanID)
		this.formats.set(chanNum, config.format)

		return config.devices.map((device) =>
			this.createConsumer(chanNum, ++this.consumerIndex, {}, device, clJobs)
		)
	}
}
