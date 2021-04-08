import Koa from 'koa'
import cors from '@koa/cors'
import bodyParser from 'koa-bodyparser'
import serve from 'koa-static'
import { v4 as uuidv4 } from 'uuid'

import connectionManagerApi from './api'
import { RTCPeerConnection } from 'wrtc'
import { WebRtcConnectionManager } from './connections/webRTCConnectionManager'
import { WebRTCConnection } from './connections/webRTCConnection'

let peerManagerSingleton: PeerManager

interface ConsumerInfo {
	readonly id: string
	readonly description: string
	newPeer: (peer: { peerConnection: RTCPeerConnection }) => void
	peerClose: (peer: { peerConnection: RTCPeerConnection }) => void
}

export interface ConsumerInfoExt extends ConsumerInfo {
	readonly connectionManager: WebRtcConnectionManager<WebRTCConnection>
}

export class PeerManager {
	// private connectionManager: WebRtcConnectionManager<WebRTCConnection>
	private consumers: Map<string, ConsumerInfoExt>
	private kapp: Koa<Koa.DefaultState, Koa.DefaultContext>
	// private allPeerConnections: RTCPeerConnection[] = []

	constructor() {
		this.consumers = new Map();

		this.kapp = new Koa()
		this.kapp.use(cors())
		this.kapp.use(bodyParser({ enableTypes: [ 'json' ] }))
		connectionManagerApi(this.kapp, this.consumers)
		this.kapp.use(serve("static/"))

		const server = this.kapp.listen(3002)
		process.on('SIGHUP', server.close)
	}

	registerSource(info: ConsumerInfo): void {
		if(this.consumers.get(info.id)) {
			throw new Error(`WebRTC Consumer "${info.id}" already registered`)
		}

		const beforeAnswer = (peerConnection: RTCPeerConnection) => {
			// let that = this
			// this.allPeerConnections.push(peerConnection)
			info.newPeer({ peerConnection })
	
			// NOTE(mroberts): This is a hack so that we can get a callback when the
			// RTCPeerConnection is closed. In the future, we can subscribe to
			// "connectionstatechange" events.
			const { close } = peerConnection
			peerConnection.close = function (...args) {
				info.peerClose({ peerConnection })
				return close.apply(this, args)
			}
		}

		this.consumers.set(info.id, {
			...info, 
			connectionManager: new WebRtcConnectionManager({
				createConnection: (id, baseOptions) =>
					new WebRTCConnection(id, {
						beforeAnswer,
						...baseOptions
					}),
				generateId: uuidv4
			})
		})
	}

	destroySource(id: string) {
		if (this.consumers.delete(id)) {
			// TODO
		}
	}

	static singleton() {
		if (!peerManagerSingleton) {
			peerManagerSingleton = new PeerManager()
		}
		return peerManagerSingleton
	}
}
