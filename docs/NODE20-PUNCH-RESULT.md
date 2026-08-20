# 路线 A 验证报告:Node 20 LTS 下 WebRTC 打洞(srflx 候选)

> 日期:2026-08-20 · 环境:macOS (Apple Silicon),Node 25.7.0(系统)/ 20.19.0(本次安装)
> 项目:dsh-relay · 目标:验证 node-datachannel 0.33.0 / werift 0.24.4 能否产生 srflx 候选并完成打洞

## 结论(摘要)

**路线 A 可行。** 在 Node 20 LTS 下:

| 库 | 单独 gather(STUN) | srflx 候选 | 连接场景 |
| --- | --- | --- | --- |
| node-datachannel 0.33.0 | ✅ 6 个候选(4 host + 2 srflx),0.3s complete | ✅ 有(IPv4 `223.72.119.64` + IPv6) | ✅ DataChannel 双向打通(含仅 srflx 候选场景) |
| werift 0.24.4 | ✅ 4 个候选(3 host + 1 srflx),0.3s complete | ✅ 有(IPv4 `223.72.119.64`) | 未测(见下) |

关键发现:**srflx 候选不仅被收集,而且可实际用于建连**——在只交换 srflx 候选(过滤全部 host 候选)的实验中,两个 PeerConnection 仍通过 srflx↔srflx 候选对建立连接、DataChannel 双向收发成功。

---

## 1. Node 20 LTS 安装

- **方法**:`nodejs.org` 可直连(未用到 ghproxy / 腾讯云中转),直接下载官方二进制 tarball 解压。
- **路径**:`/tmp/node20/bin/node` → `v20.19.0` ✅
  - 下载:`https://nodejs.org/dist/v20.19.0/node-v20.19.0-darwin-arm64.tar.gz`(41 MB)
  - 校验:`/tmp/node20/bin/node --version` → `v20.19.0`
- 未做全局安装,仅临时目录使用;tarball 已删除,解压目录保留。
- **原生模块**:node-datachannel 0.33.0 使用 **N-API v8** 预编译包(`@node-datachannel/darwin-arm64/node_datachannel.node`),ABI 跨 Node 版本稳定,**Node 20 直接加载成功,无需重新编译**。

## 2. node-datachannel 0.33.0 测试(Node 20.19.0)

### 2.1 单独 gather(iceServers = `stun:stun.l.google.com:19302`)

```json
{ "lib": "node-datachannel", "node": "v20.19.0", "mode": "stun",
  "gatheringState": "complete", "elapsedSec": "0.3",
  "total": 6, "host": 4, "srflx": 2, "prflx": 0, "relay": 0 }
```

- srflx 候选(IPv4):`candidate:... typ srflx raddr 192.168.1.11 rport ...`,公网地址 `223.72.119.64`(与 werift 报告一致,双库交叉验证通过)
- 另有 IPv6 srflx(公网 IPv6 `2409:8a00:...`)
- 对照:不带 iceServers(纯 host)→ 4 host,0 srflx(符合预期)

### 2.2 连接场景(同进程双 PeerConnection,onLocalDescription/onLocalCandidate 互连)

- **DataChannel 双向打开** ✅,`peer1 iceState connected` / `peer2 iceState connected`,`state: connected`,`iceState: completed`,0.3s 完成
- 消息互达:`Hello from Peer1` / `Hello From Peer2` 双方均收到
- 选定候选对为 host↔host(同机局域网 IPv6),验证了 DataChannel 全链路机制

### 2.3 仅 srflx 候选连接(强制走公网映射,NAT hairpin)

- 在 2.2 基础上**过滤掉全部 host 候选,只向对端转发 srflx 候选**(peer1 转发 2 个、peer2 转发 1 个,各跳过 4 个 host)
- **依然连接成功**:`peer1/peer2 iceState completed`,`dc1Open/dc2Open: true`,双向消息互达,0.3s
- 选定候选对:**srflx ↔ srflx**(公网映射地址 `2409:8a00:7892:5a60:bcb1:75af:f9e4:43d7`,`type: "srflx"`)
- 意义:证明 srflx 候选是**可用的数据路径**,而非仅收集。这是跨 NAT 打洞成立的核心机制证据。

## 3. werift 0.24.4 测试(Node 20.19.0)

### 3.1 候选收集(stun / multi)

```json
{ "lib": "werift", "node": "v20.19.0", "mode": "stun",
  "gatheringState": "complete", "elapsedSec": "0.3",
  "total": 4, "host": 3, "srflx": 1 }
```

- srflx:`candidate:02e73fb7... typ srflx raddr 192.168.1.11 rport 63028`,公网 `223.72.119.64` ✅
- multi(STUN×3)结果相同:3 host + 1 srflx,0.3s
- 注意:werift 默认配置自带 `stun:stun.l.google.com:19302`,即使不传 iceServers 也会出 srflx(host 模式测试即因此出了 1 个 srflx)

### 3.2 关于背景中"werift 候选数为 0"的疑似原因

- werift 的候选事件名是 **`onIceCandidate`**(Event 订阅),**不是** `iceCandidate`;且 gather 完成时事件载荷为 `undefined`,候选对象形如 `{ candidate: string, ... }`(`toJSON()` 结果)。
- 若测试代码监听 `pc.on('iceCandidate', ...)` 或按浏览器 WebRTC 事件风格处理,会收不到任何候选。建议复核原测试脚本的事件名与载荷解析。
- Node 版本非主因:本机 **Node 25.7.0 下 node-datachannel 同样产生 srflx**(6 候选 / 2 srflx)。因此背景中"Node 22/25 无 srflx"更可能是当时 STUN 服务器不可达、网络环境或监听方式问题,而非 Node 版本本身。

## 4. 跨主机真实打洞尝试(Mac ↔ 腾讯云 124.156.222.99)——受阻

- 已部署 node-datachannel@0.33.0 至腾讯云(Node v22.22.1,linux-x64 prebuild 加载 OK),搭建了 HTTP 信令总线 + 云端 answerer。
- **阻塞点:腾讯云安全组在网络层丢弃入站流量**:
  - 入站 TCP 8123(信令):从 Mac 连接超时;服务器本机 curl 正常 → 证明 OS 层(iptables INPUT policy ACCEPT、ufw inactive)未拦截,是云安全组拦截。
  - 入站 UDP 9000(数据面探测):Mac 发送的 UDP 包服务器未收到(0 字节)。
- WebRTC 数据面必须入站 UDP,故该跨主机测试在当前安全组配置下无法完成。
- **修复方式**:在腾讯云安全组放行一个 TCP 信令端口(如 8123)及一段 UDP 端口(如 49152–65535),然后重跑 `demo/node20-webrtc-tests/cross-relay.mjs`(云端)+ `cross-peer1.mjs`(本机)。脚本已保留。
- 补充:本机为公网 IPv6 直连环境(2409:8a00:...),IPv4 侧为 NAT(公网 223.72.119.64),两种 srflx 均已由 STUN 正确映射并被双库交叉验证。

## 5. 结论与最小可用配置

**路线 A 可行**:Node 20 LTS 下,node-datachannel 0.33.0 与 werift 0.24.4 均能稳定产生 srflx 候选,且 node-datachannel 已证明 srflx 候选可实际建立连接(DataChannel 双向打通,含仅 srflx 场景)。

**推荐最小配置(node-datachannel,与 dsh-relay 现有依赖一致)**:

```js
const pc = new nodeDataChannel.PeerConnection('Peer', {
  iceServers: ['stun:stun.l.google.com:19302'],  // 可加多路:stun1/stun2.l.google.com
});
// pc.onLocalDescription / pc.onLocalCandidate 转发信令
// pc.onDataChannel / createDataChannel + onOpen / onMessage
```

- 建议在信令/ICE 配置中**至少保留 Google STUN 之一**(或自建 STUN);多路 STUN 可提高公网映射获取的健壮性。
- 若选 werift:注意使用 `pc.onIceCandidate.subscribe(...)` 事件,并解析 `candidate.candidate` 字符串。
- Node 版本建议锁定 20 LTS(与项目 `engines: >=18.20.0` 兼容,prebuild 免编译)。

## 6. 产物与清理

- 测试脚本(保留):`demo/node20-webrtc-tests/`(6 个脚本 + README,含跨主机复测脚本)
- Node 20(保留):`/tmp/node20/`(v20.19.0)
- 已清理:`.tmp-webrtc-tests/`、`/tmp/node20/*.tar.gz`、`/tmp/udp-payload.txt`;腾讯云上 `~/webrtc-cross/`、relay 进程、`/tmp/udp-test.txt` 已删除
- 未修改项目核心代码(`src/webrtc.js` 等)
