/**
 * werift 跨主机打洞测试(替代 node-datachannel)
 * 用法: node demo/werift-cross.mjs <a|b>
 * 事件 API: pc.onIceCandidate.subscribe(...) / pc.on("iceConnectionStateChange")
 */
import { RTCPeerConnection } from "werift";
import WebSocket from "ws";

const role = process.argv[2];
const RELAY = process.env.RELAY || "ws://<RELAY_HOST>:13445";
const STUN = process.env.DSH_STUN || "stun:stun.l.google.com:19302";
const deviceId = `w2-${role}`;
const peerId = `w2-${role === "a" ? "b" : "a"}`;

const ws = new WebSocket(RELAY);
const send = (o) => ws.send(JSON.stringify(o));
const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] });

pc.onIceCandidate.subscribe((c) => {
  if (c) {
    const typ = (c.candidate?.match(/typ (\w+)/) || [])[1] || "?";
    console.log(`[${role}] 本地候选[${typ}]: ${c.candidate?.split(" ")[4]}:${c.candidate?.split(" ")[5]}`);
    send({ type: "relay", to: peerId, payload: { kind: "candidate", data: c.toJSON() } });
  }
});

pc.on("iceConnectionStateChange", (s) => {
  console.log(`[${role}] iceState: ${s}`);
  if (s === "connected" || s === "completed") {
    console.log(`[${role}] ✅🎉 P2P 直连成功!`);
    setTimeout(() => process.exit(0), 500);
  }
});

ws.on("open", () => send({ type: "register", deviceId, name: deviceId }));
ws.on("message", async (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "welcome" && role === "a") {
    const dc = pc.createDataChannel("t");
    dc.onopen = () => { console.log("[a] dc open"); dc.send("hello-from-mac"); };
    dc.onmessage = (e) => console.log("[a] 收到:", e.data.toString());
    setTimeout(async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: "relay", to: peerId, payload: { kind: "sdp", data: pc.localDescription } });
      console.log("[a] offer 已发送");
    }, 500);
  }
  if (m.type === "relay" && m.from === peerId) {
    const p = m.payload;
    if (p.kind === "sdp") {
      console.log(`[${role}] 收到SDP: ${p.data.type}`);
      await pc.setRemoteDescription(p.data);
      if (p.data.type === "offer" && role === "b") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: "relay", to: peerId, payload: { kind: "sdp", data: pc.localDescription } });
        console.log("[b] answer 已发送");
      }
    } else if (p.kind === "candidate") {
      try { await pc.addIceCandidate(p.data); } catch (e) {}
    }
  }
});

setTimeout(() => { console.log(`[${role}] 超时`); process.exit(2); }, 30000);
