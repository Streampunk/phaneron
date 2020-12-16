# Phaneron

Clusterable, accelerated and cloud-fit video server, both pre-assembled and in kit form. Welcome to a hackable vision mixing video server that is designed to support HD/SD/HDR/UHD out-of-the-box. 

A contribution to the democratization of professional video and graphics production.

### Concept

With phaneron, you have all the pieces necessary to use a gaming-style PC - with a multi-core CPU and a competant GPU - to build multi-layer, multi-channel video servers using Node.JS. Or why not go virtual - with a vGPU - in the cloud? Entirely configured in software, choose from:

* _producers_ - file (via FFmpeg), stream (via FFmpeg), live SDI (via Blackmagic), HTTP(S) from another phaneron
* _mixers_ and _compositors_ - mix and composite video, all written using GPU-accelerated floating-point maths 
* _consumers_ - outputs including SDI (via Blackmagic), files (vai FFmpeg), streams (via FFmpeg), HTTP(S) to another phaneron

All the bits that need to go super-fast are written as native bindings - such as to FFmpeg/libav - or exposed as editable OpenCL functions. You can write your GPU acceleration from within node source code! An extensible library of accelerated functions is provided for broadcast applications, including:

* colour space conversions - YUV to RGB and back, BT.709 to BT.2020 and back, support for Adobe RGB, apply gamma functions 
* de-interlacing - turn 1080i50 inputs into 1080p25 or 1080p50 on the GPU, and vice versa
* bit packing and unpacking - floating point to/from 8/10-bit raw, including the v210 bit-packed format commonly used on SDI cards 

As an example of what could be hacked together with this server, a subset of the CasparCG AMCP protocol has been implemented.

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

***tbd***
## AMCP support

Details of supported commands and how to use them.

***tbd***
## License

(c) 2020 Streampunk Media Ltd 

GPL v3 or later. 

License chosen is because the beamcoder library is linked to phaneron and uses a static build of FFmpeg that is GPL v3 or later. 

Note: Technically, phaneron could be linked with a version of FFmpeg that is not GPL. Practically, this has associated maintenance, takes time and has a cost.
