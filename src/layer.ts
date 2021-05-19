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
import { MixerDefaults } from './producer/mixer'
import { LayerUpdType, Transitioner, TransitionSpec } from './transitioner'
import { ConsumerConfig } from './config'
import { ClJobs } from './clJobQueue'

export const DefaultTransitionSpec = '{ "type": "cut", "len": 0 }'

type SourceSpec = {
	source?: Producer
	transition: TransitionSpec
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
		this.curSrcSpec = { source: undefined, transition: JSON.parse(DefaultTransitionSpec) }
		this.nextSrcSpec = { source: undefined, transition: JSON.parse(DefaultTransitionSpec) }
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

		if (this.curSrcSpec.source) {
			audioPipes.push(this.curSrcSpec.source.getMixer().getAudioPipe())
			if (this.nextSrcSpec.source && transitionSpec.type !== 'cut') {
				audioPipes.push(this.nextSrcSpec.source.getMixer().getAudioPipe())
				// if (transitionSpec.mask) audioPipes.push(transitionSpec.mask.getMixer().getAudioPipe())
			}
		}

		const videoPipes: RedioPipe<OpenCLBuffer | RedioEnd>[] = []
		if (this.curSrcSpec.source) {
			videoPipes.push(this.curSrcSpec.source.getMixer().getVideoPipe())
			if (this.nextSrcSpec.source && transitionSpec.type !== 'cut') {
				videoPipes.push(this.nextSrcSpec.source.getMixer().getVideoPipe())
				if (transitionSpec.mask) videoPipes.push(transitionSpec.mask.getMixer().getVideoPipe())
			}
		}

		this.transitioner?.update(transitionSpec.type, transitionSpec.len, audioPipes, videoPipes)
	}

	layerUpdate(type: LayerUpdType): void {
		if (type === 'transitionEnd') {
			this.curSrcSpec.transition.mask?.release()
			this.curSrcSpec.source?.release()
			this.curSrcSpec.source = this.curSrcSpec.transition.source
			this.curSrcSpec.transition = JSON.parse(DefaultTransitionSpec)
		} else if (type === 'allEnd') {
			this.curSrcSpec.transition.mask?.release()
			this.curSrcSpec.source?.release()
			this.curSrcSpec.source = undefined
			this.curSrcSpec.transition = JSON.parse(DefaultTransitionSpec)

			this.endEvent.emit(type)
			this.update()
		}
	}

	async load(
		producer: Producer,
		transitionSpec: TransitionSpec,
		preview: boolean,
		autoPlay: boolean,
		channelUpdate: () => void
	): Promise<boolean> {
		this.nextSrcSpec = { source: producer, transition: transitionSpec }
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
				await once(this.endEvent, 'end')
			}
			this.curSrcSpec.source = this.nextSrcSpec.source
			this.nextSrcSpec.source = undefined
			this.channelUpdate()
		}
		return true
	}

	async play(): Promise<void> {
		if (this.nextSrcSpec.source && this.nextSrcSpec.transition?.type === 'cut') {
			if (this.curSrcSpec.source) this.curSrcSpec.source.release()
			this.curSrcSpec.source = this.nextSrcSpec.source
			this.nextSrcSpec.source = undefined
		}
		this.curSrcSpec.transition = this.nextSrcSpec.transition
		if (this.curSrcSpec.transition.type !== 'cut') {
			this.curSrcSpec.transition.source = this.nextSrcSpec.source
		}
		this.nextSrcSpec.transition = JSON.parse(DefaultTransitionSpec)

		this.autoPlay = false
		this.curSrcSpec.source?.setPaused(false)
		this.nextSrcSpec.source?.setPaused(false)
		this.curSrcSpec.transition?.mask?.setPaused(false)

		await this.update()
		this.channelUpdate()
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
			await once(this.endEvent, 'allEnd')
		}
		this.curSrcSpec.source = undefined
		this.autoPlay = false
	}

	anchor(params: string[]): void {
		const mixer = this.curSrcSpec.source
			? this.curSrcSpec.source.getMixer()
			: this.nextSrcSpec.source?.getMixer()
		if (params.length) {
			this.mixerParams.anchor = { x: +params[0], y: +params[1] }
			mixer?.setMixParams(this.mixerParams)
		} else {
			console.dir(this.mixerParams.anchor, { colors: true })
		}
	}

	rotation(params: string[]): void {
		const mixer = this.curSrcSpec.source
			? this.curSrcSpec.source.getMixer()
			: this.nextSrcSpec.source?.getMixer()
		if (params.length) {
			this.mixerParams.rotation = +params[0]
			mixer?.setMixParams(this.mixerParams)
		} else {
			console.dir(this.mixerParams.rotation, { colors: true })
		}
	}

	fill(params: string[]): void {
		const mixer = this.curSrcSpec.source
			? this.curSrcSpec.source.getMixer()
			: this.nextSrcSpec.source?.getMixer()
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
		const mixer = this.curSrcSpec.source
			? this.curSrcSpec.source.getMixer()
			: this.nextSrcSpec.source?.getMixer()
		if (params.length) {
			this.mixerParams.volume = +params[0]
			mixer?.setMixParams(this.mixerParams)
		} else {
			console.dir(this.mixerParams.volume, { colors: true })
		}
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
		await this.transitioner?.release()
		this.transitioner = null
	}
}
