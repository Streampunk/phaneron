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

export interface ChanLayer {
	valid: boolean
	channel: number
	layer: number
}

export type StreamParams = {
	audio?: number[]
	video?: number[]
}

export type TransitionParams = {
	type: 'cut' | 'dissolve' | 'wipe'
	length: number
	url?: string
	streams?: StreamParams
}

export interface LoadParams {
	url: string
	layer: number
	channel?: number
	loop?: boolean
	preview?: boolean
	autoPlay?: boolean
	streams?: StreamParams
	seek?: number
	length?: number
	transition?: TransitionParams
}
