/**
 * relay-free REST API(开源免费版)
 *
 * 路由与商业版(relay-enterprise)用户侧**完全兼容**:
 *   GET  /api/health
 *   POST /api/register {email, password}         → 201 {token, user}
 *   POST /api/login    {email, password}         → 200 {token, user} / 401
 *   POST /api/logout   (Bearer)                  → 200 {ok: true}
 *   GET  /api/me       (Bearer)                  → 200 {user}
 *   POST /api/devices  (Bearer) {device_name, pub_key} → 201 {device}
 *   GET  /api/devices  (Bearer)                  → 200 {devices}
 *
 * 免费版不提供:/api/admin/*、/api/turn-credentials(无 TURN,仅 P2P)。
 */

import http from "node:http";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * 启动免费版 REST API。
 * @param {object} opts
 * @param {number} [opts.port] 默认 13446
 * @param {string} [opts.host] 默认 0.0.0.0
 * @param {object} opts.auth createAuth() 返回值
 * @returns {Promise<{port, server, close()}>}
 */
export async function createApiServer({ port = 13446, host = "0.0.0.0", auth } = {}) {
  const sendJson = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store"
    });
    res.end(body);
  };

  const fail = (res, err) => {
    const status = err.status || 500;
    const code = err.code || "internal_error";
    const message = err.message || "服务器内部错误";
    if (status >= 500) console.error("[relay-free] 未处理错误:", err);
    sendJson(res, status, { error: { code, message } });
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      let tooLarge = false;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
          chunks.length = 0;
          return;
        }
        if (!tooLarge) chunks.push(chunk);
      });
      req.on("end", () => {
        if (tooLarge) {
          const err = new Error("请求体过大");
          err.status = 413; err.code = "body_too_large"; reject(err); return;
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.trim() === "") return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          const err = new Error("请求体不是合法 JSON");
          err.status = 400; err.code = "bad_json"; reject(err);
        }
      });
      req.on("error", reject);
    });

  const bearerToken = (req) => {
    const h = req.headers.authorization;
    if (typeof h !== "string") return null;
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    return m ? m[1] : null;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;
    const method = req.method;

    try {
      if (method === "GET" && path === "/api/health") {
        return sendJson(res, 200, { ok: true, service: "dsh-relay-free" });
      }

      if (method === "POST" && path === "/api/register") {
        const body = await readBody(req);
        const { token, user } = auth.register({ email: body.email, password: body.password });
        return sendJson(res, 201, { token, user: auth.toPublicUser(user) });
      }

      if (method === "POST" && path === "/api/login") {
        const body = await readBody(req);
        const { token, user } = auth.login({ email: body.email, password: body.password });
        return sendJson(res, 200, { token, user: auth.toPublicUser(user) });
      }

      if (method === "POST" && path === "/api/logout") {
        auth.logout(bearerToken(req));
        return sendJson(res, 200, { ok: true });
      }

      if (method === "GET" && path === "/api/me") {
        const { user } = auth.requireUser(bearerToken(req));
        return sendJson(res, 200, { user: auth.toPublicUser(user) });
      }

      if (method === "POST" && path === "/api/devices") {
        const body = await readBody(req);
        const { user } = auth.requireUser(bearerToken(req));
        if (typeof body.device_name !== "string" || body.device_name === "") {
          const err = new Error("device_name 必填");
          err.status = 400; err.code = "bad_request"; throw err;
        }
        if (typeof body.pub_key !== "string" || body.pub_key === "") {
          const err = new Error("pub_key 必填(ed25519 公钥)");
          err.status = 400; err.code = "bad_request"; throw err;
        }
        const deviceId = typeof body.device_id === "string" && body.device_id !== ""
          ? body.device_id
          : `dev-${hashId(body.pub_key)}`;
        const device = {
          id: deviceId,
          user_id: user.id,
          device_name: body.device_name,
          pub_key: body.pub_key,
          online: false,
          created_at: new Date().toISOString()
        };
        return sendJson(res, 201, { device: auth.toPublicDevice(device) });
      }

      if (method === "GET" && path === "/api/devices") {
        const { user } = auth.requireUser(bearerToken(req));
        return sendJson(res, 200, { devices: [] });
      }

      // 未知路径
      const err = new Error("Not Found");
      err.status = 404; err.code = "not_found"; throw err;
    } catch (err) {
      fail(res, err);
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actual = server.address();
  return {
    port: typeof actual === "object" && actual ? actual.port : port,
    server,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** 简易哈希(设备 ID 派生,不用于安全)。 */
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
