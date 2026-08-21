# 参与贡献

感谢你对 dsh-relay 的兴趣!无论是 bug 报告、文档改进还是新功能,都欢迎。

## 行为准则

请保持友善、专业。涉及人身攻击、歧视、骚扰的言论会被移除。

## 提 Issue

- **Bug**:说明复现步骤、期望行为、实际行为、环境(Node 版本/OS/网络拓扑)
- **功能建议**:说明使用场景和动机,便于判断是否与项目定位契合
- 搜索已有 issue,避免重复

## 提 PR

1. Fork 本仓库,基于 `main` 建分支
2. 代码风格:与现有代码一致(ESM、`node:` 前缀导入、JSDoc 注释、中文注释)
3. **测试**:relay-core / relay-free 的改动必须有对应测试(`npm test`)
4. 提交信息遵循约定式提交(`feat:` / `fix:` / `docs:` / `test:` / `chore:`)
5. PR 描述说明改动动机和验证方式

## 本地开发

```bash
npm install
npm test          # 全部测试
npm run check     # 语法检查
npm run free      # 本地启动完整开源服务(账号+信令+STUN)
```

## 架构速览

```
packages/relay-core/   信令 WebSocket + STUN(无状态,可单跑)
packages/relay-free/   免费账号 API + 一键编排(开源闭环)
packages/protocol/     信令消息协议定义
clients/dsh-remote/    客户端 SDK(demo + 桥接)
install-client.mjs     普通用户接入脚本
```

## 商业版说明

`relay-enterprise`(多用户/超管/TURN 配额)是闭源商业组件,不在本仓库。
开源版通过 `auth.verifyRegister` 钩子与商业版解耦,可自行扩展。
