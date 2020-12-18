import { RTCPeerConnection } from 'wrtc'
import ConnectionManager, { ConnectionID } from './connectionManager'
import WebRTCConnection, { IOptions as IWebRTCConnectionOptions } from './webRTCConnection'

export class WebRtcConnectionManager<
	RTCPeerConnectionType extends WebRTCConnection<RTCPeerConnection>
> {
	private connectionManager: ConnectionManager<RTCPeerConnectionType>

	constructor(options = {}) {
		options = {
			Connection: WebRTCConnection,
			...options
		}

		this.connectionManager = new ConnectionManager(options)
	}

	createConnection = async () => {
		const connection = await this.connectionManager.createConnection()
		await connection.doOffer()
		return connection
	}

	getConnection = (id: ConnectionID) => this.connectionManager.getConnection(id)

	getConnections = (): RTCPeerConnectionType[] => this.connectionManager.getConnections()

	toJSON = () => this.getConnections().map((connection) => connection.toJSON())

	static create(options: Partial<IWebRTCConnectionOptions<RTCPeerConnection>>) {
		return new WebRtcConnectionManager({
			Connection: function (id: ConnectionID) {
				return new WebRTCConnection(id, options)
			}
		})
	}
}
