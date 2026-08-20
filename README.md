# dsh-relay — 开源信令与 P2P 打洞(DeepSeek Harness 远程控制)

> **在手机浏览器上远程控制你的 DeepSeek Harness**(`dsh web`),即使电脑在 NAT 后面。
> 本仓库是 **dsh-remote Cloud** 的开源部分:信令、STUN、客户端 SDK。个人/非商业免费。

```
手机浏览器 ──WebRTC──▶ 你的电脑(dsh web)
     │  P2P 直连(打洞成功) / TURN 中继(商业版)
     ▼
  dsh-relay 信令服务(本仓库,开源)
     └── 交换 SDP/ICE(只信令,不碰数据)
```

---

## 🚀 快速开始:作为"普通用户"接入

如果你想**用现成的服务**(别人已部署好的 dsh-relay),三步接入:

```bash
# 1. 拉取
git clone https://github.com/mrgaoang/dsh-relay.git
cd dsh-relay
npm install

# 2. 安装客户端(注册账号 + 绑定设备 + 连接信令)
DSH_RELAY_EMAIL="你的邮箱" DSH_RELAY_PASSWORD="你的密码" node install-client.mjs
# 或交互式:node install-client.mjs

# 3. 完成!手机浏览器访问服务提供方给的地址,即可远程控制
```

**`install-client.mjs` 做了什么**:

| 步骤 | 说明 |
|---|---|
| ① 服务在线检测 | 连接账号 API(`DSH_RELAY_API`) |
| ② 注册/登录 | 邮箱+密码,自动注册(free 套餐)或登录 |
| ③ 绑定设备 | 本机生成设备身份,上报公钥 |
| ④ 信令注册 | 用 JWT 在信令服务器注册设备,可被发现 |

**环境变量**:

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_RELAY_API` | `http://n.risegao.cn:13446` | 账号 API(注册/登录/设备) |
| `DSH_RELAY_WS` | `ws://n.risegao.cn:13445` | 信令 WebSocket |
| `DSH_RELAY_STUN` | `n.risegao.cn:3478` | STUN(打洞探测) |

> 想用**自己的服务**?把上面三个地址改成你自己部署的 relay 地址即可(见下文)。

---

## 🛠 自建服务(把 relay 部署到你自己的服务器)

### 组件

| 组件 | 端口 | 说明 |
|---|---|---|
| `relay-core` 信令服务 | 13445(WS)+ 3478(UDP STUN) | 本仓库,开源 |
| 账号 API | 13446 | **商业版**(`dsh-relay-enterprise`),或自建单用户认证 |

### 启动信令 + STUN

```bash
# 需要 Node.js ≥ 20(打洞验证基于 20 LTS)
DSH_RELAY_SIGNAL_PORT=13445 DSH_RELAY_STUN_PORT=3478 \
  node packages/relay-core/src/index.js
```

验证:

```bash
# STUN 探测
node -e "
const dgram=require('dgram');const s=dgram.createSocket('udp4');
const m=Buffer.alloc(20);m.writeUInt16BE(1,0);m.writeUInt32BE(0x2112a442,4);Buffer.from('abcdefghijkl').copy(m,8);
s.send(m,3478,'127.0.0.1');
s.on('message',()=>{console.log('STUN OK');process.exit(0)});
setTimeout(()=>process.exit(1),3000);"
```

### 公网部署(关键:开放端口)

| 端口 | 协议 | 用途 |
|---|---|---|
| 13445 | TCP | 信令 WebSocket(客户端连这里) |
| 3478 | UDP | STUN(打洞探测) |
| 13446 | TCP | 账号 API(商业版) |

路由器 NAT / 云安全组需放行上述端口(尤其 **UDP**,打洞依赖它)。

---

## 🔌 信令协议(简述)

客户端 ↔ 信令服务,JSON over WebSocket:

```js
// 注册(可带 JWT 认证,商业版)
{ "type": "register", "deviceId": "my-pc", "token": "<jwt>" }
→ { "type": "welcome", "ok": true }

// 发起连接(offerer)
{ "type": "offer", "targetDeviceId": "my-phone", "sdp": "...", "ice": [...] }
→ 信令转发给目标: { "type": "peer_offer", "fromDeviceId": "my-pc", "sdp": "...", "ice": [...] }

// 响应(answerer)
{ "type": "answer", "toDeviceId": "my-pc", "sdp": "...", "ice": [...] }

// 通用透传(自定义负载)
{ "type": "relay", "to": "my-phone", "payload": { ... } }
```

完整定义见 [`packages/protocol/`](packages/protocol/)。

---

## ⚡ P2P 打洞(WebRTC)

### 原理

两端都在 NAT 后面时,经 STUN 探测出各自的**公网映射地址**(srflx 候选),
通过信令交换后,向对方公网地址发 UDP 包打通(NAT 打洞),建立 WebRTC
DataChannel 直连 —— **数据不经过任何服务器**。

### ✅ 已验证:跨主机 P2P 直连成功

- **Node 20 LTS** + `node-datachannel 0.33`:跨主机(家庭 NAT ↔ 云服务器)
  经信令交换后 **`iceState: connected`,DataChannel 建立**,数据不经过服务器
- 关键:遵循官方模式(不手动 setLocalDescription),见 `docs/PUNCH-BREAKTHROUGH.md`
  与 `clients/dsh-remote/demo/punch-official.mjs`
- 手机 4G/5G(CGNAT)打洞常失败,需 TURN 中继(见 `docs/TURN-PLAN.md`)

### 最小打洞代码

```js
import * as dc from "node-datachannel";
const pc = new dc.PeerConnection("Peer", {
  iceServers: ["stun:stun.l.google.com:19302"],  // 或你的 STUN
});
pc.onLocalDescription((sdp, type) => /* 经信令发给对端 */);
pc.onLocalCandidate((c, m) => /* 经信令发给对端 */);
// 对端 setRemoteDescription + addRemoteCandidate 后自动打洞
```

### TURN 中继(打洞失败兜底)

手机 4G/5G(CGNAT)打洞常失败,需 TURN 中继。方案见
[`docs/TURN-PLAN.md`](docs/TURN-PLAN.md) 与 [`deploy/turn/`](deploy/turn/)。

---

## 📁 目录结构

```
dsh-relay/
├── install-client.mjs    [新]一键安装:注册账号+绑设备+连信令
├── packages/
│   ├── protocol/         信令协议定义
│   └── relay-core/       [开源]信令服务 + STUN 服务
├── clients/
│   └── dsh-remote/       [开源]客户端:WebRTC 打洞封装 + 测试
├── demo/                 Node 20 WebRTC 打洞测试
├── deploy/turn/          coturn TURN 中继部署(方案)
└── docs/                 测试与方案文档
```

## 商业版(闭源)

多用户账号、SaaS 超管后台、TURN 配额在私有仓库 `dsh-relay-enterprise`(需商业授权)。

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE) — 个人/研究/非商业免费;
商业用途需授权(见 [`COMMERCIAL-LICENSE.md`](./COMMERCIAL-LICENSE.md))。
