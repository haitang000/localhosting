/**
 * Tiny in-memory pub/sub used to stream provisioning progress (image pulls,
 * container creation) to whoever has the instance page open.
 */
const buffers = new Map(); // instanceId -> { lines: string[], subs: Set<fn>, done: bool }
const MAX_LINES = 300;

function bucket(instanceId) {
  let b = buffers.get(instanceId);
  if (!b) {
    b = { lines: [], subs: new Set(), done: false };
    buffers.set(instanceId, b);
  }
  return b;
}

export function emit(instanceId, line, kind = 'log') {
  const b = bucket(instanceId);
  const entry = { t: Date.now(), kind, line };
  b.lines.push(entry);
  if (b.lines.length > MAX_LINES) b.lines.shift();
  if (kind === 'done' || kind === 'error') b.done = true;
  for (const fn of b.subs) {
    try {
      fn(entry);
    } catch {
      /* subscriber went away */
    }
  }
}

export function history(instanceId) {
  return buffers.get(instanceId)?.lines ?? [];
}

export function subscribe(instanceId, fn) {
  const b = bucket(instanceId);
  b.subs.add(fn);
  return () => b.subs.delete(fn);
}

export function reset(instanceId) {
  buffers.delete(instanceId);
}
