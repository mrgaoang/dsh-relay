/**
 * WebRTC 打洞端到端 demo
 *
 * 模拟两个用户设备(device-a, device-b)通过 relay 信令建立 DataChannel 直连。
 * 本 demo 在同一台机器上跑(局域网直连),用于验证协议栈;
 * 跨 NAT 打洞测试见 docs/hole-punch-test.md。
 *
 * 用法:
 *   node demo/webrtc-demo.mjs
 *   (需要 relay 已启动: DSH_RELAY_SIGNAL_PORT=13445 DSH_RELAY_STUN_PORT=3478 node packages/relay-core/src/index.js)
 */

import { SignalingClient, WebrtcNode } from "../src/webrtc.js";

const RELAY_URL = process.env.DSH_RELAY_URL || "ws://127.0.0.1:13445";
const STUN_HOST = process.env.DSH_RELAY_STUN_HOST || "127.0.0.1";

const TIMEOUT_MS = 15_000;

// ---------- 设备 A(offerer) ----------
const signalA = new SignalingClient(RELAY_URL, {
  deviceId: "device-a", name: "Device A",
  stunHost: STUN_HOST
});
await signalA.connect();
console.log("A 注册成功");

// ---------- 设备 B(answerer) ----------
const signalB = new SignalingClient(RELAY_URL, {
  deviceId: "device-b", name: "Device B",
  stunHost: STUN_HOST
});
await signalB.connect();
console.log("B 注册成功");

// ---------- 建立 WebRTC ----------
const nodeA = new WebrtcNode({ signaling: signalA, isOfferer: true });
const nodeB = new WebrtcNode({ signaling: signalB, isOfferer: false });

// B 收到数据
nodeB.onData = (msg) => {
  console.log("B 收到数据:", msg.toString());
};

let opened = false;
const waitOpen = new Promise((resolve) => {
  nodeA.onOpen = () => {
    if (!opened) { opened = true; resolve(); }
  };
});

nodeA.init();
nodeB.init();

// A 发起连接
console.log("A 发起 WebRTC 连接...");
await nodeA.startOffer("device-b");

// 等待 DataChannel 打开
await Promise.race([
  waitOpen,
  new Promise((_, rej) => setTimeout(() => rej(new Error("连接超时")), TIMEOUT_MS))
]);
console.log("✅ DataChannel 已打开(WebRTC 直连建立)");

// A → B 发送消息
nodeA.send("hello from device-a over WebRTC!");
await new Promise(r => setTimeout(r, 500));

nodeA.close();
nodeB.close();
signalA.close();
signalB.close();
console.log("Demo 完成");
process.exit(0);
