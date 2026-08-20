// 打洞成功率测试:连续 N 轮,统计 connected 次数
// 用法: node demo/punch-rate-test.mjs a|b [rounds]
// 需 relay 在 ws://<RELAY_HOST>:13445
import * as dc from "node-datachannel";
import WebSocket from "ws";

const role = process.argv[2];
const ROUNDS = Number(process.argv[3] || 5);
const RELAY = process.env.RELAY || "ws://<RELAY_HOST>:13445";
const STUN = process.env.DSH_STUN || "stun:stun.l.google.com:19302";

let success = 0, total = 0;

function runRound(round) {
  return new Promise((resolve) => {
    total++;
    const deviceId = `rate-${role}-${round}`;
    const peerId = `rate-${role === "a" ? "b" : "a"}-${round}`;
    const ws = new WebSocket(RELAY);
    const send = (o) => ws.send(JSON.stringify(o));
    const pc = new dc.PeerConnection(`Rate-${role}-${round}`, {
      iceServers: [STUN], enableIceTcp: true, maxMessageSize: 256 * 1024
    });
    let dc1 = null, done = false;
    const finish = (ok, why) => {
      if (done) return; done = true;
      if (ok) success++;
      console.log(`  第${round}轮: ${ok ? "✅ 直连成功" : "❌ 失败"} (${why}) [${success}/${total}]`);
      try { ws.close(); } catch {}
      try { pc.close(); } catch {}
      resolve();
    };
    const timer = setTimeout(() => finish(false, "超时"), 20000);

    pc.onIceStateChange((s) => {
      if (s === "connected" || s === "completed") { clearTimeout(timer); finish(true, `iceState=${s}`); }
      if (s === "failed") { clearTimeout(timer); finish(false, "iceState=failed"); }
    });
    pc.onLocalDescription((sdp, type) => send({ type: "relay", to: peerId, payload: { kind: "sdp", data: sdp, type } }));
    pc.onLocalCandidate((candidate, mid) => send({ type: "relay", to: peerId, payload: { kind: "candidate", data: { candidate, mid } } }));

    ws.on("open", () => send({ type: "register", deviceId, name: deviceId }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "welcome" && role === "a") {
        dc1 = pc.createDataChannel("t");
        setTimeout(() => { try { pc.setLocalDescription("offer"); } catch {} }, 300);
      }
      if (m.type === "relay" && m.from === peerId) {
        const p = m.payload;
        if (p.kind === "sdp") {
          try {
            const sig = pc.signalingState();
            console.log(`[${role}] 轮${round} 收到SDP:${p.type}, signaling=${sig}`);
            pc.setRemoteDescription(p.data, p.type === "offer" ? "Offer" : "Answer");
            if (p.type === "offer" && role === "b") {
              // 等 remote description 就绪后生成 answer
              setTimeout(() => {
                try {
                  const st = pc.signalingState();
                  if (st === "have-remote-offer" || st === "stable") {
                    console.log(`[${role}] 生成 answer (signaling=${st})`);
                    pc.setLocalDescription("answer");
                  } else {
                    console.log(`[${role}] 跳过 answer (signaling=${st})`);
                  }
                } catch (e) { console.log(`[${role}] answer err:`, e.message); }
              }, 300);
            }
          } catch (e) { console.log(`[${role}] setRemote err:`, e.message); }
        } else if (p.kind === "candidate") {
          try { pc.addRemoteCandidate(p.data.candidate, p.data.mid); } catch {}
        }
      }
    });
    ws.on("error", () => finish(false, "ws error"));
  });
}

console.log(`[${role}] 打洞成功率测试开始, ${ROUNDS} 轮`);
for (let i = 1; i <= ROUNDS; i++) {
  await runRound(i);
  await new Promise(r => setTimeout(r, 1500));
}
console.log(`[${role}] 结果: ${success}/${total} 成功 (${Math.round(success/total*100)}%)`);
process.exit(0);
