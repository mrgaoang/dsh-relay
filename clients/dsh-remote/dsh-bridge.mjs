#!/usr/bin/env node
/**
 * dsh-bridge — 电脑端守护进程:把手机经 P2P 打洞的流量桥接到本地 dsh web
 *
 * 架构:
 *   手机(WebRTC) ──DataChannel──▶ 本进程 ──HTTP──▶ dsh web (127.0.0.1:3080)
 *
 * 流程:
 *   1. 连接 relay 信令,注册为设备(带 JWT 认证,可选)
 *   2. 等手机端发起 WebRTC offer(官方模式,自动协商)
 *   3. DataChannel 收到手机请求帧 → 转发 HTTP 到 dsh web → 回包经通道返回
 *
 * 帧协议(DataChannel, JSON):
 *   → 手机发: { "id": 1, "method": "GET", "path": "/api/session.list", "body": "..." }
 *   ← 本机回: { "id": 1, "status": 200, "headers": {...}, "body": "..." }
 *
 * 用法:
 *   node dsh-bridge.mjs [relayUrl] [deviceId]
 * 环境:
 *   DSH_BRIDGE_UPSTREAM  上游 dsh web(默认 http://127.0.0.1:3080)
 *   DSH_BRIDGE_TOKEN     JWT(商业版信令认证;开源版可省略)
 *   DSH_BRIDGE_STUN      STUN 地址(默认 stun.l.google.com:19302)
 */

import * as dc from "node-datachannel";
import WebSocket from "ws";

const RELAY = process.argv[2] || "ws://n.risegao.cn:13445";
const DEVICE_ID = process.argv[3] || `bridge-${Math.random().toString(16).slice(2, 8)}`;
const UPSTREAM = process.env.DSH_BRIDGE_UPSTREAM || "http://127.0.0.1:3080";
const TOKEN = process.env.DSH_BRIDGE_TOKEN || "";
const STUN = process.env.DSH_BRIDGE_STUN || "stun:stun.l.google.com:19302";

console.log(`[bridge] 设备 ${DEVICE_ID} → ${RELAY}`);
console.log(`[bridge] 上游 ${UPSTREAM}`);

const ws = new WebSocket(RELAY);
const send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };

// ---- WebRTC(官方模式,answerer:等手机 offer) ----
const pc = new dc.PeerConnection(DEVICE_ID, {
  iceServers: [STUN],
  maxMessageSize: 4 * 1024 * 1024
});

pc.onLocalDescription((sdp, type) => {
  console.log(`[bridge] 本地SDP ${type}`);
  send({ type: "relay", to: DEVICE_ID.replace("bridge-", "phone-"), payload: { kind: "sdp", data: sdp, type } });
});
pc.onLocalCandidate((candidate, mid) => {
  send({ type: "relay", to: DEVICE_ID.replace("bridge-", "phone-"), payload: { kind: "candidate", data: { candidate, mid } } });
});
pc.onIceStateChange((s) => {
  console.log(`[bridge] iceState: ${s}`);
  if (s === "connected") console.log("[bridge] ✅ 手机直连建立!");
});

// 手机创建的 DataChannel(offerer 创建)
pc.onDataChannel((dch) => {
  console.log("[bridge] DataChannel 打开(手机已连接)");
  dch.onMessage((raw) => handleRequest(dch, raw));
  dch.onClosed(() => console.log("[bridge] 连接关闭"));
});

// ---- HTTP 桥接 ----
async function handleRequest(dch, raw) {
  let frame;
  try { frame = JSON.parse(raw.toString()); } catch { return; }
  const { id, method = "GET", path = "/", body } = frame;
  if (!id || !path) return;

  const url = `${UPSTREAM}${path}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body !== undefined ? body : undefined
    });
    const text = await res.text();
    const reply = {
      id,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: text
    };
    console.log(`[bridge] ${method} ${path} → ${res.status} (${Date.now() - t0}ms)`);
    if (dch.isOpen()) dch.sendMessage(JSON.stringify(reply));
  } catch (e) {
    console.log(`[bridge] 上游错误: ${e.message}`);
    if (dch.isOpen()) dch.sendMessage(JSON.stringify({ id, status: 502, body: JSON.stringify({ error: e.message }) }));
  }
}

// ---- 信令 ----
ws.on("open", () => {
  send({ type: "register", deviceId: DEVICE_ID, name: "dsh-bridge", ...(TOKEN ? { token: TOKEN } : {}) });
});
ws.on("message", (raw) => {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === "welcome") {
    console.log(`[bridge] 信令注册成功: ${DEVICE_ID}`);
    console.log(`[bridge] 等待手机连接(手机应连信令并 offer 给 ${DEVICE_ID})...`);
  }
  if (m.type === "relay" && m.from === DEVICE_ID.replace("bridge-", "phone-")) {
    const p = m.payload;
    if (p.kind === "sdp") {
      console.log(`[bridge] 收到手机 SDP ${p.type}`);
      try { pc.setRemoteDescription(p.data, p.type); } catch (e) { console.log(`[bridge] setRemote err: ${e.message}`); }
    } else if (p.kind === "candidate") {
      try { pc.addRemoteCandidate(p.data.candidate, p.data.mid); } catch {}
    }
  }
});
ws.on("error", (e) => console.log(`[bridge] 信令错误: ${e.message || ""}`));

setTimeout(() => {
  console.log("[bridge] 运行中(Ctrl-C 退出)");
}, 1000);
