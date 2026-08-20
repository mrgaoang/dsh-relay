/**
 * dsh-relay 客户端 WebRTC 打洞模块
 *
 * 职责:
 *   1. 通过信令服务器注册设备、心跳保活
 *   2. 用 STUN 探测自己的公网端点
 *   3. 发起/响应 WebRTC 连接(ICE 打洞)→ DataChannel
 *   4. 打洞失败时可通过 TURN(商业版)兜底
 *
 * 依赖:node-datachannel(遵循官方 README 回调驱动模式)
 */

import * as dc from "node-datachannel";
import WebSocket from "ws";
import dgram from "node:dgram";

// ---------- STUN 探测 ----------

/**
 * 用 STUN 探测本机公网端点。
 * @returns {Promise<{address: string, port: number}|null>}
 */
export function stunProbe(stunHost, stunPort = 3478, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const MAGIC = 0x2112a442;
    const txId = Buffer.from("dshprobeabcd");
    const msg = Buffer.alloc(20);
    msg.writeUInt16BE(0x0001, 0);
    msg.writeUInt16BE(0, 2);
    msg.writeUInt32BE(MAGIC, 4);
    txId.copy(msg, 8);

    const timer = setTimeout(() => { socket.close(); resolve(null); }, timeoutMs);

    socket.on("message", (resp) => {
      if (resp.readUInt16BE(0) !== 0x0101) return;
      let offset = 20;
      while (offset + 4 <= resp.length) {
        const atype = resp.readUInt16BE(offset);
        const alen = resp.readUInt16BE(offset + 2);
        if (atype === 0x0020) {
          const port = resp.readUInt16BE(offset + 6) ^ 0x2112;
          const addr = [...resp.subarray(offset + 8, offset + 12)]
            .map((b, i) => b ^ [0x21, 0x12, 0xa4, 0x42][i]).join(".");
          clearTimeout(timer);
          socket.close();
          resolve({ address: addr, port });
          return;
        }
        offset += 4 + alen;
      }
    });
    socket.on("error", () => { clearTimeout(timer); socket.close(); resolve(null); });
    socket.send(msg, stunPort, stunHost);
  });
}

// ---------- 信令客户端 ----------

/**
 * 信令客户端:负责与 relay 通信。
 * 回调:onOffer(msg) / onAnswer(msg) —— 由 WebrtcNode 绑定。
 */
export class SignalingClient {
  constructor(relayUrl, { deviceId, name, pubKey, stunHost, stunPort } = {}) {
    this.relayUrl = relayUrl;
    this.deviceId = deviceId;
    this.name = name || deviceId;
    this.pubKey = pubKey || null;
    this.stunHost = stunHost;
    this.stunPort = stunPort || 3478;
    this.ws = null;
    this.endpoints = [];
    this.onOffer = null;
    this.onAnswer = null;
    this._deviceListWaiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.relayUrl);
      this.ws.on("open", () => {
        this.send({ type: "register", deviceId: this.deviceId, name: this.name, pubKey: this.pubKey });
        this.ws.once("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "welcome" && msg.ok) resolve();
          else reject(new Error("registration failed"));
        });
        this._startHeartbeat();
      });
      this.ws.on("message", (raw) => this._handleMessage(raw));
      this.ws.on("error", (e) => reject(e));
      this.ws.on("close", () => {
        setTimeout(() => { try { this.connect().catch(() => {}); } catch {} }, 5000);
      });
    });
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(async () => {
      if (this.stunHost) {
        const ep = await stunProbe(this.stunHost, this.stunPort);
        if (ep) {
          this.endpoints = [ep];
          this.send({ type: "heartbeat", deviceId: this.deviceId, endpoints: [ep] });
          return;
        }
      }
      this.send({ type: "heartbeat", deviceId: this.deviceId });
    }, 15_000);
  }

  _handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case "peer_offer": this.onOffer?.(msg); break;
      case "peer_answer": this.onAnswer?.(msg); break;
      case "devices": {
        for (const w of this._deviceListWaiters.splice(0)) w(msg.devices);
        break;
      }
      default: break;
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  offer(targetDeviceId, sdp, ice) {
    this.send({ type: "offer", targetDeviceId, sdp, ice });
  }

  answer(toDeviceId, sdp, ice) {
    this.send({ type: "answer", toDeviceId, sdp, ice });
  }

  listDevices() {
    return new Promise((resolve) => {
      this._deviceListWaiters.push(resolve);
      this.send({ type: "list_devices" });
    });
  }

  close() {
    clearInterval(this._heartbeatTimer);
    try { this.send({ type: "unregister", deviceId: this.deviceId }); } catch {}
    try { this.ws?.close(); } catch {}
  }
}

// ---------- WebRTC 打洞 ----------

/**
 * WebRTC 节点:封装 node-datachannel PeerConnection + DataChannel。
 * 遵循官方回调驱动模式:
 *   - onLocalDescription(sdp, type) → 信令转发给对端
 *   - 对端 setRemoteDescription(sdp, type) 自动协商
 *   - onLocalCandidate(candidate, mid) → 信令转发
 *   - offerer: createDataChannel;answerer: onDataChannel
 */
export class WebrtcNode {
  constructor({ signaling, isOfferer, label = "dsh-data" } = {}) {
    this.signaling = signaling;
    this.isOfferer = isOfferer;
    this.label = label;
    this.peerId = null;
    this.pc = null;
    this.dc = null;
    this.onData = null;
    this.onOpen = null;
    this.onStateChange = null;
  }

  init() {
    // 标准 STUN url(官方示例格式);TURN 商业版注入
    const iceServers = this.signaling.stunHost
      ? [`stun:${this.signaling.stunHost}:${this.signaling.stunPort}`]
      : [];

    // 多监听器事件分发(node-datachannel 回调是单槽,这里统一分发)
    const makeEmitter = () => { const cbs = []; return { on: (cb) => cbs.push(cb), emit: (...a) => { for (const cb of cbs) { try { cb(...a); } catch {} } } }; };
    this._onGather = makeEmitter();
    this._onIce = makeEmitter();
    this._onState = makeEmitter();

    this.pc = new dc.PeerConnection(`dsh-${this.signaling.deviceId}`, {
      iceServers,
      maxMessageSize: 256 * 1024
    });

    this.pc.onStateChange((state) => {
      this._onState.emit(state);
      this.onStateChange?.(state);
    });

    // 本地 SDP → 缓存,等 gathering complete(含 srflx)后与 candidate 一起发送
    this._localSdp = null;
    this.pc.onLocalDescription((sdp, type) => {
      this._localSdp = { sdp, type };
      this._trySendLocal();
    });

    // 本地 ICE candidate:收集起来,gathering complete 后一次性发送(非 trickle,确保 srflx 就绪)
    this._pendingCandidates = [];
    this.pc.onLocalCandidate((candidate, mid) => {
      this._pendingCandidates.push({ candidate, mid });
    });
    this.pc.onGatheringStateChange((state) => {
      this._onGather.emit(state);
      if (state === "complete") {
        this._trySendLocal();
      }
    });

    // 本地描述 + gathering complete 都就绪时,一次性发送 SDP + candidates
    this._trySendLocal = () => {
      if (!this.peerId || !this._localSdp || this.pc.gatheringState() !== "complete") return;
      const { sdp, type } = this._localSdp;
      const ice = this._pendingCandidates;
      this._pendingCandidates = [];
      this._localSdp = null;
      console.log(`[webrtc] ${this.signaling.deviceId} 发送 SDP(${type}) + ${ice.length} candidates → ${this.peerId}`);
      if (this.isOfferer) {
        this.signaling.offer(this.peerId, sdp, ice);
      } else {
        this.signaling.answer(this.peerId, sdp, ice);
      }
    };

    // offerer 创建 DataChannel;answerer 接收
    if (this.isOfferer) {
      this.dc = this.pc.createDataChannel(this.label);
      this._setupDataChannel(this.dc);
    }
    this.pc.onDataChannel((dc) => {
      this.dc = dc;
      this._setupDataChannel(dc);
    });

    // 信令回调
    this.signaling.onOffer = (msg) => this._handleOffer(msg);
    this.signaling.onAnswer = (msg) => this._handleAnswer(msg);
  }

  _handleOffer(msg) {
    this.peerId = msg.fromDeviceId;
    console.log(`[webrtc] ${this.signaling.deviceId} 收到offer from=${msg.fromDeviceId} sdp=${!!msg.sdp} ice=${msg.ice?.length ?? 0}`);
    if (msg.sdp) this.pc.setRemoteDescription(msg.sdp, "Offer");
    if (msg.ice) {
      for (const c of msg.ice) {
        try { console.log(`[webrtc] ${this.signaling.deviceId} addRemoteCandidate: ${c.candidate.split(" ")[4]} ${c.candidate.split(" ")[5]}`); this.pc.addRemoteCandidate(c.candidate, c.mid); } catch (e) { console.log("addRemoteCandidate err:", e); }
      }
    }
  }

  _handleAnswer(msg) {
    this.peerId = msg.fromDeviceId;
    console.log(`[webrtc] ${this.signaling.deviceId} 收到answer from=${msg.fromDeviceId} sdp=${!!msg.sdp} ice=${msg.ice?.length ?? 0}`);
    if (msg.sdp) this.pc.setRemoteDescription(msg.sdp, "Answer");
    if (msg.ice) {
      for (const c of msg.ice) {
        try { console.log(`[webrtc] ${this.signaling.deviceId} addRemoteCandidate: ${c.candidate.split(" ")[4]} ${c.candidate.split(" ")[5]}`); this.pc.addRemoteCandidate(c.candidate, c.mid); } catch (e) { console.log("addRemoteCandidate err:", e); }
      }
    }
  }

  _setupDataChannel(dc) {
    dc.onOpen(() => this.onOpen?.(dc));
    dc.onMessage((msg) => this.onData?.(msg));
    dc.onClosed(() => {});
    dc.onError(() => {});
  }

  /** 作为 offerer 发起连接(等待本地 gather complete 保证 srflx 就绪) */
  async startOffer(targetDeviceId) {
    this.peerId = targetDeviceId;
    // 立即生成 offer 触发 gathering(STUN 探测开始)
    if (!this.pc.localDescription()) {
      this.pc.setLocalDescription("offer");
    }
    // 等 gathering complete(含 srflx),最多 20 秒
    await new Promise((resolve) => {
      if (this.pc.gatheringState() === "complete") return resolve();
      this._onGather.on((s) => { if (s === "complete") resolve(); });
      setTimeout(resolve, 20000);
    });
  }

  /** 发送数据(需在 DataChannel 打开后) */
  send(data) {
    if (this.dc && this.dc.isOpen()) this.dc.sendMessage(data);
  }

  close() {
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
  }
}
