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

export function createSession(userId) {
  const token = newToken();
  const expires = new Date(Date.now() + config.sessionTtlDays * 86400_000);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    now(),
    expires.toISOString()
  );
  return { token, expires };
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
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
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
