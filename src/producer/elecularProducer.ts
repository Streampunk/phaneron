import redio, { isValue, RedioEnd, RedioPipe, Valve, Funnel, nil, RedioNil, HTTPOptions, isEnd, end, literal } from 'redioactive'
import { VideoFormat, VideoFormats } from '../config'
import { AudioMixFrame } from '../mixer'
import { Producer, ProducerFactory } from './producer'
import { clContext as nodenCLContext, OpenCLBuffer } from 'nodencl'
import { LoadParams } from '../chanLayer'
import { ClJobs } from '../clJobQueue'
import { Reader as rgba8Reader } from '../process/rgba8'
import { ToRGBA } from '../process/io'
import { PackImpl } from '../process/packer'

// FIXME - bad hack - should come from the stream
const width = 1920
const height = 1080

interface ElecularPacket {
    x: number
    y: number
    width: number
    height: number
    pts: number
    data: Buffer
}

export class ElecularProducer implements Producer {
    private readonly sourceID: string
	private readonly params: LoadParams
	private readonly clContext: nodenCLContext
    private readonly clJobs: ClJobs
    private format: VideoFormat
    private frame: Buffer = Buffer.alloc(width * height *4)
    private vidSource: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
    private paused = false
    constructor(id: number, params: LoadParams, context: nodenCLContext, clJobs: ClJobs) { 
        this.sourceID = `P${id} Elecular-HTTP ${params.url} L${params.layer}`
		this.params = params
		this.clContext = context
		this.clJobs = clJobs
		this.format = new VideoFormats().get('1080p5000') // default
    }
    async initialise(consumerFormat: VideoFormat) {
        let toRGBA: ToRGBA | null = null
        let readImpl: PackImpl = new rgba8Reader(width, height)
        toRGBA = new ToRGBA(this.clContext, 'sRGB', '709', readImpl, this.clJobs)
        await toRGBA.init()
        
		const vidLoader: Valve<ElecularPacket | RedioEnd, OpenCLBuffer[] | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const convert = toRGBA as ToRGBA
				const clSources = await convert.createSources()
				clSources.forEach((s) => s.timestamp = frame.pts)
				await convert.loadFrame(frame.data, clSources, this.clContext.queue.load)
				await this.clContext.waitFinish(this.clContext.queue.load)
				return clSources
			} else {
				return frame
			}
		}

        const waitAndDouble: (x: RedioPipe<ElecularPacket>) => RedioPipe<ElecularPacket> = 
        (x: RedioPipe<ElecularPacket>) => {
            let sentCount = -1
            let lastFrames: { [pts: number]: ElecularPacket } = { }
            let lastFramesPTSs: number[] = []
            let outResolver: ((x: ElecularPacket |RedioNil | PromiseLike<ElecularPacket | RedioNil>) => void) | null = null
            x.each((frame) => {
                lastFrames[frame.pts] = frame
                lastFramesPTSs.push(frame.pts)
                while (lastFramesPTSs.length > 10) {
                    delete lastFrames[lastFramesPTSs[0]]
                    lastFramesPTSs = lastFramesPTSs.slice(1)
                }
                if (outResolver) { 
                    outResolver(nil)
                    outResolver = null
                }
            })

            const out: Funnel<ElecularPacket> = () => new Promise<ElecularPacket | RedioNil>((resolve, reject) => {
                if (lastFramesPTSs.length === 0) {
                    outResolver = resolve
                    return
                }
                if (sentCount === -1) {
                    sentCount = lastFramesPTSs[0] * 2
                }
                let toSend = lastFrames[sentCount / 2 | 0]
                if (toSend) {
                    sentCount++
                    resolve(toSend)
                } else {
                    if (lastFramesPTSs.length > 0 && sentCount / 2 > lastFramesPTSs[lastFramesPTSs.length - 1]) {
                        sentCount++
                        resolve(toSend)
                    } else {
                        sentCount = -1
                        outResolver = resolve
                    }
                }
            })
            return redio(out)
        }

        const frameMapper = (p: ElecularPacket | RedioEnd) => {
            if (isEnd(p)) {
                return end
            }
            p.data.copy(this.frame, width * p.y * 4, 0)
            return literal<ElecularPacket>({
                ...p,
                data: this.frame
            })
        }

        this.vidSource = 
            waitAndDouble(
                redio<ElecularPacket>(this.params.url, { portNumber: 8765, blob: 'data' } as HTTPOptions)
            )
            .map(frameMapper)
            .valve(vidLoader, { bufferSizeMax: 1, oneToMany: true } )
            .
            .pause((frame) => {
				if (this.paused && isValue(frame)) (frame as OpenCLBuffer).addRef()
				return this.paused
			})
    }
    getSourceID(): string { return '' }
    getFormat(): VideoFormat { return null }
    getSourceAudio(): RedioPipe<AudioMixFrame | RedioEnd> | undefined { return undefined }
    getSourceVideo(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined { return fred }
    setPaused (pause: boolean): void { }
    release(): void { }

}

export class ElecularProducerFactory implements ProducerFactory<ElecularProducer> {
    constructor(private clContext: nodenCLContext) { }

    createProducer(id: number, params: LoadParams, clJobs: ClJobs): ElecularProducer {
        return new ElecularProducer(id, params, this.clContext, clJobs)
    }
}