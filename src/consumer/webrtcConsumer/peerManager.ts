import Koa from 'koa'
import cors from '@koa/cors'
import bodyParser from 'koa-bodyparser'
import serve from 'koa-static'
import { v4 as uuidv4 } from 'uuid'

import connectionManagerApi from './api'
import { RTCPeerConnection } from 'wrtc'
import { WebRtcConnectionManager } from './connections/webRTCConnectionManager'
import { WebRTCConnection } from './connections/webRTCConnection'
import { processCommand } from '../../AMCP/server'
import { Channel } from '../../channel'
let peerManagerSingleton: PeerManager

interface ConsumerInfo {
	readonly id: string
	readonly description: string
	newPeer: (peer: { peerConnection: RTCPeerConnection }) => void
	peerClose: (peer: { peerConnection: RTCPeerConnection }) => void
	readonly channel: Channel
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
		let receiveChannel

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

			peerConnection.ondatachannel = (event) => {
				console.log("Data channel time", event)
				receiveChannel = event.channel
				receiveChannel.onmessage = onReceiveMessageCallback
			}
		}

		let paused = false
		let channel = info.channel
		let firstMessage = true

		function onReceiveMessageCallback(event: MessageEvent<String>) {
			console.log('Received Message', event.data);

			if (event.data === 'PLAY') {
				processCommand(['PLAY', '1-1', 'AS11_DPP_HD_EXAMPLE_1.MXF', 'SEEK', '200'])
				paused = false
			}
			if (event.data === 'PAUSE') {
				if (!paused) {
					processCommand(['PAUSE', '1-1'])
					paused = true
				} else {
					processCommand(['RESUME', '1-1'])
					paused = false
				}
			}
			if (event.data === 'STOP') {
				processCommand(['STOP', '1-1'])
				paused = false
			}

			if (event.data.startsWith('ROTATION')) {
				if (firstMessage) {
					channel.anchor(1, ['0.5', '0.5'])
					firstMessage = false
				}
				channel.rotation(1, [event.data.slice(9)])
			}

			if (event.data.startsWith('FILL')) {
				if (firstMessage) {
					channel.anchor(1, ['0.5', '0.5'])
					firstMessage = false
				}
				channel.fill(1, ['0', '0', ...event.data.split(' ').slice(1) ])
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
