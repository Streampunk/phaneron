# Phaneron

Clusterable, accelerated and cloud-fit video server, both pre-assembled and in kit form. Welcome to a hackable vision mixing video server that is designed to support HD/SD/HDR/UHD out-of-the-box.

A contribution to the democratization of professional video and graphics production.

### Concept

With phaneron, you have all the pieces necessary to use a gaming-style PC - with a multi-core CPU and a competant GPU - to build multi-layer, multi-channel video servers using Node.JS. Or why not go virtual - with a vGPU - in the cloud? Entirely configured in software, choose from:

* _producers_ - file (via FFmpeg), stream (via FFmpeg), live SDI (via Blackmagic), HTTP(S) (from another phaneron) and ROUTE (from another channel)
* _processors_ - mix and composite video, all written using GPU-accelerated floating-point maths
* _consumers_ - outputs including SDI (via Blackmagic), files (vai FFmpeg), streams (via FFmpeg), HTTP(S) to another phaneron

All the bits that need to go super-fast are written as native bindings - such as to FFmpeg/libav - or exposed as editable OpenCL functions. You can write your GPU acceleration from within node source code! An extensible library of accelerated functions is provided for broadcast applications, including:

* colour space conversions - YUV to RGB and back, BT.709 to BT.2020 and back, support for Adobe RGB, apply gamma functions
* de-interlacing - turn 1080i50 inputs into 1080p25 or 1080p50 on the GPU, and vice versa
* bit packing and unpacking - floating point to/from 8/10-bit raw, including the v210 bit-packed format commonly used on SDI cards

As an example of what could be hacked together with this server, a [subset](#amcp-support) of the CasparCG AMCP protocol has been implemented.

### Vision

The endgame for this serer is illustrated in the diagram below.

![Phaneron Stack](/phaneron_stack.png)

From the bottom up:

* _hardware_ - use PC grade hardware, real or virtual, x86 or ARM, your choice of NVideo/AMB or Intel (good luck) GPU, dedicated hardware
* _operating system_ - Windows, Mac OS or Linux
* _native libraries_ - for fast processing, memory management and asychronous non-blocking multi-thread processing
* _node modules_ - exposed as Node.JS modules using Promise-based APIs
* _stream plumbing_ - plumbed together using reactive streams with redioactive, including across the network via HTTP/S (and RDMA in the data centre)
* _controller_ - its just Node Javascript code ... so can be combined with any other node package, including an AMCP controller, OSC, mqtt, websockets, GraphQL, etc..
* _frontend_ - build web tools or installed applications, with examples of access to raw RGB for ultra-low-latency local preview and MJPEG for wider-area output

Can it do 4k/8k - we'll let you know once we've finished testing it.

All contributions to building out this vision are welcome.

### What is the phaneron?

From the greek for visible or showable, we interpret the machine-based phaneron as a way to represent audio/visual worlds, real or fantasy, as filtered by sensory input. Use this phaneron to tell a story, paint a picture, or convey emotion.

## Getting started

### Prerequisites

Install a recent version of Node.JS - v12 or v14 are being used in development. Also, make sure git is installed and note that we prefer to use yarn as a package manager - although npm should also work.

Install the Blackmagic drivers - even if you don't want to use Blackmagic hardware. Yes - we know - we're working on it.

Make sure your system can build native modules using `node-gyp`. Check the prerequisites for your platform.

Phaneron uses beamcoder and naudiodon - check the prerequisites for your platform.

Set a system-wide environment variable `UV_THREADPOOL_SIZE` to a value greater than the number of CPU cores available, e.g. `32`.

### Installation

Clone the github project:

    git clone http://github.com/Streampunk/phaneron.git
    cd phaneron

Install the dependencies and build this typescript project (substitute `npm` for `yarn` if you prefer):

    yarn install
    yarn build

### First run

To run the example AMCP client, start a phaneron with:

    yarn start

Take a note of the OpenCL accelerator - is it using the expected GPU? Are there any other error messages?

At the prompt, try to play a file on channel 1 layer 1. As an example, the AMB file provided with CasparCG:

    AMCP> PLAY 1-1 AMB

If you have a Decklink card installed, you should see the file playing.

## Developing with phaneron

Details of how to `import * from 'phaneron'` and do stuff!

*tbd*

## AMCP support

Phanaron implements a subset of the AMCP protocol documented [here](https://github.com/CasparCG/help/wiki/AMCP-Protocol)

The commands currently supported are as follows:

### Basic Commands

#### LOADBG

_Syntax:_
```
LOADBG [video_channel:int]{-[layer:int]} [clip:string] {[loop:LOOP]} {SEEK [frame:int]} {LENGTH [frames:int]} {[auto:AUTO]}
```
Loads a producer in the background and prepares it for playout. If no `layer` is specified the default layer index will be used.

`clip` is a full path to a media file which will be parsed by available registered producer factories. If a successful match is found, the producer will be loaded into the background on the specified `video_channel` and `layer`.

`loop` will cause the clip to loop.

When playing and looping the clip will start at `frame`.

When playing and loop the clip will end after `frames` number of frames.

`auto` will cause the clip to automatically start when foreground clip has ended (without play). Note: only one clip can be queued to play automatically per layer.

_Examples:_
```
>> LOADBG 1-1 M:/MY_FILE.mxf
>> LOADBG 1-1 M:/MY_FILE.mxf LOOP SEEK 200 LENGTH 400 AUTO
```

#### LOAD

_Syntax:_
```
LOAD [video_channel:int]{-[layer:int]|-0} [clip:string] {"additional parameters"}
```
Loads a `clip` to the foreground and plays the first frame before pausing. If any clip is playing on the target foreground then this clip will be replaced.

See [LOADBG](#loadbg) for additional parameters

_Examples:_
```
>> LOAD 1-1 M:/MY_FILE.mxf
```

#### PLAY

_Syntax:_
```
PLAY [video_channel:int]{-[layer:int]|-0} {[clip:string]} {"additional parameters"}
```
Moves clip from background to foreground and starts playing it.

If additional parameters (see [LOADBG](#loadbg)) are provided then the provided `clip` will first be loaded to the background.

_Examples:_
```
>> PLAY 1-1
>> PLAY 1-1 M:/MYFILE.mxf
```

#### PAUSE

_Syntax:_
```
PAUSE [video_channel:int]{-[layer:int]|-0}
```
Pauses playback of the foreground clip on the specified `layer`. The [RESUME](#resume) command can be used to resume playback again.

Examples:
```
>> PAUSE 1-1
```

#### RESUME

_Syntax:_
```
RESUME [video_channel:int]{-[layer:int]|-0}
```
Resumes playback of a foreground clip previously paused with the [PAUSE](#pause) command.

_Examples:_
```
>> RESUME 1-1
```

#### STOP

_Syntax:_
```
STOP [video_channel:int]{-[layer:int]|-0}
```
Removes the foreground clip of the specified `layer`.

_Examples:_
```
>> STOP 1-1
```

#### CLEAR

_Syntax:_
```
CLEAR [video_channel:int]{-[layer:int]}
```
Removes all clips (both foreground and background) of the specified `layer`. If no layer is specified then all layers in the specified `video_channel` are cleared.

_Examples:_
```
>> CLEAR 1
```
...clears everything from the entire channel 1.
```
>> CLEAR 1-3
```
...clears only layer 3 of channel 1.

#### ADD

_Syntax:_
```
ADD [video_channel:int]{-[consumer_index:int]} [consumer:string] [parameters:string]
```
Adds a consumer to the specified `video_channel`. The string `consumer` will be parsed by the available consumer factories. If a successful match is found a consumer will be created and added to the video channel. Different consumers require different parameters, some examples are below. Consumers can alternatively be specified by updating the config class in the [index.ts](./src/index.ts) file.

Specifying `consumer_index` overrides the index that the consumer itself decides and can later be used with the [REMOVE](#remove) command to remove the consumer.

_Examples:_
```
>> ADD 1 SCREEN
>> ADD 1 DECKLINK 1
```

#### REMOVE

_Syntax:_
```
REMOVE [video_channel:int]{-[consumer_index:int]} {[parameters:string]}
```
Removes an existing consumer from `video_channel`. If `consumer_index` is given, the consumer will be removed via its id. If parameters are given instead, the consumer matching those parameters will be removed.

*Not yet implemented*

### Mixer Commands

#### MIXER FILL

_Syntax:_
```
MIXER [video_channel:int]{-[layer:int]|-0} FILL {[x:float] [y:float] [x-scale:float] [y-scale:float]}
```
Scales/positions the video stream on the specified layer. The concept is quite simple; it comes from the ancient DVE machines like ADO. Imagine that the screen has a size of 1x1 (not in pixel, but in an abstract measure). Then the coordinates of a full size picture is 0 0 1 1, which means left edge is at coordinate 0, top edge at coordinate 0, width full size = 1, heigh full size = 1.

If you want to crop the picture on the left side (for wipe left to right) You set the left edge to full right => 1 and the width to 0. So this give you the start-coordinates of 1 0 0 1.

End coordinates of any wipe are allways the full picture 0 0 1 1.

With the `FILL` command it can make sense to have values between 1 and 0, if you want to do a smaller window. If, for instance you want to have a window of half the size of your screen, you set with and height to 0.5. If you want to center it you set left and top edge to 0.25 so you will get the arguments 0.25 0.25 0.5 0.5

`x`
The new x position, 0 = left edge of monitor, 0.5 = middle of monitor, 1.0 = right edge of monitor. Higher and lower values allowed.
`y`
The new y position, 0 = top edge of monitor, 0.5 = middle of monitor, 1.0 = bottom edge of monitor. Higher and lower values allowed.
`x-scale`
The new x scale, 1 = 1x the screen width, 0.5 = half the screen width. Higher and lower values allowed. Negative values flips the layer.
`y-scale`
The new y scale, 1 = 1x the screen height, 0.5 = half the screen height. Higher and lower values allowed. Negative values flips the layer.
The positioning and scaling is done around the anchor point set by [MIXER ANCHOR](#mixer-anchor).

_Examples:_
```
>> MIXER 1-0 FILL 0.25 0.25 0.5 0.5
```

#### MIXER ANCHOR

_Syntax:_
```
MIXER [video_channel:int]{-[layer:int]|-0} ANCHOR {[x:float] [y:float]}
```
Changes the anchor point of the specified layer, or returns the current values if no arguments are given.

The anchor point is around which [MIXER FILL](#mixer-fill) and [MIXER ROTATION](#mixer-rotation) will be done from.

`x`
The x anchor point, 0 = left edge of layer, 0.5 = middle of layer, 1.0 = right edge of layer. Higher and lower values allowed.
`y`
The y anchor point, 0 = top edge of layer, 0.5 = middle of layer, 1.0 = bottom edge of layer. Higher and lower values allowed.

_Examples:_
```
>> MIXER 1-10 ANCHOR 0.5 0.6
```

#### MIXER ROTATION

_Syntax:_
```
MIXER [video_channel:int]{-[layer:int]|-0} ROTATION {[angle:float]}
```
Modifies the angle which a layer is rotated by (clockwise degrees) around the point specified by [MIXER ANCHOR](#mixer-anchor).

_Examples:_
```
>> MIXER 1-0 ROTATION 45
```

#### MIXER VOLUME

_Syntax:_
```
MIXER [video_channel:int]{-[layer:int]|-0} VOLUME {[volume:float]}
```
Changes the volume of the specified layer. 1.0 is the original volume, which can be attenuated or amplified.

_Examples:_
```
>> MIXER 1-0 VOLUME 1.5
```

## License

(c) 2020 Streampunk Media Ltd

GPL v3 or later.

License chosen is because the beamcoder library is linked to phaneron and uses a static build of FFmpeg that is GPL v3 or later.

Note: Technically, phaneron could be linked with a version of FFmpeg that is not GPL. Practically, this has associated maintenance, takes time and has a cost.
