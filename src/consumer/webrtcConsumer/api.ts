import Koa from 'koa'
import * as _ from 'koa-route'
import { ConsumerInfoExt } from './peerManager'

export default function mountConnectionsApi(
	kapp: Koa<Koa.DefaultState, Koa.DefaultContext>,
	consumers: Map<string, ConsumerInfoExt>,
	prefix: string = ''
) {
	kapp.use(_.get(`${prefix}/streams`, (ctx) => {
		ctx.body = JSON.stringify(Array.from(consumers.values()).map(c => ({ streamId: c.id, description: c.description})))
	}))
	kapp.use(_.get(`${prefix}/streams/:consumerId/connections`, (ctx, consumerId: string) => {
		const consumer = consumers.get(consumerId)
		if (!consumer) {
			ctx.status = 404
			return
		}
		ctx.body = consumer.connectionManager.getConnections()
	}))
	kapp.use(
		_.post(`${prefix}/streams/:consumerId/connections`, async (ctx, consumerId: string) => {
			try {
				const consumer = consumers.get(consumerId)
				if (!consumer) {
					ctx.status = 404
					return
				}
				const connection = await consumer.connectionManager.createConnection()
				console.log(connection)
				ctx.body = connection
			} catch (error) {
				console.error(error)
				ctx.status = 500
			}
		})
	)
	kapp.use(
		_.delete(`${prefix}/streams/:consumerId/connections/:id`, (ctx, consumerId: string, id: string) => {
			const consumer = consumers.get(consumerId)
			if (!consumer) {
				ctx.status = 404
				return
			}
			const connection = consumer.connectionManager.getConnection(id)
			if (!connection) {
				ctx.status = 404
				return
			}
			connection.close()
			ctx.body = connection
		})
	)
	kapp.use(
		_.get(`${prefix}/streams/:consumerId/connections/:id`, (ctx, consumerId: string, id: string) => {
			const consumer = consumers.get(consumerId)
			if (!consumer) {
				ctx.status = 404
				return
			}
			const connection = consumer.connectionManager.getConnection(id)
			if (!connection) {
				ctx.status = 404
				return
			}
			ctx.body = connection
		})
	)
	kapp.use(
		_.get(`${prefix}/streams/:consumerId/connections/:id/local-description`, (ctx, consumerId: string, id: string) => {
			const consumer = consumers.get(consumerId)
			if (!consumer) {
				ctx.status = 404
				return
			}
			const connection = consumer.connectionManager.getConnection(id)
			if (!connection) {
				ctx.status = 404
				return
			}
			ctx.body = connection.toJSON().localDescription
		})
	)
	kapp.use(
		_.get(`${prefix}/streams/:consumerId/connections/:id/remote-description`, (ctx, consumerId: string, id: string) => {
			const consumer = consumers.get(consumerId)
			if (!consumer) {
				ctx.status = 404
				return
			}
			const connection = consumer.connectionManager.getConnection(id)
			if (!connection) {
				ctx.status = 404
				return
			}
			ctx.body = connection.toJSON().remoteDescription
		})
	)
	kapp.use(
		_.post(`${prefix}/streams/:consumerId/connections/:id/remote-description`, async (ctx, consumerId: string, id: string) => {
			const consumer = consumers.get(consumerId)
			if (!consumer) {
				ctx.status = 404
				return
			}
			const connection = consumer.connectionManager.getConnection(id)
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
