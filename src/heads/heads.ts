/*
  Phaneron - Clustered, accelerated and cloud-fit video server, pre-assembled and in kit form.
  Copyright (C) 2021 Streampunk Media Ltd.

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

import { EventEmitter, once } from 'events'
import { Channel } from '../channel'
import { Osc } from '../osc/osc'
import fs from 'fs'
import { TransitionParams } from '../chanLayer'

type HeadsControls = { load?: string; take?: string }

export type HeadsConfig = {
	channel: number
	controls: HeadsControls
	url?: string
}

type LayerSpec = {
	layerNum: number
	url: string
	seek: number
	transition?: TransitionParams
}

type EventSpec = {
	duration: number
	layers: LayerSpec[]
}

type HeadsSpec = {
	events: EventSpec[]
}

const isJsonString = (str: string): boolean => {
	try {
		const json = JSON.parse(str)
		return typeof json === 'object'
	} catch (e) {
		return false
	}
}

export class Heads {
	private readonly osc: Osc
	private readonly channel: Channel
	private readonly eventDone: EventEmitter
	private readonly framerate: number
	private headsSpec: HeadsSpec | undefined
	private eventTimeout: NodeJS.Timeout | undefined
	private running = false

	constructor(osc: Osc, channel: Channel, controls: HeadsControls) {
		this.osc = osc
		this.channel = channel
		this.eventDone = new EventEmitter()
		const fmt = this.channel.getConfig().format
		this.framerate = fmt.timescale / fmt.fields
		if (controls.load)
			this.osc.addControl(controls.load, (msg) => {
				if (msg.value !== 0) this.loadSpec(msg.value as string)
			})

		if (controls.take)
			this.osc.addControl(controls.take, (msg) => {
				if (msg.value !== 0) this.next()
			})
	}

	loadSpec(urlOrJson: string): void {
		if (this.running) {
			this.running = false
			this.eventDone.emit('done')
			this.channel.clear(0)
		}

		if (isJsonString(urlOrJson)) {
			this.headsSpec = JSON.parse(urlOrJson)
		} else if (fs.existsSync(urlOrJson)) {
			const json = fs.readFileSync(urlOrJson).toString()
			this.headsSpec = JSON.parse(json)
		} else {
			console.log(`Heads: source URL or JSON '${urlOrJson}' could not be loaded`)
		}
	}

	async loadEvent(eventSpec: EventSpec): Promise<void> {
		await Promise.all(
			eventSpec.layers.map((l) => {
				console.log('load event:', l.url, l.transition ? l.transition : '')
				return this.channel.loadSource({
					url: l.url,
					layer: l.layerNum,
					loop: false,
					preview: false,
					autoPlay: false,
					seek: l.seek,
					transition: l.transition
				})
			})
		)
	}

	async runEvent(eventSpec: EventSpec): Promise<void> {
		await Promise.all(eventSpec.layers.map((l) => this.channel.play(l.layerNum)))
		this.eventTimeout = setTimeout(
			() => this.eventDone.emit('done'),
			eventSpec.duration * this.framerate
		)
	}

	async runEvents(): Promise<void> {
		if (this.headsSpec) {
			this.running = true
			let eventId = 0
			await this.loadEvent(this.headsSpec.events[eventId])
			while (this.running && eventId < this.headsSpec.events.length) {
				await this.runEvent(this.headsSpec.events[eventId])
				eventId++
				if (eventId < this.headsSpec.events.length)
					await this.loadEvent(this.headsSpec.events[eventId])

				await once(this.eventDone, 'done')
				if (eventId === this.headsSpec.events.length) {
					await this.channel.clear(0)
					this.running = false
				}
			}
		}
	}

	run(): void {
		this.runEvents()
	}

	next(): void {
		if (this.eventTimeout) clearTimeout(this.eventTimeout)
		if (this.running) this.eventDone.emit('done')
		else this.run()
	}
}
