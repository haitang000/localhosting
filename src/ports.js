import net from 'node:net';
import { config } from './config.js';
import { db, now } from './db.js';

function hostPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, config.bindAddress === '0.0.0.0' ? undefined : config.bindAddress);
  });
}

/** Reserves `count` ports for an instance. Throws when the pool is exhausted. */
export async function allocatePorts(instanceId, count) {
  const taken = new Set(db.prepare('SELECT port FROM port_allocations').all().map((r) => r.port));
  const chosen = [];
  const insert = db.prepare('INSERT INTO port_allocations (port, instance_id, allocated_at) VALUES (?, ?, ?)');

  for (let p = config.portPoolStart; p <= config.portPoolEnd && chosen.length < count; p++) {
    if (taken.has(p)) continue;
    if (!(await hostPortFree(p))) continue;
    try {
      insert.run(p, instanceId, now());
    } catch {
      continue; // raced with another request
    }
    chosen.push(p);
  }

  if (chosen.length < count) {
    releasePorts(instanceId);
    throw new Error(
      `端口池已耗尽（${config.portPoolStart}-${config.portPoolEnd}），需要 ${count} 个可用端口。请扩大 PORT_POOL 或清理无用实例。`
    );
  }
  return chosen;
}

export function releasePorts(instanceId) {
  db.prepare('DELETE FROM port_allocations WHERE instance_id = ?').run(instanceId);
}

export function poolStats() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM port_allocations').get();
  const total = config.portPoolEnd - config.portPoolStart + 1;
  return { total, used: c, free: total - c, start: config.portPoolStart, end: config.portPoolEnd };
}
