import fs from 'fs'
import path from 'path'

const MEDIA_DIR = 'media'

class AssetManager {
	public getAsset(clip: string): Promise<string> {
		const files = fs.readdirSync(MEDIA_DIR)

		if (clip.match(/^(?!file).*:\/\//i)) {
			return Promise.resolve(clip)
		}

		const exact_match = files.find((f) => f === clip)
		if (exact_match) {
			return Promise.resolve(path.join(MEDIA_DIR, exact_match))
		}

		const inexact_match = files.find((f) => f.toUpperCase() === clip.toUpperCase())
		if (inexact_match) {
			return Promise.resolve(path.join(MEDIA_DIR, inexact_match))
		}

		return Promise.reject(`Could not find clip ${clip}`)
	}
}

export const assetManager = new AssetManager()
