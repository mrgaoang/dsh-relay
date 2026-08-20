# 打洞攻关成功报告

> 日期:2026-08-20 · 结果:**跨主机 P2P 直连成功**

## 结论

**node-datachannel 跨 NAT 打洞成功**(`iceState: connected`,DataChannel 建立),
此前崩溃的根因已查明并解决。

## 根因

之前的 `punch-breakthrough.mjs` 在 answerer 端**手动调用
`setLocalDescription("answer")`**,导致与 node-datachannel 自动生成的
answer 冲突,触发 `Unexpected local description type answer in signaling state stable`。

**正确用法(官方示例模式)**:
- offerer:`createDataChannel()` 自动生成 offer(触发 onLocalDescription)
- answerer:`setRemoteDescription(offer)` 后**自动生成 answer**
- 两端只做:onLocalDescription 转发 SDP + onLocalCandidate 转发候选
- **全程不手动 setLocalDescription**

## 验证场景

- 设备 A:Mac(家庭 NAT,公网 223.72.119.64)
- 设备 B:腾讯云(公网 124.156.222.99)
- 信令:NAS relay(ws://n.risegao.cn:13445)
- A 走内网 192.168.1.30 连 NAS,B 走公网连 NAS(同一信令服务)
- STUN:stun.l.google.com:19302
- Node 20.19.0 + node-datachannel 0.33.0

## 结果

```
[a] 注册成功 → 发送 offer → 收到 answer → iceState: connected → ✅ 直连成功
[b] 注册成功 → 收到 offer → 自动生成 answer → iceState: checking → connected
```

无崩溃,连接稳定建立。

## 关键代码(官方模式)

```js
const pc = new dc.PeerConnection("Peer", { iceServers: [STUN] });
pc.onLocalDescription((sdp, type) => /* 经信令转发给对端 */);
pc.onLocalCandidate((c, m) => /* 经信令转发给对端 */);
// offerer:
pc.createDataChannel("t");  // 自动生成 offer
// answerer:
pc.setRemoteDescription(sdp, type);  // 自动生成 answer
```

## 脚本

- `clients/dsh-remote/demo/punch-official.mjs` — 官方模式跨主机打洞(可用)

## 意义

P2P 打洞**可行且稳定**,数据不经过服务器。商业版 TURN 中继仅作 4G/CGNAT 兜底。
