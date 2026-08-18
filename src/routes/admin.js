import crypto from 'node:crypto';
import express, { Router } from 'express';
import { db, now, audit } from '../db.js';
import { requireAdmin, publicUser, hashPassword } from '../auth.js';
import { config } from '../config.js';
import * as dk from '../docker.js';
import * as svc from '../instances.js';
import * as sites from '../sites.js';
import { publicInvite } from '../invites.js';
import { refundPoints, spendPoints } from '../points.js';
import { poolStats } from '../ports.js';
import * as announcements from '../announcements.js';
import * as guard from '../guard.js';
import { listBundles, createBundle, updateBundle, deleteBundle } from '../bundles.js';
import { panelName, panelColor, panelDescription, setSetting, captchaMode, maintenanceMode } from '../settings.js';
import * as cftunnel from '../cftunnel.js';

export const router = Router();
router.use(requireAdmin);

// ---------- overview ----------
router.get('/overview', async (req, res) => {
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const instances = db.prepare('SELECT COUNT(*) AS c FROM instances').get().c;
  let docker = null;
  let disk = null;
  try {
    docker = await dk.ping();
    disk = await dk.diskUsage().catch(() => null);
  } catch (err) {
    docker = { error: err.message };
  }
  const siteRows = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size_bytes), 0) AS b FROM sites').get();
  const sleeping = db.prepare("SELECT COUNT(*) AS c FROM instances WHERE status = 'sleeping'").get().c;
  const archived = db.prepare("SELECT COUNT(*) AS c FROM instances WHERE status = 'archived'").get().c;
  res.json({
    users,
    instances,
    sleeping,
    archived,
    sites: siteRows.c,
    sitesBytes: siteRows.b,
    ports: poolStats(),
    docker,
    disk,
    config: {
      publicHost: config.publicHost || null,
      bindAddress: config.bindAddress,
      publicPortOffset: config.publicPortOffset,
      network: config.networkName,
      sitesEnabled: config.sitesEnabled,
      idleSleep: config.idleSleepEnabled ? `${config.idleMinutes} 分钟` : '未开启',
    },
  });
});

// ---------- static sites ----------
router.get('/sites', (req, res) => {
  res.json({ sites: sites.listSites(req.user, { all: true }) });
});

router.delete('/sites/:id', async (req, res) => {
  const row = sites.getSite(req.params.id, req.user);
  res.json({ ok: true, ...(await sites.destroySite(row, req.user)) });
});

// ---------- users ----------
router.get('/users', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY id').all();
  res.json({
    users: rows.map((u) => ({ ...publicUser(u), usage: svc.usage(u.id) })),
  });
});

router.patch('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const b = req.body || {};
  const fields = {
    max_instances: b.maxInstances,
    max_memory_mb: b.maxMemoryMb,
    max_cpus: b.maxCpus,
    max_ports: b.maxPorts,
    allow_custom_image: b.allowCustomImage === undefined ? undefined : b.allowCustomImage ? 1 : 0,
    disabled: b.disabled === undefined ? undefined : b.disabled ? 1 : 0,
    role: b.role === undefined ? undefined : b.role === 'admin' ? 'admin' : 'user',
  };
  if (fields.role === 'user' && user.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
    if (admins <= 1) return res.status(400).json({ error: '至少要保留一个管理员' });
  }
  for (const [col, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(val, id);
  }
  if (b.newPassword) {
    if (String(b.newPassword).length < 8) return res.status(400).json({ error: '密码至少 8 位' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(b.newPassword)), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  // 直接改余额不走 UPDATE points 一把梳：差额过一遍 grant/refund，流水里才有这笔账。
  if (b.points !== undefined) {
    const target = Math.round(Number(b.points));
    if (!Number.isFinite(target) || target < 0 || target > 10_000_000) {
      return res.status(400).json({ error: '积分需在 0 - 10000000 之间' });
    }
    const delta = target - (user.points ?? 0);
    if (delta > 0) refundPoints(id, delta, 'admin.adjust', req.user.username);
    else if (delta < 0) {
      // 扣到目标值；并发下别人刚花掉一笔导致余额不够就扣到 0 为止。
      const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      spendPoints(fresh, Math.min(-delta, fresh.points ?? 0), 'admin.adjust', req.user.username);
    }
  }
  // 停用不再顺手删会话：attachUser 已经拒绝把停用的行交给 req.user，会话留着
  // 也拿不到任何东西，但留着 cookie 才能让对方看到停用页，而不是被静悄悄踢回
  // 登录表单、以为自己密码记错了。重新启用后原来的登录状态也直接恢复。
  // （改密码那条仍然清空会话——那是要把别处的登录踢下去。）

  // 明文新密码只进密码哈希，不写进审计日志。
  const auditable = { ...b };
  delete auditable.newPassword;
  audit(req.user, 'admin.user_update', user.username, JSON.stringify(auditable));
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json({ user: publicUser(updated) });
});

router.post('/users/:id/reset-checkin', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (!user.last_checkin_date) return res.status(400).json({ error: '该用户今日尚未签到' });
  db.prepare('UPDATE users SET last_checkin_date = NULL WHERE id = ?').run(id);
  audit(req.user, 'admin.checkin_reset', user.username, null);
  res.json({ ok: true });
});

router.delete('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  for (const row of db.prepare('SELECT * FROM instances WHERE user_id = ?').all(id)) {
    await svc.destroy(row, req.user).catch(() => {});
  }
  // 送给他的券跟着人一起走（老库上 issued_to 没有外键，所以显式删）。
  db.prepare('DELETE FROM invites WHERE issued_to = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  audit(req.user, 'admin.user_delete', user.username, null);
  res.json({ ok: true });
});

// ---------- invites ----------
router.get('/invites', (req, res) => {
  const rows = db
    .prepare(
      `SELECT i.*, u.username AS creator FROM invites i
       LEFT JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC`
    )
    .all();
  res.json({ invites: rows });
});

router.post('/invites', (req, res) => {
  const b = req.body || {};
  const type = b.type === 'instance' ? 'instance' : b.type === 'points' ? 'points' : 'register';
  const code = (b.code ? String(b.code).trim() : crypto.randomBytes(6).toString('hex')).slice(0, 64);
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(code)) return res.status(400).json({ error: '邀请码只能是 4-64 位字母数字、下划线或连字符' });
  if (db.prepare('SELECT 1 FROM invites WHERE code = ?').get(code)) return res.status(400).json({ error: '邀请码已存在' });

  const maxUses = Math.max(1, Math.min(1000, Number(b.maxUses) || 1));
  const expiresAt = b.expiresInDays
    ? new Date(Date.now() + Number(b.expiresInDays) * 86400_000).toISOString()
    : null;

  // 静态网页专用券：只能拿去发站点，所以端口恒为 0，额度默认就是站点的记账口径。
  const scope = type === 'instance' && b.scope === 'site' ? 'site' : 'any';
  const siteOnly = scope === 'site';

  let memoryMb = null;
  let cpus = null;
  let ports = null;
  let diskMb = null;
  // 积分兑换码：每次兑换给多少分。今后发福利的默认姿势 —— 用户兑成
  // 积分自己决定花在站点还是实例上。
  let points = null;
  // 实例有效天数：留空 / 0 = 建出来的实例永久有效。静态网页券背后没有容器，
  // 也就没有可封存的东西，所以这一项对它没有意义。
  let instanceDays = null;
  if (type === 'points') {
    points = Math.round(Number(b.points));
    if (!Number.isFinite(points) || points < 1 || points > 1_000_000) {
      return res.status(400).json({ error: '兑换积分需在 1 - 1000000 之间' });
    }
  }
  if (type === 'instance') {
    memoryMb = Math.round(Number(b.memoryMb ?? (siteOnly ? config.siteMemoryMb : config.voucherDefaultMemoryMb)));
    cpus = Number(b.cpus ?? (siteOnly ? config.siteCpus : config.voucherDefaultCpus));
    ports = siteOnly ? 0 : Math.round(Number(b.ports ?? config.voucherDefaultPorts));
    // 64MB 是「一个容器至少得给这么多」，对静态网页券没有意义 —— 它背后没有容器，
    // 额度就是 SITE_MEMORY_MB 那个记账数，压到 32 甚至更小都是合理的。
    const floor = siteOnly ? Math.min(64, config.siteMemoryMb) : 64;
    if (!Number.isFinite(memoryMb) || memoryMb < floor || memoryMb > 262144)
      return res.status(400).json({ error: `内存额度需在 ${floor}MB - 256GB 之间` });
    if (!Number.isFinite(cpus) || cpus < 0.1 || cpus > 64)
      return res.status(400).json({ error: 'CPU 额度需在 0.1 - 64 之间' });
    if (!Number.isFinite(ports) || ports < 0 || ports > 32)
      return res.status(400).json({ error: '端口额度需在 0 - 32 之间' });

    // 数据卷配额：留空 = 跟随全局 DISK_QUOTA_MB。静态网页券背后没有容器，不谈硬盘。
    if (!siteOnly && b.diskMb !== undefined && b.diskMb !== null && b.diskMb !== '') {
      diskMb = Math.round(Number(b.diskMb));
      if (!Number.isFinite(diskMb) || diskMb < 128 || diskMb > 1048576)
        return res.status(400).json({ error: '硬盘额度需在 128MB - 1TB 之间（留空 = 跟随全局）' });
    }

    if (!siteOnly && b.instanceDays !== undefined && b.instanceDays !== null && b.instanceDays !== '') {
      const days = Math.round(Number(b.instanceDays));
      if (!Number.isFinite(days) || days < 0 || days > 3650)
        return res.status(400).json({ error: '实例有效天数需在 0 - 3650 之间（0 = 永久）' });
      instanceDays = days > 0 ? days : null;
    }
  }

  db.prepare(
    `INSERT INTO invites (code, type, scope, created_by, note, max_uses, uses, memory_mb, cpus, ports,
       disk_mb, allow_custom_image, instance_days, points, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    code,
    type,
    scope,
    req.user.id,
    String(b.note || ''),
    maxUses,
    memoryMb,
    cpus,
    ports,
    diskMb,
    siteOnly ? 0 : b.allowCustomImage ? 1 : 0,
    instanceDays,
    points,
    expiresAt,
    now()
  );
  audit(
    req.user,
    'admin.invite_create',
    code,
    type === 'instance'
      ? `${siteOnly ? '静态网页券' : '资源券'} ${memoryMb}MB/${cpus}核/${ports}端口${
          diskMb ? `/硬盘 ${diskMb}MB` : ''
        }${instanceDays ? `/有效 ${instanceDays} 天` : ''} ×${maxUses}`
      : type === 'points'
        ? `积分兑换码 ${points} 分 ×${maxUses}`
        : `注册码 ×${maxUses}`
  );
  res.status(201).json({ invite: db.prepare('SELECT * FROM invites WHERE code = ?').get(code) });
});

/**
 * 管理员给自己开一张券，一次一张、开完即用。
 *
 * 券是实例资源额度的唯一载体（内存/CPU/端口都写在券上），管理员也不例外；
 * 但让他为了给自己开一台机器先绕去邀请码页手填一遍再复制回来，纯属仪式。
 * 这个接口按他即将创建的那个模板的用量直接发一张，额度只做钳制不报错 ——
 * 一个「给自己发券」的按钮不该弹校验失败。
 */
router.post('/invites/self', (req, res) => {
  const b = req.body || {};
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const memoryMb = Math.round(clamp(b.memoryMb, 64, 262144, config.voucherDefaultMemoryMb));
  const cpus = clamp(b.cpus, 0.1, 64, config.voucherDefaultCpus);
  const ports = Math.round(clamp(b.ports, 0, 32, config.voucherDefaultPorts));
  const code = `self-${crypto.randomBytes(5).toString('hex')}`;

  db.prepare(
    `INSERT INTO invites (code, type, scope, created_by, issued_to, note, max_uses, uses,
       memory_mb, cpus, ports, allow_custom_image, expires_at, created_at)
     VALUES (?, 'instance', 'any', ?, ?, ?, 1, 0, ?, ?, ?, 1, NULL, ?)`
  ).run(code, req.user.id, req.user.id, `${req.user.username} 给自己开的券`, memoryMb, cpus, ports, now());

  audit(req.user, 'admin.invite_self', code, `${memoryMb}MB/${cpus}核/${ports}端口`);
  res.status(201).json({ voucher: publicInvite(db.prepare('SELECT * FROM invites WHERE code = ?').get(code)) });
});

router.patch('/invites/:code', (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(req.params.code);
  if (!inv) return res.status(404).json({ error: '邀请码不存在' });
  const b = req.body || {};
  const scope = b.scope === undefined ? undefined : b.scope === 'site' ? 'site' : 'any';
  // 变成静态网页券的那一刻，端口和自定义镜像就没有意义了，一并抹掉。
  const siteOnly = (scope ?? inv.scope) === 'site';
  const map = {
    scope,
    max_uses: b.maxUses === undefined ? undefined : Math.max(inv.uses, Math.min(1000, Number(b.maxUses))),
    memory_mb: b.memoryMb === undefined ? undefined : Math.round(Number(b.memoryMb)),
    cpus: b.cpus === undefined ? undefined : Number(b.cpus),
    ports: siteOnly ? 0 : b.ports === undefined ? undefined : Math.round(Number(b.ports)),
    // 改天数只影响以后用它建的实例；已经建出来的实例把天数抄在自己身上了。
    instance_days: siteOnly
      ? null
      : b.instanceDays === undefined
        ? undefined
        : Number(b.instanceDays) > 0
          ? Math.round(Number(b.instanceDays))
          : null,
    allow_custom_image: siteOnly ? 0 : b.allowCustomImage === undefined ? undefined : b.allowCustomImage ? 1 : 0,
    // 数据卷配额：空 / 0 = 清掉，回退全局 DISK_QUOTA_MB
    disk_mb: siteOnly
      ? null
      : b.diskMb === undefined
        ? undefined
        : Number.isFinite(Number(b.diskMb)) && Number(b.diskMb) > 0
          ? Math.round(Math.min(1048576, Math.max(128, Number(b.diskMb))))
          : null,
    // 积分兑换码的面额；只对 type='points' 有意义，其它类型不碰
    points:
      inv.type !== 'points' || b.points === undefined
        ? undefined
        : Math.max(1, Math.min(1_000_000, Math.round(Number(b.points)))),
    note: b.note === undefined ? undefined : String(b.note),
  };
  for (const [col, val] of Object.entries(map)) {
    if (val === undefined || (typeof val === 'number' && !Number.isFinite(val))) continue;
    db.prepare(`UPDATE invites SET ${col} = ? WHERE code = ?`).run(val, inv.code);
  }
  audit(req.user, 'admin.invite_update', inv.code, JSON.stringify(b));
  res.json({ invite: db.prepare('SELECT * FROM invites WHERE code = ?').get(inv.code) });
});

router.delete('/invites/:code', (req, res) => {
  db.prepare('DELETE FROM invites WHERE code = ?').run(req.params.code);
  audit(req.user, 'admin.invite_delete', req.params.code, null);
  res.json({ ok: true });
});

// ---------- all instances ----------
router.get('/instances', async (req, res) => {
  res.json({ instances: await svc.listForUser(req.user, { all: true }) });
});

// ---------- approval queue ----------
router.get('/pending', async (req, res) => {
  const rows = db.prepare("SELECT * FROM instances WHERE status = 'pending' ORDER BY created_at").all();
  const owners = svc.ownersMap(rows.map((r) => r.user_id));
  const pending = await Promise.all(
    rows.map((r) => svc.serialize(r, { withState: false, owner: owners.get(r.user_id) }))
  );
  res.json({
    pending,
    // What the admin should point their tunnel at, and the address the panel
    // would show if they leave the public field blank.
    hint: {
      bindAddress: config.bindAddress,
      publicHost: config.publicHost || null,
      portPool: `${config.portPoolStart}-${config.portPoolEnd}`,
      // 自动穿透可用时前端显示勾选框（只暴露域名，不含任何凭据）
      cfTunnel: cftunnel.enabled() ? { domain: config.cfTunnelDomain } : null,
    },
  });
});

router.post('/instances/:id/approve', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  // 三态透传：没传 autoTunnel（undefined）时 approveInstance 默认自动穿透
  const at = req.body?.autoTunnel;
  await svc.approveInstance(row, req.user, {
    addresses: req.body?.addresses || {},
    note: req.body?.note,
    autoTunnel: at === true || at === false ? at : undefined,
  });
  res.json({ instance: await svc.serialize(svc.getInstance(req.params.id, req.user)) });
});

router.post('/instances/:id/reject', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  svc.rejectInstance(row, req.user, req.body?.reason);
  res.json({ instance: await svc.serialize(svc.getInstance(req.params.id, req.user)) });
});

/** Repoint a live instance's public addresses — see setAddresses(). */
router.patch('/instances/:id/addresses', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  svc.setAddresses(row, req.user, req.body?.addresses || {});
  res.json({ instance: await svc.serialize(svc.getInstance(req.params.id, req.user)) });
});

/** 管理员修改实例的过期时间（或设为永久）。 */
router.patch('/instances/:id/expiry', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  svc.setExpiry(row, req.user, req.body?.expiresAt);
  res.json({ instance: await svc.serialize(svc.getInstance(req.params.id, req.user)) });
});

// ---------- 危险操作预警 ----------
// Guard 特征库命中的记录（挖矿进程、控制台命令、创建参数、上传文件名）。
// status：open（默认，只看没处理的）/ resolved / all。
router.get('/alerts', (req, res) => {
  const status = req.query.status === 'resolved' || req.query.status === 'all' ? req.query.status : 'open';
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const where = status === 'all' ? '' : `WHERE a.status = '${status}'`;
  const alerts = db
    .prepare(`SELECT a.* FROM alerts a ${where} ORDER BY a.id DESC LIMIT ?`)
    .all(limit);
  const openCount = db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE status = 'open'").get().c;
  res.json({ alerts, openCount, rules: guard.ruleList() });
});

/**
 * 处置一条预警：ignore（忽略）/ ban_instance（封禁实例）/ ban_user（封禁用户，
 * 停掉其所有实例 + 停用账号）。处置即结案 —— 状态、动作、经办人一并记下。
 */
router.post('/alerts/:id/resolve', async (req, res) => {
  const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(Number(req.params.id));
  if (!alert) return res.status(404).json({ error: '预警不存在' });
  if (alert.status === 'resolved') return res.status(400).json({ error: '这条预警已经处理过了' });
  const action = req.body?.action;
  if (!['ignore', 'ban_instance', 'ban_user'].includes(action)) {
    return res.status(400).json({ error: '处置动作无效' });
  }

  if (action === 'ban_instance') {
    const row = alert.instance_id ? db.prepare('SELECT * FROM instances WHERE id = ?').get(alert.instance_id) : null;
    if (!row) return res.status(404).json({ error: '涉事实例已不存在（可能已被删除），请选择忽略' });
    await svc.banInstance(row, req.user, alert.label);
  } else if (action === 'ban_user') {
    const user = alert.user_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(alert.user_id) : null;
    if (!user) return res.status(404).json({ error: '涉及用户已不存在，请选择忽略' });
    if (user.id === req.user.id) return res.status(400).json({ error: '不能封禁你自己' });
    if (user.role === 'admin') {
      const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
      if (admins <= 1) return res.status(400).json({ error: '至少要保留一个管理员' });
    }
    const stopped = await svc.stopAllInstancesOf(user.id);
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(user.id);
    audit(req.user, 'admin.alert_ban_user', user.username, `停用账号并停止 ${stopped} 个实例（预警：${alert.label}）`);
  }

  db.prepare(
    "UPDATE alerts SET status = 'resolved', action = ?, resolved_by = ?, resolved_at = ? WHERE id = ?"
  ).run(action, req.user.username, now(), alert.id);
  if (action !== 'ban_user') {
    audit(
      req.user,
      `admin.alert_${action}`,
      alert.username,
      `实例 ${alert.instance_name || '—'}：${alert.label}`
    );
  }
  res.json({ ok: true });
});

/** 解封被预警处置封禁的实例（也可用于任何 banned 状态的实例）。 */
router.post('/instances/:id/unban', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  svc.unbanInstance(row, req.user);
  res.json({ instance: await svc.serialize(svc.getInstance(req.params.id, req.user)) });
});

// ---------- audit ----------
router.get('/audit', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ entries: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) });
});

// ---------- orphan containers ----------
router.get('/orphans', async (req, res) => {
  const managed = await dk.listManaged();
  const known = new Set(db.prepare('SELECT container_id FROM instances').all().map((r) => r.container_id));
  res.json({
    orphans: managed
      .filter((c) => !known.has(c.Id))
      .map((c) => ({ id: c.Id, names: c.Names, image: c.Image, state: c.State, labels: c.Labels })),
  });
});

router.delete('/orphans/:containerId', async (req, res) => {
  await dk.removeContainer(req.params.containerId);
  audit(req.user, 'admin.orphan_remove', req.params.containerId, null);
  res.json({ ok: true });
});

// ---------- announcements ----------
router.get('/announcements', (req, res) => {
  res.json({ announcements: announcements.listAll() });
});

router.post('/announcements', (req, res) => {
  const ann = announcements.create(req.body || {}, req.user);
  audit(req.user, 'admin.announcement_create', ann.title, `priority=${ann.priority} format=${ann.format}`);
  res.status(201).json({ announcement: announcements.row(ann) });
});

router.patch('/announcements/:id', (req, res) => {
  const ann = announcements.update(Number(req.params.id), req.body || {});
  audit(req.user, 'admin.announcement_update', ann.title, JSON.stringify(req.body));
  res.json({ announcement: announcements.row(ann) });
});

router.delete('/announcements/:id', (req, res) => {
  const ann = db.prepare('SELECT * FROM announcements WHERE id = ?').get(Number(req.params.id));
  if (!ann) return res.status(404).json({ error: '公告不存在' });
  announcements.del(ann.id);
  audit(req.user, 'admin.announcement_delete', ann.title, null);
  res.json({ ok: true });
});

// ---------- announcement images ----------
// Uploads arrive base64'd inside a JSON body, so they need their own body limit
// (the global parser is 256kb). This router is mounted ahead of that parser in
// server.js, exactly like the container file manager in routes/files.js.
const imageJson = express.json({
  limit: `${Math.ceil((config.announcementImageMaxBytes * 1.4) / 1048576) + 1}mb`,
});

export const announcementImageRouter = Router();
announcementImageRouter.use(requireAdmin);
announcementImageRouter.post('/upload', imageJson, (req, res) => {
  const image = announcements.uploadImage(req.body?.base64);
  audit(req.user, 'admin.announcement_image_upload', image.name, `${image.bytes} 字节`);
  res.status(201).json({ url: image.url, name: image.name });
});

// ---------- 面板设置 ----------
router.get('/settings', (req, res) => {
  res.json({
    panelName: panelName(),
    panelColor: panelColor(),
    panelDescription: panelDescription(),
    captchaMode: captchaMode(),
  });
});

router.patch('/settings', (req, res) => {
  const { panelName: name, panelColor: color, captchaMode: mode, panelDescription: description } = req.body || {};
  if (name === undefined && color === undefined && mode === undefined && description === undefined) {
    return res.status(400).json({ error: '没有可保存的字段' });
  }
  if (name !== undefined) {
    if (typeof name !== 'string') return res.status(400).json({ error: '面板名称无效' });
    const clean = name.trim().slice(0, 40);
    if (!clean) return res.status(400).json({ error: '面板名称不能为空' });
    if (/[\r\n\t]/.test(clean)) return res.status(400).json({ error: '面板名称不能包含换行或制表符' });
    setSetting('panel_name', clean);
  }
  if (color !== undefined) {
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res.status(400).json({ error: '主题色需为 #RRGGBB 格式' });
    }
    setSetting('panel_color', color.toLowerCase());
  }
  if (mode !== undefined) {
    if (mode !== 'normal' && mode !== 'strict') {
      return res.status(400).json({ error: '验证码严格程度只能是 normal 或 strict' });
    }
    setSetting('captcha_mode', mode);
  }
  if (description !== undefined) {
    if (typeof description !== 'string') return res.status(400).json({ error: '站点描述无效' });
    setSetting('panel_description', description.trim().slice(0, 200));
  }
  audit(
    req.user,
    'admin.settings_brand',
    name ?? color ?? mode ?? description,
    JSON.stringify(req.body)
  );
  res.json({
    panelName: panelName(),
    panelColor: panelColor(),
    panelDescription: panelDescription(),
    captchaMode: captchaMode(),
  });
});

/** 维护模式开关：开启后非管理员访问一律 503，管理员照常使用。改完立即生效。 */
router.post('/maintenance', (req, res) => {
  const on = Boolean(req.body?.enabled);
  setSetting('maintenance_mode', on ? '1' : '0');
  audit(req.user, 'admin.maintenance', null, on ? '开启' : '关闭');
  res.json({ maintenance: maintenanceMode() });
});

// ---------- 积分套餐 ----------
router.get('/bundles', (req, res) => {
  res.json({ bundles: listBundles() });
});

router.post('/bundles', (req, res) => {
  try {
    const bundle = createBundle(req.body || {});
    audit(
      req.user,
      'admin.bundle_create',
      bundle.name || `${bundle.memoryMb}MB/${bundle.cpus}核`,
      `${bundle.memoryMb}MB · ${bundle.cpus} 核 · ${bundle.diskMb}MB 硬盘 → ${bundle.cost} 分`
    );
    res.status(201).json({ bundle });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/bundles/:id', (req, res) => {
  try {
    const bundle = updateBundle(Number(req.params.id), req.body || {});
    if (!bundle) return res.status(404).json({ error: '套餐不存在' });
    audit(
      req.user,
      'admin.bundle_update',
      bundle.name || `${bundle.memoryMb}MB/${bundle.cpus}核`,
      `${bundle.memoryMb}MB · ${bundle.cpus} 核 · ${bundle.diskMb}MB 硬盘 → ${bundle.cost} 分${bundle.enabled ? '' : '（下架）'}`
    );
    res.json({ bundle });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/bundles/:id', (req, res) => {
  const bundle = listBundles().find((b) => b.id === Number(req.params.id));
  if (!bundle) return res.status(404).json({ error: '套餐不存在' });
  deleteBundle(bundle.id);
  audit(req.user, 'admin.bundle_delete', bundle.name || `${bundle.memoryMb}MB/${bundle.cpus}核`, null);
  res.json({ ok: true });
});
