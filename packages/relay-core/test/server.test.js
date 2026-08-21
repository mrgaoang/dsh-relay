/**
 * relay-core 信令服务器测试
 *   1. STUN Binding(返回 XOR-MAPPED-ADDRESS)
 *   2. 信令:register → welcome
 *   3. 未授权 register(auth 钩子拒绝)→ error
 *   4. 非法 JSON → error
 *   5. offer/answer 转发(两台设备互连)
 *   6. 心跳与设备列表
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import WebSocket from "ws";
import { createSignalingServer, createStunServer, createDeviceRegistry } from "../src/server.js";

const HOST = "127.0.0.1";

async function startSignal({ auth } = {}) {
  const registry = createDeviceRegistry();
  // 服务器绑 0.0.0.0(macOS 上 ws 客户端从 0.0.0.0 连 127.0.0.1 会 EADDRNOTAVAIL),
  // 测试客户端连 127.0.0.1
  const signal = await createSignalingServer({ port: 0, host: "0.0.0.0", registry, auth });
  return { registry, signal, port: signal.port };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    // macOS 上 ws 默认 localAddress=0.0.0.0 连 127.0.0.1 会 EADDRNOTAVAIL,
    // 显式指定 localAddress 为回环地址
    const ws = new WebSocket(`ws://${HOST}:${port}`, { localAddress: HOST });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMsg(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("等待消息超时")), timeoutMs);
    ws.on("message", (raw) => {
      clearTimeout(t);
      resolve(JSON.parse(raw.toString()));
    });
    ws.on("error", reject);
  });
}

// ---------- STUN ----------

test("STUN:Binding Request 返回 XOR-MAPPED-ADDRESS", async () => {
  const stun = await createStunServer({ port: 0, host: "0.0.0.0" });
  const port = stun.port;
  const socket = dgram.createSocket("udp4");

  const MAGIC = 0x2112a442;
  const txId = Buffer.from("stuntesttxid"); // 12 字节事务 ID
  const msg = Buffer.alloc(20);
  msg.writeUInt16BE(0x0001, 0); // Binding Request
  msg.writeUInt16BE(0, 2);
  msg.writeUInt32BE(MAGIC, 4);
  txId.copy(msg, 8);

  const resp = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("STUN 无响应")), 3000);
    socket.on("message", (data) => { clearTimeout(t); resolve(data); });
    socket.on("error", reject);
    socket.send(msg, port, HOST);
  });

  assert.equal(resp.readUInt16BE(0), 0x0101, "Success Response");
  assert.ok(resp.subarray(8, 20).equals(txId), "事务 ID 回显(12 字节,8..20)");

  // 找 XOR-MAPPED-ADDRESS(0x0020)
  let offset = 20;
  let found = false;
  while (offset + 4 <= resp.length) {
    const atype = resp.readUInt16BE(offset);
    const alen = resp.readUInt16BE(offset + 2);
    if (atype === 0x0020) {
      found = true;
      assert.ok(alen === 8, "XOR-MAPPED-ADDRESS 长度 8");
      break;
    }
    offset += 4 + alen;
  }
  assert.ok(found, "包含 XOR-MAPPED-ADDRESS 属性");

  socket.close();
  stun.close();
});

// ---------- 信令基础 ----------

test("信令:register → welcome,心跳保持在线", async () => {
  const { signal, registry, port } = await startSignal();
  try {
    const ws = await connect(port);
    const msgPromise = nextMsg(ws);
    ws.send(JSON.stringify({ type: "register", deviceId: "dev-a", name: "device-a", pubKey: "ed25519:aaa" }));
    const welcome = await msgPromise;
    assert.equal(welcome.type, "welcome");
    assert.equal(welcome.deviceId, "dev-a");

    // 设备在注册表中
    const dev = registry.get("dev-a");
    assert.ok(dev, "设备已注册");
    assert.equal(dev.name, "device-a");

    // 心跳
    ws.send(JSON.stringify({ type: "heartbeat", deviceId: "dev-a", endpoints: [{ host: "1.2.3.4", port: 5000, type: "srflx" }] }));
    await new Promise((r) => setTimeout(r, 100));
    const after = registry.get("dev-a");
    assert.deepEqual(after.endpoints, [{ host: "1.2.3.4", port: 5000, type: "srflx" }]);

    ws.close();
  } finally {
    signal.close();
  }
});

test("信令:未授权 register(auth 钩子拒绝)→ error", async () => {
  const auth = { verifyRegister: () => false };
  const { signal, port } = await startSignal({ auth });
  try {
    const ws = await connect(port);
    const msgPromise = nextMsg(ws);
    ws.send(JSON.stringify({ type: "register", deviceId: "dev-x", token: "bad" }));
    const err = await msgPromise;
    assert.equal(err.type, "error");
    assert.equal(err.code, "unauthorized");
    ws.close();
  } finally {
    signal.close();
  }
});

test("信令:授权 register(auth 钩子通过)→ welcome", async () => {
  const auth = { verifyRegister: () => true };
  const { signal, port } = await startSignal({ auth });
  try {
    const ws = await connect(port);
    const msgPromise = nextMsg(ws);
    ws.send(JSON.stringify({ type: "register", deviceId: "dev-ok", token: "good" }));
    const welcome = await msgPromise;
    assert.equal(welcome.type, "welcome");
    ws.close();
  } finally {
    signal.close();
  }
});

test("信令:非法 JSON → error(bad_json)", async () => {
  const { signal, port } = await startSignal();
  try {
    const ws = await connect(port);
    const msgPromise = nextMsg(ws);
    ws.send("not-json{{{");
    const err = await msgPromise;
    assert.equal(err.type, "error");
    assert.equal(err.code, "bad_json");
    ws.close();
  } finally {
    signal.close();
  }
});

test("信令:缺 deviceId 的 register → error(bad_register)", async () => {
  const { signal, port } = await startSignal();
  try {
    const ws = await connect(port);
    const msgPromise = nextMsg(ws);
    ws.send(JSON.stringify({ type: "register", name: "no-id" }));
    const err = await msgPromise;
    assert.equal(err.type, "error");
    assert.equal(err.code, "bad_register");
    ws.close();
  } finally {
    signal.close();
  }
});

// ---------- offer/answer 转发 ----------

test("信令:offer 转发到目标设备,answer 回传发起方", async () => {
  const { signal, port } = await startSignal();
  try {
    // 设备 A(发起方)
    const wsA = await connect(port);
    let aWelcome = nextMsg(wsA);
    wsA.send(JSON.stringify({ type: "register", deviceId: "dev-a", pubKey: "ed25519:a" }));
    await aWelcome;

    // 设备 B(目标)
    const wsB = await connect(port);
    let bWelcome = nextMsg(wsB);
    wsB.send(JSON.stringify({ type: "register", deviceId: "dev-b", pubKey: "ed25519:b" }));
    await bWelcome;

    // A 向 B 发 offer
    const bOffer = nextMsg(wsB);
    wsA.send(JSON.stringify({
      type: "offer", targetDeviceId: "dev-b", token: "tok",
      sdp: "sdp-of-a", ice: [{ candidate: "cand-a" }]
    }));
    const offerMsg = await bOffer;
    assert.equal(offerMsg.type, "peer_offer", "relay 收到 offer 后转发为 peer_offer");
    assert.equal(offerMsg.fromDeviceId, "dev-a");
    assert.equal(offerMsg.sdp, "sdp-of-a");

    // B 回 answer
    const aAnswer = nextMsg(wsA);
    wsB.send(JSON.stringify({
      type: "answer", toDeviceId: "dev-a",
      sdp: "sdp-of-b", ice: [{ candidate: "cand-b" }]
    }));
    const answerMsg = await aAnswer;
    assert.equal(answerMsg.type, "peer_answer", "relay 收到 answer 后转发为 peer_answer");
    assert.equal(answerMsg.sdp, "sdp-of-b");

    // A 查询设备列表
    const listPromise = nextMsg(wsA);
    wsA.send(JSON.stringify({ type: "list_devices", token: "tok" }));
    const listMsg = await listPromise;
    assert.equal(listMsg.type, "devices");
    const ids = listMsg.devices.map((d) => d.deviceId).sort();
    assert.deepEqual(ids, ["dev-a", "dev-b"]);

    wsA.close();
    wsB.close();
  } finally {
    signal.close();
  }
});
