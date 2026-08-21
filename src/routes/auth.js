import { Router } from 'express';
import { db, now, audit } from '../db.js';
import {
  COOKIE,
  createSession,
  createUser,
  destroySession,
  publicUser,
  requireAuth,
  setSessionCookie,
  verifyPassword,
  hashPassword,
  passwordProblem,
  USERNAME_RE,
} from '../auth.js';
import { usage } from '../instances.js';
import { getInvite, inviteProblem, consume, publicInvite, vouchersFor } from '../invites.js';
import { grantWelcomePoints, grantPoints, txnsFor } from '../points.js';
import { publicOnboarding, updateOnboarding, markVoucherSeen } from '../onboarding.js';
import { createPow, verifyPow, createTurnstile, mintToken, verifyTurnstile, verifyChallenge } from '../captcha.js';
import { config } from '../config.js';
import { TERMS_VERSION } from '../terms.js';
import { PRIVACY_VERSION } from '../privacy.js';
import * as announcements from '../announcements.js';
import { logger } from '../logger.js';

export const router = Router();

// --- crude in-memory brute force guard ---
const attempts = new Map(); // key -> { n, until }
function throttle(key) {
  const rec = attempts.get(key);
  if (rec && rec.until > Date.now()) {
    const secs = Math.ceil((rec.until - Date.now()) / 1000);
    throw Object.assign(new Error(`尝试过于频繁，请 ${secs} 秒后再试`), { status: 429 });
  }
}
function fail(key) {
  const rec = attempts.get(key) ?? { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= 5) {
    rec.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (rec.n - 5));
    rec.n = 0;
  }
  attempts.set(key, rec);
}
const clear = (key) => attempts.delete(key);

/**
 * 注册和登录共用的《用户协议》与《隐私政策》门槛。前端把当前展示的两个
 * 文档版本随表单提交，版本对得上才放行——正文改了但页面还开着的旧标签，
 * 会被要求刷新重读，而不是替用户同意一份没看过的文档。
 */
function agreementProblem(body) {
  if (!config.termsRequired) return null;
  const agreedTerms = String(body.termsVersion || '');
  const agreedPrivacy = String(body.privacyVersion || '');
  // 「页面上没有勾选框」是真会发生的：管理员刚把 TERMS_REQUIRED 从 false 拨到 true，
  // 而这张表单是拨之前渲染的。所以这条也得给出路，不然人对着一条没法照做的错误干瞪眼。
  if (!agreedTerms || !agreedPrivacy)
    return '请先阅读并勾选同意《用户协议》和《隐私政策》；如果页面上没有这个勾选框，请刷新页面后再试';
  if (agreedTerms !== TERMS_VERSION) return '《用户协议》已更新，请刷新页面重新阅读后再试';
  if (agreedPrivacy !== PRIVACY_VERSION) return '《隐私政策》已更新，请刷新页面重新阅读后再试';
  return null;
}

/** 把这次同意记到账上：users 表存最新版本，audit_log 留完整历史。 */
function recordAgreement(user) {
  if (!config.termsRequired) return;
  const at = now();
  const termsChanged = user.terms_agreed_version !== TERMS_VERSION;
  const privacyChanged = user.privacy_agreed_version !== PRIVACY_VERSION;
  if (!termsChanged && !privacyChanged) return;
  db.prepare(
    'UPDATE users SET terms_agreed_version = ?, terms_agreed_at = ?, privacy_agreed_version = ?, privacy_agreed_at = ? WHERE id = ?'
  ).run(TERMS_VERSION, at, PRIVACY_VERSION, at, user.id);
  if (termsChanged) audit(user, 'user.agree_terms', user.username, `version=${TERMS_VERSION}`);
  if (privacyChanged) audit(user, 'user.agree_privacy', user.username, `version=${PRIVACY_VERSION}`);
}

// --- sliding windows (per IP) for the open-registration endpoints ---
// Failed attempts already back off exponentially above; these cap the things
// backoff cannot see — captcha issuance and *successful* sign-ups.
const windows = new Map(); // key -> number[] timestamps
function inWindow(key, windowMs) {
  const now = Date.now();
  const arr = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length) windows.set(key, arr);
  else windows.delete(key);
  return arr;
}
function recordWindow(key) {
  if (windows.size > 5000) {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [k, v] of windows) if (v[v.length - 1] < cutoff) windows.delete(k);
  }
  windows.set(key, [...(windows.get(key) ?? []), Date.now()]);
}

/** 工作量证明：签发一个一次性前缀 + 难度，前端算出 nonce 才能换行为验证。 */
router.get('/pow', (req, res) => {
  if (inWindow(`ts:${req.ip}`, 10 * 60_000).length >= 60) {
    return res.status(429).json({ error: '验证请求过于频繁，请稍后再试' });
  }
  const pow = createPow(req.ip);
  recordWindow(`ts:${req.ip}`);
  res.json(pow);
});

/** Cloudflare Turnstile 风格验证：PoW + 行为分析，生成一次性 Token */
router.post('/turnstile', (req, res) => {
  // 发 token 本身不花钱，但无限量生成就是给脚本白嫖一个免费 CPU 循环；
  // 60 次 / 10 分钟 / IP 对真人绰绰有余（注册和登录那边还有各自的频控）。
  if (inWindow(`ts:${req.ip}`, 10 * 60_000).length >= 60) {
    return res.status(429).json({ error: '验证请求过于频繁，请稍后再试' });
  }
  if (!config.captchaEnabled) {
    // 关掉验证码时流程不变：直接发 token，机器人防护完全交给邀请码/限速。
    recordWindow(`ts:${req.ip}`);
    return res.json({ token: mintToken(req.ip) });
  }
  const pow = req.body?.pow;
  if (!pow || !verifyPow(pow.prefix, pow.nonce, req.ip)) {
    recordWindow(`ts:${req.ip}`);
    return res.status(400).json({ error: '验证未通过，请刷新页面后重试' });
  }
  const result = createTurnstile(req.body?.trajectory, req.body?.formBehavior, req.body?.hints, req.ip);
  recordWindow(`ts:${req.ip}`);
  // 行为落在不确定区：发一张旋转图片让人回正，而不是直接放行或拒绝。
  if (result?.challenge) return res.json({ challenge: result.challenge });
  if (!result) return res.status(400).json({ error: '行为验证未通过，请重试' });
  res.json({ token: result.token });
});

/** 图片回正验证：校验用户提交的回正角度，成功签发一次性 Token */
router.post('/captcha', (req, res) => {
  if (inWindow(`ts:${req.ip}`, 10 * 60_000).length >= 60) {
    return res.status(429).json({ error: '验证请求过于频繁，请稍后再试' });
  }
  const token = verifyChallenge(req.body?.id, req.body?.angle, req.ip, req.body?.pointer);
  recordWindow(`ts:${req.ip}`);
  if (!token) return res.status(400).json({ error: '图片旋转验证未通过，请重试' });
  res.json({ token });
});

router.post('/register', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    throttle(`reg:${req.ip}`);
    const agreement = agreementProblem(req.body);
    if (agreement) return res.status(400).json({ error: agreement });
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: '用户名需为 3-32 位字母、数字、下划线或连字符' });
    const passwordError = passwordProblem(password, username);
    if (passwordError) return res.status(400).json({ error: passwordError });

    if (!verifyTurnstile(req.body.turnstile_token, req.ip)) {
      fail(`reg:${req.ip}`);
      return res.status(400).json({ error: '验证未通过，请重新验证' });
    }

    let detail;
    if (config.openRegistration) {
      if (inWindow(`reg-ok:${req.ip}`, 60 * 60_000).length >= config.registerPerIpPerHour) {
        return res.status(429).json({ error: '这个 IP 注册太频繁，请稍后再试' });
      }
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
        return res.status(400).json({ error: '用户名已被占用' });
      }
      detail = 'open-registration';
    } else {
      const code = String(req.body.inviteCode || '').trim();
      const invite = getInvite(code);
      const problem = inviteProblem(invite, 'register');
      if (problem) {
        fail(`reg:${req.ip}`);
        return res.status(400).json({ error: problem });
      }
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
        return res.status(400).json({ error: '用户名已被占用' });
      }
      if (!consume(invite.code)) {
        fail(`reg:${req.ip}`);
        return res.status(400).json({ error: '邀请码刚刚被用完了' });
      }
      detail = `invite=${code}`;
    }

    const user = createUser({ username, password });
    logger.info('auth.register.success', { requestId: req.requestId, userId: user.id, username, ip: req.ip, mode: detail });
    clear(`reg:${req.ip}`);
    if (config.openRegistration) recordWindow(`reg-ok:${req.ip}`);
    audit(user, 'user.register', username, detail);
    recordAgreement(user);

    // 见面礼：一笔积分，发站点、开基础实例都能花，不用找管理员要券。
    const welcomePoints = grantWelcomePoints(user);

    const { token, expires } = createSession(user.id, req);
    setSessionCookie(res, token, expires);
    res.json({ user: publicUser(user), welcomePoints: welcomePoints || null });
  } catch (err) {
    logger.error('auth.register.error', { requestId: req.requestId, username: String(req.body?.username || '').trim(), ip: req.ip, error: err });
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const key = `login:${req.ip}:${username.toLowerCase()}`;
    throttle(key);
    const agreement = agreementProblem(req.body);
    if (agreement) return res.status(400).json({ error: agreement });
    if (!verifyTurnstile(req.body.turnstile_token, req.ip)) {
      fail(key);
      return res.status(400).json({ error: '验证未通过，请刷新页面重试' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      fail(key);
      logger.warn('auth.login.failed', { requestId: req.requestId, username, ip: req.ip, reason: 'invalid_credentials' });
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    // 密码对了才承认这个账号被停用：否则这就成了一个不用密码的用户名探测器。
    if (user.disabled) {
      clear(key);
      return res.status(403).json({ error: '账号已被停用', disabled: true, username: user.username });
    }

    clear(key);
    logger.info('auth.login.success', { requestId: req.requestId, userId: user.id, username: user.username, ip: req.ip });
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), user.id);
    const { token, expires } = createSession(user.id, req);
    setSessionCookie(res, token, expires);
    audit(user, 'user.login', username, null);
    // 注册那边也是「主事件在前、agree_terms 紧随其后」，日志里两条流程的顺序得一致。
    recordAgreement(user);
    res.json({ user: publicUser(user) });
  } catch (err) {
    logger.error('auth.login.error', { requestId: req.requestId, username: String(req.body?.username || '').trim(), ip: req.ip, error: err });
    next(err);
  }
});

router.post('/logout', (req, res) => {
  logger.info('auth.logout', { requestId: req.requestId, userId: req.user?.id ?? null, username: req.user?.username ?? null, ip: req.ip });
  destroySession(req.sessionToken);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  // 会话还在、但账号被停用：面板要能分辨「没登录」和「登录了但被停用」，
  // 前者给登录表单，后者给停用页。
  if (req.disabledUser) return res.json({ user: null, disabled: { username: req.disabledUser.username } });
  if (!req.user) return res.json({ user: null });
  const pendingCount =
    req.user.role === 'admin'
      ? db.prepare("SELECT COUNT(*) AS c FROM instances WHERE status = 'pending'").get().c
      : db.prepare("SELECT COUNT(*) AS c FROM instances WHERE status = 'pending' AND user_id = ?").get(req.user.id).c;
  // 未处理的危险预警数（只有管理员会有角标）
  const alertCount =
    req.user.role === 'admin'
      ? db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE status = 'open'").get().c
      : 0;
  res.json({
    user: publicUser(req.user),
    usage: usage(req.user.id),
    pendingCount,
    alertCount,
    onboarding: publicOnboarding(req.user),
    announcements: announcements.listActive(),
  });
});

/** The vouchers the panel handed to this account (the sign-up gift lives here). */
router.get('/vouchers', requireAuth, (req, res) => {
  res.json({ vouchers: vouchersFor(req.user.id) });
});

/** 积分余额和最近的流水，账号页看「这钱花哪了」用。 */
router.get('/points', requireAuth, (req, res) => {
  res.json({ points: req.user.points ?? 0, txns: txnsFor(req.user.id) });
});

/** Active sessions belong to the account owner only; raw tokens are never returned. */
router.get('/sessions', requireAuth, (req, res) => {
  const sessions = db
    .prepare(
      `SELECT token, device_label, ip_hint, created_at, expires_at
       FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC`
    )
    .all(req.user.id, now())
    .map((row) => ({
      current: row.token === req.sessionToken,
      device: row.device_label || '未知设备（旧会话）',
      ipHint: row.ip_hint || '',
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  res.json({ sessions });
});

/** Revoke every other device after a password confirmation, keeping this browser signed in. */
router.post('/sessions/revoke-others', requireAuth, (req, res) => {
  const current = String(req.body?.currentPassword || '');
  if (!verifyPassword(current, req.user.password_hash)) return res.status(400).json({ error: '当前密码不正确' });
  const result = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken);
  audit(req.user, 'user.sessions_revoke_others', req.user.username, `count=${result.changes}`);
  res.json({ revoked: result.changes });
});

/** 积分兑换码：换成积分入账。多次数的码每人也只能兑一次。 */
router.post('/redeem', requireAuth, (req, res) => {
  const code = String(req.body.code || '').trim();
  const invite = getInvite(code);
  if (!invite) return res.status(404).json({ error: '兑换码不存在' });
  if (invite.type !== 'points') {
    // 把老资源券贴进兑换框是完全可以预见的误会，告诉他券该去哪花。
    if (invite.type === 'instance') {
      return res.status(400).json({ error: '这是资源券，不用兑换 —— 创建实例或发布站点时直接填它就行' });
    }
    return res.status(400).json({ error: '这不是积分兑换码' });
  }
  if (invite.expires_at && invite.expires_at < now()) return res.status(400).json({ error: '兑换码已过期' });
  const already = db
    .prepare("SELECT 1 FROM point_txns WHERE user_id = ? AND reason = 'redeem' AND ref = ?")
    .get(req.user.id, invite.code);
  if (already) return res.status(400).json({ error: '你已经兑过这个码了' });
  if (!consume(invite.code)) return res.status(400).json({ error: '兑换码的可用次数已经用完' });

  grantPoints(req.user, invite.points, 'redeem', invite.code);
  audit(req.user, 'points.redeem', invite.code, `+${invite.points}`);
  res.json({ added: invite.points, points: req.user.points });
});

/** Lets a logged-in user check what a resource voucher grants before spending it. */
router.get('/voucher/:code', requireAuth, (req, res) => {
  const invite = getInvite(req.params.code);
  const problem = inviteProblem(invite, 'instance');
  if (problem) return res.status(404).json({ error: problem });
  // 看懂一张券就算引导里的「拿到资源券」做完了。
  markVoucherSeen(req.user);
  res.json({ voucher: publicInvite(invite) });
});

/** 新手引导的 UI 状态：向导走到第几步、跳过了、或者彻底不再显示。 */
router.patch('/onboarding', requireAuth, (req, res) => {
  res.json({ onboarding: updateOnboarding(req.user, req.body || {}) });
});

router.post('/password', requireAuth, (req, res) => {
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  if (!verifyPassword(current, req.user.password_hash)) return res.status(400).json({ error: '当前密码不正确' });
  const passwordError = passwordProblem(next, req.user.username);
  if (passwordError) return res.status(400).json({ error: passwordError });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
  // Rotate the surviving session as well: a cookie copied before the change
  // cannot remain useful, while the browser making this request stays signed in.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
  const { token, expires } = createSession(req.user.id, req);
  setSessionCookie(res, token, expires);
  audit(req.user, 'user.password_change', req.user.username, null);
  res.json({ ok: true });
});
