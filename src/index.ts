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
import { start, processCommand } from './AMCP/server'
import { Commands } from './AMCP/commands'
import { Basic } from './AMCP/basic'
import readline from 'readline'

const initialiseOpenCL = async (): Promise<nodenCLContext> => {
	const platformIndex = 0
	const deviceIndex = 0
	const clContext = new nodenCLContext({
		platformIndex: platformIndex,
		deviceIndex: deviceIndex,
		overlapping: true
	})
	await clContext.initialise()
	const platformInfo = clContext.getPlatformInfo()
	console.log(
		`OpenCL accelerator running on device from vendor '${platformInfo.vendor}', type '${platformInfo.devices[deviceIndex].type}'`
	)
	return clContext
}

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	prompt: 'AMCP> '
})

rl.on('line', async (input) => {
	if (input === 'q') {
		process.kill(process.pid, 'SIGTERM')
	}

	if (input !== '') {
		console.log(`AMCP received: ${input}`)
		await processCommand(input.toUpperCase().match(/"[^"]+"|""|\S+/g))
	}

	rl.prompt()
})

rl.on('SIGINT', () => {
	process.kill(process.pid, 'SIGTERM')
})

console.log('\nWelcome to Phaneron\n')

const commands: Commands = new Commands()
initialiseOpenCL().then((context) => {
	const basic = new Basic(context)
	basic.addCmds(commands)
})

start(commands).then((fulfilled) => console.log('Command:', fulfilled), console.error)
