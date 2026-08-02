import net from 'node:net';
import { config, loopbackAddress } from './config.js';
import { db, now } from './db.js';
import * as dk from './docker.js';
import { emit } from './events.js';

/**
 * Idle sleep / wake on access.
 *
 * While an instance runs, Docker owns its host ports and the panel is nowhere
 * near the traffic — no proxy, no extra hop. The panel only watches the
 * container's network counters; when nothing moves for `idle_minutes` it stops
 * the container, which releases the ports, and binds them itself.
 *
 * A connection to one of those parked ports is held (paused, nothing read yet),
 * the listeners are closed so Docker can have the ports back, the container is
 * started, and once it accepts connections again the held sockets are relayed
 * into it. From the visitor's side it is just a slow first request.
 *
 * TCP only: a UDP service cannot be woken this way, so sleep is refused for
 * instances that expose UDP ports.
 */

/** id -> { listeners, parked, waking, wakeTimer, traffic, relays } */
const states = new Map();

// 停放中的连接上限：单实例 64（浏览器一次唤醒的并发就 6-10 条），全局 512。
// 唤醒期间连接会一直挂着，不设上限的话对着公开的实例端口打 SYN 就能让面板
// 攒下一堆永不前进的 socket。
const MAX_PARKED = 64;
const MAX_PARKED_TOTAL = 512;
let parkedCount = 0;

function state(id) {
  let s = states.get(id);
  if (!s) {
    s = {
      listeners: new Map(),
      parked: [],
      waking: null,
      wakeTimer: null,
      traffic: null,
      relays: new Set(),
      holds: new Set(),
    };
    states.set(id, s);
  }
  return s;
}

const rowById = (id) => db.prepare('SELECT * FROM instances WHERE id = ?').get(id) || null;
const setStatus = (id, status) => db.prepare('UPDATE instances SET status = ? WHERE id = ?').run(status, id);

export const tcpPorts = (row) =>
  JSON.parse(row.ports_json || '[]')
    .filter((p) => p.protocol !== 'udp' && p.host)
    .map((p) => p.host);

export const udpPorts = (row) =>
  JSON.parse(row.ports_json || '[]').filter((p) => p.protocol === 'udp');

export function idleMs(row) {
  const mins = Number(row.idle_minutes) > 0 ? Number(row.idle_minutes) : config.idleMinutes;
  return Math.max(1, mins) * 60_000;
}

/** Whether this row can take part in sleeping at all. */
export function sleepable(row) {
  return Boolean(
    config.idleSleepEnabled && row.sleep_enabled && row.container_id && tcpPorts(row).length && !udpPorts(row).length
  );
}

/** Reason this instance may not use idle sleep, or null when it may. */
export function sleepProblem(row) {
  if (!config.idleSleepEnabled) return '管理员没有开启闲时休眠功能';
  if (udpPorts(row).length) return 'UDP 服务无法通过连接唤醒，不能开启闲时休眠';
  if (!tcpPorts(row).length) return '这个实例没有对外 TCP 端口，休眠了也没法被唤醒';
  return null;
}

/* ------------------------------------------------------------ listeners --- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listen(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, config.bindAddress === '0.0.0.0' ? undefined : config.bindAddress, () => {
      srv.removeListener('error', reject);
      resolve(srv);
    });
  });
}

/** Docker needs a moment to let go of a port after `stop`, hence the retries. */
async function openListeners(row) {
  const s = state(row.id);
  await closeListeners(s);
  for (const port of tcpPorts(row)) {
    let srv = null;
    for (let attempt = 0; attempt < 10 && !srv; attempt++) {
      try {
        srv = await listen(port);
      } catch (err) {
        if (err.code !== 'EADDRINUSE' || attempt === 9) throw err;
        await sleep(300);
      }
    }
    srv.on('connection', (socket) => park(row.id, port, socket));
    srv.on('error', () => {});
    s.listeners.set(port, srv);
  }
}

/**
 * Note: we deliberately do not wait for the 'close' event. `close()` shuts the
 * listening socket down synchronously — which is all we need before Docker can
 * take the port — but the event itself only fires once every accepted socket is
 * gone, and the sockets we parked are exactly what the wake is going to use.
 */
function closeListeners(s) {
  for (const srv of s.listeners.values()) srv.close(() => {});
  s.listeners.clear();
  return Promise.resolve();
}

/* ----------------------------------------------------------------- wake --- */

function park(id, port, socket) {
  const s = state(id);
  socket.pause();
  socket.on('error', () => socket.destroy());
  if (s.parked.length >= MAX_PARKED || parkedCount >= MAX_PARKED_TOTAL) {
    // 停不下了：直接掐掉，别占着 socket 等唤醒。
    socket.destroy();
    return;
  }
  s.parked.push({ socket, port });
  parkedCount += 1;
  // 客户端中途断开时把它从停放队列里摘掉，否则会一直躺在数组里占位。
  socket.on('close', () => {
    const i = s.parked.findIndex((p) => p.socket === socket);
    if (i !== -1) {
      s.parked.splice(i, 1);
      parkedCount -= 1;
    }
  });
  if (s.waking || s.wakeTimer) return;
  // Give the browser's other parallel connections a moment to land before the
  // listeners go away, otherwise they get refused during the handover.
  s.wakeTimer = setTimeout(() => {
    s.wakeTimer = null;
    wake(id, '收到访问请求').catch(() => {});
  }, config.wakeGraceMs);
}

function relay(s, socket, port) {
  const up = net.connect(port, loopbackAddress());
  s.relays.add(socket);
  const done = () => {
    s.relays.delete(socket);
    socket.destroy();
    up.destroy();
  };
  up.on('connect', () => {
    socket.pipe(up);
    up.pipe(socket);
    socket.resume();
  });
  up.on('error', done);
  socket.on('error', done);
  up.on('close', done);
  socket.on('close', done);
}

function flushParked(s, ok) {
  const parked = s.parked;
  s.parked = [];
  parkedCount -= parked.length;
  for (const { socket, port } of parked) {
    if (ok) relay(s, socket, port);
    else socket.destroy();
  }
}

function probe(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: loopbackAddress() });
    const finish = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(1500);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
  });
}

async function waitForPorts(ports, deadline) {
  while (Date.now() < deadline) {
    const results = await Promise.all(ports.map(probe));
    if (results.every(Boolean)) return true;
    await sleep(250);
  }
  return false;
}

/**
 * Keeps an instance out of idle sleep while something is using it in a way the
 * traffic counters cannot see (an attached console). Returns the release fn.
 */
export function hold(id) {
  const s = state(id);
  const token = {};
  s.holds.add(token);
  return () => s.holds.delete(token);
}

/** Starts a sleeping instance and hands any parked connections through. */
export function wake(id, reason = '收到访问请求') {
  const s = state(id);
  if (s.waking) return s.waking;

  s.waking = (async () => {
    const row = rowById(id);
    if (!row?.container_id) {
      flushParked(s, false);
      await closeListeners(s);
      return;
    }
    emit(id, `${reason}，正在唤醒容器…`);
    // The ports have to go back to Docker before it can bind them.
    await closeListeners(s);
    try {
      await dk.startContainer(row.container_id);
      const ready = await waitForPorts(tcpPorts(row), Date.now() + config.wakeTimeoutMs);
      db.prepare("UPDATE instances SET status = 'running', woke_at = ?, error = NULL WHERE id = ?").run(now(), id);
      s.traffic = null;
      if (!ready) {
        emit(id, '容器已启动，但端口在超时时间内没有就绪', 'error');
        flushParked(s, false);
        return;
      }
      emit(id, '已唤醒 ✅', 'done');
      flushParked(s, true);
    } catch (err) {
      emit(id, `唤醒失败：${err.message}`, 'error');
      flushParked(s, false);
      // Put the parked listeners back so the next visitor can trigger a retry.
      const fresh = rowById(id);
      if (fresh && fresh.status === 'sleeping') await openListeners(fresh).catch(() => {});
      throw err;
    }
  })().finally(() => {
    s.waking = null;
  });

  return s.waking;
}

/* ---------------------------------------------------------------- sleep --- */

export async function sleepNow(row, reason = '空闲') {
  const s = state(row.id);
  if (s.waking) return;
  await dk.stopContainer(row.container_id);
  db.prepare("UPDATE instances SET status = 'sleeping', slept_at = ? WHERE id = ?").run(now(), row.id);
  s.traffic = null;
  try {
    await openListeners(row);
    emit(row.id, `${reason}，已休眠；下次访问会自动唤醒（约几秒）`, 'log');
  } catch (err) {
    // Could not take the ports over — better to run than to be unreachable.
    emit(row.id, `休眠后无法接管端口（${err.message}），已重新启动容器`, 'error');
    await dk.startContainer(row.container_id).catch(() => {});
    setStatus(row.id, 'running');
  }
}

/* ------------------------------------------------------------ lifecycle --- */

/** The container is running and owns its ports again. */
export async function onRunning(id) {
  const s = state(id);
  clearTimeout(s.wakeTimer);
  s.wakeTimer = null;
  flushParked(s, false);
  await closeListeners(s);
  s.traffic = null;
}

/** Stopped on purpose: no listeners, so nothing wakes it until someone says so. */
export async function onStopped(id) {
  await onRunning(id);
}

export async function release(id) {
  const s = states.get(id);
  if (!s) return;
  clearTimeout(s.wakeTimer);
  flushParked(s, false);
  for (const sock of s.relays) sock.destroy();
  await closeListeners(s);
  states.delete(id);
}

export const isParked = (id) => (states.get(id)?.listeners.size ?? 0) > 0;
export const isWaking = (id) => Boolean(states.get(id)?.waking);

/** Called when an instance is switched to sleep mode while it is stopped. */
export async function parkStopped(row) {
  db.prepare("UPDATE instances SET status = 'sleeping', slept_at = ? WHERE id = ?").run(now(), row.id);
  await openListeners(row);
}

/* -------------------------------------------------------------- monitor --- */

let timer = null;

async function checkOne(row) {
  const s = state(row.id);
  if (s.waking) return;
  // An open console moves no network bytes, so it needs to say it is there.
  if (s.holds.size || s.relays.size) {
    s.traffic = { bytes: s.traffic?.bytes ?? 0, at: Date.now() };
    return;
  }
  let stats;
  try {
    stats = await dk.getStats(row.container_id);
  } catch {
    return; // container gone or docker busy — try again next tick
  }
  const bytes = (stats.netRx || 0) + (stats.netTx || 0);
  if (!s.traffic || bytes !== s.traffic.bytes) {
    s.traffic = { bytes, at: Date.now() };
    return;
  }
  if (Date.now() - s.traffic.at >= idleMs(row)) {
    const mins = Math.round(idleMs(row) / 60_000);
    await sleepNow(row, `${mins} 分钟无网络流量`).catch((err) =>
      emit(row.id, `休眠失败：${err.message}`, 'error')
    );
  }
}

async function tick() {
  const rows = db
    .prepare("SELECT * FROM instances WHERE sleep_enabled = 1 AND status = 'running' AND container_id IS NOT NULL")
    .all();
  for (const row of rows) {
    if (!sleepable(row)) continue;
    await checkOne(row).catch(() => {});
  }
}

/** Re-arms everything after a panel restart. */
export async function start() {
  if (!config.idleSleepEnabled) return;
  const sleeping = db.prepare("SELECT * FROM instances WHERE status = 'sleeping'").all();
  for (const row of sleeping) {
    if (!sleepable(row)) {
      setStatus(row.id, 'stopped');
      continue;
    }
    try {
      await openListeners(row);
      console.log(`  💤 ${row.name} 处于休眠，已接管端口 ${tcpPorts(row).join('、')}`);
    } catch (err) {
      console.warn(`  ⚠ 无法为休眠实例 ${row.name} 接管端口：${err.message}`);
    }
  }
  timer = setInterval(() => tick().catch(() => {}), Math.max(5, config.sleepCheckSeconds) * 1000);
  timer.unref();
}

export async function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  await Promise.all([...states.keys()].map((id) => release(id)));
}
