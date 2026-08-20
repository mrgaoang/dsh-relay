// node-datachannel in-process connection test (Node 20)
// Two PeerConnections in the same process, wired via onLocalDescription/onLocalCandidate
import nodeDataChannel from 'node-datachannel';

const ICE = process.env.NO_STUN ? [] : ['stun:stun.l.google.com:19302'];

let dc1 = null;
let dc2 = null;
let msg1 = null;
let msg2 = null;

const peer1 = new nodeDataChannel.PeerConnection('Peer1', { iceServers: ICE });
const peer2 = new nodeDataChannel.PeerConnection('Peer2', { iceServers: ICE });

peer1.onLocalDescription((sdp, type) => peer2.setRemoteDescription(sdp, type));
peer1.onLocalCandidate((candidate, mid) => peer2.addRemoteCandidate(candidate, mid));
peer2.onLocalDescription((sdp, type) => peer1.setRemoteDescription(sdp, type));
peer2.onLocalCandidate((candidate, mid) => peer1.addRemoteCandidate(candidate, mid));

peer2.onDataChannel((dc) => {
  dc2 = dc;
  dc2.onMessage((msg) => { msg2 = msg; });
  dc2.onOpen(() => dc2.sendMessage('Hello From Peer2'));
});
peer2.onIceStateChange((s) => {
  if (s === 'connected') console.log('peer2 iceState connected');
});

peer1.onIceStateChange((s) => {
  if (s === 'connected') console.log('peer1 iceState connected');
});

dc1 = peer1.createDataChannel('test');
dc1.onOpen(() => dc1.sendMessage('Hello from Peer1'));
dc1.onMessage((msg) => { msg1 = msg; });

const started = Date.now();
const deadline = started + 30_000;
const timer = setInterval(() => {
  const p1Open = dc1 && dc1.isOpen && dc1.isOpen();
  const p2Open = dc2 && dc2.isOpen && dc2.isOpen();
  const bothMsgs = msg1 !== null && msg2 !== null;
  const timedOut = Date.now() > deadline;
  if ((bothMsgs || timedOut) || (p1Open && p2Open && Date.now() > started + 20_000)) {
    clearInterval(timer);
    const pair1 = peer1.getSelectedCandidatePair();
    const pair2 = peer2.getSelectedCandidatePair();
    console.log(JSON.stringify({
      lib: 'node-datachannel',
      node: process.version,
      mode: ICE.length ? 'stun' : 'host',
      elapsedSec: ((Date.now() - started) / 1000).toFixed(1),
      timedOut,
      dc1Open: !!p1Open,
      dc2Open: !!p2Open,
      msg1: msg1 !== null ? String(msg1) : null,
      msg2: msg2 !== null ? String(msg2) : null,
      bothMsgs,
      peer1State: peer1.state(),
      peer1Ice: peer1.iceState(),
      peer2State: peer2.state(),
      peer2Ice: peer2.iceState(),
      selectedPair1: pair1 ? { local: pair1.local, remote: pair1.remote } : null,
      selectedPair2: pair2 ? { local: pair2.local, remote: pair2.remote } : null,
    }, null, 2));
    try { peer1.close(); } catch {}
    try { peer2.close(); } catch {}
    process.exit(0);
  }
}, 300);
