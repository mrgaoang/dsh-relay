# dsh-relay — 开源信令与 P2P 打洞(DeepSeek Harness 远程控制)

> **在手机浏览器上远程控制你的 DeepSeek Harness**(`dsh web`),即使电脑在 NAT 后面。
> 本仓库是 **dsh-remote Cloud** 的开源部分:信令、STUN、客户端 SDK、免费认证。
> **个人/非商业免费;一条命令自建完整闭环,或接入公共商业服务。**

```
手机浏览器 ──WebRTC──▶ 你的电脑(dsh web)
     │  P2P 直连(打洞成功) / TURN 中继(商业版兜底)
     ▼
  dsh-relay 信令服务(本仓库,开源)
     └── 交换 SDP/ICE(只信令,不碰数据)
```

---

## 两条使用路径

| | ① 自建(开源闭环) | ② 接入公共商业服务 |
|---|---|---|
| 适合 | 有服务器/NAS,想自己掌控 | 没有服务器,想开箱即用 |
| 服务端 | 本仓库 `relay-free`(免费) | `n.risegao.cn`(商业版,付费) |
| 多用户/超管 | ❌ 单用户 | ✅ 多账号 + 套餐 |
| TURN 兜底 | ❌ 仅 P2P | ✅ pro 含 TURN 中继 |
| 成本 | 免费(自备服务器) | 订阅制 |

> 免费版(①)打洞失败(如 4G/5G CGNAT)时无法中继;需要 TURN 兜底请用 ② 或自建 coturn(见 `deploy/turn/`)。

---

## 🚀 路径②:接入公共商业服务(无服务器)

```bash
# 1. 拉取
git clone https://github.com/mrgaoang/dsh-relay.git && cd dsh-relay && npm install

# 2. 安装客户端(注册账号 + 绑定设备 + 连接信令)
DSH_RELAY_EMAIL="你的邮箱" DSH_RELAY_PASSWORD="你的密码" node install-client.mjs
# 或交互式:node install-client.mjs

# 3. 完成!手机浏览器访问 https://n.risegao.cn 即可远程控制
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
| `DSH_RELAY_API` | `https://n.risegao.cn:13446` | 账号 API(注册/登录/设备) |
| `DSH_RELAY_WS` | `wss://n.risegao.cn:13445` | 信令 WebSocket |
| `DSH_RELAY_STUN` | `n.risegao.cn:3478` | STUN(打洞探测) |

> 默认指向公共商业服务。自建用户把三个地址改成自己的服务即可(见路径①)。

---

## 🛠 路径①:自建完整服务(开源闭环,免费)

### 方式 A: Docker 一键部署(推荐)

```bash
docker compose up -d
# 验证:
curl http://127.0.0.1:13446/api/health   # → {"ok":true,"service":"dsh-relay-free"}
# 注册接入:
DSH_RELAY_API=http://127.0.0.1:13446 DSH_RELAY_WS=ws://127.0.0.1:13445 \
  DSH_RELAY_EMAIL="you@example.com" DSH_RELAY_PASSWORD="your-password" \
  node install-client.mjs
```

一条命令起齐 **账号 API + 信令 WebSocket + STUN**,纯开源栈,无需商业版。

### 方式 B: 源码运行(Node ≥ 20)

```bash
npm install
npm run free          # 账号 API(13446)+ 信令(13445)+ STUN(3478)
```

### 公网部署

| 端口 | 协议 | 用途 |
|---|---|---|
| 13446 | TCP | 账号 REST API |
| 13445 | TCP | 信令 WebSocket |
| 3478 | UDP | STUN(打洞探测) |

**必须**:前面加 TLS 反代(nginx/caddy),让账号 API 走 `https://`、信令走 `wss://`
(`install-client` 会拒绝非回环明文传输)。路由器 NAT / 云安全组放行上述端口,
尤其 **UDP 3478**(打洞依赖)。

---

## 🔌 信令协议(简述)

客户端 ↔ 信令服务,JSON over WebSocket:

```js
// 注册(可带 JWT 认证)
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

### 端到端:手机经打洞控制 dsh web

电脑端运行桥接守护进程,手机经 P2P 直连访问本地 dsh web:

```bash
# 电脑端(桥接:打洞流量 → 本地 dsh web)
node clients/dsh-remote/dsh-bridge.mjs ws://<relay> bridge-my-pc

# 手机端(模拟/真实客户端:经打洞发请求)
node clients/dsh-remote/dsh-phone.mjs bridge-my-pc ws://<relay>
```

已验证:手机 `GET /` 与 `POST /api/session.list` 经 P2P DataChannel 直达 dsh web,
返回真实会话数据。帧协议见 `dsh-bridge.mjs` 头部注释。

### TURN 中继(打洞失败兜底)

手机 4G/5G(CGNAT)打洞常失败,需 TURN 中继。方案见
[`docs/TURN-PLAN.md`](docs/TURN-PLAN.md) 与 [`deploy/turn/`](deploy/turn/)。

---

## ❓ FAQ

**打洞成功率多高?**
家庭宽带互连(P2P 直连)成功率较高;手机 4G/5G 因运营商 CGNAT 常常失败。
打洞失败时需要 TURN 中继兜底(商业版 pro 套餐,或自建 coturn)。

**免费版(relay-free)和商业版(relay-enterprise)什么关系?**
`relay-free` 是本仓库开源的单用户认证 + 编排,能独立闭环;
`relay-enterprise` 是闭源商业组件(多用户/超管后台/TURN 配额),通过
`auth.verifyRegister` 钩子与 relay-core 兼容。两者 API 同构,免费版账号
可平滑迁移到商业版。

**数据安全吗?**
信令只转发 SDP/ICE(元数据),业务数据经 WebRTC DTLS 端到端加密,relay
不接触内容。账号密码 scrypt 哈希存储,传输强制 HTTPS/WSS。

**需要什么环境?**
Node ≥ 20(自建服务);客户端任意 Node 环境。Docker 方式无需装 Node。

**如何参与?**
见 [`CONTRIBUTING.md`](CONTRIBUTING.md);安全问题见 [`SECURITY.md`](SECURITY.md)。

---

## 📁 目录结构

```
dsh-relay/
├── install-client.mjs    [开源]一键安装:注册账号+绑设备+连信令
├── packages/
│   ├── protocol/         信令协议定义
│   ├── relay-core/       [开源]信令服务 + STUN 服务
│   └── relay-free/       [开源]免费账号 API + 一键编排(开源闭环)
├── clients/
│   └── dsh-remote/       [开源]客户端:WebRTC 打洞封装 + 测试
├── deploy/turn/          coturn TURN 中继部署(方案)
├── demo/                 Node 20 WebRTC 打洞测试
└── docs/                 测试与方案文档
```

## 测试

```bash
npm test        # relay-core + relay-free 全部单元测试
npm run check   # 语法检查
```

CI:GitHub Actions(Node 20/22 双版本 + npm audit)。

## 商业版(闭源)

多用户账号、SaaS 超管后台、TURN 配额在私有仓库 `dsh-relay-enterprise`(需商业授权)。
个人/非商业用户用本仓库的 `relay-free` 即可。

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE) — 个人/研究/非商业免费;
商业用途需授权(见 [`COMMERCIAL-LICENSE.md`](./COMMERCIAL-LICENSE.md))。
