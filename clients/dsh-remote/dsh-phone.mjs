#!/usr/bin/env node
/**
 * dsh-phone — 手机端模拟:经 P2P 打洞访问电脑上的 dsh web
 *
 * 流程:
 *   1. 连 relay 信令,注册为 phone-xxx
 *   2. 作为 offerer 向 bridge-xxx 发起 WebRTC(官方模式)
 *   3. DataChannel 建立后,发 HTTP 请求帧 → 收 dsh web 响应
 *
 * 用法:
 *   node dsh-phone.mjs <bridgeDeviceId> [relayUrl]
 * 环境:
 *   DSH_RELAY_STUN  STUN 地址
 *   DSH_PHONE_TOKEN JWT(商业版信令认证;开源版可省略)
 */
import * as dc from "node-datachannel";
import WebSocket from "ws";

const BRIDGE = process.argv[2] || "bridge-test";
const RELAY = process.argv[3] || "wss://n.risegao.cn:13443/relay-signal";
const STUN = process.env.DSH_RELAY_STUN || "stun:stun.l.google.com:19302";
const TOKEN = process.env.DSH_PHONE_TOKEN || "";
const DEVICE_ID = "phone-" + BRIDGE.replace("bridge-", "");

console.log(`[phone] ${DEVICE_ID} → bridge ${BRIDGE} @ ${RELAY}`);

const ws = new WebSocket(RELAY);
const send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };

const pc = new dc.PeerConnection(DEVICE_ID, {
  iceServers: [STUN],
  maxMessageSize: 4 * 1024 * 1024
});

let dc1 = null;
let nextId = 1;
let pending = new Map();

pc.onLocalDescription((sdp, type) => send({ type: "relay", to: BRIDGE, payload: { kind: "sdp", data: sdp, type } }));
pc.onLocalCandidate((candidate, mid) => send({ type: "relay", to: BRIDGE, payload: { kind: "candidate", data: { candidate, mid } } }));
pc.onIceStateChange((s) => {
  console.log(`[phone] iceState: ${s}`);
  if (s === "connected") console.log("[phone] ✅ P2P 直连 bridge!");
});

function httpRequest(method, path, body) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    const frame = { id, method, path };
    if (body !== undefined) frame.body = typeof body === "string" ? body : JSON.stringify(body);
    dc1.sendMessage(JSON.stringify(frame));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timeout: true }); } }, 8000);
  });
}

ws.on("message", (raw) => {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === "relay" && m.from === BRIDGE) {
    const p = m.payload;
    if (p.kind === "sdp") {
      console.log(`[phone] 收到 bridge SDP ${p.type}`);
      try { pc.setRemoteDescription(p.data, p.type); } catch (e) { console.log(`[phone] setRemote err: ${e.message}`); }
    } else if (p.kind === "candidate") {
      try { pc.addRemoteCandidate(p.data.candidate, p.data.mid); } catch {}
    }
  }
  if (m.type === "welcome") {
    console.log(`[phone] 信令注册成功,发起连接...`);
    // offerer:createDataChannel 自动生成 offer
    dc1 = pc.createDataChannel("dsh");
    dc1.onOpen(() => {
      console.log("[phone] DataChannel OPEN,开始测试 dsh web...");
      runTests();
    });
    dc1.onMessage((msg) => {
      const reply = JSON.parse(msg.toString());
      const resolve = pending.get(reply.id);
      if (resolve) { pending.delete(reply.id); resolve(reply); }
    });
  }
});

async function runTests() {
  // 1. 首页
  const home = await httpRequest("GET", "/");
  console.log(`[phone] ① GET / → ${home.timeout ? "超时" : home.status + " (" + home.body.slice(0, 30) + "...)"}`);

  // 2. session.list API
  const sessions = await httpRequest("POST", "/api/session.list", {
    type: "client-request",
    rpcId: "00000000-0000-4000-8000-0000000000aa",
    method: "session.list",
    payload: {}
  });
  if (!sessions.timeout) {
    try {
      const d = JSON.parse(sessions.body);
      console.log(`[phone] ② session.list → ok=${d.result?.ok} 会话数=${d.result?.value?.items?.length}`);
    } catch {
      console.log(`[phone] ② session.list → ${sessions.status} ${sessions.body.slice(0, 50)}`);
    }
  } else {
    console.log(`[phone] ② session.list → 超时`);
  }

  console.log("\n[phone] 端到端测试完成");
  process.exit(0);
}

ws.on("open", () => send({ type: "register", deviceId: DEVICE_ID, name: "dsh-phone", ...(TOKEN ? { token: TOKEN } : {}) }));
ws.on("error", (e) => console.log(`[phone] ws error: ${e.message || ""}`));
setTimeout(() => { console.log("[phone] 超时"); process.exit(1); }, 30000);
