/**
 * dsh-relay core — 最小信令服务器
 *
 * 功能(免费版,开源):
 *   - WebSocket 信令:注册/心跳/offer/answer 转发/设备列表
 *   - 内置 STUN 服务:客户端可探测自己的公网端点
 *   - 单进程内存态(免费版单用户/少量设备足够)
 *
 * 商业版(闭源)通过钩子扩展:多用户存储、授权、配额、计费。
 */

import { WebSocketServer } from "ws";
import dgram from "node:dgram";

// ---------- STUN(RFC 5389 最小实现:Binding Request → Success Response) ----------

/** STUN 消息类型 */
const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_SUCCESS = 0x0101;
/** Attribute: XOR-MAPPED-ADDRESS(0x0020) */
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
/** Attribute: MAPPED-ADDRESS(0x0001), 部分客户端要求 */
const ATTR_MAPPED_ADDRESS = 0x0001;

/**
 * 创建 STUN 服务器(UDP)。
 * 收到 Binding Request 后,把客户端源地址(经 NAT 后的公网地址)作为响应返回。
 */
export function createStunServer({ port = 3478 } = {}) {
  const socket = dgram.createSocket("udp4");

  socket.on("message", (msg, rinfo) => {
    if (msg.length < 20) return;
    const type = msg.readUInt16BE(0);
    if (type !== STUN_BINDING_REQUEST) return; // 非 Binding Request,忽略

    // 构造 Success Response:类型 | 长度 | 事务ID(复制请求的 4..20 字节)
    const txId = msg.subarray(4, 20);
    const xorPort = rinfo.port ^ 0x2112;
    const xorAddr = Buffer.from(rinfo.address.split(".").map((b, i) => Number(b) ^ [0x21, 0x12, 0xa4, 0x42][i]));

    // XOR-MAPPED-ADDRESS attribute
    const xored = Buffer.alloc(8);
    xored.writeUInt16BE(0x0001, 0); // family IPv4
    xored.writeUInt16BE(xorPort, 2);
    xorAddr.copy(xored, 4);

    const mapped = Buffer.alloc(8);
    mapped.writeUInt16BE(0x0001, 0);
    mapped.writeUInt16BE(rinfo.port, 2);
    Buffer.from(rinfo.address.split(".").map(Number)).copy(mapped, 4);

    const header = Buffer.alloc(20);
    header.writeUInt16BE(STUN_BINDING_SUCCESS, 0);
    header.writeUInt16BE(8 + 8 + 8, 2); // 两个 attribute 长度(4+4 each)
    txId.copy(header, 4);

    const attrXor = Buffer.alloc(4);
    attrXor.writeUInt16BE(ATTR_XOR_MAPPED_ADDRESS, 0);
    attrXor.writeUInt16BE(8, 2);
    const attrMapped = Buffer.alloc(4);
    attrMapped.writeUInt16BE(ATTR_MAPPED_ADDRESS, 0);
    attrMapped.writeUInt16BE(8, 2);

    const response = Buffer.concat([header, attrXor, xored, attrMapped, mapped]);
    socket.send(response, rinfo.port, rinfo.address);
  });

  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, "0.0.0.0", () => {
      socket.removeListener("error", reject);
      resolve({
        port,
        close: () => socket.close()
      });
    });
  });
}

// ---------- 信令服务 ----------

/**
 * 创建设备注册表(内存态,免费版)。
 * 商业版可替换为持久化存储。
 */
export function createDeviceRegistry() {
  /** deviceId -> { deviceId, name, pubKey, ws, endpoints, online, lastSeen } */
  const devices = new Map();

  return {
    register(device) {
      devices.set(device.deviceId, { ...device, online: true, lastSeen: Date.now() });
    },
    unregister(deviceId) {
      devices.delete(deviceId);
    },
    get(deviceId) {
      return devices.get(deviceId);
    },
    /** 更新设备 socket 引用(重连时) */
    attachSocket(deviceId, ws) {
      const d = devices.get(deviceId);
      if (d) {
        d.ws = ws;
        d.online = true;
        d.lastSeen = Date.now();
      }
    },
    touch(deviceId) {
      const d = devices.get(deviceId);
      if (d) d.lastSeen = Date.now();
    },
    list() {
      return [...devices.values()].map(({ deviceId, name, online, endpoints, pubKey }) => ({
        deviceId, name, online, endpoints, pubKey
      }));
    },
    /** 移除过期设备(心跳超时) */
    prune(staleMs = 60_000) {
      const now = Date.now();
      for (const [id, d] of devices) {
        if (now - d.lastSeen > staleMs) devices.delete(id);
      }
    }
  };
}

/**
 * 启动信令服务器。
 * @param {object} opts
 * @param {number} opts.port WebSocket 端口
 * @param {object} opts.registry 设备注册表
 * @param {object} [opts.auth] 可选认证钩子:{ verifyRegister({deviceId, token}) => boolean }
 */
export async function createSignalingServer({ port = 13445, registry, auth } = {}) {
  const wss = new WebSocketServer({ port, host: "0.0.0.0" });

  /** 心跳定时清理 */
  const pruneTimer = setInterval(() => registry?.prune(), 30_000);

  wss.on("connection", (ws, req) => {
    /** 当前连接绑定的 deviceId */
    let deviceId = null;

    const send = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ type: "error", code: "bad_json", message: "invalid JSON" });
        return;
      }

      switch (msg.type) {
        case "register": {
          if (!msg.deviceId || typeof msg.deviceId !== "string") {
            send({ type: "error", code: "bad_register", message: "deviceId required" });
            return;
          }
          // 可选认证钩子
          if (auth?.verifyRegister && !auth.verifyRegister(msg)) {
            send({ type: "error", code: "unauthorized", message: "registration rejected" });
            return;
          }
          deviceId = msg.deviceId;
          registry.register({
            deviceId: msg.deviceId,
            name: msg.name || msg.deviceId,
            pubKey: msg.pubKey || null,
            endpoints: msg.endpoints || []
          });
          registry.attachSocket(msg.deviceId, ws);
          send({ type: "welcome", deviceId: msg.deviceId, ok: true });
          break;
        }

        case "heartbeat": {
          if (!deviceId) { send({ type: "error", code: "not_registered" }); return; }
          registry.touch(deviceId);
          if (Array.isArray(msg.endpoints)) {
            const d = registry.get(deviceId);
            if (d) d.endpoints = msg.endpoints;
          }
          // 心跳回执(可携带对端离线通知等)
          send({ type: "heartbeat_ack", deviceId });
          break;
        }

        case "offer": {
          if (!deviceId) { send({ type: "error", code: "not_registered" }); return; }
          const target = registry.get(msg.targetDeviceId);
          if (!target || !target.online || !target.ws || target.ws.readyState !== target.ws.OPEN) {
            send({ type: "error", code: "target_offline", message: `device ${msg.targetDeviceId} offline` });
            return;
          }
          // 转发 offer 给目标
          target.ws.send(JSON.stringify({
            type: "peer_offer",
            fromDeviceId: deviceId,
            sdp: msg.sdp,
            ice: msg.ice || []
          }));
          break;
        }

        case "answer": {
          if (!deviceId) { send({ type: "error", code: "not_registered" }); return; }
          const target = registry.get(msg.toDeviceId);
          if (!target || !target.online || !target.ws || target.ws.readyState !== target.ws.OPEN) {
            send({ type: "error", code: "target_offline" });
            return;
          }
          target.ws.send(JSON.stringify({
            type: "peer_answer",
            fromDeviceId: deviceId,
            sdp: msg.sdp,
            ice: msg.ice || []
          }));
          break;
        }

        case "list_devices": {
          if (!deviceId) { send({ type: "error", code: "not_registered" }); return; }
          send({ type: "devices", devices: registry.list() });
          break;
        }

        case "relay": {
          // 通用透传:msg.to 指定目标设备,msg.payload 原样转发
          console.log(`[relay] 透传 from=${deviceId} to=${msg.to}`);
          if (!deviceId) { send({ type: "error", code: "not_registered" }); return; }
          const target = registry.get(msg.to);
          console.log(`[relay] 目标存在: ${!!target}, online: ${target?.online}, ws: ${target?.ws?.readyState}`);
          if (!target || !target.online || !target.ws || target.ws.readyState !== target.ws.OPEN) {
            send({ type: "error", code: "target_offline", message: `device ${msg.to} offline` });
            return;
          }
          target.ws.send(JSON.stringify({
            type: "relay",
            from: deviceId,
            payload: msg.payload
          }));
          break;
        }

        case "unregister": {
          if (deviceId) registry.unregister(deviceId);
          deviceId = null;
          break;
        }

        default:
          send({ type: "error", code: "unknown_type", message: `unknown message type: ${msg.type}` });
      }
    });

    ws.on("close", () => {
      console.log(`[relay] 连接关闭 deviceId=${deviceId}`);
      if (deviceId) {
        // 通知可能正等待该设备的对端
        const d = registry.get(deviceId);
        if (d) d.online = false;
        // 广播下线(简化:仅标记,由心跳超时清理)
        setTimeout(() => {
          const cur = registry.get(deviceId);
          if (cur && !cur.online) registry.unregister(deviceId);
        }, 60_000);
      }
    });

    ws.on("error", () => {});
  });

  return {
    port,
    close: () => {
      clearInterval(pruneTimer);
      wss.close();
    }
  };
}
