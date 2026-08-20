// node-datachannel standalone gather test (Node 20)
// Usage: node ndc-gather.mjs [stun|host]
import nodeDataChannel from 'node-datachannel';

const mode = process.argv[2] || 'stun';

const iceServers = mode === 'host' ? [] : ['stun:stun.l.google.com:19302'];

const candidates = [];
let gatheringDone = false;

const pc = new nodeDataChannel.PeerConnection('GatherPC', { iceServers });

pc.onLocalCandidate((candidate, mid) => {
  candidates.push(candidate);
});

pc.onGatheringStateChange((state) => {
  if (state === 'complete') gatheringDone = true;
});

const dc = pc.createDataChannel('test');
dc.onOpen(() => {});

pc.setLocalDescription('offer');

const started = Date.now();
const deadline = started + 30_000;
const timer = setInterval(() => {
  const gs = pc.gatheringState();
  if (gatheringDone || gs === 'complete' || Date.now() > deadline) {
    clearInterval(timer);
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
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(JSON.stringify({
      lib: 'node-datachannel',
      node: process.version,
      mode,
      iceServers,
      gatheringState: pc.gatheringState(),
      timeout: Date.now() > deadline,
      elapsedSec: elapsed,
      total: candidates.length,
      host, srflx, prflx, relay, other,
      samples: candidates.slice(0, 4),
    }, null, 2));
    try { pc.close(); } catch {}
    process.exit(0);
  }
}, 250);
