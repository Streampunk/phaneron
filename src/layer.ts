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

import { OpenCLBuffer } from 'nodencl'
import { RedioPipe, RedioEnd } from 'redioactive'
import { Frame } from 'beamcoder'
import { Producer } from './producer/producer'
import { MixerDefaults } from './producer/mixer'

export class Layer {
	private mixerParams = MixerDefaults
	private background: Producer | null
	private foreground: Producer | null
	private updateCombiner: () => void
	private autoPlay = false

	constructor() {
		// eslint-disable-next-line @typescript-eslint/no-empty-function
		this.updateCombiner = () => {}
		this.background = null
		this.foreground = null
	}

	async load(
		producer: Producer,
		preview: boolean,
		autoPlay: boolean,
		updateCombiner: () => void
	): Promise<boolean> {
		this.background = producer
		this.autoPlay = autoPlay
		this.updateCombiner = updateCombiner

		if (this.autoPlay && !this.foreground) {
			this.play()
		} else if (preview) {
			await this.foreground?.release()
			this.foreground = this.background
			this.background = null
			this.updateCombiner()
		}
		console.log(`Layer load: preview ${preview}, autoPlay ${this.autoPlay}`)
		return true
	}

	async play(): Promise<void> {
		if (this.background) {
			await this.foreground?.release()
			this.foreground = this.background
			this.background = null
			this.autoPlay = false
			this.updateCombiner()
		}

		this.foreground?.setPaused(false)
	}

	pause(): void {
		this.foreground?.setPaused(true)
	}

	resume(): void {
		this.foreground?.setPaused(false)
	}

	async stop(): Promise<void> {
		await this.foreground?.release()
		this.foreground = null
		this.autoPlay = false
	}

	anchor(params: string[]): void {
		const mixer = this.foreground ? this.foreground.getMixer() : this.background?.getMixer()
		if (params.length) {
			this.mixerParams.anchor = { x: +params[0], y: +params[1] }
			mixer?.setMixParams(this.mixerParams)
		} else {
			console.dir(this.mixerParams.anchor, { colors: true })
		}
	}

	rotation(params: string[]): void {
		const mixer = this.foreground ? this.foreground.getMixer() : this.background?.getMixer()
		if (params.length) {
			this.mixerParams.rotation = +params[0]
			mixer?.setMixParams(this.mixerParams)
		} else {
			console.dir(this.mixerParams.rotation, { colors: true })
		}
	}

	fill(params: string[]): void {
		const mixer = this.foreground ? this.foreground.getMixer() : this.background?.getMixer()
		if (params.length) {
			this.mixerParams.fill = {
				xOffset: +params[0],
				yOffset: +params[1],
				xScale: +params[2],
				yScale: +params[3]
			}
			mixer?.setMixParams(this.mixerParams)
		} else {
			console.dir(this.mixerParams.fill, { colors: true })
		}
	}

	volume(params: string[]): void {
		const mixer = this.foreground ? this.foreground.getMixer() : this.background?.getMixer()
		if (params.length) {
			this.mixerParams.volume = +params[0]
			mixer?.setMixParams(this.mixerParams)
		} else {
			console.dir(this.mixerParams.volume, { colors: true })
		}
	}

	getAudioPipe(): RedioPipe<Frame | RedioEnd> | undefined {
		const mixer = this.foreground ? this.foreground.getMixer() : this.background?.getMixer()
		return mixer?.getAudioPipe()
	}
	getVideoPipe(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined {
		const mixer = this.foreground ? this.foreground.getMixer() : this.background?.getMixer()
		return mixer?.getVideoPipe()
	}
}
