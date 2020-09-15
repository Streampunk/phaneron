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
import { demuxer, decoder, filterer, Packet, Frame } from 'beamcoder'

import { ToRGBA, FromRGBA } from '../process/io'
import { Reader as yuv422p10Reader } from '../process/yuv422p10'
import ImageProcess from '../process/imageProcess'
import Transform from '../process/transform'
import { Writer as v210Writer } from '../process/v210'
import Yadif from '../process/yadif'

const width = 1920
const height = 1080

let ffmpegLoader: ToRGBA
let yadif: Yadif
let transform: ImageProcess
let v210Saver: FromRGBA

const loadFrame = async (
	clContext: nodenCLContext,
	src: { count: number; data: Frame[] },
	clQueue: number
) => {
	// const start = process.hrtime()

	const clSrcs = await ffmpegLoader.createSources()
	await ffmpegLoader.loadFrame(src.data[0].data, clSrcs, clQueue)

	// const end = process.hrtime(start)
	// console.log(`Load-${src.count}: ${(end[1] / 1000000.0).toFixed(2)}`)

	await clContext.waitFinish(clQueue)
	// const done = process.hrtime(start)
	// console.log(`Load done-${src.count}: ${(done[0] * 1000.0 + done[1] / 1000000.0).toFixed(2)}`)
	return { count: src.count, data: clSrcs }
}

const processFrame = async (
	clContext: nodenCLContext,
	src: { count: number; data: OpenCLBuffer[] },
	clQueue: number
) => {
	// const start = process.hrtime()

	const v210Dsts = await v210Saver.createDests()

	const rgbaSrc = await ffmpegLoader.createDest({ width: width, height: height })
	const rgbaDsts: OpenCLBuffer[] = []
	rgbaDsts[0] = await clContext.createBuffer(
		ffmpegLoader.getNumBytesRGBA(),
		'readwrite',
		'coarse',
		{ width: width, height: height },
		'processFrame'
	)
	rgbaDsts[1] = await clContext.createBuffer(
		ffmpegLoader.getNumBytesRGBA(),
		'readwrite',
		'coarse',
		{ width: width, height: height },
		'processFrame'
	)
	const yadifDests: OpenCLBuffer[] = [] //[rgbaDsts[0], rgbaDsts[1]]

	// const setup = process.hrtime(start)
	// console.log(`OpenCL setup-${src.count}: ${(setup[1] / 1000000.0).toFixed(2)}`)

	await ffmpegLoader.processFrame(src.data, rgbaSrc, clQueue)
	// const load = process.hrtime(start)
	// console.log(`OpenCL load-${src.count}: ${((load[1] - setup[1]) / 1000000.0).toFixed(2)}`)
	await yadif.processFrame(rgbaSrc, yadifDests, clQueue)
	// const yad = process.hrtime(start)
	// console.log(`OpenCL yadif-${src.count}: ${((yad[1] - load[1]) / 1000000.0).toFixed(2)}`)

	if (yadifDests.length == 2) {
		for (let field = 0; field < 2; ++field) {
			await transform.run(
				{
					input: yadifDests[field],
					flipH: false,
					flipV: false,
					anchorX: -0.5,
					anchorY: -0.5,
					scaleX: 1.0,
					scaleY: 1.0,
					rotate: 0.0,
					offsetX: 0.0,
					offsetY: 0.0,
					output: rgbaDsts[field]
				},
				clQueue
			)

			const interlace = 0x1 | (field << 1)
			await v210Saver.processFrame(rgbaDsts[field], v210Dsts, clQueue, interlace)
		}
	}
	// const end = process.hrtime(start)
	// console.log(`OpenCL-${src.count}: ${((end[1] - yad[1]) / 1000000.0).toFixed(2)}`)

	await clContext.waitFinish(clQueue)

	src.data.forEach((s) => s.release())
	rgbaSrc.release()
	yadifDests.forEach((s) => s.release())
	rgbaDsts.forEach((s) => s.release())

	// const done = process.hrtime(start)
	// console.log(`OpenCL done-${src.count}: ${(done[0] * 1000.0 + done[1] / 1000000.0).toFixed(2)}`)
	return { count: src.count, data: v210Dsts }
}

async function saveFrame(
	clContext: nodenCLContext,
	src: { count: number; data: OpenCLBuffer[] },
	clQueue: number
) {
	// const start = process.hrtime()

	await v210Saver.saveFrame(src.data, clQueue)

	// const end = process.hrtime(start)
	// console.log(`Save-${src.count}: ${(end[1] / 1000000.0).toFixed(2)}`)

	await clContext.waitFinish(clQueue)

	// const done = process.hrtime(start)
	// console.log(`Save done-${src.count}: ${(done[0] * 1000.0 + done[1] / 1000000.0).toFixed(2)}`)
	return { count: src.count, data: src.data }
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

const init = async (): Promise<void> => {
	const clContext = await initialiseOpenCL()

	const demux = await demuxer('M:/dpp/AS11_DPP_HD_EXAMPLE_1.mxf')
	await demux.seek({ time: 40 })
	const stream = demux.streams[0]

	const vidDecode = decoder({ demuxer: demux, stream_index: stream.index })
	const vidFilter = await filterer({
		filterType: 'video',
		inputParams: [
			{
				width: stream.codecpar.width,
				height: stream.codecpar.height,
				pixelFormat: stream.codecpar.format,
				timeBase: stream.time_base,
				pixelAspect: stream.codecpar.sample_aspect_ratio
			}
		],
		outputParams: [
			{
				pixelFormat: stream.codecpar.format
			}
		],
		filterSpec: 'fps=fps=25'
		// filterSpec: 'yadif=mode=send_field:parity=auto:deint=all'
	})

	const bgColSpecRead = '709'
	const colSpecWrite = '709'

	ffmpegLoader = new ToRGBA(
		clContext,
		bgColSpecRead,
		colSpecWrite,
		new yuv422p10Reader(width, height)
	)
	await ffmpegLoader.init()

	yadif = new Yadif(clContext, width, height, 'send_field', 'tff', 'all')
	await yadif.init()

	transform = new ImageProcess(clContext, new Transform(clContext, width, height))
	await transform.init()

	v210Saver = new FromRGBA(clContext, colSpecWrite, new v210Writer(width, height, true))
	await v210Saver.init()

	let result: { count: number; data: unknown }[] = []
	let counter = 0

	const read = async (params: { count: number }) => {
		// const start = process.hrtime();
		let packet
		do packet = await demux.read()
		while (packet.stream_index !== 0)
		// const done = process.hrtime(start);
		// console.log(`read-${params.count}: ${(done[0] * 1000.0 + done[1] / 1000000.0).toFixed(2)}`);
		return { count: params.count, data: packet }
	}

	// let decFrames: Frame[] | null = null
	const decode = async (params: { count: number; data: Packet }) => {
		// const start = process.hrtime();
		// if (decFrames) return Promise.resolve({ count: params.count, data: decFrames })
		// console.log('!!! Bypassing decoder !!!')
		const frame = await vidDecode.decode(params.data)
		// decFrames = frame.frames
		// const done = process.hrtime(start);
		// console.log(`decode-${params.count}: ${(done[0] * 1000.0 + done[1] / 1000000.0).toFixed(2)}`);
		return { count: params.count, data: frame.frames }
	}

	const filter = async (params: { count: number; data: Frame[] }) => {
		// const start = process.hrtime();
		const filtFrames = await vidFilter.filter(params.data)
		// const done = process.hrtime(start);
		// console.log(`deinterlace-${params.count}: ${(done[0] * 1000.0 + done[1] / 1000000.0).toFixed(2)}`);
		return { count: params.count, data: filtFrames[0].frames }
		// return { count: params.count, data: params.data }
	}

	const waitForIt = async (t: number) => {
		return new Promise((resolve) => {
			setTimeout(resolve, t > 0 ? t : 0)
		})
	}

	const start = process.hrtime()
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const work: Promise<{ count: number; data: unknown }>[] = []
		const stamp = process.hrtime()
		if (result.length >= 6) {
			if (result[5].count % 25 === 0) console.log('tick', result[5].count)
			const clBufs = result[5].data as OpenCLBuffer[]
			clBufs[0].release()
		}
		if (result.length >= 5)
			work[5] = saveFrame(
				clContext,
				{ count: result[4].count, data: result[4].data as OpenCLBuffer[] },
				clContext.queue.unload
			)
		if (result.length >= 4)
			work[4] = processFrame(
				clContext,
				{ count: result[3].count, data: result[3].data as OpenCLBuffer[] },
				clContext.queue.process
			)
		if (result.length >= 3 && (result[2].data as Frame[]).length)
			work[3] = loadFrame(
				clContext,
				{ count: result[2].count, data: result[2].data as Frame[] },
				clContext.queue.load
			)
		if (result.length >= 2)
			work[2] = filter({ count: result[1].count, data: result[1].data as Frame[] })
		if (result.length >= 1)
			work[1] = decode({ count: result[0].count, data: result[0].data as Packet })
		work[0] = read({ count: counter })

		result = await Promise.all(work)

		let diff = process.hrtime(start)
		const wait = counter * 40 - (diff[0] * 1000 + ((diff[1] / 1000000) | 0))
		await waitForIt(wait)
		diff = process.hrtime(stamp)
		// console.log(
		// 	`Clunk ${counter} completed in ${
		// 		diff[0] * 1000 + ((diff[1] / 1000000) | 0)
		// 	} waiting ${wait}`
		// )
		counter++
	}
}

init()
