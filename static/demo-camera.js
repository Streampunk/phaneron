let startTime;
const connectButton = document.getElementById('connectButton'); 
const startButton = document.getElementById('startButton');
const muteButton = document.getElementById('muteButton');
const hangupButton = document.getElementById('hangupButton');

connectButton.addEventListener('click', async () => {
  connectButton.disabled = true;
  await startStream();
})
startButton.addEventListener('click', startLocal);
muteButton.addEventListener('click', handleMute);
hangupButton.addEventListener('click', hangup);
muteButton.disabled = true;
connectButton.disabled = true;
hangupButton.disabled = true;

const localVideo = document.getElementById('localVideo');
let localStream;

const host = `http://${window.location.hostname}:3002`

localVideo.addEventListener('loadedmetadata', function() {
  console.log(`Local video videoWidth: ${this.videoWidth}px,  videoHeight: ${this.videoHeight}px`);
});
localVideo.addEventListener('resize', () => {
  console.log(`Local video size changed to ${localVideo.videoWidth}x${localVideo.videoHeight}`);
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
    offerToReceiveAudio: 0,
    offerToReceiveVideo: 0
};

async function startLocal() {
  console.log('Requesting local stream');
  startButton.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio: true, video: { width: 1920, height: 1080 }});
    console.log('Received local stream');
    localVideo.srcObject = stream;
    localStream = stream;
    connectButton.disabled = false;
    muteButton.disabled = false;
    localStream.getAudioTracks()[0].enabled = false;
  } catch (e) {
    alert(`getUserMedia() error: ${e.name}`);
  }
}

function handleMute() { 
  if (!localStream) return;
  if (localStream.getAudioTracks()[0].enabled === true) {
    localStream.getAudioTracks()[0].enabled = false;
    muteButton.innerHTML = 'Un-mute';
  } else {
    localStream.getAudioTracks()[0].enabled = true;
    muteButton.innerHTML = 'Mute';
  }
}

async function startStream(streamId) {
  connectButton.disabled = true;
  hangupButton.disabled = false;
  if (peerConnection) {
    stopStream()
  }
  // if (streamId === undefined) {
  //   const list = await listStreams(host)
  //   if (!list || list.length === 0) throw new Error('No streams')
  //   streamId = list[0].streamId
  // }
  const videoTracks = localStream.getVideoTracks();
  const audioTracks = localStream.getAudioTracks();
  if (videoTracks.length > 0) {
    console.log(`Using video device: ${videoTracks[0].label}`);
  }
  if (audioTracks.length > 0) {
    console.log(`Using audio device: ${audioTracks[0].label}`);
  }

  peerConnection = new RTCPeerConnection({})
  // dataChannel = peerConnection.createDataChannel('Phaneron channel')
  peerConnection.addEventListener('icecandidate', e => onIceCandidate(peerConnection, e))
  // peerConnection.addEventListener('track', gotRemoteStream)
  // dataChannel.addEventListener('open', event => {
  //   console.log('data channel open')
  // })

  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
  console.log('Added local stream to peer connection');

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
  // console.log(peerConnection.getRemoteStreams())
  setTimeout(async () => {
    const stats = await peerConnection.getStats();
    stats.forEach(stat => {
      if (!(stat.type === 'outbound-rtp' && stat.kind === 'video' || stat.kind === 'audio')) {
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

// function gotRemoteStream(e) {
//   if (remoteVideo.srcObject !== e.streams[0]) {
//     remoteVideo.srcObject = e.streams[0];
//     console.log('pc2 received remote stream');
//   }
// }

function hangup() {
  console.log('Ending call')
  peerConnection.close();
  peerConnection = null;
  connectButton.disabled = false;
  hangupButton.disabled = true;
}