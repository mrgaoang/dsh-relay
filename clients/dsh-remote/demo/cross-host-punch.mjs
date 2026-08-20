/**
 * 跨主机打洞测试:通过 relay 信令交换 SDP/ICE,验证 UDP 打洞
 * 用法: node demo/cross-host-punch.mjs <a|b> [relayUrl]
 *   a = offerer(Mac,家庭 NAT)  b = answerer(腾讯云,公网)
 * 环境: DSH_STUN(默认 stun.l.google.com:19302)
 */
import * as dc from "node-datachannel";
import WebSocket from "ws";

const role = process.argv[2];
const RELAY = process.argv[3] || "ws://<RELAY_HOST>:13445";
const STUN = process.env.DSH_STUN || "stun:stun.l.google.com:19302";
const deviceId = `ch-${role}`;
const peerId = `ch-${role === "a" ? "b" : "a"}`;

const ws = new WebSocket(RELAY);
const send = (o) => ws.send(JSON.stringify(o));

const pc = new dc.PeerConnection(`Punch-${role}`, {
  iceServers: [STUN],
  enableIceTcp: true,  // TCP 兜底
  maxMessageSize: 256 * 1024
});

let dc1 = null;
let candidates = [];
let thisAnswered = false;

pc.onStateChange((s) => { if (s === "connected" || s === "failed") console.log(`[${role}] peerState: ${s}`); });
pc.onIceStateChange((s) => {
  console.log(`[${role}] iceState: ${s}`);
  if (s === "connected" || s === "completed") {
    console.log(`[${role}] ✅🎉 P2P 直连成功!`);
    if (role === "a") { try { dc1?.sendMessage("hello-from-" + role); } catch {} }
    setTimeout(() => process.exit(0), 500);
  }
});

// 本地 SDP → 信令
pc.onLocalDescription((sdp, type) => {
  console.log(`[${role}] 本地SDP ${type} len=${sdp.length}`);
  send({ type: "relay", to: peerId, payload: { kind: "sdp", data: sdp, type } });
});
// 本地候选 → 信令(逐个转发)
pc.onLocalCandidate((candidate, mid) => {
  const typ = (candidate.match(/typ (\w+)/) || [])[1] || "?";
  candidates.push({ candidate, mid, typ });
  console.log(`[${role}] 候选[${typ}]: ${candidate.split(" ")[4] || "?"}:${candidate.split(" ")[5] || "?"}`);
  send({ type: "relay", to: peerId, payload: { kind: "candidate", data: { candidate, mid } } });
});

// 对端 SDP/候选
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "relay" && m.from === peerId) {
    const p = m.payload;
    if (p.kind === "sdp") {
      console.log(`[${role}] 收到对端SDP: ${p.type}`);
      // 仅当 signalingState 允许时才 setRemoteDescription
      try {
        pc.setRemoteDescription(p.data, p.type === "offer" ? "Offer" : "Answer");
        if (p.type === "offer" && role === "b" && !thisAnswered) {
          thisAnswered = true;
          setTimeout(() => { try { pc.setLocalDescription("answer"); } catch (e) { console.log("[b] setLocal err:", e.message); } }, 200);
        }
      } catch (e) {
        console.log(`[${role}] setRemoteDescription err:`, e.message);
      }
    } else if (p.kind === "candidate") {
      const typ = (p.data.candidate.match(/typ (\w+)/) || [])[1] || "?";
      console.log(`[${role}] 收到对端候选[${typ}]`);
      try { pc.addRemoteCandidate(p.data.candidate, p.data.mid); } catch (e) { console.log(`[${role}] addRemoteCandidate err:`, e.message); }
    }
  }
  if (m.type === "welcome") {
    console.log(`[${role}] 注册成功`);
    if (role === "a") {
      // offerer:创建 channel + offer
      dc1 = pc.createDataChannel("test");
      dc1.onOpen(() => { console.log(`[${role}] ✅ DataChannel OPEN(直连建立!)`); dc1.sendMessage("hello-from-" + role); setTimeout(()=>process.exit(0),800); });
      dc1.onMessage((msg) => console.log(`[${role}] 收到: ${msg.toString()}`));
      setTimeout(() => pc.setLocalDescription("offer"), 500);
    }
  }
});

ws.on("open", () => send({ type: "register", deviceId, name: `Punch-${role}` }));
ws.on("error", (e) => console.log(`[${role}] ws error:`, e.message));

setTimeout(() => {
  console.log(`[${role}] 超时. 候选统计: ${candidates.map(c=>c.typ).join(",")}`);
  process.exit(2);
}, 45000);
