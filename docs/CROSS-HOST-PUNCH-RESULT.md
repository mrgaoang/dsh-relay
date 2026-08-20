# 跨主机打洞实测结果

> 日期:2026-08-20 · Mac(家庭 NAT 223.72.119.64)↔ 腾讯云(公网 124.156.222.99)

## 结论

**跨 NAT 打洞可以成功建立连接**,但 node-datachannel 0.33.0 在连接建立后的
ICE 重协商阶段存在**原生层崩溃缺陷**(`Unexpected local description type answer
in signaling state stable`),导致连接不稳定。

## 证据

1. **第一次完整测试**:两端均打印 `iceState: connected` ✅
   - A(Mac):产生 srflx 候选 `223.72.119.64:63731`(家庭公网 IP)+ IPv6 srflx
   - B(腾讯云):产生 srflx 候选 `124.156.222.99:50162`,收到 A 的 srflx
   - 双向候选交换完整,ICE 达到 connected
2. **Node 20 本地测试**(`demo/node20-webrtc-tests/`):
   - 仅交换 srflx 候选即可建立 DataChannel 双向连接(打洞机制成立)
3. **成功率测试**:连续多轮中,部分轮次可达 connected,但随后因原生崩溃/超时失败

## 崩溃根因

node-datachannel(libdatachannel)在 ICE 连接建立后的**重协商**中,
`onLocalDescription` 回调触发 answer 生成,与 signaling state 冲突,
原生层抛 `std::logic_error`。尝试过 signaling state 守卫,仍无法避免
(原生内部触发,非应用层可控)。

## 对产品的意义

- ✅ **P2P 打洞原理验证成功**(srflx 可建连,跨 NAT 可达 connected)
- ⚠️ **node-datachannel 不适合作为生产打洞库**(重协商崩溃)
- 结论与 POCT-REPORT 一致:打洞层需选替代方案
  - 候选:werift(Node 20 下可用,事件 API 需正确使用)
  - 或:自研 UDP 打洞 + Noise 加密(可控性最强)

## werift 0.24.4 跨主机补充测试(2026-08-20)

- 两端均产生 srflx 候选(Mac `223.72.119.64`,腾讯云 `124.156.222.99`)并完整交换 SDP
- A 收到 B 的 answer,但 ICE 检查未完成(30s 超时)
- werift 0.24.4 的 ICE 连接实现在 Node 22/25 上仍有缺陷
- 结论:两个库(ndc/werift)的跨主机打洞均有库层面问题,正式开发需
  更深入选型(或自研打洞层)

## 测试脚本

- `clients/dsh-remote/demo/cross-host-punch.mjs` — 单轮跨主机测试
- `clients/dsh-remote/demo/punch-rate-test.mjs` — 成功率统计
- 腾讯云侧:relay-core(STUN+信令)+ 上述脚本
