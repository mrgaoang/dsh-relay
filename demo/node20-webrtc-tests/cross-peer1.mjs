// Cross-host WebRTC test: Mac side (behind home NAT).
// Usage: node cross-peer1.mjs <cloud-ip>
import nodeDataChannel from 'node-datachannel';

const CLOUD = process.argv[2] || '<RELAY_HOST>';
const BUS = `http://${CLOUD}:8123`;

const candidates = [];
const pc = new nodeDataChannel.PeerConnection('Peer1', {
  iceServers: ['stun:stun.l.google.com:19302'],
});

pc.onLocalCandidate((candidate, mid) => {
  candidates.push(candidate);
  post('peer2', { kind: 'candidate', candidate, mid });
});
pc.onIceStateChange((s) => console.log('P1 iceState:', s));

let dc1 = null;
let gotReply = null;
dc1 = pc.createDataChannel('test');
dc1.onOpen(() => {
  console.log('P1 dc open, sending...');
  dc1.sendMessage('hello-from-mac');
});
dc1.onMessage((msg) => {
  gotReply = String(msg);
  console.log('P1 RECV:', gotReply);
});

function post(to, msg) {
  fetch(`${BUS}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, msg }),
  }).catch((e) => console.log('post err', String(e)));
}

// offer
pc.setLocalDescription('offer');
post('peer2', { kind: 'description', sdp: pc.localDescription().sdp, type: 'offer' });

const started = Date.now();
let since = 0;
const timer = setInterval(async () => {
  try {
    const r = await fetch(`${BUS}/recv?peer=peer1&since=${since}`);
    const { msgs, since: s } = await r.json();
    since = s;
    for (const m of msgs) {
      if (m.kind === 'description') {
        pc.setRemoteDescription(m.sdp, m.type);
      } else if (m.kind === 'candidate') {
        pc.addRemoteCandidate(m.candidate, m.mid);
      }
    }
    const done = gotReply !== null && gotReply.startsWith('reply-from-cloud');
    if (done || Date.now() - started > 120000) {
      clearInterval(timer);
      const pair = pc.getSelectedCandidatePair();
      console.log('RESULT:', JSON.stringify({
        side: 'mac-nat',
        node: process.version,
        state: pc.state(),
        ice: pc.iceState(),
        gathering: pc.gatheringState(),
        timedOut: Date.now() - started > 120000,
        candidates: candidates.length,
        dcOpen: !!(dc1 && dc1.isOpen && dc1.isOpen()),
        gotReply,
        selectedPair: pair ? { local: pair.local, remote: pair.remote } : null,
      }, null, 2));
      setTimeout(() => process.exit(0), 500);
    }
  } catch (e) {
    console.log('poll err', String(e));
  }
}, 300);
