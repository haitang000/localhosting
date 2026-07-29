import { config } from './config.js';
import { db, now, audit } from './db.js';
import * as dk from './docker.js';
import { emit } from './events.js';
import * as sleeper from './sleeper.js';
import * as term from './console.js';
import { releasePorts } from './ports.js';

/**
 * Instance lifespan, expiry, grace period, renewal and purge.
 *
 * An instance is bought with a resource voucher, and the voucher says how long
 * what it buys is good for (`instance_days`). That number is copied onto the
 * instance at request time and turned into a real `expires_at` only when the
 * container is actually built — a request that sits in the approval queue for
 * three days should not lose three days of its life to the queue.
 *
 * When the deadline passes the instance is *archived* ("封存"): the console is
 * closed, the sleeper lets go of the ports, the container is stopped. The
 * container and its volume are left exactly as they are for a grace period
 * (config.archiveRetentionDays, default 7). During that window the owner can
 * download the data or renew the instance with points. After the grace period
 * expires the instance is permanently deleted (container, volume, ports, row).
 */

/** Days off a voucher, normalised: null when it grants an unlimited life. */
export function lifeDaysOf(invite) {
  const days = Number(invite?.instance_days);
  return Number.isFinite(days) && days > 0 ? Math.round(days) : null;
}

/** The deadline `days` from now, or null for an instance that never expires. */
export function deadlineIn(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(Date.now() + n * 86400_000).toISOString();
}

/** Milliseconds left, or null when this instance has no deadline. */
export function remainingMs(row) {
  if (!row.expires_at) return null;
  return new Date(row.expires_at).getTime() - Date.now();
}

/** Milliseconds remaining in the grace period (from archived_at), or null. */
export function graceRemainingMs(row) {
  if (row.status !== 'archived' || !row.archived_at || !config.archiveRetentionDays) return null;
  const deadline = new Date(row.archived_at).getTime() + config.archiveRetentionDays * 86400_000;
  return deadline - Date.now();
}

/** True while this archived row is within the grace window and can still be
 *  renewed or downloaded. */
export function isInGrace(row) {
  const ms = graceRemainingMs(row);
  return ms != null && ms > 0;
}

/**
 * Take an expired instance out of service. Safe to call on a row in any state:
 * every step is best-effort, and the row ends up archived either way — leaving
 * it marked "running" because Docker hiccuped would only mean trying again in
 * a minute, which is exactly what we do not want for a terminal state.
 */
export async function archive(row, reason = '有效期已到') {
  term.closeForInstance(row.id, '实例已封存');
  // release() drops the parked listeners too, so nothing can wake it any more.
  await sleeper.release(row.id).catch(() => {});
  if (row.container_id) {
    try {
      await dk.stopContainer(row.container_id);
    } catch (err) {
      if (err.statusCode !== 404 && err.statusCode !== 304) {
        emit(row.id, `封存时停止容器失败：${err.message}`, 'error');
      }
    }
  }
  db.prepare("UPDATE instances SET status = 'archived', archived_at = ?, error = NULL WHERE id = ?").run(
    now(),
    row.id
  );
  audit({ username: '系统' }, 'instance.archive', row.name, reason);
  const retention = config.archiveRetentionDays;
  const msg = retention
    ? `实例已封存：容器已停止，数据保留 ${retention} 天可下载或积分续期，${retention} 天后自动删除。`
    : '实例已封存：容器已停止，数据卷原样保留，删除实例才会一并清掉。';
  emit(row.id, `${reason}，${msg}`, 'log');
}

/**
 * Permanently delete an archived instance whose grace period has run out.
 * Best-effort on every step — the row gets deleted no matter what.
 */
export async function purge(row) {
  if (row.container_id) {
    try {
      await dk.removeContainer(row.container_id);
    } catch (err) {
      if (err.statusCode !== 404) emit(row.id, `清理容器失败：${err.message}`, 'error');
    }
  }
  if (row.volume_name) {
    try {
      await dk.removeVolume(row.volume_name);
    } catch (err) {
      if (err.statusCode !== 404) emit(row.id, `清理数据卷失败：${err.message}`, 'error');
    }
  }
  releasePorts(row.id);
  db.prepare('DELETE FROM instances WHERE id = ?').run(row.id);
  audit({ username: '系统' }, 'instance.purge', row.name, `宽限期已过，自动删除`);
  console.log(`  🗑  ${row.name}（属主 ${row.user_id}）宽限期届满，已自动删除`);
}

/* -------------------------------------------------------------- monitor --- */

// 'pending' / 'rejected' / 'creating' are skipped: there is no container behind
// them yet. A pending row also has no expires_at at all — the clock only starts
// at approval — so this is really just a belt for the creating window.
async function tick() {
  const rows = db
    .prepare(
      `SELECT * FROM instances
        WHERE expires_at IS NOT NULL AND expires_at <= ?
          AND status NOT IN ('archived', 'pending', 'rejected', 'creating')`
    )
    .all(now());
  for (const row of rows) {
    await archive(row).catch((err) => emit(row.id, `封存失败：${err.message}`, 'error'));
  }

  if (!config.archiveRetentionDays) return;
  const cutoff = new Date(Date.now() - config.archiveRetentionDays * 86400_000).toISOString();
  const stale = db
    .prepare(
      `SELECT * FROM instances
        WHERE status = 'archived' AND archived_at IS NOT NULL AND archived_at <= ?`
    )
    .all(cutoff);
  for (const row of stale) {
    await purge(row).catch((err) => console.error(`  ⚠ 清理 ${row.name} 失败：${err.message}`));
  }
}

let timer = null;

export async function start() {
  // Run once up front: the panel may have been down across a deadline, and an
  // expired instance must not come back up for a whole interval first.
  await tick().catch(() => {});
  timer = setInterval(() => tick().catch(() => {}), Math.max(10, config.expiryCheckSeconds) * 1000);
  timer.unref();
  const timed = db
    .prepare("SELECT COUNT(*) AS c FROM instances WHERE expires_at IS NOT NULL AND status <> 'archived'")
    .get().c;
  if (timed) console.log(`  ⏳ ${timed} 个实例有有效期，到期后会自动封存`);
  if (config.archiveRetentionDays) {
    const ar = db.prepare("SELECT COUNT(*) AS c FROM instances WHERE status = 'archived'").get().c;
    if (ar) console.log(`  📦 ${ar} 个实例已封存，超 ${config.archiveRetentionDays} 天后自动删除`);
  }
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}
