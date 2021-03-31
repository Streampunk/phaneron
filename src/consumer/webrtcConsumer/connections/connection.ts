import { EventEmitter } from 'events'

/**
 * Lifted from: https://github.com/node-webrtc/node-webrtc-examples/
 */

export default class Connection extends EventEmitter {
	id: string
	state: 'open' | 'closed'

	constructor(id: string, _options: {}) {
		super()
		this.id = id
		this.state = 'open'
	}

	close() {
		this.state = 'closed'
		this.emit('closed')
	}

	toJSON() {
		return {
			id: this.id,
			state: this.state
		}
	}
}
