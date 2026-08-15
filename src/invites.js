import { db, now } from './db.js';

/**
 * Three kinds of codes share one table:
 *   type = 'register' — lets someone create an account
 *   type = 'instance' — a resource voucher: it carries the memory / CPU / port
 *                       budget an instance gets, and is spent on creation.
 *   type = 'points'   — 积分兑换码：换成积分再花，本身不直接换东西。
 *                       这是今后管理员发福利的默认姿势。
 *
 * A resource voucher also carries a scope, which says what it may be spent on:
 *   scope = 'any'  — an instance or a static page, the holder picks
 *   scope = 'site' — static pages only. No container, no port; the page is
 *                    booked at SITE_MEMORY_MB / SITE_CPUS (64MB / 0.1 核).
 * 老资源券不废：手里还攒着券的人照旧直接用券换实例/站点；
 * 新用户的见面礼则改成了积分（见 points.js）。
 */

export const SITE_ONLY = 'site';

export function getInvite(code) {
  if (!code) return null;
  return db.prepare('SELECT * FROM invites WHERE code = ?').get(String(code).trim()) || null;
}

/**
 * `spendOn` is what the caller is about to do with the code — 'instance' for a
 * container, 'site' for a published page. Leave it out to only check the code
 * itself (that is what the "look up my voucher" endpoint does).
 */
export function inviteProblem(invite, type, spendOn = null) {
  if (!invite) return '邀请码不存在';
  if (invite.type !== type) {
    if (invite.type === 'points') return '这是积分兑换码，请到「账号」页兑换成积分后使用';
    return type === 'instance' ? '这是注册邀请码，不能用于创建实例' : '这不是注册邀请码，不能用于注册';
  }
  if (invite.scope === SITE_ONLY && spendOn === 'instance') {
    return '这是静态网页专用券，只能用来发布静态站点，创建实例请向管理员另要一张';
  }
  if (invite.uses >= invite.max_uses) return '邀请码的可用次数已经用完';
  if (invite.expires_at && invite.expires_at < now()) return '邀请码已过期';
  return null;
}

/** Atomically spends one use. Returns false when the code became unusable. */
export function consume(code) {
  const res = db
    .prepare(
      `UPDATE invites SET uses = uses + 1
       WHERE code = ? AND uses < max_uses AND (expires_at IS NULL OR expires_at > ?)`
    )
    .run(code, now());
  return res.changes === 1;
}

export function refund(code) {
  if (!code) return;
  db.prepare('UPDATE invites SET uses = MAX(0, uses - 1) WHERE code = ?').run(code);
}

/** What a normal user is allowed to see about a code before spending it. */
export function publicInvite(invite) {
  return {
    code: invite.code,
    type: invite.type,
    scope: invite.scope || 'any',
    siteOnly: invite.scope === SITE_ONLY,
    memoryMb: invite.memory_mb,
    cpus: invite.cpus,
    ports: invite.ports,
    // 数据卷配额（MB）；null = 跟随全局 DISK_QUOTA_MB
    diskMb: invite.disk_mb ?? null,
    allowCustomImage: !!invite.allow_custom_image,
    // 用这张券建出来的实例能活多少天（null = 永久）。跟 expiresAt 不是一回事：
    // expiresAt 是券自己什么时候作废。
    instanceDays: invite.instance_days || null,
    // 积分兑换码才有的字段：每次兑换到账多少分
    points: invite.points || null,
    remaining: invite.max_uses - invite.uses,
    expiresAt: invite.expires_at,
    note: invite.note,
  };
}

/** The vouchers the panel itself handed to this account, newest first. */
export function vouchersFor(userId) {
  return db
    .prepare("SELECT * FROM invites WHERE issued_to = ? AND type = 'instance' ORDER BY created_at DESC")
    .all(userId)
    .map(publicInvite);
}
