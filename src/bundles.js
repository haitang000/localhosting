import { db, now } from './db.js';
import { config } from './config.js';

/**
 * 积分套餐：管理后台「套餐」页维护的「内存 + CPU + 硬盘」打包价。
 *
 * 首次启动（bundles 表为空）时用 POINTS_BUNDLES 播种一次，之后以数据库里的
 * 记录为准 —— 管理员在面板里改，不用重启。命中打包价（内存、CPU、硬盘三样
 * 全对）时按套餐价收，比逐档加配便宜；端口费在套餐价之外另算。
 */

export function seedBundles() {
  const c = db.prepare('SELECT COUNT(*) AS c FROM bundles').get().c;
  if (c > 0) return;
  const seeds = (config.pointsBundles ?? []).filter((b) => Number(b.cost) > 0);
  if (!seeds.length) return;
  const ins = db.prepare(
    'INSERT INTO bundles (name, memory_mb, cpus, disk_mb, cost, enabled, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)'
  );
  seeds.forEach((b, i) =>
    ins.run(
      String(b.name ?? ''),
      Math.round(Number(b.memoryMb)),
      Number(b.cpus),
      Math.round(Number(b.diskMb ?? config.pointsInstanceDiskMb)),
      Math.round(Number(b.cost)),
      i,
      now(),
      now()
    )
  );
}

function shape(row) {
  return {
    id: row.id,
    name: row.name ?? '',
    memoryMb: row.memory_mb,
    cpus: Number(row.cpus),
    diskMb: row.disk_mb,
    cost: row.cost,
    enabled: !!row.enabled,
  };
}

/** 管理后台用：全部套餐（含下架的）。 */
export function listBundles({ enabledOnly = false } = {}) {
  const rows = db
    .prepare(`SELECT * FROM bundles ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY sort, memory_mb, cpus`)
    .all();
  return rows.map(shape);
}

/** 定价查找：内存、CPU、硬盘三样全对才认打包价。 */
export function findBundle(memoryMb, ticks, diskMb) {
  return listBundles({ enabledOnly: true }).find(
    (b) => b.memoryMb === memoryMb && Math.round(b.cpus * 10) === ticks && b.diskMb === diskMb
  );
}

export function getBundle(id) {
  const row = db.prepare('SELECT * FROM bundles WHERE id = ?').get(id);
  return row ? shape(row) : null;
}

/** 校验 + 正规化套餐字段，不合法抛带人话的 Error。 */
export function cleanBundle(f = {}) {
  const memoryMb = Math.round(Number(f.memoryMb));
  const ticks = Math.round(Number(f.cpus) * 10);
  const diskMb = Math.round(Number(f.diskMb));
  const cost = Math.round(Number(f.cost));
  if (!Number.isInteger(memoryMb) || memoryMb < 64 || memoryMb > 65536) {
    throw new Error('内存需为 64 - 65536 的整数（MB）');
  }
  if (!Number.isFinite(ticks) || Math.abs(Number(f.cpus) * 10 - ticks) > 1e-6 || ticks < 1 || ticks > 128) {
    throw new Error('CPU 需为 0.1 的倍数，0.1 - 12.8 核');
  }
  if (!Number.isInteger(diskMb) || diskMb < 128 || diskMb > 1048576) {
    throw new Error('硬盘需为 128 - 1048576 的整数（MB）');
  }
  if (!Number.isInteger(cost) || cost < 0 || cost > 10000000) {
    throw new Error('价格需为 0 - 10000000 的整数（积分）');
  }
  const dup = db
    .prepare('SELECT 1 FROM bundles WHERE memory_mb = ? AND cpus = ? AND disk_mb = ? AND id != ?')
    .get(memoryMb, ticks / 10, diskMb, Number(f.id) || 0);
  if (dup) throw new Error('同规格（内存 + CPU + 硬盘）的套餐已经存在');
  return { name: String(f.name ?? '').slice(0, 40), memoryMb, cpus: ticks / 10, diskMb, cost };
}

export function createBundle(f) {
  const b = cleanBundle(f);
  const info = db
    .prepare('INSERT INTO bundles (name, memory_mb, cpus, disk_mb, cost, enabled, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(b.name, b.memoryMb, b.cpus, b.diskMb, b.cost, f.enabled === false ? 0 : 1, 999, now(), now());
  return getBundle(Number(info.lastInsertRowid));
}

export function updateBundle(id, f) {
  const cur = getBundle(id);
  if (!cur) return null;
  // 只传了部分字段（如上架/下架）也允许：缺的用当前值补上再校验
  const b = cleanBundle({ ...cur, ...f, id });
  db.prepare(
    'UPDATE bundles SET name = ?, memory_mb = ?, cpus = ?, disk_mb = ?, cost = ?, enabled = ?, updated_at = ? WHERE id = ?'
  ).run(b.name, b.memoryMb, b.cpus, b.diskMb, b.cost, f.enabled === false ? 0 : 1, now(), id);
  return getBundle(id);
}

export function deleteBundle(id) {
  db.prepare('DELETE FROM bundles WHERE id = ?').run(id);
}
