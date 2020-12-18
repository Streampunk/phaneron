import { EventEmitter } from 'events'
import Koa from 'koa'
import cors from '@koa/cors'

import connectionManagerApi from './api'
import { RTCPeerConnection } from 'wrtc'
import { WebRtcConnectionManager } from './connections/webRTCConnectionManager'
import WebRTCConnection from './connections/webRTCConnection'

let peerManagerSingleton: PeerManager

export class PeerManager extends EventEmitter {
	private connectionManager: WebRtcConnectionManager<WebRTCConnection<RTCPeerConnection>>
	private kapp: Koa<Koa.DefaultState, Koa.DefaultContext>
	private allPeerConnections: RTCPeerConnection[] = []

	constructor() {
		super()
		this.connectionManager = new WebRtcConnectionManager({
			Connection: WebRTCConnection,
			beforeOffer: this.beforeOffer
		})
		this.kapp = new Koa()
		this.kapp.use(cors())
		connectionManagerApi(this.kapp, this.connectionManager)

		const server = this.kapp.listen(3002)
		process.on('SIGHUP', server.close)
	}

	private beforeOffer = (peerConnection: RTCPeerConnection) => {
		let that = this
		this.allPeerConnections.push(peerConnection)
		this.emit('newPeer', { peerConnection })

		// NOTE(mroberts): This is a hack so that we can get a callback when the
		// RTCPeerConnection is closed. In the future, we can subscribe to
		// "connectionstatechange" events.
		const { close } = peerConnection
		peerConnection.close = function (...args) {
			that.emit('peerClose', { peerConnection })
			return close.apply(this, args)
		}

		// return (rgbaFrame: RTCVideoFrame) => {
		// 	const i420Frame: RTCVideoFrame = {
		// 		width: rgbaFrame.width,
		// 		height: rgbaFrame.height,
		// 		data: new Uint8ClampedArray(1.5 * rgbaFrame.width * rgbaFrame.height)
		// 	}
		// 	rgbaToI420(rgbaFrame, i420Frame)
		// 	source.onFrame
		// }
	}

	static singleton() {
		if (!peerManagerSingleton) {
			peerManagerSingleton = new PeerManager()
		}
		return peerManagerSingleton
	}
}
