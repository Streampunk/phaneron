/* Copyright 2018 Streampunk Media Ltd.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import { clContext as nodenCLContext, OpenCLBuffer } from 'nodencl'
import { ClProcessJobs } from '../../clJobQueue'
import { Reader as yuv420pReader, Writer as yuv420pWriter, fillBuf, dumpBuf } from '../yuv420p'
import { ToRGBA, FromRGBA } from '../io'
import { Interlace } from '../packer'

function dumpFloatBuf(
	buf: OpenCLBuffer,
	width: number,
	_height: number,
	numPixels: number,
	numLines: number
) {
	console.log()
	const r = (b: OpenCLBuffer, o: number) => b.readFloatLE(o).toFixed(4)
	for (let y = 0; y < numLines; ++y) {
		const off = y * width * 4 * 4
		let s = `Line ${y}: ${r(buf, off)}`
		for (let i = 1; i < numPixels * 4; ++i) s += `, ${r(buf, off + i * 4)}`
		console.log(s)
	}
}

async function test() {
	const platformIndex = 0
	const deviceIndex = 0
	const clContext = new nodenCLContext({
		platformIndex: platformIndex,
		deviceIndex: deviceIndex
	})
	await clContext.initialise()
	const platformInfo = clContext.getPlatformInfo()
	// console.log(JSON.stringify(platformInfo, null, 2));
	console.log(platformInfo.vendor, platformInfo.devices[deviceIndex].type)

	const clProcessJobs = new ClProcessJobs(clContext)
	const clJobs = clProcessJobs.getJobs()

	const colSpecRead = '709'
	const colSpecWrite = '709'
	const width = 1920
	const height = 1080

	const toRGBA = new ToRGBA(
		clContext,
		colSpecRead,
		colSpecWrite,
		new yuv420pReader(width, height),
		clJobs
	)
	await toRGBA.init()

	const fromRGBA = new FromRGBA(
		clContext,
		colSpecWrite,
		new yuv420pWriter(width, height, false),
		clJobs
	)
	await fromRGBA.init()

	const srcs = await toRGBA.createSources()
	const rgbaDst = await toRGBA.createDest({ width: width, height: height })

	const dsts = await fromRGBA.createDests()

	const numBytes = toRGBA.getNumBytes()
	const lumaBytes = numBytes[0]
	const chromaBytes = numBytes[1]
	const numBytesyuv420p = toRGBA.getTotalBytes()
	const yuv420pSrc = Buffer.allocUnsafe(numBytesyuv420p)
	fillBuf(yuv420pSrc, width, height)
	dumpBuf(yuv420pSrc, width, height, 4)

	await srcs[0].hostAccess('writeonly', 0, yuv420pSrc.slice(0, lumaBytes))
	await srcs[1].hostAccess('writeonly', 0, yuv420pSrc.slice(lumaBytes, lumaBytes + chromaBytes))
	await srcs[2].hostAccess(
		'writeonly',
		0,
		yuv420pSrc.slice(lumaBytes + chromaBytes, lumaBytes + chromaBytes * 2)
	)

	toRGBA.processFrame('yuv420pRead', srcs, rgbaDst)
	await clJobs.runQueue({ source: 'yuv420pRead', timestamp: 0 })

	await rgbaDst.hostAccess('readonly')
	dumpFloatBuf(rgbaDst, width, height, 2, 4)

	fromRGBA.processFrame('yuv420pWrite', rgbaDst, dsts, Interlace.Progressive)
	// rgbaDst.addRef()
	// fromRGBA.processFrame('yuv420pWrite', rgbaDst, dsts, Interlace.TopField)
	// fromRGBA.processFrame('yuv420pWrite', rgbaDst, dsts, Interlace.BottomField)
	await clJobs.runQueue({ source: 'yuv420pWrite', timestamp: 0 })

	await dsts[0].hostAccess('readonly')
	await dsts[1].hostAccess('readonly')
	await dsts[2].hostAccess('readonly')
	const yuv420pDst = Buffer.concat(dsts, numBytesyuv420p)
	dumpBuf(yuv420pDst, width, height, 4)

	await srcs[0].hostAccess('readonly')
	await srcs[1].hostAccess('readonly')
	await srcs[2].hostAccess('readonly')
	console.log('Compare returned', yuv420pSrc.compare(yuv420pDst))

	return [srcs[0], dsts[0]]
}
test()
	.then(([i, o]) => [i.creationTime, o.creationTime])
	.then(([ict, oct]) => {
		if (global.gc) global.gc()
		console.log(ict, oct)
	})
	.catch(console.error)
