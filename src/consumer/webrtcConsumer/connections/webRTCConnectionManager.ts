import { ConnectionID, IConnectionManagerOptions, ConnectionManager } from './connectionManager'
import { WebRTCConnection } from './webRTCConnection'

export class WebRtcConnectionManager<RTCPeerConnectionType extends WebRTCConnection> {
	private connectionManager: ConnectionManager<RTCPeerConnectionType>

	constructor(options: IConnectionManagerOptions<RTCPeerConnectionType>) {
		this.connectionManager = new ConnectionManager<RTCPeerConnectionType>(options)
	}

	createConnection = async () => {
		const connection = await this.connectionManager.createConnection()
		await connection.doOffer()
		return connection
	}

	getConnection = (id: ConnectionID) => this.connectionManager.getConnection(id)

	getConnections = (): RTCPeerConnectionType[] => this.connectionManager.getConnections()

	toJSON = () => this.getConnections().map((connection) => connection.toJSON())
}
