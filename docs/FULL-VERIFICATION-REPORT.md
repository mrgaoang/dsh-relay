# dsh-relay 全功能验证报告

> 日期:2026-08-20 · 范围:relay-enterprise / relay-admin / relay-core / TURN / 打洞

## 1. relay-enterprise 账号体系(真实服务,非 mock)✅

| 功能 | 结果 |
|---|---|
| 注册(含邮箱归一/弱密码拒绝) | ✅ 201 / 400 |
| 重复邮箱 | ✅ 409 |
| 登录签发 JWT | ✅ 237 字符 token |
| 错误口令 / 未知邮箱 | ✅ 401 |
| /api/me、设备绑定、设备列表 | ✅ 200 |
| 无 token 访问 | ✅ 401 |
| 超管用户列表(ADMIN_EMAILS) | ✅ total=2 |
| 普通用户访问超管接口 | ✅ 403 |
| **人工开通 pro**(配额自动 50GB) | ✅ 200 |
| 禁用 → 登录 403 / 启用 → 登录 200 | ✅ |
| 登录限流(5 连败 → 429) | ✅ |

## 2. relay-admin 对接真实 relay-enterprise ✅

- ADMIN_TOKEN(真实 JWT)加载:237 字符
- /api/users 返回真实数据(2 用户)
- 页面 200、带 token 200、无 token 401
- 超管后台可用真实数据库,非 mock

## 3. 认证信令链路(enterprise + relay-core)✅

- bob 注册登录 → JWT
- bob 用 JWT 信令注册设备 → welcome
- 坏 JWT → rejected:unauthorized
- carol 注册自己的设备
- bob → carol 跨设备 offer 转发成功

## 4. TURN 中继 ✅

- coturn 腾讯云实测(子任务):STUN 探测、TURN Allocate、数据中继 20/20 无丢失、
  过期凭证 401、配额 486
- 凭证算法验证:HMAC-SHA1 正确、过期/错误密钥拒绝
- 客户端配置(TURN-PLAN.md §8):werift 标准格式 + node-datachannel 对象格式

## 5. 跨主机打洞 ⚠️(库缺陷,原理已验证)

| 库 | 结果 |
|---|---|
| node-datachannel 0.33 | **可达 iceState: connected**(srflx 双向交换),但重协商崩溃(库 bug) |
| werift 0.24.4 | srflx 产生 + SDP 交换,ICE 检查未完成 |
| Node 20 本地 | 仅 srflx 候选即可建连(机制成立) |

结论:P2P 打洞原理可行,但两个库的跨网络稳定性不足;
生产打洞层需进一步选型(自研 UDP 打洞 + Noise 加密 或 更新库版本)。

## 6. 总体评估

| 模块 | 成熟度 | 可生产性 |
|---|---|---|
| relay-core(信令/STUN) | ✅ 稳定 | 高 |
| relay-enterprise(账号) | ✅ 32/32 测试 | 高 |
| relay-admin(后台) | ✅ 11/11 E2E | 高(需换 JWT) |
| TURN 中继 | ✅ 实测通过 | 高 |
| P2P 打洞 | ⚠️ 库缺陷 | 中(需选型) |

**建议**:信令/账号/后台/TURN 可进入生产开发;打洞层单独攻关。
