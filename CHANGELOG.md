# Changelog

## [0.1.0] - 2026-08-21

### 新增

- `packages/relay-free`:开源免费认证桩(register/login/devices + JWT/scrypt),
  与商业版 API 兼容;**纯开源栈可独立端到端闭环**
- `packages/relay-core` 单元测试:STUN、注册/心跳/offer-answer 转发、未授权拒绝、非法 JSON
- `packages/relay-free` 单元测试:密码哈希/JWT/API 全流程/verifyRegister 钩子
- CI:GitHub Actions(Node 20/22 双版本测试 + 语法检查 + npm audit)
- Docker 一键部署:`Dockerfile` + `docker-compose.yml`
- 社区文档:`CONTRIBUTING.md`、`SECURITY.md`、issue 模板
- `install-client.mjs` 安全护栏:拒绝非回环明文 HTTP/WS(防密码明文泄露)

### 变更

- `install-client.mjs` 默认改为 `https://` / `wss://`
- docs 中可复制示例的真实 IP 替换为 `<RELAY_HOST>` 等占位符
- `createStunServer` / `createSignalingServer` 支持 `host` 参数与随机端口

### 修复

- `createSignalingServer` 等待 listening 后再返回(port=0 时可取实际端口)
- `createStunServer` 返回实际绑定端口

## [0.0.1] - 2026-08-20

- 初始版本:relay-core 信令 + STUN + WebRTC 打洞
- 跨主机 P2P 打洞验证成功;TURN 兜底方案验证
