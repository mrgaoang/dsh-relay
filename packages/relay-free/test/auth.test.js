/**
 * relay-free 测试:
 *   1. 密码哈希/校验(与商业版同格式)
 *   2. JWT 签发/验证
 *   3. API:register → login → me → devices 全流程
 *   4. verifyRegister 钩子(relay-core 兼容)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuth, createStore, hashPassword, verifyPassword, signJwt, verifyJwt } from "../src/auth.js";
import { createApiServer } from "../src/api.js";

const JWT_SECRET = "test-secret-for-relay-free";

// ---------- 密码哈希 ----------

test("hashPassword/verifyPassword:正确口令通过,错误口令拒绝", () => {
  const hash = hashPassword("correct-horse");
  assert.ok(hash.startsWith("scrypt$16384$8$1$"), "格式与商业版一致");
  assert.ok(verifyPassword("correct-horse", hash));
  assert.ok(!verifyPassword("wrong-password", hash));
});

test("verifyPassword:非法存储值返回 false 而非抛异常", () => {
  assert.equal(verifyPassword("x", "not-a-valid-hash"), false);
  assert.equal(verifyPassword("x", ""), false);
});

// ---------- JWT ----------

test("signJwt/verifyJwt:签发可验证,篡改与过期被拒", () => {
  const token = signJwt({ sub: "1", email: "a@b.c", plan: "free" }, JWT_SECRET);
  const payload = verifyJwt(token, JWT_SECRET);
  assert.equal(payload.email, "a@b.c");
  assert.equal(payload.plan, "free");
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));

  // 篡改 payload → 拒
  const [h, p, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url")), plan: "pro" })).toString("base64url");
  assert.equal(verifyJwt(`${h}.${forged}.${sig}`, JWT_SECRET), null);

  // 过期 → 拒
  const expired = signJwt({ sub: "1" }, JWT_SECRET, { ttlMs: -1000 });
  assert.equal(verifyJwt(expired, JWT_SECRET), null);

  // 错误密钥 → 拒
  assert.equal(verifyJwt(token, "other-secret"), null);
});

// ---------- 认证服务 ----------

test("createAuth:register → login → requireUser 全流程", () => {
  const auth = createAuth({ store: createStore(), jwtSecret: JWT_SECRET });

  // 注册
  const { token, user } = auth.register({ email: "User@Example.com", password: "password123" });
  assert.equal(user.email, "user@example.com", "邮箱小写化");
  assert.equal(user.plan, "free");
  assert.ok(token.length > 20);

  // 重复注册 → 409
  assert.throws(() => auth.register({ email: "user@example.com", password: "password123" }), (e) => e.status === 409);

  // 登录
  const { token: t2, user: u2 } = auth.login({ email: "user@example.com", password: "password123" });
  assert.equal(u2.email, "user@example.com");

  // 错误密码 → 401
  assert.throws(() => auth.login({ email: "user@example.com", password: "wrong" }), (e) => e.status === 401);

  // requireUser
  const { user: me } = auth.requireUser(t2);
  assert.equal(me.plan, "free");
  assert.throws(() => auth.requireUser("bad-token"), (e) => e.status === 401);
});

// ---------- API 服务 ----------

test("createApiServer:健康/注册/登录/me/devices 端到端", async () => {
  const auth = createAuth({ store: createStore(), jwtSecret: JWT_SECRET });
  const api = await createApiServer({ port: 0, host: "127.0.0.1", auth });
  const base = `http://127.0.0.1:${api.port}`;

  const j = async (path, { method = "GET", body, token } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, data: await r.json() };
  };

  try {
    // 健康
    const h = await j("/api/health");
    assert.equal(h.status, 200);
    assert.equal(h.data.service, "dsh-relay-free");

    // 注册
    const reg = await j("/api/register", { method: "POST", body: { email: "u@t.co", password: "password123" } });
    assert.equal(reg.status, 201);
    assert.equal(reg.data.user.plan, "free");
    const token = reg.data.token;

    // me
    const me = await j("/api/me", { token });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, "u@t.co");

    // devices 绑定
    const dev = await j("/api/devices", { method: "POST", token, body: { device_name: "my-mac", pub_key: "ed25519:abc123" } });
    assert.equal(dev.status, 201);
    assert.ok(dev.data.device.id.startsWith("dev-"));

    // 无 token → 401
    const noAuth = await j("/api/devices", { method: "POST", body: { device_name: "x", pub_key: "y" } });
    assert.equal(noAuth.status, 401);

    // 错误密码 → 401
    const badLogin = await j("/api/login", { method: "POST", body: { email: "u@t.co", password: "wrongpass" } });
    assert.equal(badLogin.status, 401);

    // 未知路径 → 404
    const nf = await j("/api/nope");
    assert.equal(nf.status, 404);
  } finally {
    await api.close();
  }
});

// ---------- verifyRegister 钩子(relay-core 兼容) ----------

test("verifyRegister:有效 token 通过,无效拒绝,设备归属校验", () => {
  const auth = createAuth({ store: createStore(), jwtSecret: JWT_SECRET });
  const { token } = auth.register({ email: "dev@x.co", password: "password123" });

  // 新设备自动绑定 → true
  assert.equal(auth.verifyRegister({ deviceId: "phone-1", pubKey: "ed25519:k1", token, name: "phone" }), true);

  // 同一设备再次注册(同用户)→ true
  assert.equal(auth.verifyRegister({ deviceId: "phone-1", pubKey: "ed25519:k1", token, name: "phone" }), true);

  // 无效 token → false
  assert.equal(auth.verifyRegister({ deviceId: "phone-2", token: "invalid" }), false);

  // 缺 deviceId → false
  assert.equal(auth.verifyRegister({ token }), false);
});
