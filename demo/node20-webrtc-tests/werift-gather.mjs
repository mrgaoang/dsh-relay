// werift candidate gather test (Node 20)
// Usage: node werift-gather.mjs [stun|host|multi] [waitSec]
import { RTCPeerConnection } from 'werift';

const mode = process.argv[2] || 'stun';
const waitSec = parseInt(process.argv[3] || '30', 10);

let iceServers;
if (mode === 'host') {
  iceServers = [];
} else if (mode === 'multi') {
  iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ];
} else {
  iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
}

const candidates = [];
const pc = new RTCPeerConnection({ iceServers });

pc.onIceCandidate.subscribe((candidate) => {
  if (candidate && candidate.candidate) {
    candidates.push(candidate.candidate);
  }
});

const dc = pc.createDataChannel('test');
dc.onOpen = () => {};

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

const started = Date.now();
const deadline = started + waitSec * 1000;

// poll iceGatheringState
const state = await new Promise((resolve) => {
  const timer = setInterval(() => {
    const gs = pc.iceGatheringState;
    if (gs === 'complete' || Date.now() > deadline) {
      clearInterval(timer);
      resolve(gs);
    }
  }, 250);
});

let host = 0, srflx = 0, prflx = 0, relay = 0, other = 0;
for (const c of candidates) {
  const m = c.match(/typ (\w+)/);
  const t = m ? m[1] : 'unknown';
  if (t === 'host') host++;
  else if (t === 'srflx') srflx++;
  else if (t === 'prflx') prflx++;
  else if (t === 'relay') relay++;
  else other++;
}

console.log(JSON.stringify({
  lib: 'werift',
  node: process.version,
  mode,
  gatheringState: state,
  timeout: Date.now() > deadline,
  elapsedSec: ((Date.now() - started) / 1000).toFixed(1),
  total: candidates.length,
  host, srflx, prflx, relay, other,
  samples: candidates.slice(0, 4),
}, null, 2));

pc.close();
process.exit(0);
