import { StringDecoder } from 'node:string_decoder';
import { config } from './config.js';
import * as dk from './docker.js';
import * as sleeper from './sleeper.js';

/**
 * Live shell sessions inside a container.
 *
 * `docker exec` is kept open with a TTY: output streams to the browser over
 * SSE, keystrokes come back as small POSTs. One session per (instance, user),
 * so reloading the page reattaches to the same shell — with its scrollback and
 * its working directory — instead of starting over.
 *
 * While a session is attached the instance is held awake, otherwise the idle
 * watcher would nap a container someone is typing into (a shell moves no
 * network bytes).
 */

// A plain Error with a 4xx `status` is enough for the server's error handler,
// and keeps this module out of an import cycle with instances.js.
const bad = (status, message) => Object.assign(new Error(message), { status });

/** `${instanceId}:${userId}` -> session */
const sessions = new Map();
/** sid -> session, so a request only has to carry the opaque id. */
const bySid = new Map();

let counter = 0;
const newSid = () => `${Date.now().toString(36)}-${(++counter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const KEEP = () => Math.max(20_000, config.consoleScrollback);

/**
 * Cut the scrollback back to size — but only once it has drifted a quarter past
 * the limit, because trimming on every chunk means copying the whole buffer for
 * the sake of a few bytes. This makes CONSOLE_SCROLLBACK a floor rather than a
 * ceiling: a session holds up to 1.25× that many characters (~500KB at the
 * default, UTF-16).
 *
 * The cut lands on a line boundary. A browser reattaching to this session opens
 * on whatever the first surviving character is, and half an escape sequence
 * would paint as literal junk — dropping the split line costs nothing and is
 * the only place that can go wrong. Output with no newline at all (a `\r`
 * progress bar, `cat` on a binary) falls back to the blunt cut.
 */
function trimBack(s) {
  const keep = KEEP();
  if (s.length <= keep * 1.25) return s;
  const cut = s.length - keep;
  const nl = s.indexOf('\n', cut);
  return s.slice(nl === -1 ? cut : nl + 1);
}

/** Prefer bash when the image has it; every image has some /bin/sh. */
const command = (shell) =>
  shell === 'sh' || shell === 'bash'
    ? ['/bin/sh', '-c', `exec ${shell}`]
    : ['/bin/sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'];

function push(sess, text) {
  if (!text) return;
  sess.scrollback = trimBack(sess.scrollback + text);
  for (const fn of sess.subs) {
    try {
      fn({ out: text });
    } catch {
      /* a dead SSE response cleans itself up on close */
    }
  }
}

/**
 * `kind` travels to the browser so it can tell the recoverable endings apart:
 * an idle reap or a dropped stream just wants reconnecting, whereas a stopped
 * container has to be started again first. Without it every ending looks the
 * same and the panel can only offer one blunt "restart".
 */
function finish(sess, note, kind = 'ended') {
  if (sess.closed) return;
  sess.closed = true;
  sess.releaseHold?.();
  sessions.delete(sess.key);
  bySid.delete(sess.sid);
  const text = `\r\n\x1b[90m[${note}]\x1b[0m\r\n`;
  sess.scrollback = trimBack(sess.scrollback + text);
  for (const fn of sess.subs) {
    try {
      fn({ out: text });
      fn({ closed: true, kind, note });
    } catch {
      /* ignore */
    }
  }
  sess.subs.clear();
  try {
    sess.stream?.destroy();
  } catch {
    /* ignore */
  }
}

async function spawn(row, user, { shell = 'auto', cols = 100, rows = 30 }) {
  // 封存和休眠都是「容器停着」，但只有休眠该被一次访问叫醒。
  if (row.status === 'archived') throw bad(400, '实例已封存，容器不会再启动，控制台也就连不上了');
  if (row.status === 'banned') throw bad(403, '实例因违规操作被封禁，控制台不可用；如有疑问请联系管理员');
  let state = await dk.containerState(row.container_id);
  if (!state.running && row.status === 'sleeping') {
    await sleeper.wake(row.id, '打开控制台');
    state = await dk.containerState(row.container_id);
  }
  if (!state.running) throw bad(400, '容器未在运行，先启动它再打开控制台');

  const { exec, stream } = await dk.execStream(row.container_id, command(shell), {
    tty: true,
    cols,
    rows,
    // 这里给了 TTY，于是 git log / systemctl status / man 都会自作主张调分页器。
    // 但用户不知道自己进了 less：他接着敲下一条命令，那几个字母全被 less 当快捷键
    // 吃掉，看上去就是终端疯了，「中断」也救不回来（less 不理 SIGINT）。输出本来
    // 就在一块能滚动、能搜索的区域里，分页在这儿没有价值。这些只是默认值，
    // 用户 export PAGER=less 照样盖得掉。
    // LESS=-FRX 兜住直接敲 less 的情况：光有 -F（不足一屏就退出）的话，短输出会
    // 画在备用屏幕上、随即随备用屏幕一起被收走，看着像什么都没发生；配上 -X
    // 不走备用屏幕才留得住。-R 保留颜色。
    // apt 中途弹的 whiptail 对话框要靠 Tab/空格操作，在这儿等于死锁，所以关掉。
    env: [
      'TERM=xterm-256color',
      'LANG=C.UTF-8',
      'PAGER=cat',
      'GIT_PAGER=cat',
      'SYSTEMD_PAGER=cat',
      'MANPAGER=cat',
      'LESS=-FRX',
      'DEBIAN_FRONTEND=noninteractive',
    ],
  });

  const sess = {
    sid: newSid(),
    key: `${row.id}:${user.id}`,
    instanceId: row.id,
    userId: user.id,
    shell,
    exec,
    stream,
    scrollback: '',
    subs: new Set(),
    closed: false,
    startedAt: Date.now(),
    lastActive: Date.now(),
    releaseHold: sleeper.hold(row.id),
  };

  const decoder = new StringDecoder('utf8');
  stream.on('data', (chunk) => push(sess, decoder.write(chunk)));
  stream.on('end', () => finish(sess, '会话已结束'));
  stream.on('close', () => finish(sess, '会话已结束'));
  stream.on('error', (err) => finish(sess, `会话中断：${err.message}`, 'error'));

  sessions.set(sess.key, sess);
  bySid.set(sess.sid, sess);
  return sess;
}

/** Existing shell for this user on this instance, or a fresh one. */
export async function attach(row, user, opts = {}) {
  const live = sessions.get(`${row.id}:${user.id}`);
  if (live && !live.closed) {
    // The session follows the user, but the screen it is drawn on does not:
    // whoever attaches last sets the size. Awaited, so the PTY is already the
    // new width when the browser gets its scrollback snapshot — otherwise the
    // first screenful still wraps at the previous device's width. Only when a
    // size was actually supplied: resize() turns undefined into 100×30 and
    // would squash a perfectly good session.
    const cols = Number(opts.cols);
    const rows = Number(opts.rows);
    if (Number.isFinite(cols) && Number.isFinite(rows)) await resize(live, cols, rows);
    return live;
  }
  return spawn(row, user, opts);
}

export async function restart(row, user, opts = {}) {
  const live = sessions.get(`${row.id}:${user.id}`);
  if (live) finish(live, '会话已重启', 'restart');
  return spawn(row, user, opts);
}

/** Look a session up, refusing anything that is not this user's on this instance. */
export function get(sid, row, user) {
  const sess = bySid.get(String(sid || ''));
  if (!sess || sess.closed || sess.instanceId !== row.id || sess.userId !== user.id) {
    throw bad(404, '控制台会话已失效，请重新打开');
  }
  sess.lastActive = Date.now();
  return sess;
}

export function write(sess, data) {
  if (typeof data !== 'string' || !data.length) return;
  if (data.length > 8192) throw bad(413, '一次输入的内容过长');
  sess.stream.write(data);
}

export async function resize(sess, cols, rows) {
  const w = Math.min(Math.max(Number(cols) || 100, 20), 500);
  const h = Math.min(Math.max(Number(rows) || 30, 5), 200);
  await sess.exec.resize({ w, h }).catch(() => {});
}

export function subscribe(sess, fn) {
  fn({ snapshot: sess.scrollback });
  sess.subs.add(fn);
  sess.lastActive = Date.now();
  return () => {
    sess.subs.delete(fn);
    sess.lastActive = Date.now();
  };
}

/** Everything belonging to an instance — used when it is stopped or deleted. */
export function closeForInstance(instanceId, note = '容器已停止，会话结束') {
  for (const sess of [...bySid.values()]) {
    if (sess.instanceId === instanceId) finish(sess, note, 'stopped');
  }
}

export const info = (sess) => ({
  sid: sess.sid,
  shell: sess.shell,
  startedAt: new Date(sess.startedAt).toISOString(),
});

/** Detached sessions do not live forever: a forgotten tab should not hold a shell. */
const gc = setInterval(() => {
  const ttl = Math.max(1, config.consoleIdleMinutes) * 60_000;
  for (const sess of [...bySid.values()]) {
    if (sess.subs.size === 0 && Date.now() - sess.lastActive > ttl) finish(sess, '闲置过久，会话已回收', 'idle');
  }
}, 30_000);
gc.unref();
