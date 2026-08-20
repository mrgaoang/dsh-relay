/**
 * 打洞攻关版 v2:完全遵循 node-datachannel 官方示例
 *
 * 关键:不手动 setLocalDescription!offerer createDataChannel 自动生成 offer;
 *      answerer setRemoteDescription(offer) 后自动生成 answer。
 * 两端只需:onLocalDescription 转发 SDP + onLocalCandidate 转发候选
 *
 * 用法: node demo/punch-official.mjs <a|b> <relayUrl>
 */
import * as dc from "node-datachannel";
import WebSocket from "ws";

const role = process.argv[2];
const RELAY = process.argv[3] || "ws://127.0.0.1:13445";
const STUN = process.env.DSH_STUN || "stun:stun.l.google.com:19302";
const deviceId = `po-${role}`;
const peerId = `po-${role === "a" ? "b" : "a"}`;

const ws = new WebSocket(RELAY);
const send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };

const pc = new dc.PeerConnection(`PO-${role}`, {
  iceServers: [STUN],
  maxMessageSize: 256 * 1024
});

let dc1 = null;
let done = false;
function finish(ok, why) {
  if (done) return; done = true;
  console.log(`[${role}] ${ok ? "✅ 直连成功" : "❌ " + why}`);
  try { ws.close(); } catch {}
  try { pc.close(); } catch {}
  setTimeout(() => process.exit(ok ? 0 : 1), 300);
}

pc.onIceStateChange((s) => {
  console.log(`[${role}] iceState: ${s}`);
  if (s === "connected" || s === "completed") finish(true, `iceState=${s}`);
  if (s === "failed") finish(false, "iceState=failed");
});

// 本地 SDP → 转发(官方模式:answerer 也自动触发)
pc.onLocalDescription((sdp, type) => {
  console.log(`[${role}] 本地SDP ${type}`);
  send({ type: "relay", to: peerId, payload: { kind: "sdp", data: sdp, type } });
});

// 本地候选 → 转发
pc.onLocalCandidate((candidate, mid) => {
  send({ type: "relay", to: peerId, payload: { kind: "candidate", data: { candidate, mid } } });
});

// 对端 channel(offerer 创建了,answerer 收)
pc.onDataChannel((d) => {
  dc1 = d;
  d.onOpen(() => console.log(`[${role}] DataChannel OPEN`));
  d.onMessage((msg) => console.log(`[${role}] 收到: ${msg.toString()}`));
});

ws.on("message", (raw) => {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === "relay" && m.from === peerId) {
    const p = m.payload;
    if (p.kind === "sdp") {
      console.log(`[${role}] 收到SDP ${p.type}`);
      try { pc.setRemoteDescription(p.data, p.type); } catch (e) { console.log(`[${role}] setRemote err: ${e.message}`); }
    } else if (p.kind === "candidate") {
      try { pc.addRemoteCandidate(p.data.candidate, p.data.mid); } catch {}
    }
  }
  if (m.type === "welcome") {
    console.log(`[${role}] 注册成功`);
    if (role === "a") {
      // offerer:createDataChannel 自动生成 offer
      dc1 = pc.createDataChannel("t");
      dc1.onOpen(() => console.log(`[${role}] DataChannel OPEN`));
      dc1.onMessage((msg) => console.log(`[${role}] 收到: ${msg.toString()}`));
    }
  }
});

ws.on("open", () => send({ type: "register", deviceId, name: `PO-${role}` }));
ws.on("error", (e) => finish(false, "ws error"));
setTimeout(() => finish(false, "超时(30s)"), 30000);
