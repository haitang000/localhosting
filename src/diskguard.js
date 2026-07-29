import { config } from './config.js';
import { db } from './db.js';
import * as dk from './docker.js';
import { emit } from './events.js';

/**
 * Docker Desktop ignores the native StorageOpt quota (see docker.js /
 * config.js), so this is the fallback: poll `docker system df` for how much
 * each instance's volume(s) actually take up, and stop any running instance
 * that goes over its budget. Not a hard limit — a burst of writes between two
 * ticks can still land — just a backstop that catches it within one interval.
 */

/** id -> { bytes, checkedAt } — last known usage, for display without a fresh docker.df() per request. */
const lastUsage = new Map();

function volumeNames(row) {
  if (!row.volume_name) return [];
  const paths = JSON.parse(row.volume_paths_json || '[]');
  return dk.volumeNamesFor(row.volume_name, paths);
}

export function quotaMbFor(_row) {
  return config.diskQuotaMb;
}

/** Cached snapshot from the last tick, or null if this instance has no volume / hasn't been checked yet. */
export function usageFor(row) {
  return lastUsage.get(row.id) ?? null;
}

async function tick() {
  const rows = db
    .prepare("SELECT * FROM instances WHERE container_id IS NOT NULL AND volume_name IS NOT NULL")
    .all();
  if (!rows.length) return;

  let sizes;
  try {
    sizes = await dk.volumeSizes();
  } catch {
    return; // docker busy/unreachable — try again next tick
  }

  for (const row of rows) {
    const names = volumeNames(row);
    if (!names.length) continue;
    const bytes = names.reduce((a, n) => a + (sizes[n] || 0), 0);
    lastUsage.set(row.id, { bytes, checkedAt: Date.now() });

    const quotaMb = quotaMbFor(row);
    if (!quotaMb || row.status !== 'running') continue;
    if (bytes <= quotaMb * 1024 * 1024) continue;

    try {
      await dk.stopContainer(row.container_id);
      const usedMb = Math.round(bytes / 1024 / 1024);
      db.prepare("UPDATE instances SET status = 'stopped', error = ? WHERE id = ?").run(
        `磁盘用量 ${usedMb}MB 超过配额 ${quotaMb}MB，已自动停止`,
        row.id
      );
      emit(row.id, `磁盘用量 ${usedMb}MB 超过配额 ${quotaMb}MB，已自动停止`, 'error');
    } catch (err) {
      emit(row.id, `磁盘超额但停止容器失败：${err.message}`, 'error');
    }
  }
}

let timer = null;

export async function start() {
  if (!config.diskGuardEnabled) return;
  timer = setInterval(() => tick().catch(() => {}), Math.max(5, config.diskGuardCheckSeconds) * 1000);
  timer.unref();
  await tick().catch(() => {});
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  lastUsage.clear();
}
