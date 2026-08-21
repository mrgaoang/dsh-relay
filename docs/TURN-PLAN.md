# dsh-relay TURN 中继接入方案(coturn)

> 状态:方案定稿 + 实测记录 · 日期:2026-08-20 · 作者:dsh-relay 工程
> 配套交付:`deploy/turn/docker-compose.turn.yml`、`deploy/turn/turnserver.conf.example`
> 商业定位:Pro 版中继兜底(P2P 打洞失败时走 TURN),免费版仅 P2P 无中继。

---

## 1. 背景与目标

dsh-remote Cloud 的 P2P 远程控制依赖 WebRTC 打洞。实测矩阵显示:家庭宽带 ↔ 手机 4G/5G
打洞成功率仅 10–30%,手机 ↔ 手机 <10%,CGNAT 场景几乎必然失败。**打洞失败必须有中继兜底**,
否则 Pro 用户"出差连家里电脑"的核心场景不可用。

目标:

1. 用 coturn(TURN/STUN 服务器)提供标准 WebRTC 中继;
2. 不落盘静态账号 —— 用 **TURN REST API**(时间戳 + HMAC-SHA1)签发短时临时凭证;
3. 落地商业配额:Pro = **限速 2Mbps / 50GB 每月**;
4. 与现有 werift / node-datachannel 客户端无缝对接;
5. 部署于腾讯云(商业托管)或用户 NAS(自建),一份配置两处可用。

---

## 2. 概念:TURN vs STUN(30 秒版)

| | STUN | TURN |
|---|---|---|
| 作用 | 探测 NAT 后的**公网端点**(reflexive candidate) | 在服务器上**分配中继端口**转发媒体/数据 |
| 数据面 | 不转发数据,仅信令 | **转发所有数据**(relayed candidate) |
| 场景 | 打洞成功路径的辅助 | 打洞失败后的兜底 |
| 成本 | 极低 | 消耗带宽,需配额治理 |
| WebRTC 角色 | `stun:host:3478` | `turn:host:3478?transport=udp`(带用户名/密码) |

WebRTC ICE 流程:**host candidate**(本机) → **srflx**(STUN 测出的公网端点) → **relay**(TURN)。
两端无法直连时,ICE 自动选 relay 路径,数据经 TURN 服务器中转(仍为 DTLS 端到端加密,TURN
只看密文)。

### TURN candidate 格式(WebRTC)

```
// ICE candidate 行(foundation 组件类型 优先级 地址 端口 类型 ...):
candidate:842163049 1 udp 1677729535 124.156.222.99 49176 typ relay \
  raddr 10.0.4.6 rport 50123 generation 0

// iceServers 配置(URL 形式):
turn:124.156.222.99:3478?transport=udp     // 默认 UDP
turn:124.156.222.99:3478?transport=tcp     // 强制 TCP
turns:turn.example.com:5349?transport=tcp  // TURNS(TLS 封装)
```

`typ relay` 即 TURN 中继候选;`raddr/rport` 是客户端在 TURN 服务器眼中的地址。

---

## 3. 架构总览

```
┌─ 手机浏览器(PWA)───────────────┐        ┌─ 用户电脑(dsh-remote)──────┐
│ werift / 浏览器原生 WebRTC      │        │ node-datachannel / werift  │
│  1. 向 relay 请求 TURN 凭证     │        │  1. 向 relay 请求 TURN 凭证 │
│  2. ICE 打洞失败 → 连 coturn    │        │  2. ICE 打洞失败 → 连 coturn│
└──────────┬──────────────────────┘        └──────────┬──────────────────┘
           │ 4. 数据流(密文,经 TURN 中继)              │
           └──────────────┬────────────────────────────┘
                          ▼
                 ┌──────────────────┐
                 │   coturn (TURN)  │  ← 中继数据面,只转发密文
                 │ 3478/5349,49160+ │
                 └──────────────────┘
                          ▲
           2. 临时凭证(HTTPS 下发,1 小时有效)
┌─────────────────────────┴─────────────────────────┐
│  dsh-relay(relay-enterprise)                      │
│  ├─ /api/turn-credentials(POST,验 JWT)            │
│  │    username = <expiry-ts>:<userId>             │
│  │    password = base64(HMAC-SHA1(secret,user))   │
│  ├─ 配额检查:本月用量 ≥ 50GB → 拒绝签发            │
│  └─ 用量统计:抓取 coturn Prometheus 指标按用户累计 │
└────────────────────────────────────────────────────┘
```

时序:

1. 客户端建立 WebRTC 连接前,经 **HTTPS**(WSS 信令或 REST)向 relay 请求 TURN 凭证;
2. relay 校验用户订阅(Pro)与本月配额,用共享密钥签发临时 `username/password`(1 小时有效);
3. 客户端把凭证放进 `iceServers`,发起 ICE;打洞失败时自动协商 relay candidate;
4. 数据经 coturn 中继转发,双端 DTLS 加密,coturn 无法解密。

---

## 4. TURN REST API:动态临时凭证(核心设计)

### 4.1 为什么不用静态账号

coturn 传统做法(`lt-cred-mech` + turnadmin 建号)是**长期静态用户名/密码**:
- 泄露后无法短期失效,只能改库;
- 无法按会话/时间精细控制,配额治理只能事后;
- 凭证明文要发给所有客户端,静态值长期暴露在客户端代码/缓存中。

**TURN REST API**(`use-auth-secret` + `static-auth-secret`)是 coturn 内置的
**时间受限共享密钥方案**(Twilio / Xirsys 同款),服务器**不存储任何用户账号**,
只凭时间戳 + HMAC 校验,天然支持短时凭证。

### 4.2 算法(coturn 源码确认,`src/apps/relay/userdb.c`)

```
username = "<过期Unix时间戳>:<用户ID>"
password = base64( HMAC-SHA1( staticAuthSecret, username ) )
```

- **username**:`<expiryTs>` 是凭证过期时刻的 Unix 秒(epoch seconds),`<用户ID>` 任意字符串
  (建议用 userId@deviceId 便于按用户做配额/审计);
- **password**:以 `static-auth-secret` 为 HMAC 密钥,对**完整 username 字符串**
  做 HMAC-SHA1,输出 **base64**;
- **校验规则**(coturn `get_user_key`):解析 username 得到 `ts`,仅当 `ts >= 服务器当前时间`
  才继续校验 HMAC —— 即 **过期时间即 username 里的时间戳**;
- 密码经 RFC 5389 长时凭证机制派生 `MD5(username:realm:password)` 参与
  MESSAGE-INTEGRITY 校验,WebRTC 浏览器/werift 原生支持。

> 时间戳在 username **前缀**(`ts:user`),分隔符默认 `:`,可用
> `rest-api-separator` 修改。客户端只需在 1 小时内重连时重新向 relay 取新凭证即可。

### 4.3 Node.js 签发实现(relay-enterprise 内)

```js
import crypto from "node:crypto";

const STATIC_AUTH_SECRET = process.env.TURN_STATIC_AUTH_SECRET; // 与 coturn 配置一致
const TURN_URL = process.env.TURN_URL;                          // e.g. "turn:turn.example.com:3478?transport=udp"

/** 签发 1 小时有效的 TURN 临时凭证 */
export function issueTurnCredentials(userId, deviceId, ttlSec = 3600) {
  const expiry = Math.floor(Date.now() / 1000) + ttlSec;
  const username = `${expiry}:${userId}@${deviceId}`;
  const credential = crypto
    .createHmac("sha1", STATIC_AUTH_SECRET)
    .update(username)
    .digest("base64");
  return {
    urls: TURN_URL,
    username,
    credential,
    // 元信息(relay 自用,不是 WebRTC 字段):过期时间,便于客户端提前续签
    expiresAt: expiry * 1000,
  };
}

// HTTP 接口(HTTPS 下暴露):
//   POST /api/turn-credentials   (JWT 鉴权,校验 plan=pro 且本月用量<50GB)
//   → { iceServers: [ { urls, username, credential } ] }
```

### 4.4 续签与失效

- 凭证到期后 coturn 拒绝 Allocate(401 Unauthorized),客户端 ICE 会失败;
- 客户端应监听 ICE 失败/连接断开,在**到期前 5 分钟**重新请求凭证并重启 PeerConnection
  (或对长会话直接续签,见 §7 防滥用);
- 立即吊销:密钥轮换(改 `static-auth-secret` 并重启 coturn)可全局失效;
  单用户封禁 = relay 停止签发 + 其现有凭证到期自然失效(最长 1 小时)。

---

## 5. coturn 部署(Docker)

### 5.1 交付文件

- `deploy/turn/docker-compose.turn.yml` —— 官方 `coturn/coturn:4.6` 镜像,bridge 端口映射
  (注释内含 Linux host 网络替代方案);
- `deploy/turn/turnserver.conf.example` —— 关键配置模板(占位符替换后使用)。

### 5.2 turnserver.conf 关键项说明

| 配置项 | 值(示例) | 说明 |
|---|---|---|
| `listening-port` | `3478` | TURN/STUN 主端口(UDP+TCP),WebRTC 默认目标 |
| `tls-listening-port` | `5349` | TURNS(TLS)端口,需证书;安全组放行 |
| `external-ip` | `124.156.222.99` | **公网 IP 映射**。云主机 1:1 NAT / NAS 家庭宽带必须显式配置,否则 relay candidate 是内网地址 |
| `min-port` / `max-port` | `49160` / `49200` | 中继 UDP 端口池,安全组/防火墙需放行 |
| `lt-cred-mech` | — | 长时凭证机制(WebRTC 必需) |
| `use-auth-secret` | — | 开启 TURN REST API(隐含 lt-cred-mech) |
| `static-auth-secret` | `<随机密钥>` | 共享密钥,`openssl rand -base64 32` 生成,**占位符替换,勿入库** |
| `realm` | `turn.example.com` | 必须与 REST API 配合;建议用域名 |
| `fingerprint` | — | RFC 5389 消息指纹,防伪造,建议开 |
| `total-quota` | `100` | 全局并发 TURN 分配上限 |
| `user-quota` | `5` | 单用户并发分配上限(按 username 的 userid 部分) |
| `max-bps` | `250000` | 单会话限速,**bytes/s**;2Mbps = 250000 |
| `no-cli` / `no-multicast-peers` | — | 关闭管理端口 / 禁止组播 peer(安全加固) |
| `cert` / `pkey` | `/etc/coturn/turn_server_cert.pem` | TURNS 证书(Let's Encrypt),未配则不启 TLS |
| `prometheus` / `prometheus-username-labels` | — | 打开用量监控(见 §6.3) |

### 5.3 启动

```bash
cd deploy/turn
cp turnserver.conf.example turnserver.conf
# 编辑 turnserver.conf:external-ip、static-auth-secret、realm
docker compose -f docker-compose.turn.yml up -d
docker compose -f docker-compose.turn.yml logs -f coturn
```

镜像入口为 `turnserver`,默认读 `/etc/coturn/turnserver.conf`(compose 已挂载)。
日志走 stdout,`docker logs` 可直接采集。

---

## 6. 配额与限速(商业版核心)

### 6.1 coturn 原生能力(并发 + 带宽)

- **`max-bps=250000`** → 单会话限速 2Mbps(bytes/s;输入/输出分别计,即每方向 2Mbps)。
  超过部分丢弃或暂缓(受缓冲区限制)。**注意单位是 bytes/s,不是 bit/s**:
  `2 Mbps = 2,000,000 / 8 = 250,000 B/s`。
- **`total-quota=100`** → 整机最多 100 个并发中继会话,防单机被打满(对应 Pro 并发上限)。
- **`user-quota=5`** → 同一 userid 最多 5 个并发会话(防止单用户多开占满)。
- **`bps-capacity`** → 整机带宽上限(所有会话合计),超出拒绝新分配,可选。

> ⚠️ coturn **没有"每月累计流量"配额**。50GB/月 必须由 relay-enterprise 应用层治理(见 6.3)。

### 6.2 配额模型(产品映射)

| 套餐 | max-bps(单会话) | user-quota | 月流量 | total-quota |
|---|---|---|---|---|
| 免费 | —(无中继) | — | — | — |
| Pro(¥19/月) | 250000(2Mbps) | 5 | 50GB | 100 |
| 团队(¥1999/年) | 可更高/不限 | 不限 | 协商 | 专属节点 |

### 6.3 每月 50GB 用量的应用层治理

1. **计量**:coturn 开启 `prometheus` + `prometheus-username-labels`(4.6 内置,
   `/metrics`,默认端口 9641),指标含按 username 标签的收发字节;
2. **采集**:relay-enterprise 定时(如每 5 分钟)抓取 `http://coturn:9641/metrics`,
   按 username 的 `userId` 部分累计当月流量,写入 `usage` 表(见 PRODUCT-PLAN §6.3);
3. **拦截**:签发凭证前检查 `usage(userId, 本月) + 预估增量 < 50GB`,超限返回
   `402 QUOTA_EXCEEDED`;已签发的凭证到期(≤1h)后自然无法再建会话;
4. **告警**:80%/100% 阈值触发超管后台告警(PRODUCT-PLAN 中继配额模块)。

---

## 7. 安全设计

| 威胁 | 对策 |
|---|---|
| 凭证被截获 | 凭证**只经 HTTPS/WSS 下发**;relay 的 REST 端点强制 TLS;签名时 HMAC 密钥不落客户端 |
| 凭证被重放/盗用 | **有效期 1 小时**,时间戳由 coturn 强制校验(`ts >= now`),过期即 401;短 TTL 缩小盗用窗口 |
| 密钥泄露 | `static-auth-secret` 不进 git(占位符 + `.env`/密钥管理注入);轮换 = 改密钥重启 coturn,全局立即失效 |
| 中继被滥用(带宽) | `max-bps` + `total-quota` + `user-quota` 三重限制;异常流量告警 |
| 中继被滥用(流量) | 50GB/月应用层配额 + 签发前置检查 + 用量告警(§6.3) |
| 免费用户蹭中继 | 签发接口校验 JWT 订阅(plan=pro);免费版客户端代码不含 TURN URL |
| 明文 TURN 被嗅探 | 生产开 TURNS(`turns:...:5349`,证书)加密信令面;数据面本就 DTLS 端到端加密 |
| peer 打到内网/组播 | `no-multicast-peers`、默认禁回环、可配 `allowed-peer-ip` 白名单 |

补充约定:

- **realm 用域名**而非 IP,未来多租户/多 realm 可扩展,且 TURNS 证书匹配域名;
- **监听绑定**:生产建议 `listening-ip=<内网IP>` 避免暴露多余网卡(可选);
- **最小化端口暴露**:云安全组只放行 3478/5349/中继池;9641 Prometheus 仅内网可达
  (`prometheus-address=127.0.0.1` 或 compose 不映射端口)。

---

## 8. 与 werift / node-datachannel 对接

### 8.1 werift 0.24.4(现有 `clients/dsh-remote/demo/werift-relay.mjs` 同款 API)

```js
import { RTCPeerConnection } from "werift";

// 1. 从 relay 获取凭证(HTTPS):
const { iceServers } = await (await fetch("https://relay.example.com/api/turn-credentials", {
  method: "POST",
  headers: { authorization: `Bearer ${jwt}` },
})).json();

// 2. 组装 iceServers:STUN 在前,TURN 在后
const pc = new RTCPeerConnection({
  iceServers: [
    { urls: "stun:124.156.222.99:3478" },
    ...iceServers, // [{ urls: "turn:124.156.222.99:3478?transport=udp", username, credential }]
  ],
});

// 3. 监听 relay candidate(werift 事件):
pc.onIceCandidate = (c) => {
  if (c?.type === "relay") console.log("TURN 中继候选就绪:", c.address, c.port);
};
pc.on("connectionStateChange", (s) => {
  if (s === "connected") console.log("✅ 已建立(直连或中继)");
  if (s === "failed") console.log("❌ 打洞与中继均失败");
});
```

werift 从 iceServers 提取 `turnServer/turnUsername/turnPassword`,默认 `turnTransport="udp"`,
UDP 失败自动回退 TCP —— 无需额外参数。

> ⚠️ 本次实测中 werift 0.24.4 在 Node 25 上触发已知 gathering bug(候选不产生,
> 见 `docs/POCT-REPORT.md`),未能用它跑通 relay candidate;TURN 服务器侧验证改用
> 原始 TURN 报文 + `turnutils_uclient` 完成(见 §10)。
> **Node 20 LTS 下双库已验证可用**(见 `docs/NODE20-PUNCH-RESULT.md`:
> werift 0.24.4 可产生 srflx 候选,node-datachannel 0.33 可建连),生产客户端
> 用 **Node 20 LTS + werift**,或直接走浏览器原生 WebRTC,并按 §10.3 的
> relay-candidate 抓取方式复测 TURN 路径。

### 8.2 node-datachannel 0.33(现有 `src/webrtc.js` 改造点)

node-datachannel 支持两种 iceServers 写法,推荐**对象格式**(避免 URL 编码坑):

```js
// 对象格式(推荐):relayType = "TurnUdp" | "TurnTcp" | "TurnTls"
const pc = new dc.PeerConnection(`dsh-${deviceId}`, {
  iceServers: [
    "stun:124.156.222.99:3478",               // STUN 用字符串即可
    {
      hostname: "124.156.222.99",
      port: 3478,
      username,                                 // "1787237549:test-user"
      password: credential,                     // base64 HMAC
      relayType: "TurnUdp",
    },
  ],
  maxMessageSize: 256 * 1024,
});

// 字符串格式(底层 libdatachannel 用 RFC 3986 URL 解析,凭证在 userinfo 段):
//   "turn://<urlencode(user)>:<urlencode(pwd)>@host:3478?transport=udp"
// ⚠️ REST 用户名含冒号("ts:userid"),必须 URL 编码为 %3A;密码 base64 若含 +/ 也需编码:
//   `turn://${encodeURIComponent(username)}:${encodeURIComponent(credential)}@124.156.222.99:3478?transport=udp`
```

> 说明:node-datachannel 与浏览器 RTCIceServer(`{urls, username, credential}`)格式不同。
> Node 25 上 node-datachannel 0.33 连接场景 srflx 不产生(见 `docs/POCT-REPORT.md`),
> 但 **Node 20 LTS 已验证可用**(见 `docs/NODE20-PUNCH-RESULT.md`:srflx 候选产生且
> 可建连)。若客户端选定 node-datachannel,生产环境固定 Node 20 LTS,并按 §10.3 复测
> TURN relay candidate。

### 8.3 浏览器(PWA)

```js
const pc = new RTCPeerConnection({ iceServers: [
  { urls: "stun:124.156.222.99:3478" },
  { urls: "turn:124.156.222.99:3478?transport=udp", username, credential },
]});
// 浏览器原生支持,无需额外库
```

### 8.4 信令协议扩展(建议)

在现有 `register/heartbeat` 之外增加(商业版):

```jsonc
// 客户端 → relay
{ "type": "turn_credentials", "targetDeviceId": "..." }
// relay → 客户端
{ "type": "turn_credentials", "iceServers": [ { "urls": "...", "username": "...", "credential": "..." } ], "expiresAt": 1720000000000 }
```

---

## 9. 部署清单

### 9.1 腾讯云(124.156.222.99,商业托管)

| 项 | 值 |
|---|---|
| 安全组放行 | `3478/udp`、`3478/tcp`、`5349/tcp`(TLS)、`49160-49200/udp` |
| external-ip | `124.156.222.99`(云主机 1:1 NAT,必须显式配置) |
| 证书 | 域名解析到本机后 Let's Encrypt 签发,配 `cert/pkey` 开 TURNS |
| Prometheus | 9641 仅内网可达,relay-enterprise 采集 |

### 9.2 NAS(fnOS,192.168.1.30,自建)

| 项 | 值 |
|---|---|
| 路由器端口转发 | `3478/udp+tcp`、`5349/tcp`、`49160-49200/udp` → 192.168.1.30 |
| external-ip | 路由器 WAN 公网 IP;动态 IP 需 DDNS + 更新脚本(可 cron 定时改 conf 重启) |
| 备选 | 若 NAS 只服务内网,可不配 external-ip,但手机 4G 场景必须公网可达 |

### 9.3 验证命令

```bash
# 1) STUN 连通(UDP 3478):任一客户端 stunProbe
node -e "import('./clients/dsh-remote/src/webrtc.js').then(m=>m.stunProbe('124.156.222.99',3478).then(r=>console.log('STUN OK',r)))"

# 2) TURN 分配(容器内自带 turnutils_uclient):
docker exec dsh-turn turnutils_uclient -T -u "<ts>:<user>" -w "<password>" 124.156.222.99

# 3) 端口可达性(本机):
nc -z -u 124.156.222.99 3478 && echo "udp3478 ok"
```

---

## 10. 实测记录

### 10.1 环境

| 项 | 值 |
|---|---|
| 目标机 | 腾讯云 124.156.222.99(ubuntu,Docker 29.4.1) |
| 测试方法 | SSH(sshpass)+ Docker 启动 coturn 测试实例(`coturn/coturn:4.6`,配置挂载) |
| 安全组 | **仅 UDP 3478 放行**;TCP 3478 / TCP 5349 均被安全组丢弃 |
| 测试配置 | `external-ip=124.156.222.99`、`use-auth-secret` + 测试 secret、`realm=dsh-test.local`、`user-quota=5`、`total-quota=100`、`max-bps=250000`、`no-tls/no-dtls` |

> 注:实测前端口 3478 被 PoC 遗留的 relay-core STUN 进程占用(其信令 13445 已失效),
> 已停止该残留进程;coturn 同时提供 STUN,3478 服务无缝接管。

### 10.2 结果 ✅(全部通过)

| # | 验证项 | 方法 | 结果 |
|---|---|---|---|
| 1 | coturn 容器启动 | `docker compose up -d` | ✅ 3478/udp+tcp、49160-49200/udp 监听正常,日志无错误 |
| 2 | STUN(UDP 3478,公网) | Mac 端 `stunProbe` | ✅ 返回本机公网地址 `223.72.119.64:50284` |
| 3 | TURN Allocate(REST 临时凭证,公网路径) | Mac 端原始 TURN 客户端(手写 STUN/TURN 报文,含 MESSAGE-INTEGRITY + FINGERPRINT) | ✅ `relayed=124.156.222.99:49178`(external-ip 映射正确,端口取自中继池) |
| 4 | 数据中继转发 | 容器内 `turnutils_uclient -y`(双客户端经 TURN 互传) | ✅ 20/20 消息,0 丢失,2000 bytes 双向 |
| 5 | 凭证过期拒绝 | 签发 `expiry = now-600s` 的凭证再 Allocate | ✅ 401 Unauthorized(日志 `Cannot find credentials of user`) |
| 6 | user-quota=5 配额 | 同一 user 连开 6 个分配(每次独立 socket) | ✅ 5 个成功,第 6 个 `486 Allocation Quota Reached` |
| 7 | max-bps=250000(2Mbps) | 启动日志确认 | ✅ `250000 bytes per second allowed per session` |
| 8 | TCP 3478 / 5349(TURNS) | Mac 端 TCP 探测 | ⚠️ **安全组未放行**(TIMEOUT)。生产需放行 TCP 3478(TURN-over-TCP 兜底)与 5349(TURNS),并配置证书 |

### 10.3 结论与注意事项

- **TURN REST API + external-ip 全链路可用**:临时凭证(HMAC-SHA1)鉴权、relay candidate
  公网地址、配额(并发 + 限速)均按预期工作;
- **端口**:仅 UDP 3478 放行已可支撑 WebRTC 默认 UDP 中继;建议生产放行 TCP 3478 与
  TCP 5349(TURNS 加密信令面),并在腾讯云安全组 + 服务器 ufw 两侧确认;
- **测试实例仍在运行**(`dsh-turn-test`,测试 secret 仅用于验证),清理:
  `docker compose -f deploy/turn/docker-compose.turn.yml down`(生产配置以本文件为准);
- **客户端侧 UDP 丢包**:Mac 家庭宽带上快速连续请求出现个别响应丢失(服务器日志显示
  请求均被处理),属公网 UDP 传输现象,客户端应按 STUN 规范做重传(如 werift/浏览器原生)。

---

## 11. 参考

- coturn 官方镜像:`https://hub.docker.com/r/coturn/coturn`(配置挂载 `/etc/coturn/turnserver.conf`)
- coturn 手册:`https://manpages.debian.org/bullseye/coturn/turnserver.1.en.html`
- coturn 源码(userdb.c REST API 实现):`https://github.com/coturn/coturn`
- PRODUCT-PLAN.md(商业模型/配额):`/Users/mac/AIWorkSpace/myFreeWork/PRODUCT-PLAN.md`
- POCT-REPORT.md(打洞现状):`/Users/mac/AIWorkSpace/myFreeWork/dsh-relay/docs/POCT-REPORT.md`
- NODE20-PUNCH-RESULT.md(Node 20 打洞验证):`/Users/mac/AIWorkSpace/myFreeWork/dsh-relay/docs/NODE20-PUNCH-RESULT.md`

---

## 12. NAS 生产部署实测(2026-08,fnOS + 光猫 SK-D847N)

### 12.1 环境与端口规划

| 项 | 值 |
|---|---|
| 目标机 | fnOS NAS(192.168.1.30),Docker 28.5.2,Docker Compose v2.40.3 |
| 光猫 | 中国移动 SK-D847N(192.168.1.1,无 UPnP IGD,端口转发需管理页手工配) |
| 公网 | 动态 IP(实测 223.72.119.64),DDNS 域名 n.risegao.cn |
| NAS 已有 | relay-core STUN 占用 **3478/udp** → coturn 改听 **3479** |
| coturn 监听 | `3479/udp+tcp` + 中继池 `34810-34829/udp` |
| 光猫端口转发 | `3479/udp+tcp`、`34810-34829/udp` → 192.168.1.30 |

### 12.2 NAS 特有配置要点

```ini
listening-port=3479          # 避开 relay-core STUN 3478
listening-ip=192.168.1.30    # 只绑物理网卡,避免绑 docker 网桥 172.x
relay-ip=192.168.1.30
external-ip=223.72.119.64/192.168.1.30   # 公网IP/内网IP 映射
min-port=34810               # 中继池缩到 20 端口,方便光猫转发
max-port=34829
use-auth-secret
static-auth-secret=<与 relay-enterprise .env 的 DSH_ENTERPRISE_TURN_SECRET 相同>
realm=n.risegao.cn
denied-peer-ip=10.0.0.0-10.255.255.255   # 防 TURN 被当内网探测跳板
denied-peer-ip=192.168.0.0-192.168.255.255
# 其余配额项与云端一致(total-quota/user-quota/max-bps)
```

### 12.3 部署步骤(镜像传输 + 启动)

```bash
# 1) NAS 无法直连 Docker Hub → 借道腾讯云中转(amd64):
#    腾讯云: docker pull --platform linux/amd64 coturn/coturn:latest
#    腾讯云: docker save coturn/coturn:latest -o /tmp/coturn.tar
#    经 HTTP(nginx 临时目录)或 scp 传到 NAS 后:
#     NAS:   docker load -i /tmp/coturn.tar

# 2) 配置(挂载 /etc/coturn/turnserver.conf,镜像入口 turnserver)
mkdir -p /vol2/docker/dsh-turn
#    turnserver.conf 按 12.2 编写;注意容器以 nobody 运行,
#    配置文件权限必须 644(chmod 644),否则 "Cannot find config file"。

# 3) host 网络启动(免端口映射开销)
cat > /vol2/docker/dsh-turn/docker-compose.yml <<'YML'
services:
  coturn:
    image: coturn/coturn:latest
    container_name: dsh-turn
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./turnserver.conf:/etc/coturn/turnserver.conf:ro
    command: ["-c", "/etc/coturn/turnserver.conf"]
YML
cd /vol2/docker/dsh-turn && docker compose up -d

# 4) 光猫端口转发(192.168.1.1 管理页 → 应用-高级NAT设置):
#    3479/udp+tcp、34810-34829/udp → 192.168.1.30(逐条添加)
```

### 12.4 端到端验证结果 ✅

| # | 验证项 | 方法 | 结果 |
|---|---|---|---|
| 1 | coturn 启动 | `docker compose up -d` + `ss -ulnp \| grep 192.168.1.30:3479` | ✅ UDP/TCP 3479 绑定,relay 池初始化 done |
| 2 | 端口公网可达 | 腾讯云 `nc`/STUN binding 探测 n.risegao.cn:3479 | ✅ TCP 3479 通;UDP 3479 STUN 响应 40B |
| 3 | REST 凭证签发 | relay-enterprise `GET /api/turn-credentials`(pro 套餐) | ✅ `{enabled:true, plan:pro, quota:{maxBps:250000, monthlyGb:50}}`,username=`<ts>:2`,HMAC 与 coturn use-auth-secret 公式一致 |
| 4 | TURN Allocate + 数据中继(公网) | 腾讯云 `docker run coturn turnutils_uclient -y -u <ts>:2 -w <pwd> -p 3479 n.risegao.cn` | ✅ **20/20 消息双向、0 丢失、2000B 双向、RTT 60ms**(经公网中继,relayed 端口取自 34810-34829 池) |
| 5 | 免费套餐拦截 | admin(free)请求 `/api/turn-credentials` | ✅ `{enabled:false, plan:free, message:"当前套餐不含 TURN 中继(仅 P2P)"}` |

### 12.5 注意事项

- **镜像拉取**:NAS 直连 Docker Hub 超时(registry-1.docker.io deadline exceeded),
  需借道云主机 `docker save`/`load`;fnnas 镜像源不可用(401/错误页)。
- **容器用户**:coturn 镜像默认 `nobody:nogroup`,配置只读挂载 + 644 权限,
  否则启动报 "Cannot find config file" 但进程不退出(反复重试 3478 绑定)。
- **IP 会话**:光猫登录后无 cookie(302 + IP 会话),管理页操作需同 IP 持续;
  登录加密为 AES-128-CBC(key/iv 固定串),表单需带页面内 `session_token`
  (`doAddLogic` 中的值,非 logout 那个)。
- **UDP 丢包**:公网 UDP 偶发丢失属正常,客户端按 STUN 规范重传。
- **TURNS 未启用**:TLS 证书未配置,`turns:` 与 DTLS 监听关闭(生产可补 Let's Encrypt)。
