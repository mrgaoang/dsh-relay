// Cross-host WebRTC test: Tencent-cloud side.
// Runs: HTTP signaling bus (port 8123) + WebRTC peer2 (answerer).
// Usage: node cross-relay.mjs
import http from 'http';
import nodeDataChannel from 'node-datachannel';

const PORT = 8123;
const queues = { peer1: [], peer2: [] };
const index = { peer1: 0, peer2: 0 };

// ---------- signaling bus ----------
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      if (req.method === 'POST' && req.url.startsWith('/send')) {
        const { to, msg } = JSON.parse(body);
        queues[to].push(msg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, qlen: queues[to].length }));
      } else if (req.method === 'GET' && req.url.startsWith('/recv')) {
        const u = new URL(req.url, 'http://x');
        const peer = u.searchParams.get('peer');
        let since = parseInt(u.searchParams.get('since') || '0', 10);
        const q = queues[peer];
        const msgs = q.slice(since);
        index[peer] = q.length;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ msgs, since: q.length }));
      } else {
        res.writeHead(404); res.end('nf');
      }
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`signaling bus on :${PORT}`);
});

// ---------- WebRTC peer2 ----------
const candidates = [];
const pc = new nodeDataChannel.PeerConnection('Peer2', {
  iceServers: ['stun:stun.l.google.com:19302'],
});

pc.onLocalCandidate((candidate, mid) => {
  candidates.push(candidate);
  post('peer1', { kind: 'candidate', candidate, mid });
});

let dc2 = null;
pc.onDataChannel((dc) => {
  dc2 = dc;
  dc2.onMessage((msg) => {
    console.log('P2 RECV:', String(msg));
    dc2.sendMessage('reply-from-cloud:' + String(msg));
  });
  dc2.onOpen(() => console.log('P2 dc open'));
});
pc.onIceStateChange((s) => console.log('P2 iceState:', s));

function post(to, msg) {
  fetch(`http://127.0.0.1:${PORT}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, msg }),
  }).catch((e) => console.log('post err', String(e)));
}

// ---------- poll signaling for peer2 ----------
const started = Date.now();
let since = 0;
const timer = setInterval(async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/recv?peer=peer2&since=${since}`);
    const { msgs, since: s } = await r.json();
    since = s;
    for (const m of msgs) {
      if (m.kind === 'description') {
        pc.setRemoteDescription(m.sdp, m.type);
        if (m.type === 'offer') {
          pc.setLocalDescription('answer');
        }
      } else if (m.kind === 'candidate') {
        pc.addRemoteCandidate(m.candidate, m.mid);
      }
    }
    if (pc.state() === 'connected' || Date.now() - started > 120000) {
      clearInterval(timer);
      const pair = pc.getSelectedCandidatePair();
      console.log('RESULT:', JSON.stringify({
        side: 'cloud',
        node: process.version,
        state: pc.state(),
        ice: pc.iceState(),
        gathering: pc.gatheringState(),
        timedOut: Date.now() - started > 120000,
        candidates: candidates.length,
        dcOpen: !!(dc2 && dc2.isOpen && dc2.isOpen()),
        selectedPair: pair ? { local: pair.local, remote: pair.remote } : null,
      }, null, 2));
      setTimeout(() => process.exit(0), 500);
    }
  } catch (e) {
    console.log('poll err', String(e));
  }
}, 300);
