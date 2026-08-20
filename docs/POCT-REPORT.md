# dsh-relay PoC 测试报告

## 已验证 ✅(PoC 阶段一完成)

| 组件 | 结果 |
|---|---|
| relay-core 信令服务 | ✅ 注册/心跳/offer-answer 转发/设备列表/通用透传,全部通过 |
| relay-core STUN 服务 | ✅ Binding Request → XOR-MAPPED-ADDRESS 正确 |
| 信令协议 | ✅ JSON over WebSocket,错误处理正常 |
| 本地 WebRTC(node-datachannel) | ✅ 同机 DataChannel 建立并传数据 |
| 跨网络信令交换 | ✅ 双向 SDP + candidate 完整交换(Mac ↔ 腾讯云) |
| 公网部署 | ✅ relay 部署腾讯云,Mac 经公网连接正常 |

## 关键发现 ⚠️(WebRTC 库选型)

**在 Node.js 25 上,三个 WebRTC 库都无法可靠实现跨 NAT 打洞**:

| 库 | 问题 |
|---|---|
| **node-datachannel 0.33** | 单独 gather 能产生 srflx;连接场景 srflx 不产生 → ICE 永远 checking。libdatachannel 的已知缺陷 |
| **wrtc 0.4.7** | 打洞成熟,但不兼容 Node ≥ 22(node-pre-gyp 过期) |
| **werift 0.24.4** | 纯 TS 无原生依赖;gathering 能 complete 但 iceCandidate 事件不触发(候选不产生) → 无法交换候选 |

**结论**:Node 生态的 WebRTC 打洞支持在 **Node 22 和 Node 25 上均不成熟**:
- Node 25(Mac):node-datachannel 连接时 srflx 不产生;werift 候选数为 0
- Node 22(腾讯云):werift 候选数也为 0(排除 Node 版本因素)

PoC 阶段一已验证 relay/STUN/协议(云服务核心,与打洞无关);
打洞层需要**技术路线调整**。

## 技术路线调整建议(阶段二)

| 方案 | 评估 |
|---|---|
| **A. 降级 Node 版本(推荐)** | 用 Node 20 LTS 重测 node-datachannel/werift —— 打洞库多为 Node ≤20 开发 |
| **B. 原生/子进程 WebRTC** | 用 Python/C++ WebRTC(如 aiortc/libwebrtc)做打洞端点,Node 只管信令与代理 |
| **C. 自研 UDP 打洞** | STUN 已实现;手动 NAT 打洞 + Noise 加密 + 自定义可靠传输(数据量小,DCH 场景可控) |
| **D. 浏览器优先** | 手机端浏览器原生 WebRTC 打洞;电脑端提供浏览器内嵌控制台(edge 场景) |

**推荐 A 先试**(成本最低):Node 20 LTS + werift/node-datachannel 重测。
若仍不行 → C 自研打洞(relay 协议已就绪,只需替换传输层)。

## 已交付(可复用)

- `packages/relay-core`:信令 + STUN + 通用透传(可部署,已验证)
- `packages/protocol`:协议定义
- `clients/dsh-remote/src/webrtc.js`:WebRTC 封装(打洞库可替换)
- 测试脚本:本地/跨网络信令、WebRTC demo、打洞调试

## 测试环境

- relay:腾讯云 124.156.222.99(13445 信令 + 3478 STUN)
- 设备 A:Mac 家庭宽带(192.168.1.x,CMCC-Happy6)
- 设备 B:腾讯云(公网 124.156.222.99)
- Node 25.7.0(Mac)/ 22.22.1(腾讯云)
