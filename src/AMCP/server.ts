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

import * as net from 'net'
import { Responses, responses207, responses218, responses220 } from './cmdResponses'
import { Commands } from './commands'

let cmds: Commands
let ccgResponses = responses218

export function processCommand(command: string[] | null, token = ''): string {
	if (!command) {
		return '400 ERROR'
	}
	if (command[0] === 'REQ') {
		if (command[2] !== 'PING') {
			return processCommand(command.slice(2), command[1])
		} else {
			token = command[1]
		}
	}
	if (command[0] === 'SWITCH') {
		if (command[1] === '207') {
			ccgResponses = responses207
			return '202 SWITCH 207 OK'
		}
		if (command[1] === '218') {
			ccgResponses = responses218
			return '202 SWITCH 218 OK'
		}
		if (command[1] === '220') {
			ccgResponses = responses220
			return '202 SWITCH 220 OK'
		}
		return '400 SWITCH ERROR'
	}
	if (command[0] === 'BYE') {
		return '***BYE***'
	}
	if (ccgResponses[command[0]]) {
		if (!cmds?.process(command)) {
			return `400 ERROR\r\n${command.join(' ')} NOT IMPLEMENTED`
		}
		const responseFn = ccgResponses[command[0]]
		let response: string | null = null
		if (typeof responseFn === 'function') {
			response = responseFn(command)
		} else {
			if (responseFn.none && command.length === 1) {
				response = (responseFn.none as (req: string[]) => string | null)(command)
			} else if (responseFn.number && command.length >= 2) {
				response = (responseFn.number as (req: string[]) => string | null)(command)
			} else if (responseFn.layer && command.length >= 3) {
				response = ((responseFn.layer as Responses)[command[2]] as (
					req: string[]
				) => string | null)(command)
			} else if (command.length >= 2 && responseFn[command[1]]) {
				response = (responseFn[command[1]] as (req: string[]) => string | null)(command)
			}
			if (response === null && responseFn.string && command.length >= 2) {
				response = (responseFn.string as (req: string[]) => string | null)(command)
			}
		}
		if (response) return token ? `RES ${token} ${response}` : response
	}

	return token
		? `RES ${token} 400 ERROR\r\n${command.join(' ')}`
		: `400 ERROR\r\n${command.join(' ')}`
}

const server = net.createServer((c) => {
	console.log('client connected')
	c.on('end', () => {
		console.log('client disconnected')
	})
})
server.on('error', (err) => {
	throw err
})

export async function start(commands?: Commands): Promise<string> {
	if (commands) cmds = commands

	return new Promise((resolve, reject) => {
		let resolved = false
		server.once('error', (e) => {
			if (!resolved) reject(e)
		})
		server.listen(5250, () => {
			resolved = true
			resolve('CasparCL server AMCP protocol running on port 5250')
		})
	})
}

export async function stop(): Promise<string> {
	return new Promise((resolve, reject) => {
		let resolved = false
		server.once('error', (err) => {
			if (!resolved) reject(err)
		})
		server.close((e) => {
			if (e) return reject(e)
			resolved = true
			resolve('CasparCL server closed')
		})
	})
}

server.on('listening', () => {
	// console.log('CasparCL server AMCP protocol running on port 5250')
})

server.on('connection', (sock) => {
	let chunk = ''
	sock.on('data', (input) => {
		chunk += input.toString()
		let eol = chunk.indexOf('\r\n')

		while (eol > -1) {
			const command = chunk.substring(0, eol)
			console.log(command)
			const result = processCommand(command.toUpperCase().match(/"[^"]+"|""|\S+/g))
			if (result === '***BYE***') {
				sock.destroy()
				break
			}
			sock.write(result.toString() + '\r\n')
			console.log(result)
			if (result === '202 KILL OK') {
				sock.destroy()
				stop().catch(console.error)
				break
			}
			chunk = chunk.substring(eol + 2)
			eol = chunk.indexOf('\r\n')
		}
	})
	sock.on('error', console.error)
	sock.on('close', () => {
		console.log('client disconnect')
	})
})

export function version(version: string): void {
	if (version === '207') {
		ccgResponses = responses207
	}
	if (version === '218') {
		ccgResponses = responses218
	}
	if (version === '220') {
		ccgResponses = responses220
	}
}

if (!module.parent) {
	start().then(console.log, console.error)
}
