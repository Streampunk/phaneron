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

import { CmdList, CmdSet } from './commands'
import { ChanLayer, LoadParams } from '../chanLayer'
import { Channel } from '../channel'
import { ConsumerRegistry } from '../consumer/consumer'
import { ClJobs } from '../clJobQueue'
import { ConfigParams } from '../config'

export class BasicCmds implements CmdList {
	private readonly consumerRegistry: ConsumerRegistry
	private readonly channels: Array<Channel>
	private readonly clJobs: ClJobs

	constructor(consumerRegistry: ConsumerRegistry, channels: Array<Channel>, clJobs: ClJobs) {
		this.consumerRegistry = consumerRegistry
		this.channels = channels
		this.clJobs = clJobs
	}

	list(): CmdSet {
		return {
			group: '',
			entries: [
				{ cmd: 'LOADBG', fn: this.loadbg.bind(this) },
				{ cmd: 'LOAD', fn: this.load.bind(this) },
				{ cmd: 'PLAY', fn: this.play.bind(this) },
				{ cmd: 'PAUSE', fn: this.pause.bind(this) },
				{ cmd: 'RESUME', fn: this.resume.bind(this) },
				{ cmd: 'STOP', fn: this.stop.bind(this) },
				{ cmd: 'CLEAR', fn: this.clear.bind(this) },
				{ cmd: 'ADD', fn: this.add.bind(this) },
				{ cmd: 'REMOVE', fn: this.remove.bind(this) }
			]
		}
	}

	parseParams(params: string[]): ConfigParams {
		const paramsObj: ConfigParams = {}
		const paramStr = params.join(' ')
		const re = /(?<name>[^-\s]+)(\s+(?<value>[^\s]+))?/g
		let matches: RegExpExecArray | null = null
		while ((matches = re.exec(paramStr)) && matches.groups) {
			if (matches.groups.value) {
				const value = parseInt(matches.groups.value)
				paramsObj[matches.groups.name.toLowerCase()] = isNaN(value)
					? matches.groups.value.toLowerCase()
					: value
			}
		}
		return paramsObj
	}

	async doLoad(chanLay: ChanLayer, params: string[], preview: boolean): Promise<boolean> {
		if (!chanLay.valid) return Promise.resolve(false)

		const channel = this.channels[chanLay.channel - 1]
		if (!channel) return Promise.resolve(false)

		const url = params[0]
		const chanNum = url === 'DECKLINK' ? +params[1] : 0

		const loop = params.find((param) => param === 'LOOP') !== undefined
		const autoPlay = params.find((param) => param === 'AUTO') !== undefined

		const seekIndex = params.findIndex((param) => param === 'SEEK')
		const seek = seekIndex < 0 ? 0 : +params[seekIndex + 1]

		const lengthIndex = params.findIndex((param) => param === 'LENGTH')
		const length = seekIndex < 0 ? 0 : +params[lengthIndex + 1]

		const loadParams: LoadParams = {
			url: url,
			layer: chanLay.layer,
			channel: chanNum,
			loop: loop,
			preview: preview,
			autoPlay: autoPlay,
			seek: seek,
			length: length
		}

		return channel.loadSource(loadParams)
	}

	/**
	 * Loads a producer in the background and prepares it for playout. If no layer is specified the default layer index will be used.
	 *
	 * _clip_ will be parsed by available registered producer factories. If a successfully match is found, the producer will be loaded into the background.
	 * If a file with the same name (extension excluded) but with the additional postfix _a is found this file will be used as key for the main clip.
	 *
	 * _loop_ will cause the clip to loop.
	 * When playing and looping the clip will start at _frame_.
	 * When playing and loop the clip will end after _frames_ number of frames.
	 *
	 * _auto_ will cause the clip to automatically start when foreground clip has ended (without play).
	 * The clip is considered "started" after the optional transition has ended.
	 *
	 * Note: only one clip can be queued to play automatically per layer.
	 */
	async loadbg(chanLay: ChanLayer, params: string[]): Promise<boolean> {
		return this.doLoad(chanLay, params, false)
	}

	/**
	 * Loads a clip to the foreground and plays the first frame before pausing.
	 * If any clip is playing on the target foreground then this clip will be replaced.
	 */
	async load(chanLay: ChanLayer, params: string[]): Promise<boolean> {
		return this.doLoad(chanLay, params, true)
	}

	/**
	 * Moves clip from background to foreground and starts playing it.
	 * If a transition (see LOADBG) is prepared, it will be executed.
	 * If additional parameters (see LOADBG) are provided then the provided clip will first be loaded to the background.
	 */
	async play(chanLay: ChanLayer, params: string[]): Promise<boolean> {
		if (!chanLay.valid) return Promise.resolve(false)

		const channel = this.channels[chanLay.channel - 1]
		if (!channel) return Promise.resolve(false)

		if (params.length !== 0) await this.loadbg(chanLay, params)

		return channel.play(chanLay.layer)
	}

	/**
	 * Pauses playback of the foreground clip on the specified layer.
	 * The RESUME command can be used to resume playback again.
	 */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async pause(chanLay: ChanLayer, _params: string[]): Promise<boolean> {
		if (!chanLay.valid) return Promise.resolve(false)
		const channel = this.channels[chanLay.channel - 1]
		if (!channel) return Promise.resolve(false)
		return channel.pause(chanLay.layer)
	}

	/** Resumes playback of a foreground clip previously paused with the PAUSE command. */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async resume(chanLay: ChanLayer, _params: string[]): Promise<boolean> {
		if (!chanLay.valid) return Promise.resolve(false)
		const channel = this.channels[chanLay.channel - 1]
		if (!channel) return Promise.resolve(false)
		return channel.resume(chanLay.layer)
	}

	/** Removes the foreground clip of the specified layer */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async stop(chanLay: ChanLayer, _params: string[]): Promise<boolean> {
		if (!chanLay.valid) return Promise.resolve(false)
		const channel = this.channels[chanLay.channel - 1]
		if (!channel) return Promise.resolve(false)
		return channel.stop(chanLay.layer)
	}

	/**
	 * Removes all clips (both foreground and background) of the specified layer.
	 * If no layer is specified then all layers in the specified video_channel are cleared.
	 */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async clear(chanLay: ChanLayer, _params: string[]): Promise<boolean> {
		if (!chanLay.valid) return Promise.resolve(false)
		const channel = this.channels[chanLay.channel - 1]
		if (!channel) return Promise.resolve(false)
		return channel.clear(chanLay.layer)
	}

	async add(chanLay: ChanLayer, params: string[]): Promise<boolean> {
		if (!chanLay.valid) return Promise.resolve(false)
		const channel = this.channels[chanLay.channel - 1]
		if (!channel) return Promise.resolve(false)
		if (params.length === 0) return Promise.resolve(false)
		let consumerName = params[0].toLowerCase()
		if (consumerName === 'file' || consumerName === 'stream') consumerName = 'ffmpeg'
		const consumerIndex = chanLay.layer ? chanLay.layer : -1
		const deviceIndex = +params[1] || 0

		try {
			const consumer = this.consumerRegistry.createConsumer(
				chanLay.channel,
				consumerIndex,
				this.parseParams(params),
				{ name: consumerName, deviceIndex: deviceIndex },
				this.clJobs
			)
			await consumer.initialise()
			channel.addConsumer(consumer)
		} catch (err) {
			console.log(`Error adding consumer to configured channel ${chanLay.channel}: ${err.message}`)
			return Promise.resolve(false)
		}

		return Promise.resolve(true)
	}

	async remove(chanLay: ChanLayer, params: string[]): Promise<boolean> {
		if (!chanLay.valid) return Promise.resolve(false)
		const channel = this.channels[chanLay.channel - 1]
		if (!channel) return Promise.resolve(false)
		const consumerIndex = chanLay.layer ? chanLay.layer : -1

		try {
			this.consumerRegistry.removeConsumer(
				chanLay.channel,
				channel,
				consumerIndex,
				this.parseParams(params)
			)
		} catch (err) {
			console.log(
				`Error removing consumer from configured channel ${chanLay.channel}: ${err.message}`
			)
			return Promise.resolve(false)
		}

		return Promise.resolve(false)
	}
}
