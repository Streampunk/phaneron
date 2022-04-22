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

import { EventEmitter, once } from 'events'
import { clContext as nodenCLContext, OpenCLBuffer } from 'nodencl'
import { RedioPipe, RedioEnd } from 'redioactive'
import { Frame } from 'beamcoder'
import { Producer } from './producer/producer'
import { Mixer, MixerDefaults } from './producer/mixer'
import { Transitioner } from './transitioner'
import { ConsumerConfig } from './config'
import { ClJobs } from './clJobQueue'
import { SourcePipes } from './routeSource'

export type TransitionSpec = {
	type: string
	len: number
	source?: Producer
	sourceMixer?: Mixer
	mask?: Producer
	maskMixer?: Mixer
}
export const DefaultTransitionSpec = '{ "type": "cut", "len": 0 }'

type SourceSpec = {
	source: Producer | undefined
	mixer: Mixer | undefined
	transition: TransitionSpec
	firstTs: number | undefined
}

export class Layer {
	private readonly clContext: nodenCLContext
	private readonly layerID: string
	private readonly consumerConfig: ConsumerConfig
	private readonly clJobs: ClJobs
	private readonly endEvent: EventEmitter
	private mixerParams = JSON.parse(MixerDefaults)
	private curSrcSpec: SourceSpec
	private nextSrcSpec: SourceSpec
	private transitioner: Transitioner | null
	private channelUpdate: () => void
	private layerTick: ((t: string) => void) | undefined
	private autoPlay = false

	constructor(
		clContext: nodenCLContext,
		layerID: string,
		consumerConfig: ConsumerConfig,
		clJobs: ClJobs
	) {
		this.clContext = clContext
		this.layerID = layerID
		this.consumerConfig = consumerConfig
		this.clJobs = clJobs
		this.endEvent = new EventEmitter()
		this.curSrcSpec = {
			source: undefined,
			mixer: undefined,
			transition: JSON.parse(DefaultTransitionSpec),
			firstTs: undefined
		}
		this.nextSrcSpec = {
			source: undefined,
			mixer: undefined,
			transition: JSON.parse(DefaultTransitionSpec),
			firstTs: undefined
		}
		// eslint-disable-next-line @typescript-eslint/no-empty-function
		this.channelUpdate = () => {}
		this.transitioner = new Transitioner(
			this.clContext,
			this.layerID,
			this.consumerConfig.format,
			this.clJobs,
			this.endEvent,
			this.layerUpdate.bind(this)
		)
	}

	async initialise(): Promise<void> {
		await this.transitioner?.initialise()
	}

	update(): void {
		const audioPipes: RedioPipe<Frame | RedioEnd>[] = []
		const transitionSpec = this.curSrcSpec.transition

		if (this.curSrcSpec.mixer) {
			audioPipes.push(this.curSrcSpec.mixer.getAudioPipe())
			if (transitionSpec.source && transitionSpec.sourceMixer && transitionSpec.type !== 'cut') {
				audioPipes.push(transitionSpec.sourceMixer.getAudioPipe())
				// if (transitionSpec.mask && transitionSpec.maskMixer)
				// 	audioPipes.push(transitionSpec.maskMixer.getAudioPipe())
			}
		}

		const videoPipes: RedioPipe<OpenCLBuffer | RedioEnd>[] = []
		if (this.curSrcSpec.mixer) {
			videoPipes.push(this.curSrcSpec.mixer.getVideoPipe())
			if (transitionSpec.source && transitionSpec.sourceMixer && transitionSpec.type !== 'cut') {
				videoPipes.push(transitionSpec.sourceMixer.getVideoPipe())
				if (transitionSpec.mask && transitionSpec.maskMixer)
					videoPipes.push(transitionSpec.maskMixer.getVideoPipe())
			}
		}

		this.transitioner?.update(transitionSpec.type, transitionSpec.len, audioPipes, videoPipes)
	}

	layerUpdate(ts: number[]): void {
		if (this.layerTick && ts.length) this.layerTick('tick')
		if (this.curSrcSpec.transition.type !== 'cut' && ts.length > 1) {
			if (!this.curSrcSpec.firstTs) this.curSrcSpec.firstTs = ts[1]
			const numEnds = ts.reduce((n, t) => (n += t < 0 ? 1 : 0), 0)
			if (ts[1] - this.curSrcSpec.firstTs === this.curSrcSpec.transition.len - 2) {
				this.curSrcSpec.transition.mask?.release()
				this.curSrcSpec.source?.release()
				this.curSrcSpec.source = undefined
				this.curSrcSpec.mixer = undefined
			} else if (
				(this.curSrcSpec.transition.type === 'wipe' && numEnds > 1) ||
				(this.curSrcSpec.transition.type === 'dissolve' && numEnds > 0)
			) {
				this.curSrcSpec.source = this.curSrcSpec.transition.source
				this.curSrcSpec.mixer = this.curSrcSpec.transition.sourceMixer
				this.curSrcSpec.transition = JSON.parse(DefaultTransitionSpec)
				this.update()
				this.endEvent.emit('transitionComplete')
			}
		} else if (
			this.curSrcSpec.source &&
			this.curSrcSpec.transition.type === 'cut' &&
			ts.length === 1 &&
			ts[0] < 0
		) {
			this.curSrcSpec.transition.mask?.release()
			this.curSrcSpec.source?.release()
			this.curSrcSpec.source = undefined
			this.curSrcSpec.transition = JSON.parse(DefaultTransitionSpec)
			this.update()
			this.endEvent.emit('end')
			if (this.nextSrcSpec.source === undefined && this.layerTick) this.layerTick('end')
		}
	}

	async load(
		producer: Producer,
		mixer: Mixer,
		transitionSpec: TransitionSpec,
		preview: boolean,
		autoPlay: boolean,
		channelUpdate: () => void
	): Promise<boolean> {
		this.nextSrcSpec = {
			source: producer,
			mixer: mixer,
			transition: transitionSpec,
			firstTs: undefined
		}
		this.autoPlay = autoPlay
		this.channelUpdate = channelUpdate

		if (this.autoPlay) {
			if (this.curSrcSpec.source) {
				this.endEvent.once('end', () => {
					this.curSrcSpec.source = undefined
					this.play()
				})
			} else {
				this.play()
			}
		} else if (preview) {
			if (this.curSrcSpec.source) {
				this.curSrcSpec.source.release()
				this.curSrcSpec.source = undefined
				this.curSrcSpec.mixer = undefined
				await once(this.endEvent, 'end')
			}
			this.curSrcSpec.source = this.nextSrcSpec.source
			this.curSrcSpec.mixer = this.nextSrcSpec.mixer
			this.nextSrcSpec.source = undefined
			this.nextSrcSpec.mixer = undefined
			await this.update()
			this.channelUpdate()
		}
		return true
	}

	async play(ticker?: (t: string) => void): Promise<void> {
		if (this.nextSrcSpec.source && this.nextSrcSpec.transition?.type === 'cut') {
			if (this.curSrcSpec.source) {
				this.curSrcSpec.source.release()
				await once(this.endEvent, 'end')
			}
			this.curSrcSpec.source = this.nextSrcSpec.source
			this.curSrcSpec.mixer = this.nextSrcSpec.mixer
		}

		this.curSrcSpec.transition = this.nextSrcSpec.transition
		if (this.curSrcSpec.transition.type !== 'cut') {
			this.curSrcSpec.transition.source = this.nextSrcSpec.source
			this.curSrcSpec.transition.sourceMixer = this.nextSrcSpec.mixer
		}
		this.nextSrcSpec.source = undefined
		this.nextSrcSpec.mixer = undefined
		this.nextSrcSpec.transition = JSON.parse(DefaultTransitionSpec)

		this.autoPlay = false
		this.layerTick = ticker
		this.curSrcSpec.source?.setPaused(false)
		this.curSrcSpec.transition?.source?.setPaused(false)
		this.curSrcSpec.transition?.mask?.setPaused(false)

		await this.update()
		this.channelUpdate()

		// delay further commands until any transition has completed - reduces demand on cpu/gpu
		if (this.curSrcSpec.transition.type !== 'cut') await once(this.endEvent, 'transitionComplete')
	}

	pause(): void {
		this.curSrcSpec.source?.setPaused(true)
	}

	resume(): void {
		this.curSrcSpec.source?.setPaused(false)
	}

	async stop(): Promise<void> {
		if (this.curSrcSpec.source) {
			this.curSrcSpec.source.release()
			await once(this.endEvent, 'end')
		}
		this.autoPlay = false
	}

	anchor(params: string[]): void {
		const mixer =
			this.curSrcSpec && this.curSrcSpec.source && this.curSrcSpec.mixer
				? this.curSrcSpec.mixer
				: this.nextSrcSpec && this.nextSrcSpec.source && this.nextSrcSpec.mixer
				? this.nextSrcSpec.mixer
				: undefined
		if (params.length) {
			this.mixerParams.anchor = { x: +params[0], y: +params[1] }
			mixer?.setMixParams(this.mixerParams)
		} else {
			console.dir(this.mixerParams.anchor, { colors: true })
		}
	}

	rotation(params: string[]): void {
		const mixer =
			this.curSrcSpec && this.curSrcSpec.source && this.curSrcSpec.mixer
				? this.curSrcSpec.mixer
				: this.nextSrcSpec && this.nextSrcSpec.source && this.nextSrcSpec.mixer
				? this.nextSrcSpec.mixer
				: undefined
		if (params.length) {
			this.mixerParams.rotation = +params[0]
			mixer?.setMixParams(this.mixerParams)
		} else {
			console.dir(this.mixerParams.rotation, { colors: true })
		}
	}

	fill(params: string[]): void {
		const mixer =
			this.curSrcSpec && this.curSrcSpec.source && this.curSrcSpec.mixer
				? this.curSrcSpec.mixer
				: this.nextSrcSpec && this.nextSrcSpec.source && this.nextSrcSpec.mixer
				? this.nextSrcSpec.mixer
				: undefined
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
		const mixer =
			this.curSrcSpec && this.curSrcSpec.source && this.curSrcSpec.mixer
				? this.curSrcSpec.mixer
				: this.nextSrcSpec && this.nextSrcSpec.source && this.nextSrcSpec.mixer
				? this.nextSrcSpec.mixer
				: undefined
		if (params.length) {
			this.mixerParams.volume = +params[0]
			mixer?.setMixParams(this.mixerParams)
		} else {
			console.dir(this.mixerParams.volume, { colors: true })
		}
	}

	getSourcePipes(): SourcePipes | undefined {
		return this.curSrcSpec.source?.getSourcePipes()
	}

	getAudioPipe(): RedioPipe<Frame | RedioEnd> | undefined {
		return this.transitioner?.getAudioPipe()
	}
	getVideoPipe(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined {
		return this.transitioner?.getVideoPipe()
	}
	getEndEvent(): EventEmitter {
		return this.endEvent
	}

	async release(): Promise<void> {
		this.curSrcSpec.source = undefined
		this.curSrcSpec.mixer = undefined
		await this.transitioner?.release()
		this.transitioner = null
	}
}
