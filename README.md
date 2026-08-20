# dsh-relay — 开源信令与 P2P 打洞(DeepSeek Harness 远程控制)

dsh-relay 是 **dsh-remote Cloud** 的开源部分:为 DeepSeek Harness 手机远程控制
提供 WebSocket 信令、STUN 打洞与客户端 SDK。**个人/非商业免费**,商业授权见下文。

## 组成(开源)

```
dsh-relay/
├── packages/
│   ├── protocol/      信令协议定义(JSON over WebSocket)
│   └── relay-core/    [开源]信令服务 + STUN 服务
├── clients/
│   └── dsh-remote/    [开源]客户端:WebRTC 打洞封装 + 测试
├── demo/              Node 20 WebRTC 打洞测试
├── deploy/turn/       coturn TURN 中继部署(方案)
└── docs/              测试与方案文档
```

## 快速启动(信令 + STUN)

```bash
# 需要 Node.js ≥ 20(打洞验证基于 20 LTS)
DSH_RELAY_SIGNAL_PORT=13445 DSH_RELAY_STUN_PORT=3478 \
  node packages/relay-core/src/index.js
```

## 客户端打洞(Node 20 LTS)

`node-datachannel 0.33` 在 Node 20 下可产生 srflx 候选并建立直连
(见 `demo/node20-webrtc-tests/` 与 `docs/NODE20-PUNCH-RESULT.md`)。

## 商业版(闭源,单独仓库)

多用户账号、超管后台、TURN 中继配额等商业能力在私有仓库
`dsh-relay-enterprise`(需商业授权)。非商业自建可用本仓库的信令 + 单用户认证。

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE)
个人/研究/非商业免费;商业用途需授权(见 `COMMERCIAL-LICENSE.md`)。
