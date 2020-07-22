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

import { ChanLayer } from '../chanLayer'

function chanLayerFromString(chanLayStr: string): ChanLayer {
	let valid = false
	let channel = 0
	let layer = 0
	const match = chanLayStr?.match('(?<channel>\\d+)-?(?<layer>\\d*)')
	if (match?.groups) {
		valid = true
		const chanLay = match.groups
		channel = parseInt(chanLay.channel)
		if (chanLay.layer !== '') {
			layer = parseInt(chanLay.layer)
		}
	}
	return { valid: valid, channel: channel, layer: layer }
}

export interface CmdEntry {
	cmd: string
	fn: (chanLayer: ChanLayer, params: string[]) => Promise<boolean>
}

export interface CmdSet {
	group: string
	entries: CmdEntry[]
}

export interface CmdList {
	list(): CmdSet
}

export class Commands {
	private readonly map: CmdSet[]

	constructor() {
		this.map = []
	}

	add(entries: CmdSet): void {
		this.map.push(entries)
	}

	async process(command: string[]): Promise<boolean> {
		let result = false

		let cmdIndex = 2
		let group = this.map.find(({ group }) => group === command[0])
		if (!group) {
			group = this.map.find(({ group }) => group === '')
			cmdIndex = 0
		}

		if (group) {
			const entry = group.entries.find(({ cmd }) => cmd === command[cmdIndex])
			if (entry) {
				const chanLayer = chanLayerFromString(command[1])
				result = await entry.fn(chanLayer, command.slice(cmdIndex == 2 ? 3 : 2))
			}
		}

		return result
	}
}
