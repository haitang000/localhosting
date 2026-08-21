import crypto from 'node:crypto';
import { config } from './config.js';
import { db, now, audit } from './db.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, keyHex] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const key = Buffer.from(keyHex, 'hex');
    const test = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), key.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(key, test);
  } catch {
    return false;
  }
}

export function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function deviceLabel(userAgent = '') {
  const ua = String(userAgent);
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : '未知浏览器';
  const platform = /Windows NT/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iPod/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '未知设备';
  return `${browser} · ${platform}`;
}

/** Keeps enough of an address to recognise a login, without storing the full IP. */
function maskedIp(ip = '') {
  const value = String(ip).replace(/^::ffff:/, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return `${value.split('.').slice(0, 2).join('.')}.*.*`;
  const parts = value.split(':').filter(Boolean);
  return parts.length ? `${parts.slice(0, 3).join(':')}:*` : '';
}

export function createSession(userId, req) {
  const token = newToken();
  const expires = new Date(Date.now() + config.sessionTtlDays * 86400_000);
  db.prepare(
    'INSERT INTO sessions (token, user_id, device_label, ip_hint, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    token,
    userId,
    deviceLabel(req?.headers?.['user-agent']),
    maskedIp(req?.ip),
    now(),
    expires.toISOString()
  );
  return { token, expires };
}

/** Password policy shared by self-service changes, registration, and admin actions. */
export function passwordProblem(password, username = '') {
  const value = String(password);
  if (value.length < config.passwordMinLength) return `密码至少 ${config.passwordMinLength} 位`;
  if (value.length > 1024) return '密码过长（最多 1024 位）';
  const name = String(username).trim().toLowerCase();
  if (name.length >= 3 && value.toLowerCase().includes(name)) return '密码不能包含用户名';
  return null;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function sweepSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
}
setInterval(sweepSessions, 3600_000).unref();
sweepSessions();

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // 客户端送来畸形 % 序列的 cookie：整条值当不存在，别让一次解码头炸掉请求。
      out[key] = '';
    }
  }
  return out;
}

export const COOKIE = 'lh_session';

export function setSessionCookie(res, token, expires) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires,
    secure: config.publicScheme === 'https',
  });
}

export function attachUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie).lh_session;
  req.sessionToken = token || null;
  if (token) {
    const row = db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`
      )
      .get(token, now());
    // A stopped account never becomes req.user — every guard below reads that
    // one field, so the session stays inert no matter how long the cookie
    // lives. The row is parked on req.disabledUser purely so the panel can say
    // *why* the door is shut instead of bouncing the person to a sign-in form
    // that will not let them in either.
    if (row?.disabled) req.disabledUser = row;
    else if (row) req.user = row;
  }
  next();
}

/** 401 means "log in and this works". A stopped account gets 403 — retrying cannot help. */
export function requireAuth(req, res, next) {
  if (req.disabledUser) return res.status(403).json({ error: '账号已被停用', disabled: true });
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  next();
}

export function requireAdmin(req, res, next) {
  if (req.disabledUser) return res.status(403).json({ error: '账号已被停用', disabled: true });
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

export function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    disabled: !!u.disabled,
    points: u.points ?? 0,
    quota: {
      maxInstances: u.max_instances,
      maxMemoryMb: u.max_memory_mb,
      maxCpus: u.max_cpus,
      maxPorts: u.max_ports,
      allowCustomImage: !!u.allow_custom_image,
    },
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

export function createUser({ username, password, role = 'user', quota = {} }) {
  const info = db
    .prepare(
      `INSERT INTO users
        (username, password_hash, role, max_instances, max_memory_mb, max_cpus, max_ports, allow_custom_image, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      username,
      hashPassword(password),
      role,
      quota.maxInstances ?? config.defaultMaxInstances,
      quota.maxMemoryMb ?? config.defaultMaxMemoryMb,
      quota.maxCpus ?? config.defaultMaxCpus,
      quota.maxPorts ?? config.defaultMaxPorts,
      quota.allowCustomImage ?? (config.defaultAllowCustomImage ? 1 : 0),
      now()
    );
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

/** Creates the first admin account when the database is empty. */
export function bootstrapAdmin() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (c > 0) return null;
  const password = config.adminPassword || newToken(12);
  const user = createUser({
    username: config.adminUsername,
    password,
    role: 'admin',
    quota: { maxInstances: 999, maxMemoryMb: 65536, maxCpus: 64, maxPorts: 64, allowCustomImage: 1 },
  });
  audit(user, 'bootstrap_admin', user.username, null);
  return { username: user.username, password, generated: !config.adminPassword };
}

export const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
