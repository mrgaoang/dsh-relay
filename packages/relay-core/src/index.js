/**
 * dsh-relay 服务入口(免费版,开源)
 *
 * 启动:
 *   node packages/relay-core/src/index.js
 * 或:
 *   DSH_RELAY_SIGNAL_PORT=13445 DSH_RELAY_STUN_PORT=3478 node packages/relay-core/src/index.js
 */

import { createSignalingServer, createStunServer, createDeviceRegistry } from "./server.js";

const SIGNAL_PORT = Number(process.env.DSH_RELAY_SIGNAL_PORT || 13445);
const STUN_PORT = Number(process.env.DSH_RELAY_STUN_PORT || 3478);

const registry = createDeviceRegistry();

const stun = await createStunServer({ port: STUN_PORT });
console.log(`[relay] STUN 服务已启动: udp://0.0.0.0:${STUN_PORT}`);

const signal = await createSignalingServer({ port: SIGNAL_PORT, registry });
console.log(`[relay] 信令服务已启动: ws://0.0.0.0:${SIGNAL_PORT}`);

console.log("[relay] 就绪。Ctrl-C 退出。");

process.on("SIGINT", () => {
  signal.close();
  stun.close();
  process.exit(0);
});
