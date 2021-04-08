let startTime;
const remoteVideo = document.getElementById('remoteVideo');

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
const offerOptions = {
    offerToReceiveAudio: 1,
    offerToReceiveVideo: 1
};
async function startStream(host, streamId) {
  if (peerConnection) {
    stopStream()
  }

  if (streamId === undefined) {
    const list = await listStreams(host)
    if (!list || list.length === 0) throw new Error('No streams')
    streamId = list[0].streamId
  }
  peerConnection = new RTCPeerConnection({})
  peerConnection.addEventListener('icecandidate', e => onIceCandidate(peerConnection, e))
  peerConnection.addEventListener('track', gotRemoteStream)
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
}

function stopStream() {
  peerConnection.close()
  peerConnection = null
}

async function listStreams (host) {
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