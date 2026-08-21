# dsh-relay 开源免费版 — 一键自建镜像
# 包含:relay-free(账号 API + 信令 + STUN),纯开源栈
# 用法: docker compose up -d(见 docker-compose.yml)
FROM node:22-alpine

WORKDIR /app

# 先复制依赖清单,利用层缓存
COPY package.json package-lock.json ./
COPY packages/relay-core/package.json packages/relay-core/
COPY packages/relay-free/package.json packages/relay-free/
COPY packages/protocol/package.json packages/protocol/
COPY clients/dsh-remote/package.json clients/dsh-remote/

RUN npm ci

# 复制源码
COPY packages/ packages/
COPY clients/ clients/
COPY install-client.mjs ./

# 默认端口(可被 compose 覆盖)
EXPOSE 13446 13445 3478/udp

CMD ["node", "packages/relay-free/src/index.js"]
