import { RTCPeerConnection as DefaultRTCPeerConnection } from 'wrtc'
import { ConnectionID } from './connectionManager'
import Connection from './connection'

const TIME_TO_CONNECTED = 10000
const TIME_TO_HOST_CANDIDATES = 3000 // NOTE(mroberts): Too long.
const TIME_TO_RECONNECTED = 10000

export interface IWebRTCConnectionOptions {
	createRTCPeerConnection: (config: RTCConfiguration) => DefaultRTCPeerConnection
	beforeOffer: (peerConnection: DefaultRTCPeerConnection) => void
	clearTimeout: (timeoutId: NodeJS.Timeout) => void
	setTimeout: (callback: (...args: any[]) => void, ms: number, ...args: any[]) => NodeJS.Timeout
	timeToConnected: number
	timeToHostCandidates: number
	timeToReconnected: number
}

export class WebRTCConnection extends Connection {
	private peerConnection: DefaultRTCPeerConnection
	private options: IWebRTCConnectionOptions
	private connectionTimer: NodeJS.Timeout | null = null
	private reconnectionTimer: NodeJS.Timeout | null = null

	constructor(id: ConnectionID, options0: Partial<IWebRTCConnectionOptions> = {}) {
		super(id, options0)

		this.options = {
			createRTCPeerConnection: (config: RTCConfiguration) => new DefaultRTCPeerConnection(config),
			beforeOffer() {},
			clearTimeout,
			setTimeout,
			timeToConnected: TIME_TO_CONNECTED,
			timeToHostCandidates: TIME_TO_HOST_CANDIDATES,
			timeToReconnected: TIME_TO_RECONNECTED,
			...options0
		}

		const { createRTCPeerConnection, beforeOffer, timeToConnected } = this.options

		const peerConnection = (this.peerConnection = createRTCPeerConnection({
			// @ts-ignore
			sdpSemantics: 'unified-plan'
		}))

		beforeOffer(peerConnection)

		this.connectionTimer = this.options.setTimeout(() => {
			if (
				peerConnection.iceConnectionState !== 'connected' &&
				peerConnection.iceConnectionState !== 'completed'
			) {
				this.close()
			}
		}, timeToConnected)

		peerConnection.addEventListener('iceconnectionstatechange', this.onIceConnectionStateChange)
	}

	private onIceConnectionStateChange = () => {
		const peerConnection = this.peerConnection
		const { setTimeout, clearTimeout, timeToReconnected } = this.options

		if (
			peerConnection.iceConnectionState === 'connected' ||
			peerConnection.iceConnectionState === 'completed'
		) {
			if (this.connectionTimer) {
				clearTimeout(this.connectionTimer)
				this.connectionTimer = null
			}
			if (this.reconnectionTimer) {
				clearTimeout(this.reconnectionTimer)
				this.reconnectionTimer = null
			}
		} else if (
			peerConnection.iceConnectionState === 'disconnected' ||
			peerConnection.iceConnectionState === 'failed'
		) {
			if (!this.connectionTimer && !this.reconnectionTimer) {
				const self = this
				this.reconnectionTimer = setTimeout(() => {
					self.close()
				}, timeToReconnected)
			}
		}
	}

	doOffer = async () => {
		const offer = await this.peerConnection.createOffer()
		await this.peerConnection.setLocalDescription(offer)
		// try {
		//  await waitUntilIceGatheringStateComplete(this.peerConnection, this.options)
		// } catch (error) {
		// 	this.close()
		// 	throw error
		// }
	}

	applyAnswer = async (answer: RTCSessionDescriptionInit) => {
		await this.peerConnection.setRemoteDescription(answer)
	}

	close = () => {
		const peerConnection = this.peerConnection
		const { clearTimeout } = this.options

		peerConnection.removeEventListener('iceconnectionstatechange', this.onIceConnectionStateChange)
		if (this.connectionTimer) {
			clearTimeout(this.connectionTimer)
			this.connectionTimer = null
		}
		if (this.reconnectionTimer) {
			clearTimeout(this.reconnectionTimer)
			this.reconnectionTimer = null
		}
		peerConnection.close()
		super.close()
	}

	toJSON = () => {
		return {
			...super.toJSON(),
			iceConnectionState: this.iceConnectionState,
			localDescription: this.localDescription,
			remoteDescription: this.remoteDescription,
			signalingState: this.signalingState
		}
	}

	get iceConnectionState() {
		return this.peerConnection.iceConnectionState
	}

	get localDescription() {
		return descriptionToJSON(this.peerConnection.localDescription, true)
	}

	get remoteDescription() {
		return descriptionToJSON(this.peerConnection.remoteDescription)
	}

	get signalingState() {
		return this.peerConnection.signalingState
	}
}

function descriptionToJSON(
	description: RTCSessionDescription | null,
	shouldDisableTrickleIce?: boolean
) {
	return !description
		? {}
		: {
				type: description.type,
				sdp: shouldDisableTrickleIce ? disableTrickleIce(description.sdp) : description.sdp
		  }
}

function disableTrickleIce(sdp: string) {
	return sdp.replace(/\r\na=ice-options:trickle/g, '')
}

// async function waitUntilIceGatheringStateComplete<
// 	RTCPeerConnectionType extends DefaultRTCPeerConnection
// >(peerConnection: RTCPeerConnectionType, options: IOptions<RTCPeerConnectionType>) {
// 	if (peerConnection.iceGatheringState === 'complete') {
// 		return
// 	}

// 	const { timeToHostCandidates } = options

// 	const promise = new Promise<void>((resolve, reject) => {
// 		const timeout = options.setTimeout(() => {
// 			peerConnection.removeEventListener('icecandidate', onIceCandidate)
// 			reject(new Error('Timed out waiting for host candidates'))
// 		}, timeToHostCandidates)

// 		function onIceCandidate({ candidate }: { candidate: RTCIceCandidate }) {
// 			if (!candidate) {
// 				options.clearTimeout(timeout)
// 				peerConnection.removeEventListener('icecandidate', onIceCandidate)
// 				resolve()
// 			}
// 		}

// 		peerConnection.addEventListener('icecandidate', onIceCandidate)
// 	})

// 	await promise
// }
