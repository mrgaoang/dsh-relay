/**
 * relay-free — 开源免费版一体入口
 *
 * 一条命令启动完整自建服务(纯开源栈,无需商业版):
 *   - REST 账号 API(register/login/devices)→ 端口 13446
 *   - 信令 WebSocket(relay-core)→ 端口 13445
 *   - STUN UDP(relay-core 内置)→ 端口 3478
 *
 * 环境变量:
 *   DSH_FREE_API_PORT    账号 API 端口(默认 13446)
 *   DSH_FREE_SIGNAL_PORT 信令端口(默认 13445)
 *   DSH_FREE_STUN_PORT   STUN 端口(默认 3478)
 *   DSH_FREE_JWT_SECRET  JWT 密钥(默认随机,重启后旧 token 失效;生产请固定)
 *   DSH_FREE_HOST        监听地址(默认 0.0.0.0)
 *
 * 说明:免费版为单进程内存态(用户/设备存内存),重启后需重新注册账号。
 * 需要多用户/持久化/超管后台 → 商业版(dsh-relay-enterprise,闭源)。
 */

import { randomBytes } from "node:crypto";
import { createAuth, createStore } from "./auth.js";
import { createApiServer } from "./api.js";
import { createSignalingServer, createStunServer, createDeviceRegistry } from "@dsh-relay/core";

const API_PORT = Number(process.env.DSH_FREE_API_PORT || 13446);
const SIGNAL_PORT = Number(process.env.DSH_FREE_SIGNAL_PORT || 13445);
const STUN_PORT = Number(process.env.DSH_FREE_STUN_PORT || 3478);
const HOST = process.env.DSH_FREE_HOST || "0.0.0.0";
const JWT_SECRET = process.env.DSH_FREE_JWT_SECRET || randomBytes(32).toString("hex");

async function main() {
  const store = createStore();
  const auth = createAuth({ store, jwtSecret: JWT_SECRET });

  // 1. STUN(UDP 打洞探测)
  const stun = createStunServer({ port: STUN_PORT, host: HOST });
  console.log(`[relay-free] STUN  UDP    :${STUN_PORT}`);

  // 2. 信令 WebSocket(带 auth 钩子:校验 JWT + 设备归属)
  const registry = createDeviceRegistry();
  const signal = await createSignalingServer({
    port: SIGNAL_PORT,
    host: HOST,
    registry,
    auth: { verifyRegister: auth.verifyRegister }
  });
  console.log(`[relay-free] 信令  WS     :${SIGNAL_PORT}`);

  // 3. 账号 REST API
  const api = await createApiServer({ port: API_PORT, host: HOST, auth });
  console.log(`[relay-free] 账号  HTTP   :${API_PORT}`);

  console.log("\n✅ relay-free 已启动(纯开源栈)");
  console.log(`   账号 API  : http://${HOST}:${API_PORT}`);
  console.log(`   信令 WS   : ws://<host>:${SIGNAL_PORT}`);
  console.log(`   STUN      : <host>:${STUN_PORT}`);
  console.log("   使用 install-client.mjs 注册账号即可接入。\n");

  const shutdown = () => {
    api.close().catch(() => {});
    signal.close().catch(() => {});
    stun.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[relay-free] 启动失败:", err);
  process.exit(1);
});
