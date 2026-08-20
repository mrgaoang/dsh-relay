// werift 跨网络打洞测试:通过 relay 透传交换 SDP/candidates
// 用法: node demo/werift-relay.mjs <a|b>
import { RTCPeerConnection } from "werift";
import WebSocket from "ws";

const RELAY = process.env.RELAY || "ws://127.0.0.1:13445";
const STUN = process.env.STUN || "stun:stun.l.google.com:19302";
const role = process.argv[2];
const deviceId = `w-${role}`;
const peerId = `w-${role === "a" ? "b" : "a"}`;

const ws = new WebSocket(RELAY);
const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] });

function send(payload) { ws.send(JSON.stringify({ type: "relay", to: peerId, payload })); }

pc.onIceCandidate = (c) => { if (c) send({ kind: "candidate", data: c.toJSON() }); };
pc.on("iceConnectionStateChange", (s) => {
  console.log(`[${role}] iceState: ${s}`);
  if (s === "connected" || s === "completed") { console.log(`[${role}] ✅ P2P 直连!`); setTimeout(()=>process.exit(0),500); }
  if (s === "failed") { console.log(`[${role}] ❌ ICE 失败`); }
});
pc.on("connectionStateChange", (s) => { console.log(`[${role}] conn: ${s}`); if (s === "connected") setTimeout(()=>process.exit(0),500); });
pc.on("iceCandidate", (c) => { if (c) { console.log(`[${role}] 本地候选: ${c.address}:${c.port} type=${c.type}`); send({ kind: "candidate", data: c.toJSON() }); } });

ws.on("open", async () => { console.log(`[${role}] 信令已连接`);
  ws.send(JSON.stringify({ type: "register", deviceId, name: `werift-${role}` }));
  await new Promise(r => setTimeout(r, 500));
  if (role === "a") {
    const dc = pc.createDataChannel("t");
    dc.onopen = () => { console.log("[a] dc open"); dc.send("hi from a"); };
    dc.onmessage = (e) => console.log("[a] recv:", e.data.toString());
    // 先生成 offer 触发 gathering,再等 complete(候选含 srflx)后发送
    console.log("[a] 创建 DataChannel...");
    const offer = await pc.createOffer();
    console.log("[a] offer 已创建");
    await pc.setLocalDescription(offer);
    console.log("[a] localDescription 已设置,等待 gathering...");
    await waitGather();
    console.log("[a] gathering 完成");
    send({ kind: "sdp", data: pc.localDescription });
    console.log("[a] offer 已发送(候选就绪)");
  }
});

function waitGather(timeoutMs = 20000) {
  return new Promise((resolve) => {
    const check = () => {
      const gs = pc.iceGatheringState;
      if (gs === "complete") { clearInterval(timer); clearTimeout(to); resolve(); }
    };
    const timer = setInterval(check, 500);
    const to = setTimeout(() => { clearInterval(timer); resolve(); }, timeoutMs);
    check();
  });
}

ws.on("message", async (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "relay" && msg.from === peerId) {
    const p = msg.payload;
    if (p.kind === "sdp") {
      console.log(`[${role}] 收到 SDP: ${p.data.type}`);
      await pc.setRemoteDescription(p.data);
      if (p.data.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitGather();
        send({ kind: "sdp", data: pc.localDescription });
        console.log(`[${role}] answer 已发送(候选就绪)`);
      }
    } else if (p.kind === "candidate") {
      console.log(`[${role}] 收到候选`);
      await pc.addIceCandidate(p.data);
    }
  }
});

setTimeout(() => { console.log(`[${role}] 超时`); process.exit(2); }, 40000);
