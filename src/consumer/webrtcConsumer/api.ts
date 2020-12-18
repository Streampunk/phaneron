import Koa from 'koa'
import * as _ from 'koa-route'
import { RTCPeerConnection } from 'wrtc'
import ConnectionManager from './connections/connectionManager'
import WebRTCConnection from './connections/webRTCConnection'

export default function mountConnectionsApi(
	kapp: Koa<Koa.DefaultState, Koa.DefaultContext>,
	connectionManager: ConnectionManager<WebRTCConnection<RTCPeerConnection>>,
	prefix: string = ''
) {
	kapp.use(_.get(`${prefix}/connections`, (ctx) => (ctx.body = connectionManager.getConnections())))
	kapp.use(
		_.post(`${prefix}/connections`, async (ctx) => {
			try {
				const connection = await connectionManager.createConnection()
				ctx.body = connection
			} catch (error) {
				console.error(error)
				ctx.status = 500
			}
		})
	)
	kapp.use(
		_.delete(`${prefix}/connections/:id`, (ctx, params) => {
			const { id } = params
			const connection = connectionManager.getConnection(id)
			if (!connection) {
				ctx.status = 404
				return
			}
			connection.close()
			ctx.body = connection
		})
	)
	kapp.use(
		_.get(`${prefix}/connections/:id`, (ctx, id) => {
			const connection = connectionManager.getConnection(id)
			if (!connection) {
				ctx.status = 404
				return
			}
			ctx.body = connection
		})
	)
	kapp.use(
		_.get(`${prefix}/connections/:id/local-description`, (ctx, id) => {
			const connection = connectionManager.getConnection(id)
			if (!connection) {
				ctx.status = 404
				return
			}
			ctx.body = connection.toJSON().localDescription
		})
	)
	kapp.use(
		_.get(`${prefix}/connections/:id/remote-description`, (ctx, id) => {
			const connection = connectionManager.getConnection(id)
			if (!connection) {
				ctx.status = 404
				return
			}
			ctx.body = connection.toJSON().remoteDescription
		})
	)
	kapp.use(
		_.post(`${prefix}/connections/:id/remote-description`, async (ctx, id) => {
			const connection = connectionManager.getConnection(id)
			if (!connection) {
				ctx.status = 404
				return
			}
			try {
				await connection.applyAnswer(ctx.request.body as RTCSessionDescriptionInit)
				ctx.body = connection.toJSON().remoteDescription
			} catch (error) {
				ctx.status = 400
			}
		})
	)
}
