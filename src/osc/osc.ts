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

import { OSCClient, OSCType, OSCServer } from 'ts-osc'
import { OSCArgument } from 'ts-osc/lib/types'

export type OscConfig = {
	serverPort: number
	clientPort: number
	clientAddr: string
}

export type OscValue = string | number | boolean | Buffer | OSCArgument<OSCType>[] | null
export type OscMsg = { type: OSCType; value: OscValue }

export class Osc {
	private readonly client: OSCClient
	private readonly server: OSCServer
	private readonly controlMap: Map<string, (msg: OscMsg) => void> = new Map()

	constructor(config: OscConfig) {
		this.client = new OSCClient(config.clientAddr, config.clientPort)
		this.server = new OSCServer('0.0.0.0', config.serverPort)

		this.server.on('error', console.error)
		this.server.on('listening', () => console.log(`OSC listening on port ${config.serverPort}`))
		this.server.on('message', (oscMessage) => {
			const control = oscMessage.address
			const type = oscMessage.type
			const value = oscMessage.value
			// console.log(`OSC message: '${control}' type: ${type} value: ${value}`)

			const update = this.controlMap.get(control)
			if (update) update({ type: type, value: value })
		})
		this.server.on('close', this.server.close)
	}

	sendMsg(control: string, msg: OscMsg): void {
		this.client.send(control, msg.type, msg.value)
	}

	addControl(control: string, upd: (msg: OscMsg) => void, set?: OscMsg): void {
		this.controlMap.set(control, upd)
		if (set) this.sendMsg(control, set)
	}

	removeControl(control: string): void {
		this.controlMap.delete(control)
	}
}
