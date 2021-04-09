let startTime;
const connectButton = document.getElementById('connectButton');
const playButton = document.getElementById('playButton');
const pauseButton = document.getElementById('pauseButton');
const stopButton = document.getElementById('stopButton');

playButton.disabled = true;
pauseButton.disabled = true;
stopButton.disabled = true;

connectButton.addEventListener('click', async () => {
  connectButton.disabled = true;
  await startStream();
  playButton.disabled = false;
})

playButton.addEventListener('click', play);
pauseButton.addEventListener('click', pause);
stopButton.addEventListener('click', stopClick);

const remoteVideo = document.getElementById('remoteVideo');

const host = `http://${window.location.hostname}:3002`

remoteVideo.addEventListener('loadedmetadata', function() {
  console.log(`Remote video videoWidth: ${this.videoWidth}px,  videoHeight: ${this.videoHeight}px`);
});

remoteVideo.addEventListener('resize', () => {
  console.log(`Remote video size changed to ${remoteVideo.videoWidth}x${remoteVideo.videoHeight}`);
  // We'll use the first onsize callback as an indication that video has started
  // playing out.
  if (startTime) {
    const elapsedTime = window.performance.now() - startTime;
    console.log('Setup time: ' + elapsedTime.toFixed(3) + 'ms');
    startTime = null;
  }
});

let peerConnection = null;
let dataChannel = null;
const offerOptions = {
    offerToReceiveAudio: 1,
    offerToReceiveVideo: 1
};
async function startStream(streamId) {
  if (peerConnection) {
    stopStream()
  }

  if (streamId === undefined) {
    const list = await listStreams(host)
    if (!list || list.length === 0) throw new Error('No streams')
    streamId = list[0].streamId
  }
  peerConnection = new RTCPeerConnection({})
  dataChannel = peerConnection.createDataChannel('Phaneron channel')
  peerConnection.addEventListener('icecandidate', e => onIceCandidate(peerConnection, e))
  peerConnection.addEventListener('track', gotRemoteStream)
  dataChannel.addEventListener('open', event => {
    console.log('data channel open')
  })
  const offer = await peerConnection.createOffer(offerOptions)
  await peerConnection.setLocalDescription(offer)
  console.log('Sending offer:', offer)
  const offerResponse = await fetch(`${host}/streams/${streamId}/connections`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(offer)
  })
  console.log('Response is:', offerResponse)
  const remoteOffer = await offerResponse.json()
  console.log(remoteOffer)
  await peerConnection.setRemoteDescription(remoteOffer)
  console.log(peerConnection.getRemoteStreams())
  setTimeout(async () => {
    const stats = await peerConnection.getStats();
    stats.forEach(stat => {
      if (!(stat.type === 'inbound-rtp' && stat.kind === 'video' || stat.kind === 'audio')) {
        return;
      }
      const codec = stats.get(stat.codecId);
      if (codec && stat.kind === 'video') {
        document.getElementById('videoCodec').innerText = 'Video codec: ' + codec.mimeType +
            ' ' + (codec.sdpFmtpLine ? codec.sdpFmtpLine + ' ' : '') +
            ', payloadType=' + codec.payloadType + '.';
      }
      if (codec && stat.kind === 'audio') {
        document.getElementById('audioCodec').innerText = 'Audio codec: ' + codec.mimeType +
            ' ' + (codec.sdpFmtpLine ? codec.sdpFmtpLine + ' ' : '') +
            ', payloadType=' + codec.payloadType + ', clockRate=' + codec.clockRate + 
            ', channels=' + codec.channels + '.';
      }
      
    });
  }, 1000);

}

function stopStream() {
  peerConnection.close()
  peerConnection = null
}

async function listStreams () {
  const rawConsumersList = await fetch(`${host}/streams`, {
    method: 'GET'
  });
  const consumersList = await rawConsumersList.json();

  return consumersList
}

async function onIceCandidate(pc, event) {
  console.log('onIceCandidate:', event)
  // try {
  //   await (getOtherPc(pc).addIceCandidate(event.candidate));
  //   onAddIceCandidateSuccess(pc);
  // } catch (e) {
  //   onAddIceCandidateError(pc, e);
  // }
  // console.log(`${getName(pc)} ICE candidate:\n${event.candidate ? event.candidate.candidate : '(null)'}`);
}

function gotRemoteStream(e) {
  if (remoteVideo.srcObject !== e.streams[0]) {
    remoteVideo.srcObject = e.streams[0];
    console.log('pc2 received remote stream');
  }
}

function play() {
  console.log('Play button!');
  dataChannel.send("PLAY");
  pauseButton.disabled = false;
  stopButton.disabled = false;
}

function pause() {
  console.log('Pause button');
  dataChannel.send("PAUSE");
}

function stopClick() {
  console.log('Pause button');
  dataChannel.send("STOP");
}