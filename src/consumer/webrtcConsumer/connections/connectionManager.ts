import DefaultConnection from './connection'

export type ConnectionID = string
type IDGenerationFunction = () => ConnectionID

export interface IConnectionManagerOptions<ConnectionType extends DefaultConnection> {
	createConnection: (id: string, baseOptions: {}) => ConnectionType
	generateId: IDGenerationFunction
}

export class ConnectionManager<ConnectionType extends DefaultConnection> {
	constructor(options: IConnectionManagerOptions<ConnectionType>) {
		const { createConnection, generateId } = options

		const connections = new Map<ConnectionID, ConnectionType>()
		const closedListeners = new Map()

		function createId() {
			do {
				const id = generateId()
				if (!connections.has(id)) {
					return id
				}
				// eslint-disable-next-line
			} while (true)
		}

		function deleteConnection(connection: ConnectionType) {
			// 1. Remove "closed" listener.
			const closedListener = closedListeners.get(connection)
			closedListeners.delete(connection)
			connection.removeListener('closed', closedListener)

			// 2. Remove the Connection from the Map.
			connections.delete(connection.id)
		}

		this.createConnection = async () => {
			const id = createId()
			const connection = createConnection(id, {})

			// 1. Add the "closed" listener.
			function closedListener() {
				deleteConnection(connection)
			}
			closedListeners.set(connection, closedListener)
			connection.once('closed', closedListener)

			// 2. Add the Connection to the Map.
			connections.set(connection.id, connection)

			return connection
		}

		this.getConnection = (id) => {
			return connections.get(id) || null
		}

		this.getConnections = () => {
			return [...connections.values()]
		}
	}

	createConnection: () => Promise<ConnectionType>
	getConnection: (id: ConnectionID) => ConnectionType | null
	getConnections: () => ConnectionType[]

	toJSON() {
		return this.getConnections().map((connection) => connection.toJSON())
	}
}
