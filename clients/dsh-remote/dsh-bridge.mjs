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
 *   DSH_BRIDGE_UPSTREAM   上游 dsh web(默认 http://127.0.0.1:3080)
 *   DSH_BRIDGE_EMAIL      账号邮箱(与 DSH_BRIDGE_PASSWORD 一起自动登录拿 JWT)
 *   DSH_BRIDGE_PASSWORD   账号密码
 *   DSH_BRIDGE_TOKEN      JWT(直接给 token;优先级高于 邮箱+密码)
 *   DSH_BRIDGE_API        账号 API 地址(默认 https://n.risegao.cn:13443/relay-api)
 *   DSH_BRIDGE_STUN       STUN 地址(默认 stun:n.risegao.cn:3478)
 */

import * as dc from "node-datachannel";
import WebSocket from "ws";

const RELAY = process.argv[2] || "wss://n.risegao.cn:13443/relay-signal";
const DEVICE_ID = process.argv[3] || `bridge-${Math.random().toString(16).slice(2, 8)}`;
const UPSTREAM = process.env.DSH_BRIDGE_UPSTREAM || "http://127.0.0.1:3080";
const API_BASE = (process.env.DSH_BRIDGE_API || "https://n.risegao.cn:13443/relay-api").replace(/\/+$/, "");
const EMAIL = process.env.DSH_BRIDGE_EMAIL || "";
const PASSWORD = process.env.DSH_BRIDGE_PASSWORD || "";
const TOKEN = process.env.DSH_BRIDGE_TOKEN || "";
const STUN = process.env.DSH_BRIDGE_STUN || "stun:n.risegao.cn:3478";

console.log(`[bridge] 设备 ${DEVICE_ID} → ${RELAY}`);
console.log(`[bridge] 上游 ${UPSTREAM}`);

// ---- 认证:token 优先,否则 邮箱+密码 自动登录 ----
async function resolveToken() {
  if (TOKEN) { console.log("[bridge] 使用 DSH_BRIDGE_TOKEN"); return TOKEN; }
  if (EMAIL && PASSWORD) {
    console.log(`[bridge] 用账号 ${EMAIL} 登录换取 JWT...`);
    try {
      const r = await fetch(API_BASE + "/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD })
      });
      const d = await r.json();
      if (r.status === 200 && d.token) {
        console.log("[bridge] 登录成功,已获取 JWT");
        return d.token;
      }
      console.error(`[bridge] 登录失败(${r.status}): ${d.error?.message || "未知错误"}`);
      console.error("[bridge] 请检查 DSH_BRIDGE_EMAIL / DSH_BRIDGE_PASSWORD,或直接设 DSH_BRIDGE_TOKEN");
      process.exit(1);
    } catch (e) {
      console.error(`[bridge] 无法连接账号 API ${API_BASE}: ${e.message}`);
      console.error("[bridge] 开源版(relay-free)可省略认证直接运行");
      process.exit(1);
    }
  }
  console.log("[bridge] 无认证配置(匿名;仅开源 relay-free 可用)");
  return "";
}

// ---- 启动:先认证,再连信令 ----
let ws;
let authToken = "";
const send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };

authToken = await resolveToken();
ws = new WebSocket(RELAY);

// ---- WebRTC(官方模式,answerer:等手机 offer) ----
// 打洞失败时用 TURN 中继兜底(pro/team 套餐;free 仅 P2P)
let ICE_SERVERS = [STUN];
if (authToken) {
  try {
    const r = await fetch(API_BASE + "/api/turn-credentials", {
      headers: { authorization: `Bearer ${authToken}` }
    });
    const d = await r.json();
    if (r.status === 200 && d.enabled && Array.isArray(d.iceServers)) {
      // relay-enterprise 返回 { urls, username, credential } 分离格式;
      // node-datachannel 需要 turn:user:pass@host:port 内嵌格式,做转换
      ICE_SERVERS = [STUN];
      for (const s of d.iceServers) {
        for (const u of Array.isArray(s.urls) ? s.urls : [s.urls]) {
          const m = /^turn:([^?]+)(\?.*)?$/i.exec(u);
          if (m && s.username && s.credential) {
            ICE_SERVERS.push(`turn:${encodeURIComponent(s.username)}:${encodeURIComponent(s.credential)}@${m[1]}`);
          } else if (/^stun:/i.test(u)) {
            ICE_SERVERS.push(u);
          }
        }
      }
      console.log("[bridge] 已启用 TURN 中继兜底(pro)");
    } else {
      console.log("[bridge] 当前套餐无 TURN(仅 P2P)");
    }
  } catch (e) { console.log("[bridge] TURN 配置跳过:", e.message); }
}

const pc = new dc.PeerConnection(DEVICE_ID, {
  iceServers: ICE_SERVERS,
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
  send({ type: "register", deviceId: DEVICE_ID, name: "dsh-bridge", ...(authToken ? { token: authToken } : {}) });
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
