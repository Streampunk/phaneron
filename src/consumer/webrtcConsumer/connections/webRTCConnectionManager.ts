import { ConnectionID, IConnectionManagerOptions, ConnectionManager } from './connectionManager'
import { WebRTCConnection } from './webRTCConnection'

export class WebRtcConnectionManager<RTCPeerConnectionType extends WebRTCConnection> {
	private connectionManager: ConnectionManager<RTCPeerConnectionType>

	constructor(options: IConnectionManagerOptions<RTCPeerConnectionType>) {
		this.connectionManager = new ConnectionManager<RTCPeerConnectionType>(options)
	}

	createConnection = async (offer?: RTCSessionDescription) => {
		const connection = await this.connectionManager.createConnection()
		console.log("In WebRTC connection manager createConnection.")
		if (offer) {
			await connection.applyOffer(offer)
			console.log("Applied offer ... time to answer")
			await connection.doAnswer()
			console.log("Generated answer", connection.localDescription)
		} 
		return connection
	}

	getConnection = (id: ConnectionID) => this.connectionManager.getConnection(id)

	getConnections = (): RTCPeerConnectionType[] => this.connectionManager.getConnections()

	toJSON = () => this.getConnections().map((connection) => connection.toJSON())
}
