import { ApolloServer } from 'apollo-server'
import { Channel } from '../channel'
import { VideoFormat, VideoFormats } from '../config'
import typeDefs from './schema'

const model: {
	channels: Channel[]
	videoFormats: VideoFormat[]
} = {
	channels: [],
	videoFormats: []
}

const resolvers = {
	Query: {
		channels: () => [], // (parent, args, context, info) => [],
		videoFormats: () => [] // (parent, args, context, info) => []
	}
}

const server = new ApolloServer({ typeDefs, resolvers })

export async function start(channels: Channel[]): Promise<string> {
	model.channels = channels
	model.videoFormats = new VideoFormats().list()
	const { url } = await server.listen()
	return `🚀  GraphQL Server ready at ${url}`
}

export async function stop(): Promise<string> {
	await server.stop()
	return `GraphQL Server shut down.`
}
