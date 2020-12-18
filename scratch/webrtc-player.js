const TIME_TO_HOST_CANDIDATES = 3000;  // NOTE(mroberts): Too long.

class ConnectionClient {
  constructor(options = {}) {
    options = {
      RTCPeerConnection: window.RTCPeerConnection,
      clearTimeout,
      host: '',
      prefix: '.',
      setTimeout,
      timeToHostCandidates: TIME_TO_HOST_CANDIDATES,
      ...options
    };

    const {
      RTCPeerConnection,
      prefix,
      host
    } = options;

    this.createConnection = async (options = {}) => {
      options = {
        beforeAnswer() {},
        stereo: false,
        ...options
      };

      const {
        beforeAnswer,
        stereo
      } = options;

      const response1 = await fetch(`${host}${prefix}/connections`, {
        method: 'POST'
      });

      const remotePeerConnection = await response1.json();
      const { id } = remotePeerConnection;

      const localPeerConnection = new RTCPeerConnection({
        sdpSemantics: 'unified-plan'
      });

      // NOTE(mroberts): This is a hack so that we can get a callback when the
      // RTCPeerConnection is closed. In the future, we can subscribe to
      // "connectionstatechange" events.
      localPeerConnection.close = function() {
        fetch(`${host}${prefix}/connections/${id}`, { method: 'delete' }).catch(() => {});
        return RTCPeerConnection.prototype.close.apply(this, arguments);
      };

      try {
        await localPeerConnection.setRemoteDescription(remotePeerConnection.localDescription);

        await beforeAnswer(localPeerConnection);

        const originalAnswer = await localPeerConnection.createAnswer();
        const updatedAnswer = new RTCSessionDescription({
          type: 'answer',
          sdp: stereo ? enableStereoOpus(originalAnswer.sdp) : originalAnswer.sdp
        });
        await localPeerConnection.setLocalDescription(updatedAnswer);

        await fetch(`${host}${prefix}/connections/${id}/remote-description`, {
          method: 'POST',
          body: JSON.stringify(localPeerConnection.localDescription),
          headers: {
            'Content-Type': 'application/json'
          }
        });

        return localPeerConnection;
      } catch (error) {
        localPeerConnection.close();
        throw error;
      }
    };
  }
}

function enableStereoOpus(sdp) {
  return sdp.replace(/a=fmtp:111/, 'a=fmtp:111 stereo=1\r\na=fmtp:111');
}

const connectionClient = new ConnectionClient({ host: 'http://localhost:3002', prefix: ''});
let peerConnection = null;
async function startStream () {
    peerConnection = await connectionClient.createConnection({ beforeAnswer });
}
function stopStream () {
    peerConnection.close()
    peerConnection = null
}

async function beforeAnswer(peerConnection) {
	  const videoElm = document.getElementById('remoteVideo');
  
    const remoteStream = new MediaStream(peerConnection.getReceivers().map(receiver => receiver.track));
    videoElm.srcObject = remoteStream;

    console.log('configured video element')
  
    // NOTE(mroberts): This is a hack so that we can get a callback when the
    // RTCPeerConnection is closed. In the future, we can subscribe to
    // "connectionstatechange" events.
    const { close } = peerConnection;
    peerConnection.close = function() {
        videoElm.srcObject = null;
  
      return close.apply(this, arguments);
    };
}
