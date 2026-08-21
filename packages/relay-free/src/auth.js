/**
 * relay-free 认证模块(开源免费版)
 *
 * 与商业版(relay-enterprise)保持**同一格式**,便于账号平滑迁移:
 *   - 密码哈希:scrypt$N$r$p$salt$hash(scrypt, N=16384, r=8, p=1, keyLen=64)
 *   - JWT:HMAC-SHA256,payload { sub, email, plan, iat, exp, jti }
 *     header { alg: "HS256", typ: "JWT" }
 *
 * 注意:本模块是免费版的独立实现(内存态、单用户场景),不依赖商业版代码。
 */

import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";

export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLen: 64 };
export const DEFAULT_JWT_TTL_MS = 2 * 60 * 60 * 1000; // 2h,与商业版一致

// ---------- 密码哈希(scrypt,与商业版同格式) ----------

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_PARAMS.keyLen, {
    N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p
  }).toString("hex");
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, N, r, p, salt, hashHex] = parts;
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p)
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------- JWT(HMAC-SHA256,与商业版同格式) ----------

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function signJwt(claims, secret, { ttlMs = DEFAULT_JWT_TTL_MS, jti } = {}) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Date.now();
  const payload = {
    ...claims,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000),
    jti: jti || randomBytes(12).toString("hex")
  };
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

export function verifyJwt(token, secret) {
  try {
    const [h, p, sig] = String(token).split(".");
    if (!h || !p || !sig) return null;
    const expect = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- 免费版存储(内存态,单进程) ----------

/**
 * 创建免费版存储。纯内存,适合个人自建。
 * @returns {{ users: Map, devices: Map, nextUserId: number }}
 */
export function createStore() {
  return { users: new Map(), usersById: new Map(), devices: new Map(), nextUserId: 1 };
}

/**
 * 创建认证服务(API + 信令钩子共用)。
 * @param {object} opts
 * @param {object} opts.store createStore() 返回值
 * @param {string} opts.jwtSecret
 * @param {string[]} [opts.adminEmails] 预留:免费版忽略(单用户)
 * @returns {{
 *   register({email,password}): {token, user},
 *   login({email,password}): {token, user},
 *   logout(token): void,
 *   requireUser(token): {user},
 *   verifyRegister({deviceId,pubKey,token,name}): boolean,
 *   toPublicUser(user): object
 * }}
 */
export function createAuth({ store, jwtSecret }) {
  const users = store.users;
  const usersById = store.usersById;
  const devices = store.devices;

  /** 用户 → 公开字段(绝不外泄 password_hash)。 */
  function toPublicUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      email: u.email,
      plan: u.plan,
      status: u.status,
      created_at: u.created_at
    };
  }

  /** 设备 → 公开字段。 */
  function toPublicDevice(d) {
    return {
      id: d.id,
      device_name: d.device_name,
      pub_key: d.pub_key,
      online: Boolean(d.online),
      created_at: d.created_at
    };
  }

  function requireUser(token) {
    const payload = verifyJwt(token, jwtSecret);
    if (!payload || typeof payload.sub !== "string") {
      const err = new Error("无效或过期的 token");
      err.status = 401;
      err.code = "unauthorized";
      throw err;
    }
    const user = usersById.get(Number(payload.sub));
    if (!user || user.status !== "active") {
      const err = new Error("用户不存在或已禁用");
      err.status = 401;
      err.code = "unauthorized";
      throw err;
    }
    return { user };
  }

  return {
    toPublicUser,
    toPublicDevice,

    register({ email, password }) {
      if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        const err = new Error("邮箱格式不正确");
        err.status = 400; err.code = "bad_email"; throw err;
      }
      if (typeof password !== "string" || password.length < 8) {
        const err = new Error("密码至少 8 位");
        err.status = 400; err.code = "bad_password"; throw err;
      }
      const key = email.toLowerCase();
      if (users.has(key)) {
        const err = new Error("该邮箱已注册");
        err.status = 409; err.code = "email_exists"; throw err;
      }
      const user = {
        id: store.nextUserId++,
        email: key,
        password_hash: hashPassword(password),
        plan: "free",
        status: "active",
        created_at: new Date().toISOString()
      };
      users.set(key, user);
      usersById.set(user.id, user);
      const token = signJwt({ sub: String(user.id), email: user.email, plan: user.plan }, jwtSecret);
      return { token, user };
    },

    login({ email, password }) {
      const key = String(email || "").toLowerCase();
      const user = users.get(key);
      if (!user || !verifyPassword(String(password || ""), user.password_hash)) {
        const err = new Error("邮箱或密码错误");
        err.status = 401; err.code = "invalid_credentials"; throw err;
      }
      if (user.status !== "active") {
        const err = new Error("账号已禁用");
        err.status = 403; err.code = "disabled"; throw err;
      }
      const token = signJwt({ sub: String(user.id), email: user.email, plan: user.plan }, jwtSecret);
      return { token, user };
    },

    logout() {
      // 免费版无状态(内存 JWT),登出由客户端丢弃 token 即可
      return { ok: true };
    },

    requireUser,

    /**
     * 信令注册钩子:校验 JWT + 设备归属。
     * 兼容 relay-core createSignalingServer({ auth: { verifyRegister } })。
     * @param {{deviceId, pubKey?, token?, name?}} msg
     * @returns {boolean}
     */
    verifyRegister({ deviceId, pubKey, token, name } = {}) {
      try {
        if (typeof deviceId !== "string" || deviceId === "") return false;
        const { user } = requireUser(token);
        const existing = devices.get(deviceId);
        if (existing) {
          // 已绑定设备:必须属于当前用户,否则拒绝
          if (existing.user_id !== user.id) return false;
          devices.set(deviceId, { ...existing, pub_key: pubKey || existing.pub_key, online: true });
          return true;
        }
        // 新设备:自动绑定到 token 对应用户
        devices.set(deviceId, {
          id: deviceId,
          user_id: user.id,
          device_name: typeof name === "string" ? name : deviceId,
          pub_key: typeof pubKey === "string" ? pubKey : null,
          online: true,
          created_at: new Date().toISOString()
        });
        return true;
      } catch {
        return false;
      }
    }
  };
}
