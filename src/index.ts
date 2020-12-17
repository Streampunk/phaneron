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
import { ClProcessJobs } from './clJobQueue'
import { start, processCommand } from './AMCP/server'
import { Commands } from './AMCP/commands'
import { Channel } from './channel'
import { BasicCmds } from './AMCP/basicCmds'
import { MixerCmds } from './AMCP/mixerCmds'
import { ConsumerRegistry } from './consumer/consumer'
import { ProducerRegistry } from './producer/producer'
import { ConsumerConfig, VideoFormats } from './config'
import readline from 'readline'
import fs from 'fs'

class Config {
	private readonly videoFormats: VideoFormats
	readonly consumers: ConsumerConfig[]

	constructor() {
		this.videoFormats = new VideoFormats()
		this.consumers = [
			{
				format: this.videoFormats.get('1080i5000'),
				devices: [
					{ name: 'decklink', deviceIndex: 1, embeddedAudio: true },
					{ name: 'screen', deviceIndex: 0 }
				]
			},
			{
				format: this.videoFormats.get('1080i5000'),
				devices: []
			},
			{
				format: this.videoFormats.get('1080i5000'),
				devices: []
			},
			{
				format: this.videoFormats.get('1080i5000'),
				devices: []
			}
		]
	}
}

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
	if (input === 'q' || input === 'Q') {
		process.kill(process.pid, 'SIGTERM')
	}

	if (input !== '') {
		console.log(`AMCP received: ${input}`)
		const result = await processCommand(input.toUpperCase().match(/"[^"]+"|""|\S+/g))
		console.log('AMCP returned:', result)
	}

	rl.prompt()
})

rl.on('SIGINT', () => {
	process.kill(process.pid, 'SIGTERM')
})

console.log('\nWelcome to Phaneron\n')

const commands: Commands = new Commands()
initialiseOpenCL()
	.then(async (clContext) => {
		const consReg = new ConsumerRegistry(clContext)
		const prodReg = new ProducerRegistry(clContext)

		const clProcessJobs = new ClProcessJobs(clContext)
		const clJobs = clProcessJobs.getJobs()
		const config = new Config()
		const channels: Channel[] = []

		config.consumers.forEach((consumerConfig, i) => {
			try {
				channels.push(
					new Channel(clContext, `ch ${i + 1}`, i + 1, consumerConfig, consReg, prodReg, clJobs)
				)
			} catch (err) {
				console.log(`Error creating configured channel ${i + 1}: ${err.message}`)
			}
		})

		if (channels.length === 0) console.error('Error: No channels found!!')
		await Promise.all(channels.map((chan) => chan.initialise()))

		commands.add(new BasicCmds(consReg, channels, clJobs).list())
		commands.add(new MixerCmds(channels).list())

		// setInterval(() => clContext.logBuffers(), 2000)
	})
	.then(() => start(commands))
	.then(console.log, console.error)
	.then(async () => {
		if (fs.existsSync('startupAMCPCommands')) {
			const startupFile = fs.readFileSync('startupAMCPCommands').toString().split('\n')
			for (const command of startupFile) {
				if (!command.match('^#')) {
					await processCommand(command.match(/"[^"]+"|""|\S+/g))
				}
			}
		}
	})
	.then(() => rl.prompt())
	.catch(console.error)
