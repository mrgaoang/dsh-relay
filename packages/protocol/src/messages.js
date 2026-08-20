/**
 * dsh-relay 信令协议 v0.1(草案)
 *
 * 传输:JSON over WebSocket(客户端 → relay,relay → 客户端)
 * 所有消息包含 `type` 字段;错误统一为 { type: "error", code, message }。
 *
 * 数据流:
 *   ① 客户端注册(register)→ relay 记录 deviceId + 公钥 + 端点
 *   ② 客户端心跳(heartbeat)→ 保持在线状态,上报最新公网端点(STUN 探测结果)
 *   ③ 发起方(offer)→ relay 找到目标设备 → 转发 offer(SDP+ICE)
 *   ④ 目标方(answer)→ relay 转发回发起方 → 两端 WebRTC 直连
 *
 * relay 只转发 SDP/ICE,不接触业务数据(端到端加密由 WebRTC DTLS 保证)。
 */

/** 客户端 → relay */
export const CLIENT_MESSAGES = {
  /** 注册: { type, deviceId, pubKey, name } */
  REGISTER: "register",
  /** 心跳+端点上报: { type, deviceId, endpoints: [{host, port, type}] } */
  HEARTBEAT: "heartbeat",
  /** 发起 WebRTC 连接: { type, targetDeviceId, sdp, ice, token } */
  OFFER: "offer",
  /** 响应连接: { type, toDeviceId, sdp, ice } */
  ANSWER: "answer",
  /** 断开: { type, deviceId } */
  UNREGISTER: "unregister",
  /** 查询在线设备: { type, token } */
  LIST_DEVICES: "list_devices"
};

/** relay → 客户端 */
export const SERVER_MESSAGES = {
  /** 注册确认: { type, deviceId, ok } */
  WELCOME: "welcome",
  /** 转发 offer: { type, fromDeviceId, sdp, ice } */
  PEER_OFFER: "peer_offer",
  /** 转发 answer: { type, fromDeviceId, sdp, ice } */
  PEER_ANSWER: "peer_answer",
  /** 设备列表: { type, devices: [{deviceId, name, online}] } */
  DEVICES: "devices",
  /** 错误: { type, code, message } */
  ERROR: "error",
  /** 对端离线通知: { type, deviceId } */
  PEER_OFFLINE: "peer_offline"
};

/** 消息类型联合(供校验) */
export const MESSAGE_TYPES = new Set([
  ...Object.values(CLIENT_MESSAGES),
  ...Object.values(SERVER_MESSAGES)
]);
