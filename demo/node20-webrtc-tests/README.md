# Node 20 WebRTC 打洞测试脚本

路线 A 验证用临时脚本(Node 20.19.0,`/tmp/node20/bin/node`)。运行方式:

```sh
NODE=/tmp/node20/bin/node   # 或任意 Node 20
cd demo/node20-webrtc-tests

# node-datachannel 0.33.0 单独 gather(stun / host)
$NODE ndc-gather.mjs stun

# node-datachannel 同进程连接(DataChannel 双向)
$NODE ndc-connect.mjs

# node-datachannel 仅 srflx 候选连接(强制走公网映射 / NAT hairpin)
$NODE ndc-connect-srflx.mjs

# werift 0.24.4 gather(stun / host / multi)
$NODE werift-gather.mjs stun

# 跨主机打洞(需先放行腾讯云安全组入站 TCP 8123 + UDP 大范围端口):
# 1. 上传并启动 cross-relay.mjs 到公网服务器(npm i node-datachannel@0.33.0 后)
# 2. 本机运行: $NODE cross-peer1.mjs <公网IP>
```

详见 `docs/NODE20-PUNCH-RESULT.md`。
