#!/usr/bin/env node
/**
 * dsh-relay 客户端安装助手(普通用户)
 *
 * 功能:
 *   1. 连接公共 relay 服务(信令 + 账号)
 *   2. 注册新账号(邮箱+密码)
 *   3. 绑定本机设备
 *   4. 通过信令注册设备(带 JWT)
 *
 * 用法:
 *   node install-client.mjs
 *   环境变量:
 *     DSH_RELAY_API   账号 API 地址(默认 https://n.risegao.cn:13443/relay-api)
 *     DSH_RELAY_WS    信令地址(默认 wss://n.risegao.cn:13443/relay-signal)
 *     DSH_RELAY_STUN  STUN 地址(默认 n.risegao.cn:3478)
 *
 * 安全提示:
 *   密码通过账号 API 传输。默认使用 HTTPS/WSS;自建服务请务必配 TLS,
 *   仅在 127.0.0.1 本地测试时可临时用 http:// / ws://。
 */

import WebSocket from "ws";
import os from "node:os";

const API = process.env.DSH_RELAY_API || "https://n.risegao.cn:13443/relay-api";
const WS = process.env.DSH_RELAY_WS || "wss://n.risegao.cn:13443/relay-signal";

// 明文 HTTP/WS 仅允许回环地址(本地测试),防止密码明文走公网
if (/^http:\/\//i.test(API) && !/^http:\/\/127\.0\.0\.1|^http:\/\/localhost/i.test(API)) {
  console.error("❌ 安全警告:账号 API 使用明文 HTTP(非本地回环)。密码将明文传输,已拒绝执行。");
  console.error("   请使用 HTTPS(公共服务)或仅本地测试时指向 127.0.0.1。");
  process.exit(1);
}
if (/^ws:\/\//i.test(WS) && !/^ws:\/\/127\.0\.0\.1|^ws:\/\/localhost/i.test(WS)) {
  console.error("❌ 安全警告:信令使用明文 WS(非本地回环)。设备令牌将明文传输,已拒绝执行。");
  console.error("   请使用 WSS(公共服务)或仅本地测试时指向 127.0.0.1。");
  process.exit(1);
}

async function api(path, body, token) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

async function ask(question) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

console.log("╔══════════════════════════════════════════╗");
console.log("║   dsh-relay 客户端安装助手                ║");
console.log("╚══════════════════════════════════════════╝");
console.log(`  服务: ${API}`);

// 1. 健康检查
try {
  const h = await fetch(API + "/api/health").then((r) => r.json());
  console.log(`✅ 服务在线: ${h.service || "relay-enterprise"}`);
} catch {
  console.log("❌ 无法连接服务,请检查网络或服务地址");
  process.exit(1);
}

// 2. 登录或注册(支持环境变量非交互: DSH_RELAY_EMAIL / DSH_RELAY_PASSWORD)
console.log("\n--- 账号 ---");
const email = process.env.DSH_RELAY_EMAIL || await ask("邮箱: ");
const password = process.env.DSH_RELAY_PASSWORD || await ask("密码(≥8位): ");

let token, user;
// 先试登录
let res = await api("/api/login", { email, password });
if (res.status === 200) {
  token = res.data.token;
  user = res.data.user;
  console.log("✅ 登录成功");
} else if (res.status === 401) {
  // 未注册,尝试注册
  console.log("账号不存在,尝试注册...");
  res = await api("/api/register", { email, password });
  if (res.status === 201) {
    res = await api("/api/login", { email, password });
    token = res.data.token;
    user = res.data.user;
    console.log("✅ 注册成功");
  } else {
    console.log(`❌ 注册失败: ${res.data?.error?.message || res.status}`);
    process.exit(1);
  }
} else {
  console.log(`❌ 登录失败: ${res.data?.error?.message || res.status}`);
  process.exit(1);
}

// 3. 绑定设备
console.log("\n--- 设备 ---");
const deviceName = os.hostname();
const pubKey = "ed25519:" + Math.random().toString(16).slice(2, 18);
res = await api("/api/devices", { device_name: deviceName, pub_key: pubKey }, token);
if (res.status === 201) {
  console.log(`✅ 设备已绑定: ${deviceName}`);
} else {
  console.log(`⚠️ 设备绑定: ${res.status} ${res.data?.error?.message || ""}(可能已存在)`);
}

// 4. 信令注册设备(带 JWT)
console.log("\n--- 信令连接 ---");
const ws = new WebSocket(WS);
const signalResult = await new Promise((resolve) => {
  const t = setTimeout(() => { ws.close(); resolve("超时"); }, 5000);
  ws.on("open", () => ws.send(JSON.stringify({ type: "register", deviceId: `dev-${Date.now()}`, name: deviceName, pubKey, token })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "welcome") { clearTimeout(t); resolve("welcome-ok"); }
    if (m.type === "error") { clearTimeout(t); resolve(`rejected:${m.code}`); }
  });
  ws.on("error", () => { clearTimeout(t); resolve("ws-error"); });
});
console.log(signalResult === "welcome-ok" ? "✅ 信令注册成功" : `❌ 信令: ${signalResult}`);
ws.close();

console.log("\n══════════════════════════════════════════");
console.log("✅ 安装完成!");
console.log(`  账号: ${user?.email}`);
console.log(`  套餐: ${user?.plan || "free"}`);
console.log("  现在可以通过手机或本机使用远程控制功能");
console.log("══════════════════════════════════════════");
