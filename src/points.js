import { db, now, audit } from './db.js';
import { config } from './config.js';
import { findBundle } from './bundles.js';

/**
 * 积分：面板里的通用货币。新用户注册送 WELCOME_POINTS（默认 100），
 * 发一个静态站点扣 SITE_POINTS_COST（默认 50）；开实例是「基础价 +
 * 加配」：基础价 INSTANCE_POINTS_COST（默认 100，含 0.1 核 / 128MB /
 * 1 端口 / 7 天），内存、CPU、端口都能加钱往上配，价目见 priceInstanceSpec。
 *
 * 老的资源券没有废：手里还揣着券的人照旧直接用券换实例/站点；管理员
 * 今后发的「券」则是积分兑换码（invites.type = 'points'），兑成积分再花。
 *
 * 余额直接放在 users.points 上，每一笔变动在 point_txns 落一行流水。
 * 扣分走一条带条件的 UPDATE（points >= 扣的数），和 invites.consume()
 * 一个路数 —— 并发下也透支不了。
 */

export const balanceOf = (userId) =>
  db.prepare('SELECT points FROM users WHERE id = ?').get(userId)?.points ?? 0;

/**
 * 积分实例的配置单：把用户选的规格校验、正规化并算出总价。
 * 前端支付页照同一份价目表现算给用户看，但最终扣多少以这里为准 ——
 * 改个请求体就想白拿大内存是不行的。配置不合法时抛带人话的 Error。
 */
export function priceInstanceSpec(spec = {}) {
  const baseMem = config.pointsInstanceMemoryMb;
  const baseCpus = config.pointsInstanceCpus;
  const basePorts = config.pointsInstancePorts;
  const baseDisk = config.pointsInstanceDiskMb;
  const step = config.pointsMemStepMb;
  const diskStep = config.pointsDiskStepMb;

  const memoryMb = Math.round(Number(spec.memoryMb ?? baseMem));
  const cpus = Number(spec.cpus ?? baseCpus);
  const ports = Math.round(Number(spec.ports ?? basePorts));
  const diskMb = Math.round(Number(spec.diskMb ?? baseDisk));

  if (
    !Number.isInteger(memoryMb) ||
    memoryMb < baseMem ||
    memoryMb > config.pointsMaxMemoryMb ||
    (memoryMb - baseMem) % step !== 0
  ) {
    throw new Error(`内存需在 ${baseMem} - ${config.pointsMaxMemoryMb} MB 之间，按 ${step} MB 一档选`);
  }
  // CPU 按 0.1 核一档，先放大十倍再算，避开 0.1+0.2 那类浮点笑话。
  const ticks = Math.round(cpus * 10);
  const baseTicks = Math.round(baseCpus * 10);
  const maxTicks = Math.round(config.pointsMaxCpus * 10);
  if (!Number.isFinite(cpus) || Math.abs(cpus * 10 - ticks) > 1e-6 || ticks < baseTicks || ticks > maxTicks) {
    throw new Error(`CPU 需在 ${baseCpus} - ${config.pointsMaxCpus} 核之间，按 0.1 核一档选`);
  }
  if (!Number.isInteger(ports) || ports < basePorts || ports > config.pointsMaxPorts) {
    throw new Error(`对外端口需在 ${basePorts} - ${config.pointsMaxPorts} 个之间`);
  }
  if (
    !Number.isInteger(diskMb) ||
    diskMb < baseDisk ||
    diskMb > config.pointsMaxDiskMb ||
    (diskMb - baseDisk) % diskStep !== 0
  ) {
    throw new Error(`硬盘需在 ${baseDisk} - ${config.pointsMaxDiskMb} MB 之间，按 ${diskStep} MB 一档选`);
  }

  const cost =
    memCpuCost(memoryMb, ticks, diskMb) + (ports - basePorts) * config.pointsPortCost;
  return { memoryMb, cpus: ticks / 10, diskMb, ports, cost };
}

/**
 * 内存 + CPU + 硬盘部分的价：先看是不是打包套餐（管理后台维护，三样全对
 * 才认），对不上才按价目表逐档累加。端口费不在这里。
 */
function memCpuCost(memoryMb, ticks, diskMb) {
  const bundle = findBundle(memoryMb, ticks, diskMb);
  if (bundle) return bundle.cost;
  return (
    config.instancePointsCost +
    ((memoryMb - config.pointsInstanceMemoryMb) / config.pointsMemStepMb) * config.pointsMemStepCost +
    (ticks - Math.round(config.pointsInstanceCpus * 10)) * config.pointsCpuStepCost +
    ((diskMb - config.pointsInstanceDiskMb) / config.pointsDiskStepMb) * config.pointsDiskStepCost
  );
}

function logTxn(userId, delta, reason, ref) {
  db.prepare(
    'INSERT INTO point_txns (user_id, delta, balance, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, delta, balanceOf(userId), reason, ref ?? null, now());
}

/** 白给的分：注册见面礼、兑换码、管理员手动调整。amount 必须是正整数。 */
export function grantPoints(user, amount, reason, ref = null) {
  const n = Math.round(Number(amount));
  if (!Number.isInteger(n) || n <= 0) return false;
  db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(n, user.id);
  logTxn(user.id, n, reason, ref);
  // 同一个请求后面还要拿 req.user 算余额，顺手同步
  user.points = (user.points ?? 0) + n;
  return true;
}

/** 原子扣分。余额不够时一分不动，返回 false。 */
export function spendPoints(user, amount, reason, ref = null) {
  const n = Math.round(Number(amount));
  if (!Number.isInteger(n) || n <= 0) return true; // 定价被配成 0 = 免费
  const res = db
    .prepare('UPDATE users SET points = points - ? WHERE id = ? AND points >= ?')
    .run(n, user.id, n);
  if (res.changes !== 1) return false;
  logTxn(user.id, -n, reason, ref);
  user.points = Math.max(0, (user.points ?? n) - n);
  return true;
}

/** 退分（删除/创建失败/驳回）。人可能已经被删了，退不进去就算了。 */
export function refundPoints(userId, amount, reason, ref = null) {
  const n = Math.round(Number(amount));
  if (!Number.isInteger(n) || n <= 0) return false;
  const res = db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(n, userId);
  if (res.changes !== 1) return false;
  logTxn(userId, n, reason, ref);
  return true;
}

/**
 * 注册见面礼。best effort —— 和当年的欢迎券一样，一个新账号比它的
 * 见面礼值钱，这里出错不能连累注册本身。
 */
export function grantWelcomePoints(user) {
  if (!config.welcomePoints) return 0;
  try {
    grantPoints(user, config.welcomePoints, 'welcome', null);
  } catch (err) {
    console.error('[welcome-points]', err.message);
    return 0;
  }
  audit(user, 'points.welcome', user.username, `+${config.welcomePoints}`);
  return config.welcomePoints;
}

/** 最近的积分流水，给账号页看「这钱花哪了」。 */
export function txnsFor(userId, limit = 20) {
  return db
    .prepare('SELECT delta, balance, reason, ref, created_at FROM point_txns WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, Math.min(Math.max(1, limit), 100))
    .map((t) => ({ delta: t.delta, balance: t.balance, reason: t.reason, ref: t.ref, createdAt: t.created_at }));
}
