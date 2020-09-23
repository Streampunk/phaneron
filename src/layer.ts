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
import { RedioPipe, RedioEnd } from 'redioactive'
import { Frame } from 'beamcoder'
import { Producer } from './producer/producer'
import { Mixer } from './mixer'
import { VideoFormat } from './config'

export class Layer {
	private readonly clContext: nodenCLContext
	private readonly consumerFormat: VideoFormat
	private background: Producer | null
	private foreground: Producer | null
	private autoPlay = false
	private mixer: Mixer | null = null

	constructor(clContext: nodenCLContext, consumerFormat: VideoFormat) {
		this.clContext = clContext
		this.consumerFormat = consumerFormat
		this.background = null
		this.foreground = null
	}

	async load(producer: Producer, preview: boolean, autoPlay: boolean): Promise<boolean> {
		this.background = producer
		this.autoPlay = autoPlay

		const srcAudio = this.background.getSourceAudio()
		const srcVideo = this.background.getSourceVideo()
		if (!(srcVideo !== undefined && srcAudio !== undefined)) {
			console.log('Failed to create sources for layer')
			return false
		}
		this.mixer = new Mixer(this.clContext, this.background.getFormat(), this.consumerFormat)
		await this.mixer.init(srcAudio, srcVideo)

		if (this.autoPlay && !this.foreground) {
			this.play()
		} else if (preview) {
			this.foreground = this.background
			this.background = null
		}
		console.log(`Layer load: preview ${preview}, autoPlay ${this.autoPlay}`)
		return true
	}

	play(): void {
		if (this.background) {
			this.foreground = this.background
			this.background = null
			this.autoPlay = false
		}
	}

	pause(): void {
		this.foreground?.setPaused(true)
	}

	resume(): void {
		this.foreground?.setPaused(false)
	}

	stop(): void {
		this.foreground?.release()
		this.foreground = null
		this.autoPlay = false
	}

	getAudioPipe(): RedioPipe<Frame | RedioEnd> | undefined {
		return this.mixer?.getAudioPipe()
	}
	getVideoPipe(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined {
		return this.mixer?.getVideoPipe()
	}
}
