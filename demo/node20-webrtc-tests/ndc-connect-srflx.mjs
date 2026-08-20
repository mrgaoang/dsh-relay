// node-datachannel srflx-only connect test (Node 20)
// Two in-process peers, but ONLY srflx candidates are exchanged (host filtered out).
// Forces the data path through the real public mapping (NAT hairpin) instead of LAN host candidates.
import nodeDataChannel from 'node-datachannel';

const ICE = ['stun:stun.l.google.com:19302'];

let dc1 = null, dc2 = null;
let msg1 = null, msg2 = null;
let fwd1 = 0, fwd2 = 0, skip1 = 0, skip2 = 0;

const peer1 = new nodeDataChannel.PeerConnection('Peer1', { iceServers: ICE });
const peer2 = new nodeDataChannel.PeerConnection('Peer2', { iceServers: ICE });

peer1.onLocalDescription((sdp, type) => peer2.setRemoteDescription(sdp, type));
peer1.onLocalCandidate((candidate, mid) => {
  if (candidate.includes('typ srflx')) { fwd1++; peer2.addRemoteCandidate(candidate, mid); }
  else skip1++;
});
peer2.onLocalDescription((sdp, type) => peer1.setRemoteDescription(sdp, type));
peer2.onLocalCandidate((candidate, mid) => {
  if (candidate.includes('typ srflx')) { fwd2++; peer1.addRemoteCandidate(candidate, mid); }
  else skip2++;
});

peer2.onDataChannel((dc) => {
  dc2 = dc;
  dc2.onMessage((m) => { msg2 = m; });
  dc2.onOpen(() => dc2.sendMessage('Hello From Peer2'));
});
peer2.onIceStateChange((s) => { if (s === 'connected') console.log('peer2 connected'); });
peer1.onIceStateChange((s) => { if (s === 'connected') console.log('peer1 connected'); });

dc1 = peer1.createDataChannel('test');
dc1.onOpen(() => dc1.sendMessage('Hello from Peer1'));
dc1.onMessage((m) => { msg1 = m; });

const started = Date.now();
const deadline = started + 30000;
const timer = setInterval(() => {
  const p1Open = dc1 && dc1.isOpen && dc1.isOpen();
  const p2Open = dc2 && dc2.isOpen && dc2.isOpen();
  const bothMsgs = msg1 !== null && msg2 !== null;
  const timedOut = Date.now() > deadline;
  if (bothMsgs || timedOut) {
    clearInterval(timer);
    const pair1 = peer1.getSelectedCandidatePair();
    const pair2 = peer2.getSelectedCandidatePair();
    console.log(JSON.stringify({
      lib: 'node-datachannel',
      node: process.version,
      mode: 'srflx-only (NAT hairpin)',
      elapsedSec: ((Date.now() - started) / 1000).toFixed(1),
      timedOut,
      fwdSrflx: { peer1: fwd1, peer2: fwd2 },
      skippedHost: { peer1: skip1, peer2: skip2 },
      dc1Open: !!p1Open,
      dc2Open: !!p2Open,
      bothMsgs,
      peer1Ice: peer1.iceState(),
      peer2Ice: peer2.iceState(),
      selectedPair1: pair1 ? { local: pair1.local, remote: pair1.remote } : null,
      selectedPair2: pair2 ? { local: pair2.local, remote: pair2.remote } : null,
    }, null, 2));
    try { peer1.close(); } catch {}
    try { peer2.close(); } catch {}
    process.exit(0);
  }
}, 300);
