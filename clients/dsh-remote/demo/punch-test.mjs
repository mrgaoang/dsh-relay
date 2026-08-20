// 跨网络打洞测试:通过 relay 信令交换 SDP/ICE,验证 WebRTC 直连
// 用法: node demo/punch-test.mjs <role>  (role: a|b)
//   a = offerer(设备A,如家庭宽带)
//   b = answerer(设备B,如云服务器)
import { SignalingClient, WebrtcNode } from "../src/webrtc.js";

const RELAY = process.env.DSH_RELAY_URL || "ws://127.0.0.1:8080/relay";
const STUN = process.env.DSH_STUN_HOST || "stun.l.google.com"; // 公共 STUN
const STUN_PORT = 19302;
const role = process.argv[2] || "a";
const deviceId = role === "a" ? "punch-a" : "punch-b";
const target = role === "a" ? "punch-b" : "punch-a";

const signal = new SignalingClient(RELAY, { deviceId, name: `Punch ${role.toUpperCase()}`, stunHost: STUN, stunPort: STUN_PORT });
await signal.connect();
console.log(`[${role}] 注册成功(${deviceId})`);

const node = new WebrtcNode({ signaling: signal, isOfferer: role === "a" });
node.onStateChange = (s) => { if (s === "connected" || s === "failed") console.log(`[${role}] ICE state: ${s}`); };
node.onOpen = () => {
  console.log(`[${role}] ✅ DataChannel OPEN(直连建立!)`);
  node.send(`hello from ${role}`);
  setTimeout(() => { process.exit(0); }, 1000);
};
node.onData = (m) => console.log(`[${role}] 收到数据: ${m.toString()}`);

node.init();

if (role === "a") {
  console.log(`[a] 发起连接 → ${target}`);
  await node.startOffer(target);
}

// 30 秒超时
setTimeout(() => {
  const st = node.pc ? node.pc.iceState() : "unknown";
  console.log(`[${role}] 超时,最终 ICE state: ${st}`);
  process.exit(st === "completed" || st === "connected" ? 0 : 2);
}, 30000);
