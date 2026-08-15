import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import * as dk from '../docker.js';
import * as svc from '../instances.js';
import * as term from '../console.js';
import * as sleeper from '../sleeper.js';
import { history, subscribe } from '../events.js';

export const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  res.json({ instances: await svc.listForUser(req.user), usage: svc.usage(req.user.id) });
});

router.post('/', async (req, res) => {
  const result = await svc.createInstance(req.user, req.body || {});
  res.status(201).json(result);
});

router.get('/:id', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  res.json({ instance: await svc.serialize(row) });
});

router.post('/:id/action/:what', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  await svc.action(row, req.params.what, req.user);
  res.json({ instance: await svc.serialize(svc.getInstance(req.params.id, req.user)) });
});

/** Turn idle sleep on/off (owner or admin). */
router.patch('/:id/sleep', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  await svc.setSleep(row, req.user, {
    enabled: req.body?.enabled,
    idleMinutes: req.body?.idleMinutes,
  });
  res.json({ instance: await svc.serialize(svc.getInstance(req.params.id, req.user)) });
});

/** 积分续期（管理员免费）。 */
router.post('/:id/renew', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  const days = Number(req.body?.days ?? 0);
  // 上限 3650 天（10 年）：超大的天数会撑爆 Date 导致 500，且对正常续期毫无意义。
  if (!Number.isInteger(days) || days <= 0 || days > 3650) {
    return res.status(400).json({ error: '续期天数需为 1 - 3650 的整数' });
  }
  const fresh = await svc.renewInstance(row, req.user, days);
  res.json({ instance: await svc.serialize(fresh) });
});

/** 下载封存实例的数据卷。 */
router.get('/:id/download', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  const { stream, filename, contentType } = await svc.downloadArchive(row, req.user);
  res.setHeader('Content-Type', contentType);
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'archive.tar';
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy?.());
  stream.pipe(res);
});

router.delete('/:id', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  const result = await svc.destroy(row, req.user, { keepVolume: req.query.keepVolume === '1' });
  if (row.container_id) statsHistory.delete(row.container_id);
  res.json({ ok: true, ...result });
});

router.get('/:id/logs', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  if (!row.container_id) return res.json({ logs: '' });
  const tail = Math.min(Number(req.query.tail) || 200, config.maxLogLines);
  try {
    res.json({ logs: await dk.getLogs(row.container_id, tail) });
  } catch (err) {
    if (err.statusCode === 404) return res.json({ logs: '(容器不存在)' });
    throw err;
  }
});

/* 运行状态历史：每次轮询追加一个样本（按容器保留最多 STATS_HISTORY_MAX 条），
   客户端重进详情页时用它把走势图补满，不用从头攒。 */
const statsHistory = new Map(); // container_id -> { t, cpu, mem, rx, tx }[]
const STATS_HISTORY_MAX = 360; // 每 4s 一次 ≈ 24 分钟

router.get('/:id/stats', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  if (!row.container_id) return res.json({ stats: null });
  try {
    const stats = await dk.getStats(row.container_id);
    const arr = statsHistory.get(row.container_id) ?? [];
    arr.push({ t: Date.now(), cpu: stats.cpuPercent, mem: stats.memPercent, rx: stats.netRx, tx: stats.netTx });
    if (arr.length > STATS_HISTORY_MAX) arr.shift();
    statsHistory.set(row.container_id, arr);
    res.json({ stats, history: arr });
  } catch {
    res.json({ stats: null });
  }
});

/* ------------------------------------------------------------- console --- */

/** Open (or reattach to) a live shell inside the container. */
router.post('/:id/console', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  if (!row.container_id) return res.status(400).json({ error: '容器还未创建完成' });
  const opts = {
    shell: ['sh', 'bash', 'auto'].includes(req.body?.shell) ? req.body.shell : 'auto',
    cols: req.body?.cols,
    rows: req.body?.rows,
  };
  const sess = req.body?.restart
    ? await term.restart(row, req.user, opts)
    : await term.attach(row, req.user, opts);
  res.json({ session: term.info(sess) });
});

/** Keystrokes / a whole command line going to the shell's stdin. */
router.post('/:id/console/input', (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  const sess = term.get(req.body?.sid, row, req.user);
  term.write(sess, String(req.body?.data ?? ''));
  res.json({ ok: true });
});

router.post('/:id/console/resize', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  const sess = term.get(req.body?.sid, row, req.user);
  await term.resize(sess, req.body?.cols, req.body?.rows);
  res.json({ ok: true });
});

/* ---- Minecraft 游戏命令 ----
   MC 服务端以 PID 1 运行、命令只从它自己的 stdin 读 —— docker exec 开个
   shell 敲进去没用。itzg 镜像默认开着 RCON（端口 25575），但密码是运行时
   写进 /data/server.properties 的、不在容器环境变量里，所以先读出来再交给
   rcon-cli —— 两步都走 argv，用户的命令不会被 shell 解释。 */
router.post('/:id/minecraft/command', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  if (!/itzg\/minecraft/i.test(row.image || '')) {
    return res.status(400).json({ error: '这个实例不是 Minecraft 服务器，没有游戏命令可发' });
  }
  if (!row.container_id) return res.status(400).json({ error: '容器还未创建完成' });
  let state = await dk.containerState(row.container_id);
  if (!state.running && row.status === 'sleeping') {
    await sleeper.wake(row.id, '执行游戏命令');
    state = await dk.containerState(row.container_id);
  }
  if (!state.running) return res.status(400).json({ error: '容器未在运行，先启动它再执行命令' });

  const cmd = String(req.body?.command ?? '').trim().replace(/[\r\n\0]/g, ' ');
  if (!cmd || cmd.length > 200) {
    return res.status(400).json({ error: '命令不能为空且不超过 200 字' });
  }

  const propsPath = JSON.parse(row.volume_paths_json || '[]')[0] || '/data';
  const props = await dk.execCollect(
    row.container_id,
    ['sh', '-c', `grep -E '^rcon\\.(password|port)=' "${propsPath}/server.properties" 2>/dev/null || true`],
    { timeoutMs: 3000 }
  );
  const kv = {};
  for (const line of props.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const password = kv['rcon.password'] ?? '';
  const port = kv['rcon.port'] || '25575';
  if (!password) {
    return res.status(503).json({ error: 'RCON 还没就绪（服务器可能仍在启动），请稍后再试' });
  }

  const r = await dk.execCollect(
    row.container_id,
    ['rcon-cli', '--host', '127.0.0.1', '--port', port, '--password', password, cmd],
    { timeoutMs: 8000 }
  );
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  if (r.timedOut) return res.status(504).json({ error: 'RCON 无响应（服务器可能还没起来），请稍后再试' });
  res.json({ output: output || '(服务器无输出)', exitCode: r.exitCode });
});


function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // EventSource 自己会重连，但默认要等约 3 秒。控制台断一下就是几秒的哑火，
  // 告诉浏览器 1 秒就够 —— 这些流本来就是长连接，重连成本只有一次握手。
  res.write('retry: 1000\n');
  res.write(': ok\n\n');
}
const send = (res, data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

/** Provisioning progress (image pull, container create). */
router.get('/:id/events', (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  openSse(res);
  for (const e of history(row.id)) send(res, e);
  const off = subscribe(row.id, (e) => send(res, e));
  const ka = setInterval(() => res.write(': ka\n\n'), 20_000);
  req.on('close', () => {
    off();
    clearInterval(ka);
  });
});

/** Live console output for a session opened above. */
router.get('/:id/console/stream', (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  const sess = term.get(req.query.sid, row, req.user);
  openSse(res);
  const off = term.subscribe(sess, (msg) => {
    send(res, msg);
    if (msg.closed) res.end();
  });
  const ka = setInterval(() => res.write(': ka\n\n'), 20_000);
  req.on('close', () => {
    off();
    clearInterval(ka);
  });
});

/** Live container logs. */
router.get('/:id/logs/stream', async (req, res) => {
  const row = svc.getInstance(req.params.id, req.user);
  if (!row.container_id) return res.status(404).json({ error: '容器不存在' });
  openSse(res);
  let stream;
  try {
    stream = await dk.followLogs(row.container_id, (text) => send(res, { line: text }), 100);
  } catch {
    send(res, { line: '(无法附加到日志流)' });
    return res.end();
  }
  const ka = setInterval(() => res.write(': ka\n\n'), 20_000);
  const cleanup = () => {
    clearInterval(ka);
    stream?.destroy?.();
  };
  stream.on('end', () => {
    cleanup();
    res.end();
  });
  req.on('close', cleanup);
});
