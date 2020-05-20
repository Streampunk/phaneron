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

interface CmdEntry {
	cmd: string
	fn: (chanLayer: ChanLayer, params: string[]) => Promise<boolean>
}

export class Commands {
	private readonly map: CmdEntry[]

	constructor() {
		this.map = []
	}

	add(entry: CmdEntry): void {
		this.map.push(entry)
	}
	async process(command: string[]): Promise<boolean> {
		let result = false
		const entry = this.map.find(({ cmd }) => cmd === command[0])
		if (entry) {
			const chanLayer = chanLayerFromString(command[1])
			result = await entry.fn(chanLayer, command.slice(chanLayer ? 2 : 1))
		}

		return result
	}
}
