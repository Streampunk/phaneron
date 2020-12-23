import { gql } from 'apollo-server'

export default gql`
	"""
	A channel is an individual composition of various sources, layed out on different layers
	"""
	type Channel {
		id: ID!
		number: Int!
		videoFormat: VideoFormat!
		layers: [Layer!]!
	}

	"""
	A producer is a media stream source that will produce media when not paused
	"""
	type Producer {
		sourceId: ID!
		format: VideoFormat!
		paused: Boolean!
	}

	type Mixer {
		dupa: String
	}

	"""
	A layer is a part of the channel, that can have a foreground and a background. The background can play
	automatically, if the foreground is empty.
	"""
	type Layer {
		foreground: Producer
		background: Producer
		autoPlay: Boolean!
		mixer: Mixer!
	}

	"""
	A video format is a specification of the audio & video format that will be produced by a Channel
	"""
	type VideoFormat {
		name: String!
		fields: Int!
		width: Int!
		height: Int!
		squareWidth: Int!
		squareHeight: Int!
		timescale: Float!
		duration: Int!
		audioSampleRate: Int!
		audioChannels: Int!
	}

	type Query {
		channels: [Channel]!
		videoFormats: [VideoFormat]!
	}
`
