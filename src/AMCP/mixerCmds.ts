/*
  Phaneron - Clustered, accelerated and cloud-fit video server, pre-assembled and in kit form.
  Copyright (C) 2020 Streampunk Media Ltd.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
  https://www.streampunk.media/ mailto:furnace@streampunk.media
  14 Ormiscaig, Aultbea, Achnasheen, IV22 2JJ  U.K.
*/

import { CmdList, CmdSet } from './commands'
import { ChanLayer } from '../chanLayer'
import { Channel } from '../channel'

export class MixerCmds implements CmdList {
	private readonly channels: Array<Channel>

	constructor(channels: Array<Channel>) {
		this.channels = channels
	}

	list(): CmdSet {
		return {
			group: 'MIXER',
			entries: [
				{ cmd: 'ANCHOR', fn: this.anchor.bind(this) },
				{ cmd: 'FILL', fn: this.fill.bind(this) },
				{ cmd: 'ROTATION', fn: this.rotation.bind(this) },
				{ cmd: 'VOLUME', fn: this.volume.bind(this) }
			]
		}
	}

	/**
	 * Changes the anchor point of the specified layer, or returns the current values if no arguments are given.
	 */
	async anchor(chanLay: ChanLayer, params: string[]): Promise<boolean> {
		if (!chanLay.valid) return Promise.resolve(false)
		return this.channels[chanLay.channel - 1].anchor(chanLay, params)
	}

	/**
	 * Scales/positions the video stream on the specified layer.
	 * The concept is quite simple; it comes from the ancient DVE machines like ADO.
	 * Imagine that the screen has a size of 1x1 (not in pixel, but in an abstract measure).
	 * Then the coordinates of a full size picture is 0 0 1 1, which means
	 *   left edge is at coordinate 0, top edge at coordinate 0,
	 *   width full size = 1, height full size = 1.
	 * If you want to crop the picture on the left side (for wipe left to right), you set the
	 * left edge to full right => 1 and the width to 0. So this give you the start-coordinates of 1 0 0 1.
	 * End coordinates of any wipe are always the full picture 0 0 1 1.
	 */
	async fill(chanLay: ChanLayer, params: string[]): Promise<boolean> {
		if (!chanLay.valid) return Promise.resolve(false)
		return this.channels[chanLay.channel - 1].fill(chanLay, params)
	}

	/**
	 * Returns or modifies the angle of which a layer is rotated by (clockwise degrees) around the point specified by MIXER ANCHOR.
	 */
	async rotation(chanLay: ChanLayer, params: string[]): Promise<boolean> {
		if (!chanLay.valid) return Promise.resolve(false)
		return this.channels[chanLay.channel - 1].rotation(chanLay, params)
	}

	async volume(chanLay: ChanLayer, params: string[]): Promise<boolean> {
		if (!chanLay.valid) return Promise.resolve(false)
		return this.channels[chanLay.channel - 1].volume(chanLay, params)
	}
}
