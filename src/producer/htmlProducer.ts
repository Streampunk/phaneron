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

import { ProducerFactory, Producer, InvalidProducerError } from './producer'
import { clContext as nodenCLContext, OpenCLBuffer } from 'nodencl'
import redio, { RedioPipe, nil, end, isValue, RedioEnd, isEnd, Generator, Valve } from 'redioactive'
import {
	Filterer,
	filterer,
	Frame,
	frame
} from 'beamcoder'
import { ClJobs } from '../clJobQueue'
import { LoadParams } from '../chanLayer'
import { VideoFormat } from '../config'
import * as Ceforama from 'ceforama'
import { ToRGBA } from '../process/io'
import { Reader as bgraReader } from '../process/bgra8'
import { Mixer, AudioMixFrame } from './mixer'

// TODO make this dynamic from consumer params
const CEF_FRAME_RATE = 50

interface AudioChannel {
	name: string
	frames: Frame[]
}

export class HTMLProducer implements Producer {
	private readonly sourceID: string
	private readonly params: LoadParams
	private readonly clContext: nodenCLContext
	private readonly clJobs: ClJobs
	private readonly consumerFormat: VideoFormat
	private readonly mixer: Mixer
	private audFilterer: Filterer | null = null
	private audSource: RedioPipe<AudioMixFrame | RedioEnd> | undefined
	private vidSource: RedioPipe<OpenCLBuffer | RedioEnd> | undefined    
    private cefClient: Ceforama.CeforamaClient | null = null 
    private toRGBA: ToRGBA | null = null
	private running = true
	private paused = true
    private updater: NodeJS.Timeout | null = null
    private lastFrame : Promise<Ceforama.CeforamaFrame> | null = null
    private changed = true

	constructor(
		id: number,
		params: LoadParams,
		context: nodenCLContext,
		clJobs: ClJobs,
		consumerFormat: VideoFormat
	) {
		this.sourceID = `P${id} Ceforama ${params.url} L${params.layer}`
		this.params = params
		this.clContext = context
		this.clJobs = clJobs
		this.consumerFormat = consumerFormat
		this.mixer = new Mixer(this.clContext, this.consumerFormat, this.clJobs)
	}

    async initialise(): Promise<void> {
        if (!this.params.url.startsWith('[HTML] ')) {
            throw new InvalidProducerError('Ceforama producer supports HTML content')
        }
        let width = this.consumerFormat.width
		let height = this.consumerFormat.height
        this.cefClient = await Ceforama.client({
            width,
            height,
            url: this.params.url.slice(7),
            fps: CEF_FRAME_RATE
        })
        Ceforama.runLoop()

        this.toRGBA = new ToRGBA(
            this.clContext,
            'sRGB',
            '709',
            new bgraReader(width, height),
            this.clJobs
        )
        await this.toRGBA.init()

        let silentFrame: Frame | null = null

        silentFrame = frame({
            nb_samples: 1024,
            format: 's32',
            pts: 0,
            sample_rate: this.consumerFormat.audioSampleRate,
            channels: 1,
            channel_layout: '1c',
            data: [Buffer.alloc(1024 * 4)]
        })

        this.audFilterer = await filterer({
            filterType: 'audio',
            inputParams: [
                {
                    name: 'in0:a',
                    timeBase: [1, this.consumerFormat.audioSampleRate],
                    sampleRate: this.consumerFormat.audioSampleRate,
                    sampleFormat: 's32',
                    channelLayout: '1c'
                }
            ],
            outputParams: [
                {
                    name: 'out0:a',
                    sampleRate: this.consumerFormat.audioSampleRate,
                    sampleFormat: 'fltp',
                    channelLayout: '1c'
                }
            ],
            filterSpec: '[in0:a] asetpts=N/SR/TB [out0:a]'
        })

        const getNextFrame: () => Promise<Ceforama.CeforamaFrame> | null = () => {
            return this.cefClient?.frame().then(f => {
                this.lastFrame = Promise.resolve(f)
                this.changed = true
                getNextFrame()
                return f
            }) || null
        }

        const frameSource: Generator<Ceforama.CeforamaFrame | RedioEnd> = async () => {
            let result: Promise<Ceforama.CeforamaFrame | RedioEnd> = Promise.resolve(end)
            // TODO consider frame racing - if I've not seen a frame in 1/FPS + 20%, send the last one
            if (!this.updater) {
                this.updater = setInterval(() => this.cefClient?.update(), 20)
            }
            if (this.cefClient && this.running) {
                if (this.lastFrame) { 
                    result = this.lastFrame;
                    if (this.changed) {
                        getNextFrame()
                        this.changed = false
                    }
                } else {
                    result = getNextFrame() || result
                }
            } else {
                // stop CEF capture
            }
            return result
        }

        const silence: Generator<AudioChannel[] | RedioEnd> = async () =>
            this.running ? [{ name: 'in0:a', frames: [silentFrame] }] : end


        const audFilter: Valve<AudioChannel[] | RedioEnd, AudioMixFrame | RedioEnd> = async (
            frames
        ) => {
            if (isValue(frames) && this.audFilterer) {
                if (!this.running) return nil
                const ff = await this.audFilterer.filter(frames)
                if (ff.reduce((acc, f) => acc && f.frames && f.frames.length > 0, true)) {
                    return { frames: ff.map((f) => f.frames), mute: false }
                } else return nil
            } else {
                return frames as RedioEnd
            }
        }

        const vidLoader: Valve<Ceforama.CeforamaFrame | RedioEnd, OpenCLBuffer[] | RedioEnd> = async (
			frame
		) => {
			if (isValue(frame)) {
				const toRGBA = this.toRGBA as ToRGBA
				const clSources = await toRGBA.createSources()
				const timestamp =
					(frame.seq / CEF_FRAME_RATE) 
				clSources.forEach((s) => {
					// s.loadstamp = nowms
					s.timestamp = timestamp
				})
				await toRGBA.loadFrame(frame.frame, clSources, this.clContext.queue.load)
				await this.clContext.waitFinish(this.clContext.queue.load)
				return clSources
			} else {
				return frame
			}
		}

        const vidProcess: Valve<OpenCLBuffer[] | RedioEnd, OpenCLBuffer | RedioEnd> = async (
			clSources
		) => {
			if (isValue(clSources)) {
				const toRGBA = this.toRGBA as ToRGBA
				const clDest = await toRGBA.createDest({ width: width, height: height })
				// clDest.loadstamp = clSources[0].loadstamp
				clDest.timestamp = clSources[0].timestamp
				toRGBA.processFrame(this.sourceID, clSources, clDest)
				return clDest
			} else {
				if (isEnd(clSources)) this.toRGBA = null
				return clSources
			}
		}

		const srcFormat = {
			name: 'ceforama',
			fields: 1,
			width: width,
			height: height,
			squareWidth: width,
			squareHeight: height,
			timescale: CEF_FRAME_RATE,
			duration: 1,
			audioSampleRate: 48000,
			audioChannels: 1
		}

		const ceforamaFrames = redio(frameSource, { bufferSizeMax: 2 })

        this.vidSource = ceforamaFrames
            .valve(vidLoader, { bufferSizeMax: 1 })
            .valve(vidProcess, { bufferSizeMax: 1 })
            .pause((frame) => {
                if (this.paused && isValue(frame)) (frame as OpenCLBuffer).addRef()
				return this.paused
            })

        this.audSource = redio(silence, { bufferSizeMax: 2 })
            .valve(audFilter, { oneToMany: true })
            .pause((frame) => {
                if (!this.running) {
                    frame = nil
                    return false
                }
                if (this.paused && isValue(frame)) (frame as AudioMixFrame).mute = true
                return this.paused    
            })

        await this.mixer.init(this.sourceID, this.audSource, this.vidSource, srcFormat)

        console.log(`Created Ceforama producer for channel ${this.params.channel}`)

        this.lastFrame = this.cefClient.frame()
    }

    getMixer(): Mixer {
		return this.mixer
	}

	setPaused(pause: boolean): void {
		this.paused = pause
	}

	release(): void {
		this.running = false
		this.mixer.release()
	}
}

export class HTMLProducerFactory implements ProducerFactory<HTMLProducer> {
    private clContext: nodenCLContext

    constructor(clContext: nodenCLContext) {
        this.clContext = clContext
    }
    
	createProducer(
		id: number,
		params: LoadParams,
		clJobs: ClJobs,
		consumerFormat: VideoFormat
	): HTMLProducer {
		return new HTMLProducer(id, params, this.clContext, clJobs, consumerFormat)
	}
}