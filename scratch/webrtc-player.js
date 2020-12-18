class ConnectionClient {
  constructor(options = {}) {
    this.options = {
      host: '',
      ...options
    };
  }

  async listStreams() {
    const { host } = this.options;

    const rawConsumersList = await fetch(`${host}/streams`, {
      method: 'GET'
    });
    const consumersList = await rawConsumersList.json();

    return consumersList
  }

  async createConnection(streamId, options = {}) {
    options = {
      beforeAnswer() { },
      stereo: false,
      ...options
    };

    const { host } = this.options;

    const {
      beforeAnswer,
      stereo
    } = options;

    // const rawConsumersList = await fetch(`${host}/streams`, {
    //   method: 'GET'
    // });
    // const consumersList = await rawConsumersList.json();

    // if (consumersList.length === 0) {
    //   throw new Error('No consumers')
    // }

    // const streamId = consumersList[0].streamId

    const response1 = await fetch(`${host}/streams/${streamId}/connections`, {
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
    localPeerConnection.close = function () {
      fetch(`${host}/streams/${streamId}/connections/${id}`, { method: 'delete' }).catch(() => { });
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

      await fetch(`${host}/streams/${streamId}/connections/${id}/remote-description`, {
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

function enableStereoOpus(sdp) {
  return sdp.replace(/a=fmtp:111/, 'a=fmtp:111 stereo=1\r\na=fmtp:111');
}
