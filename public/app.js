import { icon } from './icons.js';
import { openTextEditor } from './editor.js';

const app = document.getElementById('app');
const state = { user: null, usage: null, cfg: null, templates: [], onboarding: null, disabled: null, announcements: [] };
let timers = [];

/* ---------------- utils ---------------- */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const bytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

/* 磁盘容量：≥1GB 显示成 GB，否则 MB。 */
const fmtMb = (mb) => (mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`);

/* 主题色：--primary-strong / --primary-flat 已在 CSS 里用 color-mix 从
   --primary 派生，这里只需写一个变量，logo 和整套强调色跟着变。
   顺带把 favicon 的描边色也换成同款。 */
function applyTheme(color) {
  if (!/^#[0-9a-fA-F]{6}$/.test(color || '')) return;
  const hex = color.toLowerCase();
  document.documentElement.style.setProperty('--primary', hex);
  const fav = document.querySelector('link[rel="icon"]');
  if (fav) {
    fav.href = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='5' y='5' width='22' height='22' rx='7' fill='none' stroke='%23${hex.slice(
      1
    )}' stroke-width='3'/></svg>`;
  }
}

const when = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');

/* 剩余时长，粗到「天」为止 —— 还有 40 天的实例不需要知道是 40 天 3 小时，
   而只剩几小时的实例才真的想看到小时。 */
const lasts = (ms) => {
  if (ms == null) return '';
  if (ms <= 0) return '已到期';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `还剩 ${Math.max(1, mins)} 分钟`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `还剩 ${hours} 小时`;
  return `还剩 ${Math.floor(hours / 24)} 天`;
};

/** 剩余不到三天就该显眼了 —— 马上到期，可以积分续期。 */
const expiringSoon = (life) => life?.expiresAt && life.remainingMs != null && life.remainingMs < 3 * 86400_000;

/* Motion shared by the few places that animate from script rather than CSS.
   The curve is style.css's --ease-out; WAAPI cannot read a custom property, and
   the global prefers-reduced-motion block cannot reach a scripted animation
   either — both have to be repeated here. */
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

function toast(message, kind = '') {
  // 一旦切到停用页，后面那些请求失败的提示就都是同一件事的回声了，别再堆上来。
  if (state.disabled) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon({ ok: 'circle-check', err: 'circle-alert' }[kind] || 'info')}<span></span>`;
  el.querySelector('span').textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 300);
  }, kind === 'err' ? 6000 : 3000);
}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      // 服务端对 /api 写操作要求这个头（跨站表单/脚本带不了它），防同站 CSRF。
      'X-Lh-Csrf': '1',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) {
    // 账号被停用是整个会话的状态，不是某一个请求的失败，所以在这里认掉而不是
    // 指望每个调用点自己判断：面板里几十处 catch 都只会 toast 一下就算完，
    // 谁先撞上全看运气，人就卡在一个用不了的界面上对着一条提示。
    if (data.disabled) showDisabled({ username: data.username });
    // 错误照样抛，调用方该中断还得中断；body 挂上去供需要分辨的人用。
    throw Object.assign(new Error(data.error || `请求失败 (${res.status})`), { status: res.status, data });
  }
  return data;
}

function clearTimers() {
  timers.forEach((t) => (typeof t === 'function' ? t() : clearInterval(t)));
  timers = [];
}

/**
 * One place to refresh "who am I / how much am I using / how far along is the
 * onboarding", so every poller keeps the same picture instead of its own slice.
 */
async function syncMe() {
  const me = await api('/auth/me');
  // Being stopped mid-session is the common case — an admin flips the switch
  // while the tab is open — so the shared refresher is where we catch it, and
  // every poller inherits the handover for free.
  // /auth/me 是 200 带 disabled 字段（不是错误），所以走不到 api() 里那道拦截。
  if (me.disabled) {
    showDisabled(me.disabled);
    return me;
  }
  if (me.user) state.user = me.user;
  state.usage = me.usage;
  state.pendingCount = me.pendingCount ?? 0;
  state.onboarding = me.onboarding ?? null;
  state.announcements = me.announcements ?? [];
  celebrateOnboarding();
  return me;
}

const copy = (text) =>
  navigator.clipboard?.writeText(text).then(
    () => toast('已复制到剪贴板', 'ok'),
    () => toast('复制失败，请手动选中', 'err')
  );

const STATUS_TEXT = {
  pending: '待审批',
  rejected: '已驳回',
  running: '运行中',
  exited: '已停止',
  stopped: '已停止',
  created: '未启动',
  creating: '创建中',
  restarting: '重启中',
  sleeping: '休眠中',
  waking: '唤醒中…',
  archived: '已封存',
  paused: '已暂停',
  dead: '异常',
  missing: '容器丢失',
  error: '创建失败',
  unknown: '未知',
};

/* One glyph per status, so a card's state is legible before the text is read. */
const STATUS_ICON = {
  pending: 'hourglass',
  rejected: 'ban',
  running: 'play',
  exited: 'square',
  stopped: 'square',
  created: 'power',
  creating: 'rotate-cw',
  restarting: 'rotate-cw',
  sleeping: 'moon',
  waking: 'sunrise',
  archived: 'archive',
  paused: 'square',
  dead: 'triangle-alert',
  missing: 'circle-alert',
  error: 'triangle-alert',
  unknown: 'info',
};

const badge = (s) =>
  `<span class="badge ${esc(s)}">${icon(STATUS_ICON[s] || 'info')}${esc(STATUS_TEXT[s] || s)}</span>`;

/** Section heading with its own glyph. `flush` drops the top margin, which is
    what every heading sitting at the top of a card wants. */
const cat = (name, text, { flush = false } = {}) =>
  `<div class="cat${flush ? ' flush' : ''}">${icon(name)}${esc(text)}</div>`;

/* Rounded-square trace loader. `inline` puts it next to surrounding text. */
const loader = ({ label = '加载中', inline = false } = {}) =>
  `<div class="loading${inline ? ' inline' : ''}" role="status" aria-label="${esc(label)}">
     <svg class="loader" viewBox="0 0 32 32" aria-hidden="true">
       <rect class="track" x="5" y="5" width="22" height="22" rx="7" />
       <rect class="trace" x="5" y="5" width="22" height="22" rx="7" />
     </svg>
   </div>`;

/* ---------------- dot-matrix brand mark ----------------
   The sign-in screen's mark is the favicon's rounded square, but drawn out of
   the same dots as the field behind it — the backdrop condensing into the logo
   rather than a solid shape pasted on top of it.

   Geometry is the favicon's — a 22×22 rect stroked 3 wide inside a 32×32 box,
   so this mark, the header mark and the loader all trace the same square — with
   one deliberate exception: the corner is rx=5 where the favicon uses 7. The
   lattice rounds a corner off on its own (dots step diagonally across it, and
   the outer row sits 1.5 units past the path), so carrying rx=7 up to this size
   read visibly rounder than the mark it is quoting. 5 is as tight as it can go;
   below that the corner turns into a single chamfer instead of a curve.

   Each grid point is tested against the signed distance to the stroked path and
   kept if it lands on it; the step is 22/15 so a sample sits exactly on the path
   at every flat edge, which is what makes the ring come out an even three dots
   thick (2·step ≈ the 3-wide stroke) instead of wandering between two and three
   as the grid drifts across the outline. Every dot is the same size — tried
   shrinking the outer rows to soften the curves and it only made the ring look
   ragged; equal dots let the eye do the smoothing, which is how a dot matrix is
   supposed to work. */
const MARK_STEP = 22 / 15;
/* Kept in step with the mark-wave duration in style.css: the per-dot delay below
   is a fraction of one cycle, so the two have to agree or the wave stops being a
   wave. */
const MARK_WAVE = 3600;
/* How long the whole matrix takes to light up on arrival. The last dot starts at
   the end of this window and takes mark-dot-in's own 300ms on top, so the mark is
   whole a shade after one second — long enough to read as assembling, short
   enough that nobody is waiting on it to type a password. */
const MARK_ASSEMBLE = 700;

function dotMark(label = 'localhosting', { assemble = false } = {}) {
  const CENTER = 16; // the 32-box's middle
  const RADIUS = 5; // see above — the favicon's 7, pulled in for the lattice
  const FLAT = 11 - RADIUS; // half-extent minus corner radius: the straight run
  const BAND = MARK_STEP * 1.02; // reaches the ±1-step rows, never the ±2 ones
  const DOT = MARK_STEP * 0.31;
  const dots = [];
  // −1..16 rather than 0..15: the stroke's outer half falls outside the rect
  // path itself, so the grid has to start one step before the corner.
  for (let i = -1; i <= 16; i++) {
    for (let j = -1; j <= 16; j++) {
      const x = 5 + MARK_STEP * i;
      const y = 5 + MARK_STEP * j;
      const qx = Math.abs(x - CENTER) - FLAT;
      const qy = Math.abs(y - CENTER) - FLAT;
      const d = Math.abs(
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - RADIUS
      );
      if (d > BAND) continue;
      // How far down the top-left → bottom-right diagonal this dot sits, handed
      // to CSS as a negative delay: every dot is already mid-cycle on the first
      // frame, so the wave arrives as one band drifting across a lit matrix
      // rather than 148 dots blinking in unison.
      const phase = Math.round(((x + y - 7) / 50) * MARK_WAVE);
      dots.push({ x, y, phase });
    }
  }

  /* Arrival order. Shuffling the *order* and then pacing it evenly across the
     window beats rolling an independent random delay per dot: independent
     draws clump and leave gaps, which reads as a stutter, whereas an even
     cadence in a random order reads as an image resolving out of noise. The
     randomness that matters is which dot, not when. */
  const light = dots.map((_, n) => n);
  for (let n = light.length - 1; n > 0; n--) {
    const m = Math.floor(Math.random() * (n + 1));
    [light[n], light[m]] = [light[m], light[n]];
  }
  const lightAt = [];
  light.forEach((dot, place) => {
    lightAt[dot] = Math.round((place / light.length) * MARK_ASSEMBLE);
  });

  // Two delays per dot: the wave's phase, then its turn to light up. When the
  // mark is not assembling the second value simply has no animation to bind to
  // and is ignored, so the same markup serves both cases.
  const circles = dots.map(
    (p, n) =>
      `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${DOT.toFixed(2)}"
               style="animation-delay:-${p.phase}ms,${lightAt[n]}ms" />`
  );

  // The stops are left empty on purpose: style.css colours them, so the mark
  // follows the theme the same way every other brand surface does.
  return `<svg class="dotmark${assemble ? ' assemble' : ''}" viewBox="0 0 32 32"
               role="img" aria-label="${esc(label)}">
            <defs>
              <linearGradient id="dotmark-ink" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" /><stop offset="1" />
              </linearGradient>
            </defs>
            <g fill="url(#dotmark-ink)">${circles.join('')}</g>
          </svg>`;
}

/* ---------------- user agreement ----------------
   The text itself lives on the server (src/terms.js) and arrives via
   /api/terms; this dialog and the standalone /terms page render the same
   HTML, so there is exactly one copy to keep honest. */
let termsCache = null;
async function showTerms({ onAgree } = {}) {
  document.getElementById('terms-dlg')?.remove();
  const dlg = document.createElement('dialog');
  dlg.id = 'terms-dlg';
  dlg.className = 'terms';
  dlg.setAttribute('aria-labelledby', 'terms-title');
  // tabindex on the scrolling body: the text has nothing focusable inside it,
  // and only Chrome/Firefox put such a container in the tab order on their own —
  // without this a keyboard user in Safari cannot scroll past the first screen
  // of the very document they are being asked to agree to.
  dlg.innerHTML = `
    <h3 id="terms-title">${icon('scroll-text')}用户协议</h3>
    <div class="terms-meta"></div>
    <div class="terms-doc" tabindex="0" role="region" aria-label="协议正文">${loader()}</div>
    <div class="row" style="justify-content:flex-end;margin-top:16px">
      <button class="ghost" data-close>关闭</button>
      ${onAgree ? `<button class="primary" data-agree disabled>${icon('check')}我已阅读并同意</button>` : ''}
    </div>`;
  document.body.append(dlg);
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  // 正文到位前按钮是灰的：这颗按钮的意思是「读完了」，加载中和加载失败时都还没法读。
  const agreeBtn = dlg.querySelector('[data-agree]');
  if (agreeBtn)
    agreeBtn.onclick = () => {
      dlg.close();
      onAgree();
    };
  // Clicking the backdrop targets the dialog itself; Esc fires close on its own.
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.onclose = () => dlg.remove();
  dlg.showModal();
  try {
    termsCache ??= await api('/terms');
    // 服务端可能在这个页面开着的时候拨过版本号。用户读到的是刚取回的这一版，
    // 提交时也得报这一版，否则他刚读完就被「协议已更新，请刷新」挡回去。
    if (state.cfg?.terms) state.cfg.terms = { version: termsCache.version, updated: termsCache.updated };
    if (!dlg.isConnected) return;
    dlg.querySelector('.terms-meta').textContent =
      `版本 ${termsCache.version} · 更新于 ${termsCache.updated}`;
    dlg.querySelector('.terms-doc').innerHTML = termsCache.html;
    if (agreeBtn) agreeBtn.disabled = false;
  } catch (err) {
    if (dlg.isConnected)
      dlg.querySelector('.terms-doc').innerHTML =
        `<p class="err">${icon('circle-alert')}协议加载失败：${esc(err.message)}</p>`;
  }
}

/* ---------------- 工作量证明 PoW ----------------
   服务端给前缀 + 难度，前端算一个 nonce 使 sha256(前缀+nonce) 的前 N 位
   为 0。对真人零感知（后台 worker 里算，默认 18 位 ≈ 零点几秒），对脚本是
   每个 token 实打实的算力开销。用纯 JS 实现而非 crypto.subtle：面板常走
   http 局域网访问，subtle 只在 https/localhost 才存在。 */

/** 验证计算中的加载态：3×3 点阵错峰闪烁（和品牌点阵同一套语言）。 */
const BLINK_DOTS = '<span class="dotblink" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>';

function sha256Hex(msg) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = new TextEncoder().encode(msg);
  const bitLen = bytes.length * 8;
  const len = (((bytes.length + 8) >> 6) + 1) * 64;
  const buf = new Uint8Array(len);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(len - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(len - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  for (let i = 0; i < len; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4);
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[j] + w[j]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, '0')).join('');
}

/** 哈希前导零位数是否 ≥ bits。 */
function powPasses(hex, bits) {
  if (bits <= 0) return true;
  let zeros = 0;
  for (let i = 0; i < hex.length; i++) {
    const nib = parseInt(hex[i], 16);
    if (nib === 0) { zeros += 4; continue; }
    for (let b = 0x8; b > 0 && (nib & b) === 0; b >>= 1) zeros++;
    break;
  }
  return zeros >= bits;
}

const POW_WORKER_SRC = `
  const sha256 = ${sha256Hex.toString()};
  const powPasses = ${powPasses.toString()};
  self.onmessage = (e) => {
    const { prefix, bits } = e.data;
    const expected = 2 ** bits;
    let nonce = 0;
    try {
      while (true) {
        if (powPasses(sha256(prefix + nonce), bits)) {
          self.postMessage({ nonce: String(nonce) });
          return;
        }
        nonce++;
        if ((nonce & 0xfff) === 0) {
          self.postMessage({ progress: Math.min(100, Math.round((nonce / expected) * 1000) / 10) });
        }
        if (nonce > 0x7fffffff) break;
      }
      self.postMessage({ error: '验证计算超时' });
    } catch (err) {
      self.postMessage({ error: String((err && err.message) || err) });
    }
  };
`;

let powWorker = null;
function getPowWorker() {
  if (typeof Worker === 'undefined' || !URL || !URL.createObjectURL) return null;
  try {
    if (!powWorker) {
      powWorker = new Worker(URL.createObjectURL(new Blob([POW_WORKER_SRC], { type: 'text/javascript' })));
    }
    return powWorker;
  } catch {
    return null;
  }
}

/** 计算 PoW，worker 可用就走 worker，否则主线程分块算避免卡界面。 */
function solvePow({ prefix, bits }, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = getPowWorker();
    if (worker) {
      const onMsg = (e) => {
        if (e.data && e.data.progress != null) { onProgress?.(e.data.progress); return; }
        worker.removeEventListener('message', onMsg);
        worker.removeEventListener('error', onErr);
        if (e.data && e.data.nonce != null) resolve(e.data.nonce);
        else reject(new Error((e.data && e.data.error) || '验证计算失败'));
      };
      const onErr = () => {
        worker.removeEventListener('message', onMsg);
        reject(new Error('验证计算失败'));
      };
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', onErr);
      worker.postMessage({ prefix, bits });
    } else {
      let nonce = 0;
      const expected = 2 ** bits;
      const tick = () => {
        for (let i = 0; i < 4096; i++) {
          if (powPasses(sha256Hex(prefix + nonce), bits)) return resolve(String(nonce));
          nonce++;
        }
        onProgress?.(Math.min(100, Math.round((nonce / expected) * 1000) / 10));
        setTimeout(tick, 0);
      };
      tick();
    }
  });
}

/** 取 PoW 前缀 → 算出 nonce → 返回可直接提交的 { prefix, nonce }。 */
async function getPowProof(onProgress) {
  const p = await api('/auth/pow');
  const nonce = await solvePow(p, onProgress);
  return { prefix: p.prefix, nonce };
}

/** 浏览器环境自报信号：屏幕/缩放/时区/语言/画布哈希，服务端只做合理性校验。 */
function getHints() {
  const h = {
    dpr: window.devicePixelRatio || 1,
    sw: window.screen?.width || 0,
    sh: window.screen?.height || 0,
    tz: new Date().getTimezoneOffset(),
    lang: (navigator.languages?.length ? navigator.languages : [navigator.language]).slice(0, 8),
  };
  try {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 32;
    const g = c.getContext('2d');
    if (g) {
      g.textBaseline = 'top';
      g.font = '14px Arial';
      g.fillStyle = '#f60';
      g.fillRect(0, 0, 64, 32);
      g.fillStyle = '#069';
      g.fillText('localhosting', 2, 2);
      h.canvas = c.toDataURL();
    }
  } catch {}
  return h;
}

/* ---------------- 图片回正验证 ----------------
   Behavior 分析落在不确定区（或验证码严格模式）时，服务端发来一张已旋转的
   真实照片；弹窗里把它拖回正位（或点按钮 ±15° 微调）即通过。取消弹窗视为
   放弃本次验证，resolve(null)，调用方恢复待验证状态。 */
function solveRotatePuzzle(challenge) {
  return new Promise((resolve) => {
    document.getElementById('puzzle-dlg')?.remove();
    const dlg = document.createElement('dialog');
    dlg.id = 'puzzle-dlg';
    dlg.className = 'puzzle';
    dlg.setAttribute('aria-labelledby', 'puzzle-title');
    dlg.innerHTML = `
      <h3 id="puzzle-title">${icon('rotate-cw')}旋转图片回正</h3>
      <p class="puzzle-tip">拖动图片或滑块，让「上方」对准顶部的三角标记</p>
      <div class="puzzle-stage" id="puzzle-stage" tabindex="0" role="slider" aria-label="旋转图片"
           aria-valuemin="0" aria-valuemax="359" aria-valuenow="0" aria-valuetext="0 度">
        <span class="puzzle-notch" aria-hidden="true"></span>
        <img class="puzzle-img" src="${esc(challenge.image)}" alt="旋转验证图片" draggable="false" />
      </div>
      <input type="range" id="puzzle-slider" class="puzzle-range" min="0" max="359" step="1" value="0" aria-label="旋转图片角度" />
      <div class="err" id="puzzle-err"></div>
      <div class="row" style="justify-content:flex-end;margin-top:8px">
        <button class="ghost" data-cancel>取消</button>
        <button class="primary" data-done>${icon('check')}完成</button>
      </div>`;
    document.body.append(dlg);

    let settled = false;
    let deg = 0;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      dlg.close();
      resolve(val);
    };

    const stage = dlg.querySelector('#puzzle-stage');
    const img = dlg.querySelector('.puzzle-img');
    const errEl = dlg.querySelector('#puzzle-err');
    const doneBtn = dlg.querySelector('[data-done]');
    const slider = dlg.querySelector('#puzzle-slider');
    slider.oninput = () => {
      deg = Number(slider.value);
      paint();
    };

    const norm = (d) => ((d % 360) + 360) % 360;
    const paint = () => {
      img.style.transform = `rotate(${deg}deg)`;
      slider.value = Math.round(deg);
      stage.setAttribute('aria-valuenow', Math.round(deg));
      stage.setAttribute('aria-valuetext', `${Math.round(deg)} 度`);
    };
    const nudge = (d) => {
      deg = norm(deg + d);
      paint();
    };

    // 拖拽旋转：以转盘圆心为基准算指针角度差。
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const rect = stage.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const angleOf = (p) => Math.atan2(p.clientY - cy, p.clientX - cx) * (180 / Math.PI);
      drag = { start: angleOf(e) - deg };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('dragging');
      e.preventDefault();
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const rect = stage.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const cur = Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI);
      deg = norm(cur - drag.start);
      paint();
    });
    const endDrag = (e) => {
      if (!drag) return;
      drag = null;
      stage.classList.remove('dragging');
      if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-15); }
      if (e.key === 'ArrowRight') { e.preventDefault(); nudge(15); }
    });

    doneBtn.onclick = async () => {
      doneBtn.disabled = true;
      errEl.textContent = '';
      try {
        const r = await api('/auth/captcha', {
          method: 'POST',
          body: { id: challenge.id, angle: Math.round(deg) },
        });
        finish(r.token);
      } catch (err) {
        doneBtn.disabled = false;
        errEl.textContent = err.message;
      }
    };

    dlg.querySelector('[data-cancel]').onclick = () => finish(null);
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) finish(null);
    });
    dlg.addEventListener('cancel', () => finish(null));
    dlg.onclose = () => {
      if (!settled) resolve(null);
      // 等退出动画（180ms）播完再移除，不然 transition 被立刻掐断。
      setTimeout(() => dlg.remove(), 180);
    };
    dlg.showModal();
  });
}

/* ---------------- auth screen ---------------- */
/**
 * Eases the sign-in card from the height it had to the height it now has.
 *
 * Switching 登录 ↔ 注册 swaps a whole field block in or out, which is a jump of
 * a hundred-odd pixels — and because the card is rebuilt from scratch rather
 * than edited in place, a CSS `transition: height` has nothing to transition
 * *from*. So the outgoing height is measured before the swap and handed to the
 * animation afterwards. `overflow` is pinned for the duration: on the way up
 * the box is briefly shorter than its own content.
 */
function animateAuthHeight(from) {
  const card = app.querySelector('form.auth');
  if (!card || !from || REDUCED_MOTION.matches) return;
  const to = card.offsetHeight;
  if (from === to) return;
  card.style.overflow = 'hidden';
  card
    .animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 260, easing: EASE_OUT })
    .finished.finally(() => (card.style.overflow = ''));
}

/* CAPTCHA 组件收缩包裹标签文字；文字换长度时（正在验证 → 验证通过 →
   验证失败，点击重试）宽度会跳，这里用跟 animateAuthHeight 同一套
   WAAPI 技巧把它补成平滑过渡。 */
function animateWidgetWidth(el, from) {
  if (!el || !from || REDUCED_MOTION.matches) return;
  const to = el.offsetWidth;
  if (from === to) return;
  el.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: 220, easing: EASE_OUT });
}

/* 标签文字过渡：旧字拆成单字 span 从左往右逐个淡出，再换上新字逐个
   淡入（错峰 60ms、淡入 160ms），宽度动画在换字后量好新宽度再补。
   文字没变时直接跳过，不闪。每次调用都会作废旧定时器，只有最后一次
   换字生效——快速连续触发（如验证失败后立刻重试）不会串台。 */
function setTurnstileLabel(el, label, text) {
  if (label.textContent === text) return;
  clearTimeout(label._fadeTimer);
  const from = el.offsetWidth;
  const oldText = label.textContent;
  const fadeOutMs = 160;
  // 渐隐时长逐字递减：第 i 个字 160 - i*10ms（保底 60ms），后面的字走得更快
  const fadeMs = (i) => Math.max(60, fadeOutMs - i * 10);
  const swapMs = Math.max(0, (oldText.length - 1) * 60) + fadeMs(Math.max(0, oldText.length - 1));
  label.innerHTML = [...oldText]
    .map(
      (ch, i) =>
        `<span class="fade-out" style="animation-delay:${i * 60}ms;animation-duration:${fadeMs(i)}ms">${
          ch === ' ' ? '\u00A0' : esc(ch)
        }</span>`
    )
    .join('');
  label._fadeTimer = setTimeout(() => {
    // 渐显时长同样逐字递减：第 i 个字 160 - i*10ms（保底 60ms）
    label.innerHTML = [...text]
      .map(
        (ch, i) =>
          `<span style="animation-delay:${i * 60}ms;animation-duration:${Math.max(60, fadeOutMs - i * 10)}ms">${
            ch === ' ' ? '\u00A0' : esc(ch)
          }</span>`
      )
      .join('');
    animateWidgetWidth(el, from);
  }, swapMs);
}

/**
 * `fresh` means we are arriving at this screen, not just toggling 登录/注册 on
 * it — only then does the mark light itself up. Flipping the tab rebuilds the
 * same DOM, and replaying a one-second assembly every time someone taps between
 * the two would turn a flourish into a tic.
 */
function renderAuth(mode = 'login', { fresh = true } = {}) {
  const open = !!state.cfg?.openRegistration;
  const brand = state.cfg?.panelName || 'localhosting';
  // Measured before innerHTML throws the old card away.
  const fromHeight = app.querySelector('form.auth')?.offsetHeight ?? 0;
  app.className = 'auth-wrap';
  app.innerHTML = `
    ${dotMark(brand, { assemble: fresh })}
    <form class="card auth">
      <h1>${esc(brand)}</h1>
      <div class="sub">一键部署属于你自己的容器服务</div>
      <div class="switch">
        <button type="button" data-mode="login" class="${mode === 'login' ? 'on' : ''}">${icon(
          'log-in'
        )}登录</button>
        <button type="button" data-mode="register" class="${mode === 'register' ? 'on' : ''}">${icon(
          'user-plus'
        )}${open ? '注册' : '邀请码注册'}</button>
      </div>
      <label class="field"><span>${icon('user')}用户名</span>
        <input name="username" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" required /></label>
      <label class="field"><span>${icon('lock-keyhole')}密码</span>
        <input name="password" type="password" autocomplete="${
          mode === 'login' ? 'current-password' : 'new-password'
        }" required /></label>
       <div class="field turnstile-wrap" id="turnstile-wrap">
         <div class="turnstile" id="turnstile" role="button" tabindex="0" aria-label="我不是机器人，点击验证">
           <span class="turnstile-icon" id="turnstile-icon"></span>
           <span class="turnstile-label">我不是机器人</span>
         </div>
       </div>
       ${
         mode !== 'register'
           ? ''
           : open
            ? '<div class="hint">密码至少 8 位；用户名 3-32 位字母/数字/下划线/连字符。</div>'
            : `<label class="field"><span>${icon('ticket')}邀请码</span>
             <input name="inviteCode" required autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="向管理员索取" />
             <div class="hint">密码至少 8 位；用户名 3-32 位字母/数字/下划线/连字符。</div></label>`
      }
      ${
        state.cfg?.terms
          ? `<label class="agree"><input type="checkbox" name="agree" required />
             <span>我已阅读并同意<a href="/terms" data-terms>《用户协议》</a></span></label>`
          : ''
      }
      <div class="err" data-err></div>
      <button class="primary" style="width:100%;margin-top:6px" type="submit">${
        mode === 'login' ? `${icon('log-in')}登录` : `${icon('user-plus')}注册并登录`
      }</button>
    </form>`;

  app.querySelectorAll('[data-mode]').forEach(
    (b) => (b.onclick = () => renderAuth(b.dataset.mode, { fresh: false }))
  );
  const form = app.querySelector('form');

  // 《用户协议》：点开是弹窗，弹窗里点「我已阅读并同意」顺手替人把勾打上。
  // 带修饰键的点击（Ctrl/⌘/Shift/Alt）和中键不拦，让它照常在新标签/新窗口
  // 打开 /terms 独立页 —— 想留着慢慢读的人不该被弹窗按住。
  const termsLink = form.querySelector('[data-terms]');
  if (termsLink)
    termsLink.onclick = (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      // 现查当前文档里的表单，而不是闭包里这一个：弹窗开着时浏览器的前进/后退
      // 会把表单整个重建，勾打在已经脱离文档的旧表单上等于没打。
      showTerms({
        onAgree: () => {
          const live = app.querySelector('form.auth');
          if (live?.agree) live.agree.checked = true;
        },
      });
    };

  // Cloudflare Turnstile 风格验证
  let turnstileVerified = false;
  let turnstileToken = null;
  const turnstileEl = document.getElementById('turnstile');
  const turnstileIcon = document.getElementById('turnstile-icon');
  const turnstileLabel = turnstileEl?.querySelector('.turnstile-label');

  function createRipple(e) {
    const rect = turnstileEl.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = (e.clientX || rect.left + rect.width / 2) - rect.left - size / 2;
    const y = (e.clientY || rect.top + rect.height / 2) - rect.top - size / 2;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    turnstileEl.append(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  }

  // 鼠标/触摸轨迹追踪（点击也算一个采样点：有些人不动鼠标光用键盘）
  let trajCleanup = null;
  if (trajCleanup) trajCleanup();
  const trajPoints = [];
  const onMove = (e) => {
    if (trajPoints.length >= 500) return;
    const t = Date.now();
    const last = trajPoints[trajPoints.length - 1];
    if (last && t <= last.t) return; // 时间戳必须严格递增，重复点会整条判脚本
    trajPoints.push({
      x: Math.round(e.clientX ?? e.touches?.[0]?.clientX ?? 0),
      y: Math.round(e.clientY ?? e.touches?.[0]?.clientY ?? 0),
      t,
    });
  };
  document.addEventListener('mousemove', onMove, { passive: true });
  document.addEventListener('touchmove', onMove, { passive: true });
  document.addEventListener('pointerdown', onMove, { passive: true });
  document.addEventListener('pointerup', onMove, { passive: true });
  trajCleanup = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('pointerdown', onMove);
    document.removeEventListener('pointerup', onMove);
  };

  function getTrajectory() {
    if (trajPoints.length < 5) return null;
    const firstT = trajPoints[0].t;
    const maxPts = 100;
    const step = Math.max(1, Math.floor(trajPoints.length / maxPts));
    const sampled = [];
    for (let i = 0; i < trajPoints.length; i += step) {
      const p = trajPoints[i];
      sampled.push({ x: p.x, y: p.y, t: p.t - firstT });
    }
    return sampled;
  }

  // 表单填写行为追踪
  const fb = { fields: {}, startTime: Date.now(), focusOrder: [] };
  form.querySelectorAll('input').forEach((inp) => {
    const name = inp.name;
    inp.addEventListener('focus', () => {
      if (!fb.fields[name]) {
        fb.fields[name] = { keystrokes: [] };
        fb.focusOrder.push(name);
      }
    });
    inp.addEventListener('input', () => {
      if (!fb.fields[name]) {
        fb.fields[name] = { keystrokes: [] };
        fb.focusOrder.push(name);
      }
      fb.fields[name].keystrokes.push(Date.now());
    });
  });
  function getFormBehavior() {
    const fields = {};
    for (const [name, d] of Object.entries(fb.fields)) {
      const k = d.keystrokes;
      if (k.length < 2) continue;
      const gaps = [];
      for (let i = 1; i < k.length; i++) gaps.push(k[i] - k[i - 1]);
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const v = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
      fields[name] = { n: k.length, meanGap: Math.round(mean), varGap: Math.round(v) };
    }
    const totalKeystrokes = Object.values(fields).reduce((s, f) => s + f.n, 0);
    if (totalKeystrokes < 3) return null;
    return { fields, totalMs: Date.now() - fb.startTime, focusOrder: fb.focusOrder };
  }

  if (turnstileEl) {
    let verifying = false;
    const doVerify = async (e) => {
      if (turnstileVerified || verifying) return;
      verifying = true;
      // 先摘掉错误态（红字、抖动），再换文字——不然旧红字会带着 error 色渲染进淡出动画
      turnstileEl.classList.remove('error');
      turnstileEl.classList.remove('shake');
      setTurnstileLabel(turnstileEl, turnstileLabel, '我不是机器人');
      createRipple(e);
      turnstileEl.classList.add('loading');
      turnstileIcon.innerHTML = BLINK_DOTS;
      try {
        // 先做工作量证明（防脚本的算力闸）
        setTurnstileLabel(turnstileEl, turnstileLabel, '正在验证');
        const pow = await getPowProof();
        const data = await api('/auth/turnstile', {
          method: 'POST',
          body: { trajectory: getTrajectory(), formBehavior: getFormBehavior(), hints: getHints(), pow },
        });
        // 行为分析落在不确定区：弹窗让人把图片回正，解完才有 token。
        if (data.challenge) {
          const token = await solveRotatePuzzle(data.challenge);
          if (token === null) {
            turnstileEl.classList.remove('loading');
            turnstileIcon.innerHTML = '';
            setTurnstileLabel(turnstileEl, turnstileLabel, '我不是机器人');
            verifying = false;
            return;
          }
          turnstileToken = token;
        } else {
          turnstileToken = data.token;
        }
        turnstileVerified = true;
        turnstileEl.classList.remove('loading');
        turnstileEl.classList.add('verified');
        turnstileIcon.innerHTML = '<svg class="turnstile-check" viewBox="0 0 24 24" aria-hidden="true"><polyline points="4 12 9 17 20 6" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        setTurnstileLabel(turnstileEl, turnstileLabel, '验证通过');
      } catch (err) {
        turnstileEl.classList.remove('loading');
        turnstileEl.classList.add('shake');
        turnstileEl.classList.add('error');
        turnstileEl.addEventListener('animationend', function onShake() {
          turnstileEl.classList.remove('shake');
          turnstileEl.removeEventListener('animationend', onShake);
        });
        turnstileIcon.innerHTML = '';
        setTurnstileLabel(turnstileEl, turnstileLabel, '验证失败，点击重试');
      } finally {
        verifying = false;
      }
    };
    turnstileEl.onclick = doVerify;
    turnstileEl.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doVerify(e); } };
  }

  animateAuthHeight(fromHeight);

  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const errEl = form.querySelector('[data-err]');
    btn.disabled = true;
    // A one-line error fits inside .err's min-height and costs nothing; a wrapped
    // one moves the whole card, so clearing it is a height change too.
    const beforeClear = form.offsetHeight;
    errEl.textContent = '';
    animateAuthHeight(beforeClear);
    try {
      if (turnstileEl && !turnstileVerified) {
        errEl.textContent = '请先完成验证';
        btn.disabled = false;
        return;
      }
      const fd = Object.fromEntries(new FormData(form));
      if (turnstileToken) fd.turnstile_token = turnstileToken;
      if (state.cfg?.terms && fd.agree) fd.termsVersion = state.cfg.terms.version;
      delete fd.agree;
      const { user, welcomePoints } = await api(`/auth/${mode}`, { method: 'POST', body: fd });
      state.user = user;
      location.hash = '#/instances';
      await boot();
      // 见面礼直接说清楚是什么、能干什么，别让人回头再去问管理员。
      if (welcomePoints) {
        const p = state.cfg?.points;
        const spend =
          p?.siteCost > 0 && p?.instanceCost > 0
            ? `够发 ${Math.floor(welcomePoints / p.siteCost)} 个静态站点，或开 ${Math.floor(
                welcomePoints / p.instanceCost
              )} 台基础实例`
            : '发静态站点、开基础实例都能花';
        toast(`已送你 ${welcomePoints} 积分 —— ${spend}`, 'ok');
      }
    } catch (err) {
      // 密码是对的、账号被停用：api() 已经切到停用页了，这张表单已经不在文档里，
      // 别再往它的错误栏里写字。
      if (state.disabled) return;
      const beforeErr = form.offsetHeight;
      errEl.textContent = err.message;
      animateAuthHeight(beforeErr);
    } finally {
      btn.disabled = false;
    }
  };
}

/* ---------------- stopped-account screen ----------------
   A stopped account gets a page of its own instead of a red line under the
   sign-in form. Nothing typed into that form can help, so leaving it on screen
   only invites another attempt; this says what happened, what survived, and who
   to go ask. Same dot-field shell as the sign-in screen so it still reads as the
   same product — only the mark above the card turns danger. */
/** 切过去，已经在这一页就不重画——不然每个失败的在途请求都会把页面重置一次。 */
function showDisabled(info) {
  if (!state.disabled) renderDisabled(info);
}

function renderDisabled({ username } = {}) {
  clearTimers();
  // 大部分接口的 403 只说「停用了」不带名字，但如果是从面板里被踢出来的，
  // 我们本来就知道是谁。
  const who = username ?? state.user?.username ?? null;
  state.user = null;
  state.disabled = { username: who };
  app.className = 'auth-wrap';
  app.innerHTML = `
    <div class="statemark">${icon('ban', { title: '账号已被停用' })}</div>
    <div class="card auth stopped">
      <h1>账号已被停用</h1>
      <div class="sub">${icon('info')}管理员停用了这个账号，暂时不能使用面板。</div>
      ${who ? `<div class="who">${icon('circle-user')}${esc(who)}</div>` : ''}
      <p class="note">你的实例和数据都还在，账号恢复后可以接着用。
        如果觉得这是误操作，请联系管理员说明情况。</p>
      <button class="ghost" id="stopped-back">${icon('log-out')}返回登录</button>
    </div>`;

  document.getElementById('stopped-back').onclick = async () => {
    // 会话故意留着（后端不再在停用时删它），所以退出得走一次 logout 把 cookie
    // 清掉，不然刷新又回到这一页。
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    state.disabled = null;
    renderAuth();
  };
}

/* ---------------- shell ---------------- */
/**
 * Brings the current item of a horizontally scrolling strip into view.
 *
 * On a phone the header nav, the instance tabs and the admin tabs are all single
 * scrolling rows, so the active one is regularly off-screen after a re-render —
 * and then nothing on screen says which page you are on. `nearest` so a strip
 * that already shows it is left alone, and `instant` because this runs during a
 * render, not as a response to a gesture.
 */
/**
 * Gives every cell in a `.cards` table the text of the column it sits under, so
 * the phone layout can print `label  value` once the heading row is hidden.
 *
 * Read off the <th> row on purpose: the alternative is a data-label on all ~33
 * <td>s across the admin templates, spelling out headings that are already in the
 * same template string — and going stale the first time a column moves. Called
 * from shell(), which *is* the re-render, so it re-runs with every repaint; a
 * table injected into the page after that has to call this itself.
 */
function labelCards(root = app) {
  root.querySelectorAll('table.cards').forEach((t) => {
    const heads = [...t.querySelectorAll('tr:has(th) th')].map((th) => th.textContent.trim());
    if (!heads.length) return;
    t.querySelectorAll('tr:not(:has(th))').forEach((tr) =>
      [...tr.children].forEach((td, n) => {
        if (td.colSpan === 1) td.dataset.label = heads[n] ?? '';
      })
    );
  });
}

function revealActive(container, selector) {
  const strip = typeof container === 'string' ? document.querySelector(container) : container;
  const on = strip?.querySelector(selector);
  if (!on || strip.scrollWidth <= strip.clientWidth + 1) return;
  on.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'instant' });
}

/* ---------------- announcements ---------------- */
const ANN_CLOSED_KEY = 'lh.announcements.closed';

function getClosedAnnouncements() {
  try { return JSON.parse(localStorage.getItem(ANN_CLOSED_KEY)) || []; } catch { return []; }
}

function markAnnouncementClosed(id) {
  const closed = getClosedAnnouncements();
  if (closed.indexOf(id) === -1) closed.push(id);
  localStorage.setItem(ANN_CLOSED_KEY, JSON.stringify(closed));
}

function isAnnouncementClosed(id) {
  return getClosedAnnouncements().indexOf(id) !== -1;
}

const ANN_COLLAPSED = 'lh.announcements.collapsed';

function announcementBarHtml(announcements) {
  if (!announcements?.length) return '';
  const visible = announcements.filter(a => a.dismissible === false || !isAnnouncementClosed(a.id));
  if (!visible.length) return '';
  const collapsed = localStorage.getItem(ANN_COLLAPSED) === '1';
  const icons = { info: 'info', warning: 'circle-alert', critical: 'circle-alert' };
  return `<details class="announcement-bar" id="ann-bar"${collapsed ? '' : ' open'}>
      <summary>
        <span class="announcement-bar-caret">${icon('chevron-right')}</span>
        ${icon('info')}<b>公告</b>
        <span class="sub">${visible.length} 条</span>
      </summary>
      <div class="announcement-bar-content">${visible.map(a => `
        <div class="announcement-banner ${esc(a.priority)}">
          <div class="announcement-banner-inner">
            <span class="announcement-banner-ico">${icon(icons[a.priority] || 'info')}</span>
            <div class="announcement-banner-body">${a.title ? `<b class="announcement-banner-title">${esc(a.title)}</b>` : ''}${a.html}</div>
            ${a.dismissible ? `<button class="announcement-banner-close" data-dismiss-ann="${a.id}" aria-label="关闭公告">${icon('x')}</button>` : ''}
          </div>
        </div>`).join('')}
      </div>
    </details>`;
}

function announcementPanelHtml(announcements) {
  if (!announcements?.length) return '';
  const visible = announcements.filter(a => a.dismissible === false || !isAnnouncementClosed(a.id));
  if (!visible.length) return '';
  return `<div class="card" style="margin-bottom:16px">
    ${visible.map(a => `
      <div class="announcement-item ${esc(a.priority)}">
        <div class="announcement-item-head">
          <span class="badge ${esc(a.priority)}">${icon({ info: 'info', warning: 'circle-alert', critical: 'circle-alert' }[a.priority] || 'info')}${esc({ info: '信息', warning: '提醒', critical: '重要' }[a.priority] || a.priority)}</span>
          <b>${esc(a.title)}</b>
        </div>
        <div class="announcement-item-body">${a.html}</div>
      </div>
    `).join('')}
  </div>`;
}

function wireAnnouncementDismiss() {
  app.querySelectorAll('[data-dismiss-ann]').forEach(b => {
    b.onclick = () => {
      markAnnouncementClosed(Number(b.dataset.dismissAnn));
      const banner = b.closest('.announcement-banner');
      if (banner) {
        banner.style.transition = 'opacity .25s, margin .25s, padding .25s';
        banner.style.opacity = '0';
        banner.style.marginTop = '0';
        banner.style.paddingTop = '0';
        banner.style.paddingBottom = '0';
        banner.style.overflow = 'hidden';
        setTimeout(() => {
          banner.remove();
          const bar = document.getElementById('ann-bar');
          if (bar) {
            const content = bar.querySelector('.announcement-bar-content');
            if (content && !content.querySelector('.announcement-banner')) {
              bar.remove();
              localStorage.removeItem(ANN_COLLAPSED);
            }
          }
        }, 260);
      }
    };
  });

  const annBar = document.getElementById('ann-bar');
  if (annBar) {
    annBar.ontoggle = () => localStorage.setItem(ANN_COLLAPSED, annBar.open ? '0' : '1');
  }
}

/* ---------------- announcement lightbox ---------------- */
let annLightbox = null;

function closeAnnouncementLightbox() {
  if (!annLightbox) return;
  document.removeEventListener('keydown', onAnnLightboxKey);
  document.body.style.overflow = '';
  annLightbox.classList.remove('open');
  const el = annLightbox;
  setTimeout(() => el.remove(), 200);
  annLightbox = null;
}

function onAnnLightboxKey(e) {
  if (e.key === 'Escape') closeAnnouncementLightbox();
}

function openAnnouncementLightbox(img) {
  closeAnnouncementLightbox();
  annLightbox = document.createElement('div');
  annLightbox.className = 'lightbox';
  const big = document.createElement('img');
  big.src = img.currentSrc || img.src;
  big.alt = img.alt || '';
  annLightbox.appendChild(big);
  annLightbox.onclick = closeAnnouncementLightbox;
  document.body.appendChild(annLightbox);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onAnnLightboxKey);
  requestAnimationFrame(() => annLightbox.classList.add('open'));
}

function shell(active, inner) {
  const admin = state.user.role === 'admin';
  app.className = '';
  app.innerHTML = `
    <header class="top"><div class="inner">
      <div class="brand"><span class="brandmark">${icon('boxes')}</span>${esc(
        state.cfg?.panelName || 'localhosting'
      )}</div>
      <!-- aria-current as well as the .active pill: on a phone this strip is the
           only navigation, and it marks where you are with colour alone. -->
      <nav class="tabs">
        <a href="#/instances" class="${active === 'instances' ? 'active' : ''}"${
          active === 'instances' ? ' aria-current="page"' : ''
        }>${icon('boxes')}概览</a>
        <a href="#/new" class="${active === 'new' ? 'active' : ''}"${
          active === 'new' ? ' aria-current="page"' : ''
        }>${icon('circle-plus')}新建实例</a>
        ${
          state.cfg?.sites?.enabled
            ? `<a href="#/sites" class="${active === 'sites' ? 'active' : ''}"${
                active === 'sites' ? ' aria-current="page"' : ''
              }>${icon('globe')}静态站点</a>`
            : ''
        }
        ${
          admin
            ? `<a href="#/admin" class="${active === 'admin' ? 'active' : ''}"${
                active === 'admin' ? ' aria-current="page"' : ''
              }>${icon('shield')}管理后台${
                state.pendingCount ? ` <span class="badge pending">${state.pendingCount}</span>` : ''
              }</a>`
            : ''
        }
        <a href="#/account" class="${active === 'account' ? 'active' : ''}"${
          active === 'account' ? ' aria-current="page"' : ''
        }>${icon('circle-user')}账号</a>
      </nav>
      <div class="spacer"></div>
      <div class="whoami">
        <div class="avatar">${esc(state.user.username.slice(0, 2).toUpperCase())}</div>
        <span>${esc(state.user.username)}${admin ? ' · 管理员' : ''}</span>
        <button class="small ghost" id="logout">${icon('log-out')}退出</button>
      </div>
    </div></header>
    <div class="shell">${announcementBarHtml(state.announcements)}${onboardingBarHtml(active)}${inner}</div>`;
  document.getElementById('logout').onclick = async () => {
    await api('/auth/logout', { method: 'POST' });
    state.user = null;
    state.onboarding = null;
    obSeen = null; // the next account starts its own diff, not this one's
    clearTimers();
    renderAuth();
  };
  revealActive('header.top nav.tabs', 'a.active');
  wireOnboardingBar();
  wireAnnouncementDismiss();
  labelCards();
}

/* ---------------- onboarding ----------------
   A full-screen wizard the first time someone lands here, and — once it is
   closed — a collapsible checklist above the page until all four boxes tick
   themselves. The boxes are ticked by the server from real data, never by the
   wizard: reading a page is not the same as having done the thing. */

const OB_COLLAPSED = 'lh.onboarding.collapsed';
/** Pages the checklist belongs on. Instance detail is deliberately left alone,
    and 账号 is skipped because it hosts the same progress in a card of its own. */
const OB_PAGES = new Set(['instances', 'new', 'sites']);

const patchOnboarding = (body) =>
  api('/auth/onboarding', { method: 'PATCH', body }).then(
    (r) => (state.onboarding = r.onboarding),
    () => {}
  );

function celebrateOnboarding() {
  const ob = state.onboarding;
  if (!ob?.allDone || ob.state === 'done') return;
  state.onboarding = { ...ob, state: 'done' };
  toast('🎉 新手指引完成 —— 剩下的你已经会了', 'ok');
  patchOnboarding({ state: 'done' });
}

/** The wizard's pages. The static-site one only exists when the feature is on. */
function obSteps() {
  const sites = !!state.cfg?.sites?.enabled;
  const steps = [
    {
      title: `欢迎，${esc(state.user.username)}`,
      body: `
        <p>这个面板帮你把一个服务真正跑起来：你挑镜像、填几个参数，它负责建容器、分端口，
          管理员负责把它接到公网上 —— 全程不用碰命令行。</p>
        <div class="ob-flow">
          <span>${icon('sparkles')}手里有积分</span><i>${icon('chevron-right')}</i>
          <span>${icon('layers')}挑模板填参数</span><i>${icon('chevron-right')}</i>
          <span>${icon('inbox')}提交申请</span><i>${icon('chevron-right')}</i>
          <span>${icon('shield')}管理员放行</span><i>${icon('chevron-right')}</i>
          <span>${icon('link')}拿到访问地址</span>
        </div>
        <p class="sub">下面${sites ? '三' : '两'}页把要点讲完，随时可以跳过。</p>`,
    },
    {
      title: '第一件事：看看你的积分',
      body: `
        <p>积分是这里的通用货币：开实例 <b>${state.cfg?.points?.instanceCost ?? 100} 分起</b>（含 ${
          state.cfg?.points?.instanceSpec?.cpus ?? 0.1
        } 核 · ${state.cfg?.points?.instanceSpec?.memoryMb ?? 128} MB · 1 个端口${
          state.cfg?.points?.instanceSpec?.days ? ` · 有效 ${state.cfg.points.instanceSpec.days} 天` : ''
        }），内存、CPU、端口都能加积分往上配；发一个<b>静态站点</b>花 ${
          state.cfg?.points?.siteCost ?? 50
        } 分。你现在有 <b>${state.user.points ?? 0}</b> 分${
          state.cfg?.welcomePoints ? `（注册送的 ${state.cfg.welcomePoints} 分就在里面）` : ''
        }。</p>
        <p>想要超出加配封顶的规格？向管理员要一张<b>资源券</b>：券上写死了内存、CPU 和端口数，
          创建时填上它就不扣积分。管理员发的<b>积分兑换码</b>则在「账号」页兑成积分再花。</p>
        <label class="field" style="margin-top:4px"><span>${icon(
          'ticket'
        )}已经拿到券了？粘进来看看额度</span>
          <input id="ob-voucher" placeholder="例如 K7M2-9QF4-…" autocomplete="off" />
          <div class="hint" id="ob-voucher-info">只是查一下，不会花掉次数。</div>
        </label>
        ${
          state.cfg?.refundInviteOnDelete === false
            ? ''
            : '<p class="sub">删除实例默认会把积分 / 券退回来，所以放心建、放心重来。</p>'
        }`,
    },
    {
      title: '提交的是申请，不是命令',
      body: `
        <p>点「提交申请」的那一刻，面板<b>还不会碰 Docker</b>：它只是扣掉积分（或券的次数），
          然后从端口池里替你预留好主机端口。</p>
        <p>接着管理员照着这个端口把内网穿透配好、填上你实际要访问的地址，点放行 ——
          这时候容器才开始拉镜像、启动，实时进度你在实例页看得到。</p>
        <p>所以刚提交时状态是<span class="badge pending">待审批</span>。被驳回、或者你自己撤回，
          端口立刻释放、积分 / 券原样退回。</p>
        ${
          state.cfg?.sleep?.enabled
            ? `<div class="hint">顺带一提：勾上「闲时休眠」的实例，没人访问就自动停掉、不占内存和 CPU，
                 下一个人连上来面板再把它拉起来，冷启动一两秒。</div>`
            : ''
        }`,
    },
  ];
  if (sites) {
    steps.push({
      title: '只想放个网页？拖进去就完事',
      body: `
        <p>要上线的只是一个 HTML 页面、或者一整个网页文件夹的话，根本不用建容器：
          到「静态站点」把文件拖进方框、填个站点名，点发布，地址立刻就能访问。</p>
        <p>这条路<b>不占端口、也不用等审批</b> —— 文件是面板自己存、自己发的，
          一个站点只按 ${state.cfg?.sites?.cpus ?? 0.1} 核 · ${state.cfg?.sites?.memoryMb ?? 32} MB 记账。
          发一个花 ${state.cfg?.points?.siteCost ?? 50} 积分（手里有券也可以用券），删掉退回。</p>
        <p class="sub">地址长这样：<code class="mono">/s/你的站点名/</code></p>`,
    });
  }
  return steps;
}

function openWizard(startStep = 0) {
  const steps = obSteps();
  let idx = Math.min(Math.max(0, Number(startStep) || 0), steps.length - 1);
  let goTo = null;

  document.getElementById('ob-dialog')?.remove();
  const dlg = document.createElement('dialog');
  dlg.id = 'ob-dialog';
  dlg.className = 'ob';
  dlg.setAttribute('aria-labelledby', 'ob-title');
  // The frame is built once and only its *state* changes per step. Re-rendering
  // it wholesale (as this used to) restarted the dot transitions from scratch
  // and dropped keyboard focus on the floor every time someone pressed 下一步.
  dlg.innerHTML = `
    <div class="ob-panel">
      <div class="ob-top">
        <div class="ob-dots">${steps
          .map(
            (x, n) => `<button data-ob-step="${n}" aria-label="第 ${n + 1} 步：${esc(x.title)}"><i></i></button>`
          )
          .join('')}</div>
        <div class="spacer" style="flex:1"></div>
        <button class="small ghost" id="ob-skip"></button>
      </div>
      <div class="ob-body" id="ob-body"></div>
      <div class="ob-foot">
        <button class="small ghost" id="ob-prev">${icon('arrow-left')}上一步</button>
        <div class="spacer" style="flex:1"></div>
        <button class="primary" id="ob-next"></button>
      </div>
    </div>`;
  document.body.append(dlg);

  const page = dlg.querySelector('#ob-body');
  const prev = dlg.querySelector('#ob-prev');
  const next = dlg.querySelector('#ob-next');
  const skip = dlg.querySelector('#ob-skip');
  const dots = [...dlg.querySelectorAll('[data-ob-step]')];

  // Clicking the backdrop targets the dialog itself; Esc fires close on its own.
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.addEventListener('close', async () => {
    // The node has to outlive close() by the length of the exit transition,
    // otherwise there is nothing left on screen to animate.
    setTimeout(() => dlg.remove(), REDUCED_MOTION.matches ? 0 : 220);
    await patchOnboarding({ state: 'checklist', step: idx });
    if (goTo && location.hash !== goTo) location.hash = goTo;
    else route();
  });
  // ← / → walk the steps. Ignored while typing, where they belong to the caret.
  dlg.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowRight' && idx < steps.length - 1) go(idx + 1);
    else if (e.key === 'ArrowLeft' && idx > 0) go(idx - 1);
    else return;
    e.preventDefault();
  });

  const go = (n) => {
    const dir = Math.sign(n - idx);
    idx = n;
    paint(dir);
    patchOnboarding({ step: idx });
  };

  const paint = (dir = 0) => {
    const last = idx === steps.length - 1;
    const from = dir ? page.offsetHeight : 0;

    page.innerHTML = `
      <div class="ob-eyebrow">${icon('graduation-cap')}新手指引 · 第 ${idx + 1} / ${steps.length} 步</div>
      <h2 id="ob-title">${steps[idx].title}</h2>
      ${steps[idx].body}
      ${
        last
          ? `<div class="ob-cta">
               <button class="primary" data-ob-go="#/new">${icon('circle-plus')}去创建第一个实例</button>
               ${
                 state.cfg?.sites?.enabled
                   ? `<button data-ob-go="#/sites">${icon('globe')}去发布一个网页</button>`
                   : ''
               }
             </div>`
          : ''
      }`;

    dots.forEach((b, n) => {
      b.className = n === idx ? 'on' : n < idx ? 'past' : '';
      if (n === idx) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
    });
    prev.disabled = !idx;
    next.innerHTML = last ? `${icon('rocket')}开始使用` : `下一步${icon('arrow-right')}`;
    skip.innerHTML = `${last ? '关闭' : '跳过'}${icon('x')}`;

    // Slide in from the side you came from, and grow the page to its new height
    // so the footer stays put instead of being kicked down the screen. Driven
    // from script rather than a class + CSS transition: parking the element on
    // the start state is itself a style change, so the transition would fire
    // once on the way *in* to that state and cancel the one that matters. The
    // content is thrown away wholesale each step, so there is nothing here that
    // would benefit from a transition's interruptibility anyway.
    if (dir && !REDUCED_MOTION.matches) {
      const to = page.offsetHeight;
      page.animate(
        [
          { opacity: 0, transform: `translateX(${dir > 0 ? 16 : -16}px)`, filter: 'blur(3px)' },
          { opacity: 1, transform: 'none', filter: 'none' },
        ],
        { duration: 210, easing: EASE_OUT }
      );
      if (from !== to) {
        page.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 280, easing: EASE_OUT });
      }
    }

    wireStep();
    // Keep the primary action under the finger / Enter key across steps.
    next.focus({ preventScroll: true });
  };

  const wireStep = () => {
    page.querySelectorAll('[data-ob-go]').forEach(
      (b) =>
        (b.onclick = () => {
          goTo = b.dataset.obGo;
          dlg.close();
        })
    );

    // Same live lookup as the create form — checking a code here also ticks the
    // "got a voucher" box, because the server records the successful lookup.
    // Deliberately not focused: it is the optional path on this page, and on a
    // phone focusing it would throw the keyboard over the text being read.
    const vin = page.querySelector('#ob-voucher');
    if (!vin) return;
    const info = page.querySelector('#ob-voucher-info');
    let t;
    vin.oninput = () => {
      clearTimeout(t);
      const code = vin.value.trim();
      if (code.length < 4) {
        info.style.color = '';
        info.textContent = '只是查一下，不会花掉次数。';
        return;
      }
      t = setTimeout(async () => {
        try {
          const { voucher: v } = await api(`/auth/voucher/${encodeURIComponent(code)}`);
          info.style.color = 'var(--success)';
          info.textContent = `✓ 内存 ${v.memoryMb} MB · CPU ${v.cpus} 核 · 端口 ${v.ports} 个${
            v.diskMb ? ` · 硬盘 ${fmtMb(v.diskMb)}` : ''
          } · 还能用 ${v.remaining} 次${v.allowCustomImage ? ' · 允许自定义镜像' : ''}`;
        } catch (err) {
          info.style.color = 'var(--danger)';
          info.textContent = err.message;
        }
      }, 350);
    };
  };

  dots.forEach((b) => (b.onclick = () => go(Number(b.dataset.obStep))));
  prev.onclick = () => idx && go(idx - 1);
  next.onclick = () => (idx === steps.length - 1 ? dlg.close() : go(idx + 1));
  skip.onclick = () => dlg.close();

  paint();
  dlg.showModal();
}

/** The four boxes. `step` on an action reopens the wizard at that page. */
function obTasks() {
  const sites = !!state.cfg?.sites?.enabled;
  return [
    { key: 'account', title: '账号已开通', desc: '你已经登录进来了，这一步白送。' },
    {
      key: 'voucher',
      title: '手里有积分',
      desc: state.cfg?.welcomePoints
        ? `注册已经送了 ${state.cfg.welcomePoints} 积分，发站点、开实例都用它，内存、CPU、端口能加分往上配；超出封顶的规格再向管理员要资源券。`
        : '积分靠管理员发的兑换码获得；超出加配封顶的规格就向管理员要一张资源券。',
      actions: [{ label: '积分怎么花', step: 1, icon: 'sparkles' }],
    },
    {
      key: 'deploy',
      title: '上线第一个服务',
      desc: sites
        ? '挑个模板填参数，提交申请，积分自动扣；只是个网页的话直接拖进静态站点更快。'
        : '挑个模板填参数，提交申请，积分自动扣。',
      actions: sites
        ? [
            { label: '去创建实例', href: '#/new', icon: 'circle-plus' },
            { label: '拖个网页', href: '#/sites', icon: 'globe' },
          ]
        : [{ label: '去创建实例', href: '#/new', icon: 'circle-plus' }],
    },
    {
      key: 'live',
      title: '拿到可访问的地址',
      desc: '管理员配好内网穿透并放行之后，地址就出现在实例卡片上，点一下即可复制。',
      actions: [{ label: '查看概览', href: '#/instances', icon: 'boxes' }],
    },
  ];
}

/* What the bar looked like the last time it was drawn. The bar is rebuilt from
   scratch on every navigation, so without this a box that ticked while you were
   on another page would simply *be* ticked — the one moment worth showing is
   exactly the one that gets lost. */
let obSeen = null;

function onboardingBarHtml(active) {
  const ob = state.onboarding;
  if (!ob || ob.state !== 'checklist' || !OB_PAGES.has(active)) return '';
  if (location.hash.startsWith('#/i/')) return ''; // instance detail borrows active='instances'

  // On a phone the expanded checklist is 537px tall, which together with the
  // header means a new account's first screen is entirely chrome and not one
  // instance card. It starts folded there — the summary line still says how far
  // along they are, and opening it is one tap. A stored preference always wins.
  const stored = localStorage.getItem(OB_COLLAPSED);
  const collapsed = stored === null ? innerWidth <= 640 : stored === '1';
  const pct = Math.round((ob.done / ob.total) * 100);
  const items = obTasks()
    .map((t) => {
      const done = !!ob.progress[t.key];
      const just = done && obSeen && !obSeen.progress[t.key];
      const actions = done
        ? ''
        : (t.actions || [])
            .map((a) =>
              a.href
                ? `<a class="btn small" href="${esc(a.href)}">${icon(a.icon)}${esc(a.label)}</a>`
                : `<button class="small ghost" data-ob-open="${a.step}">${icon(a.icon)}${esc(
                    a.label
                  )}</button>`
            )
            .join('');
      return `<li class="ob-task${done ? ' done' : ''}${just ? ' just' : ''}">
          <span class="ob-check" aria-hidden="true"></span>
          <div style="flex:1;min-width:0">
            <div class="ob-task-name">${esc(t.title)}</div>
            <div class="sub">${esc(t.desc)}</div>
          </div>
          <div class="row">${actions}</div>
        </li>`;
    })
    .join('');

  // Painted at the old percentage and nudged to the new one a frame later, so
  // the fill slides instead of teleporting on a freshly built element.
  const meter = `<span class="meter ob-meter"><i style="width:${obSeen?.pct ?? pct}%" data-to="${pct}%"></i></span>`;
  obSeen = { progress: { ...ob.progress }, pct };

  return `<details class="ob-bar" id="ob-bar"${collapsed ? '' : ' open'}>
      <summary>
        <span class="ob-caret">${icon('chevron-right')}</span>
        ${icon('graduation-cap')}<b>新手指引</b>
        ${meter}
        <span class="sub">${ob.done} / ${ob.total} 完成</span>
      </summary>
      <ol class="ob-tasks">${items}</ol>
      <div class="ob-bar-foot">
        <button class="small ghost" data-ob-open="0">${icon('graduation-cap')}重看一遍向导</button>
        <button class="small ghost" data-ob-dismiss>${icon('x')}不再显示</button>
      </div>
    </details>`;
}

function wireOnboardingBar() {
  const bar = document.getElementById('ob-bar');
  if (bar) bar.ontoggle = () => localStorage.setItem(OB_COLLAPSED, bar.open ? '0' : '1');
  const fill = bar?.querySelector('.ob-meter > i');
  if (fill) requestAnimationFrame(() => (fill.style.width = fill.dataset.to));
  app.querySelectorAll('[data-ob-open]').forEach((b) => (b.onclick = () => openWizard(b.dataset.obOpen)));
  const off = app.querySelector('[data-ob-dismiss]');
  if (off) {
    off.onclick = async () => {
      await patchOnboarding({ state: 'done' });
      toast('已隐藏；想再看可以到「账号」页打开', 'ok');
      route();
    };
  }
  const back = app.querySelector('[data-ob-show]');
  if (back) {
    back.onclick = async () => {
      await patchOnboarding({ state: 'checklist' });
      route();
    };
  }
}

const maybeOpenWizard = () => {
  if (state.onboarding?.state === 'new') openWizard(state.onboarding.step);
};

/* ---------------- instance list ---------------- */
function instanceCard(i) {
  const ports = i.ports
    .map(
      (p) =>
        `<span class="addr" data-copy="${esc(p.address)}" title="点击复制">${icon('link')}${esc(
          p.address
        )}<small>${esc(p.label)} · ${p.container}/${p.protocol}</small>${icon('copy', {
          cls: 'trail',
        })}</span>`
    )
    .join('');
  return `
    <div class="card inst">
      <div class="head">
        <div style="flex:1;min-width:0">
          <div class="name">${esc(i.name)}</div>
          <div class="img">${esc(i.image)}</div>
        </div>
        ${badge(i.status)}
      </div>
      ${i.error ? `<div class="err">${icon('triangle-alert')}${esc(i.error)}</div>` : ''}
      ${
        i.rejectReason
          ? `<div class="err">${icon('ban')}驳回原因：${esc(i.rejectReason)}</div>`
          : ''
      }
      ${
        i.status === 'pending'
          ? `<div class="sub">${icon('plug')}已占用主机端口 ${
              i.ports.map((p) => p.host).join('、') || '无'
            }，等管理员配置穿透后放行。</div>`
          : `<div class="row">${ports || '<span class="sub">未映射端口</span>'}</div>`
      }
      <div class="kv">
        <span>${icon('memory-stick')}内存 ${i.memoryMb} MB</span><span>${icon('cpu')}CPU ${i.cpus}</span>
        ${
          i.disk?.quotaMb
            ? `<span>${icon('hard-drive')}磁盘 ${
                i.disk.usedBytes != null ? bytes(i.disk.usedBytes) : '?'
              } / ${i.disk.quotaMb}MB</span>`
            : ''
        }
        ${i.sleep?.enabled ? `<span>${icon('moon')}空闲 ${i.sleep.idleMinutes} 分钟休眠</span>` : ''}
        <span>${icon('calendar')}${i.status === 'pending' ? '申请于' : '创建于'} ${when(i.createdAt)}</span>
        ${
          i.life?.expiresAt && i.status !== 'archived'
            ? `<span${expiringSoon(i.life) ? ' class="warn"' : ''}>${icon('hourglass')}${lasts(
                i.life.remainingMs
              )}到期</span>`
            : i.life?.days && !i.life.expiresAt
              ? `<span>${icon('hourglass')}放行后有效 ${i.life.days} 天</span>`
              : ''
        }
      </div>
      ${
        i.status === 'archived'
          ? `<div class="hint">${icon('archive')}有效期已到，实例于 ${when(
              i.life?.archivedAt
            )} 封存。${
              i.life?.graceRemainingMs != null
                ? i.life.graceRemainingMs > 0
                  ? `数据保留 ${lasts(i.life.graceRemainingMs)}，之后永久删除。`
                  : '宽限期已过，数据已永久删除。'
                : '数据卷还留着，但无法再启动。'
            }</div>`
          : i.status === 'sleeping'
            ? `<div class="hint">${icon('moon')}已休眠以省资源，访问上面的地址会自动启动（约几秒）。</div>`
            : ''
      }
      <div class="row" style="margin-top:auto">
        <a class="btn small" href="#/i/${esc(i.id)}">${icon('eye')}详情</a>
        ${
          i.status === 'pending' || i.status === 'rejected' || i.status === 'archived'
            ? ''
            : i.status === 'running'
              ? `<button class="small" data-act="stop" data-id="${esc(i.id)}">${icon('square')}停止</button>
                 <button class="small" data-act="restart" data-id="${esc(i.id)}">${icon(
                   'rotate-cw'
                 )}重启</button>`
              : `<button class="small" data-act="start" data-id="${esc(i.id)}">${
                  i.status === 'sleeping' ? `${icon('sunrise')}唤醒` : `${icon('play')}启动`
                }</button>`
        }
        <button class="small danger" data-del="${esc(i.id)}" data-name="${esc(i.name)}" ${
          i.status === 'pending' ? 'data-pending="1"' : ''
        }>${i.status === 'pending' ? `${icon('undo-2')}撤回申请` : `${icon('trash-2')}删除`}</button>
      </div>
    </div>`;
}

function quotaBar(usage, quota) {
  const pct = quota.maxInstances ? Math.min(100, (usage.instances / quota.maxInstances) * 100) : 0;
  return `<div class="card" style="display:flex;gap:30px;flex-wrap:wrap;align-items:flex-end">
    <div class="stat" style="min-width:150px">
      <span>${icon('boxes')}实例数</span>
      <b style="font-size:15px">${usage.instances} <span class="sub">/ ${quota.maxInstances}</span></b>
      <div class="meter" style="margin-top:5px"><i style="width:${pct}%"></i></div>
    </div>
    <div class="stat"><b style="font-size:15px">${usage.memoryMb} MB</b>
      <span>${icon('memory-stick')}已分配内存</span></div>
    <div class="stat"><b style="font-size:15px">${usage.cpus}</b>
      <span>${icon('cpu')}已分配 CPU</span></div>
    <div class="stat"><b style="font-size:15px">${fmtMb(usage.diskMb ?? 0)}</b>
      <span>${icon('hard-drive')}已分配硬盘</span></div>
    <div class="stat"><b style="font-size:15px">${usage.ports}</b>
      <span>${icon('plug')}已占用端口</span></div>
    <div class="sub" style="flex:1;min-width:180px;text-align:right">
      ${icon('ticket')}每个实例的资源由创建时使用的资源券决定
    </div>
  </div>`;
}

async function viewInstances() {
  shell('instances', loader());
  let signature = '';
  let checkedIn = false;
  const paint = async ({ force = true } = {}) => {
    const [{ instances, usage }] = await Promise.all([api('/instances'), syncMe()]);
    state.usage = usage;
    if (force) {
      try { const cs = await api('/checkin/status'); checkedIn = cs.checkedIn; } catch {}
    }
    const sig = JSON.stringify([
      instances.map((i) => [i.id, i.status, i.error, i.disk?.usedBytes]),
      usage,
      state.pendingCount,
      state.announcements.map(a => [a.id, a.html, a.active]),
      state.onboarding && [state.onboarding.state, state.onboarding.done],
    ]);
    if (!force && sig === signature) return;
    signature = sig;
    const body = instances.length
      ? `<div class="grid cols">${instances.map(instanceCard).join('')}</div>`
      : `<div class="card empty"><div class="big">${icon(
          'boxes'
        )}</div>还没有实例。<a href="#/new">去创建一个</a>吧。</div>`;
    const checkinBtn = checkedIn
      ? `<button class="btn primary" disabled style="opacity:.6">${icon('check')}已签到</button>`
      : `<button class="btn primary" id="checkin-btn">${icon('calendar')}每日签到</button>`;
    shell(
      'instances',
      `<div class="page-title"><span class="page-ico">${icon('boxes')}</span><h1>概览</h1>
        <span class="sub">${instances.length} 个</span>
        <div class="spacer" style="flex:1"></div>
        ${checkinBtn}</div>
       ${quotaBar(usage, state.user.quota)}
       <div style="height:16px"></div>${body}`
    );
    const cb = document.getElementById('checkin-btn');
    if (cb) cb.onclick = openCheckin;
    wireInstanceActions(paint);
  };
  await paint().catch((e) => toast(e.message, 'err'));
  timers.push(setInterval(() => paint({ force: false }).catch(() => {}), 6000));
}

async function openCheckin() {
  let status;
  try { status = await api('/checkin/status'); } catch (e) { return toast(e.message, 'err'); }
  if (status.checkedIn) return toast('今天已经签到过了，明天再来吧', 'ok');

  document.getElementById('checkin-dlg')?.remove();
  const dlg = document.createElement('dialog');
  dlg.id = 'checkin-dlg';
  dlg.innerHTML = `
    <div style="text-align:center">
      <div style="font-size:32px;margin-bottom:8px">${icon('calendar')}</div>
      <h3 style="margin:0 0 4px">每日签到</h3>
      <div class="sub" style="margin-bottom:16px">完成验证，随机获得 10 ~ 30 积分</div>
      <div class="checkin-stats">
        <div class="checkin-stat">
          <b>${state.user.points ?? 0}</b>
          <span>当前积分</span>
        </div>
        <div class="checkin-stat">
          <b>10 ~ 30</b>
          <span>今日奖励</span>
        </div>
      </div>
      <div class="turnstile-wrap" style="display:flex;flex-direction:column;align-items:center;margin:12px 0">
        <div class="turnstile" id="checkin-turnstile" role="button" tabindex="0" aria-label="我不是机器人，点击验证">
          <span class="turnstile-icon" id="checkin-turnstile-icon"></span>
          <span class="turnstile-label">我不是机器人</span>
        </div>
      </div>
      <div class="err" id="checkin-err"></div>
      <div class="row" style="justify-content:center;margin-top:16px;gap:8px">
        <button class="ghost" data-close>取消</button>
        <button class="primary" id="checkin-submit" disabled>${icon('sparkles')}签到得积分</button>
      </div>
    </div>`;
  document.body.append(dlg);
  const errEl = dlg.querySelector('#checkin-err');
  const submitBtn = dlg.querySelector('#checkin-submit');
  const turnstileEl = dlg.querySelector('#checkin-turnstile');
  const turnstileIcon = dlg.querySelector('#checkin-turnstile-icon');
  const turnstileLabel = turnstileEl?.querySelector('.turnstile-label');

  let turnstileVerified = false;
  let turnstileToken = null;
  let verifying = false;

  /* Track mouse/touch inside the dialog for behavior analysis */
  const traj = [];
  const onMove = (e) => {
    if (traj.length >= 500) return;
    const t = Date.now();
    const last = traj[traj.length - 1];
    if (last && t <= last.t) return; // 时间戳必须严格递增
    traj.push({
      x: Math.round(e.clientX ?? e.touches?.[0]?.clientX ?? 0),
      y: Math.round(e.clientY ?? e.touches?.[0]?.clientY ?? 0),
      t,
    });
  };
  document.addEventListener('mousemove', onMove, { passive: true });
  document.addEventListener('touchmove', onMove, { passive: true });
  document.addEventListener('pointerdown', onMove, { passive: true });
  document.addEventListener('pointerup', onMove, { passive: true });
  const trajCleanup = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('pointerdown', onMove);
    document.removeEventListener('pointerup', onMove);
  };

  const getTrajectory = () => {
    if (traj.length < 5) return null;
    const firstT = traj[0].t;
    const maxPts = 100;
    const step = Math.max(1, Math.floor(traj.length / maxPts));
    const sampled = [];
    for (let i = 0; i < traj.length; i += step) {
      const p = traj[i];
      sampled.push({ x: p.x, y: p.y, t: p.t - firstT });
    }
    return sampled;
  };

  const createRipple = (e) => {
    const rect = turnstileEl.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = (e.clientX || rect.left + rect.width / 2) - rect.left - size / 2;
    const y = (e.clientY || rect.top + rect.height / 2) - rect.top - size / 2;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    turnstileEl.append(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  };

  const doVerify = async (e) => {
    if (turnstileVerified || verifying) return;
    verifying = true;
    // 先摘掉错误态（红字、抖动），再换文字——不然旧红字会带着 error 色渲染进淡出动画
    turnstileEl.classList.remove('error');
    turnstileEl.classList.remove('shake');
    setTurnstileLabel(turnstileEl, turnstileLabel, '我不是机器人');
    createRipple(e);
    turnstileEl.classList.add('loading');
    turnstileIcon.innerHTML = BLINK_DOTS;
    try {
      // 先做工作量证明
      setTurnstileLabel(turnstileEl, turnstileLabel, '正在验证');
      const pow = await getPowProof();
      const data = await api('/auth/turnstile', {
        method: 'POST',
        body: { trajectory: getTrajectory(), hints: getHints(), pow },
      });
      // 行为分析落在不确定区：弹窗让人把图片回正，解完才有 token。
      if (data.challenge) {
        const token = await solveRotatePuzzle(data.challenge);
        if (token === null) {
          turnstileEl.classList.remove('loading');
          turnstileIcon.innerHTML = '';
          setTurnstileLabel(turnstileEl, turnstileLabel, '我不是机器人');
          verifying = false;
          return;
        }
        turnstileToken = token;
      } else {
        turnstileToken = data.token;
      }
      turnstileVerified = true;
      turnstileEl.classList.remove('loading');
      turnstileEl.classList.add('verified');
      turnstileIcon.innerHTML = '<svg class="turnstile-check" viewBox="0 0 24 24" aria-hidden="true"><polyline points="4 12 9 17 20 6" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      setTurnstileLabel(turnstileEl, turnstileLabel, '验证通过');
      submitBtn.disabled = false;
      submitBtn.focus();
    } catch (err) {
      turnstileEl.classList.remove('loading');
      turnstileEl.classList.add('shake');
      turnstileEl.classList.add('error');
      turnstileEl.addEventListener('animationend', function onShake() {
        turnstileEl.classList.remove('shake');
        turnstileEl.removeEventListener('animationend', onShake);
      });
      turnstileIcon.innerHTML = '';
      setTurnstileLabel(turnstileEl, turnstileLabel, '验证失败，点击重试');
    } finally {
      verifying = false;
    }
  };

  turnstileEl.onclick = doVerify;
  turnstileEl.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doVerify(e); } };

  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.onclose = () => { trajCleanup(); dlg.remove(); };

  submitBtn.onclick = async () => {
    submitBtn.disabled = true;
    errEl.textContent = '';
    try {
      const r = await api('/checkin', { method: 'POST', body: { turnstileToken } });
      trajCleanup();
      dlg.innerHTML = `
        <div class="checkin-done">
          <div style="font-size:48px;color:var(--success);margin-bottom:12px">${icon('circle-check')}</div>
          <h3 style="margin:0">签到成功！</h3>
          <div class="checkin-gain">+${r.points}<span> 积分</span></div>
          <div class="sub">当前积分：${r.total}，明天再来哦</div>
          <button class="primary" style="margin-top:20px" data-close>${icon('check')}好的</button>
        </div>`;
      dlg.querySelector('[data-close]').onclick = () => dlg.close();
      route();
    } catch (e) {
      errEl.textContent = e.message;
      submitBtn.disabled = false;
    }
  };

  dlg.showModal();
}

function wireInstanceActions(refresh) {
  app.querySelectorAll('[data-copy]').forEach((el) => (el.onclick = () => copy(el.dataset.copy)));
  app.querySelectorAll('[data-act]').forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await api(`/instances/${b.dataset.id}/action/${b.dataset.act}`, { method: 'POST' });
          toast('操作已执行', 'ok');
          await refresh();
        } catch (e) {
          toast(e.message, 'err');
          b.disabled = false;
        }
      })
  );
  app.querySelectorAll('[data-del]').forEach(
    (b) =>
      (b.onclick = async () => {
        const pending = !!b.dataset.pending;
        const msg = pending
          ? `撤回「${b.dataset.name}」的创建申请？占用的端口会释放，积分 / 券退回。`
          : `确定删除实例「${b.dataset.name}」？容器和数据卷都会被清除，不可恢复。`;
        const yes = await askDialog({
          title: pending ? '撤回申请' : '删除实例',
          label: pending ? '' : '请输入实例名称以确认',
          ok: pending ? '撤回' : '删除',
          kind: 'danger',
          hint: msg,
          match: pending ? '' : b.dataset.name,
        });
        if (yes !== (pending ? true : b.dataset.name)) return;
        b.disabled = true;
        try {
          const r = await api(`/instances/${b.dataset.del}`, { method: 'DELETE' });
          toast(
            r.refundedPoints
              ? `已删除，${r.refundedPoints} 积分已退回`
              : r.refundedInvite
                ? `已删除，资源券 ${r.refundedInvite} 的次数已退回`
                : '已删除',
            'ok'
          );
          if (location.hash.startsWith('#/i/')) location.hash = '#/instances';
          else await refresh();
        } catch (e) {
          toast(e.message, 'err');
          b.disabled = false;
        }
      })
  );
  app.querySelectorAll('[data-renew]').forEach(
    (b) =>
      (b.onclick = async () => {
        const cost = Number(b.dataset.cost);
        const days = Number(b.dataset.days);
        if (!confirm(`续期 ${days} 天需要 ${cost} 积分，确定继续？`)) return;
        b.disabled = true;
        try {
          const r = await api(`/instances/${b.dataset.renew}/renew`, { method: 'POST', body: { days } });
          toast(`已续期 ${days} 天${r.instance?.life?.expiresAt ? '，新到期 ' + r.instance.life.expiresAt.slice(0, 10) : ''}`, 'ok');
          await refresh();
        } catch (e) {
          toast(e.message, 'err');
          b.disabled = false;
        }
      })
  );
  app.querySelectorAll('[data-dl]').forEach((b) => {
    if (!b.dataset.dl || b.dataset.dl.length < 20) return;
    b.onclick = async () => {
      b.disabled = true;
      try {
        const res = await api(`/instances/${b.dataset.dl}/download`, { raw: true });
        const blob = await res.blob();
        const disp = res.headers.get('Content-Disposition') || '';
        const utf = disp.match(/filename\*=UTF-8''(.+?)(?:;|$)/);
        const name = utf ? decodeURIComponent(utf[1]) : (disp.match(/filename="(.+?)"/) || [])[1] || 'archive.tar';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        toast('数据下载已开始', 'ok');
      } catch (e) {
        toast(e.message, 'err');
      }
      b.disabled = false;
    };
  });
}

/* ---------------- create ---------------- */
function envFieldHtml(f, value) {
  const id = `env_${f.key}`;
  const val = value ?? f.default ?? '';
  if (f.type === 'select') {
    return `<label class="field"><span>${esc(f.label || f.key)}${f.required ? ' *' : ''}</span>
      <select name="${esc(id)}">${f.options
        .map((o) => `<option value="${esc(o)}" ${o === val ? 'selected' : ''}>${esc(o)}</option>`)
        .join('')}</select></label>`;
  }
  return `<label class="field"><span>${esc(f.label || f.key)}${f.required ? ' *' : ''}</span>
    <input name="${esc(id)}" type="${f.type === 'password' ? 'password' : 'text'}"
      value="${esc(val)}" placeholder="${f.generate === 'password' ? '留空则自动生成强密码' : ''}" />
    <div class="hint mono">${esc(f.key)}</div></label>`;
}

/* ---------------- create instance: four steps ----------------
   支付 → 模板 → 配置 → 确认。All input lives in `draft`, so walking back and
   forth never loses anything. Payment comes first on purpose: 不填券就是花积分
   按自己配的规格开实例（基础价 + 加配），填了券则用券上的规格 —— the template
   step can then flag cards the port quota can't cover, and unlock
   自定义镜像 when the voucher itself grants it. */
function viewNew() {
  const TITLES = ['支付方式', '选模板', '填配置', '确认提交'];
  const draft = {
    voucherCode: '',
    voucher: null, // last successful lookup, matching voucherCode
    spec: null, // 积分路径的规格，稍后初始化成基础价含的档位
    planId: null, // 选中的套餐卡：'0'…'n' 是预设档，'__custom__' 是自定义
    tplId: null, // template id or '__custom__'
    name: '',
    image: '',
    env: {}, // template env values the user typed
    portsText: '',
    envText: '',
    volumePath: '',
    cmdText: '',
    sleepEnabled: null, // null = follow the panel default
    idleMinutes: null,
    autoTunnel: false, // 管理员专用：放行时自动建 Cloudflare 隧道
    note: '',
  };
  let step = 0;

  shell(
    'new',
    `<div class="page-title"><span class="page-ico">${icon('circle-plus')}</span><h1>新建实例</h1>
       <span class="sub" id="nv-sub"></span></div>
     <ol class="steps" id="nv-steps"></ol>
     <div id="nv-slot"></div>`
  );
  const slot = document.getElementById('nv-slot');

  const tpl = () =>
    draft.tplId && draft.tplId !== '__custom__' ? state.templates.find((x) => x.id === draft.tplId) : null;
  // 积分路径的价目表来自 /api/config；万一还没加载到，就用和后端同款的默认值。
  const pSpec = () =>
    state.cfg?.points?.instanceSpec ?? { memoryMb: 128, cpus: 0.1, ports: 1, days: 7, diskMb: 2048 };
  const pAdd = () =>
    state.cfg?.points?.addons ?? {
      memStepMb: 128,
      memStepCost: 40,
      cpuStepCost: 10,
      portCost: 10,
      maxMemoryMb: 16384,
      maxCpus: 8,
      maxPorts: 4,
      diskStepMb: 2048,
      diskStepCost: 100,
      maxDiskMb: 16384,
    };
  if (!draft.spec)
    draft.spec = {
      memoryMb: pSpec().memoryMb,
      cpus: pSpec().cpus,
      diskMb: pSpec().diskMb,
      ports: pSpec().ports,
    };
  // 打包套餐：管理后台维护，内存 + CPU + 硬盘三样全对才认直减价；售罄不参与。
  const pBundle = (s) =>
    (state.cfg?.points?.bundles ?? []).find(
      (x) =>
        x.memoryMb === s.memoryMb &&
        Math.round(x.cpus * 10) === Math.round(s.cpus * 10) &&
        x.diskMb === (s.diskMb ?? pSpec().diskMb) &&
        x.stock !== 0
    );
  // 实例时长：命中套餐时用套餐自带的时长（NULL = 跟随全局），否则用全局基础时长。
  const specDays = () => {
    const bnd = pBundle(draft.spec);
    return bnd ? (bnd.days == null ? pSpec().days : bnd.days) : pSpec().days;
  };
  // 内存 + CPU + 硬盘部分的原价（不认打包），划掉的那个数字就是它。
  const pFull = (s) => {
    const b = pSpec();
    const a = pAdd();
    return (
      (state.cfg?.points?.instanceCost ?? 100) +
      ((s.memoryMb - b.memoryMb) / a.memStepMb) * a.memStepCost +
      Math.round((s.cpus - b.cpus) * 10) * a.cpuStepCost +
      ((s.diskMb ?? b.diskMb) - b.diskMb) / a.diskStepMb * a.diskStepCost
    );
  };
  // 总价 = 内存+CPU（打包价优先） + 端口费，和后端 priceInstanceSpec 同一套算法。
  const pCost = () => {
    const s = draft.spec;
    return (
      (pBundle(s)?.cost ?? pFull(s)) + (s.ports - pSpec().ports) * pAdd().portCost
    );
  };
  const pointsLine = () => {
    const s = draft.spec;
    const days = specDays();
    return `${s.memoryMb} MB · ${s.cpus} 核 · ${fmtMb(s.diskMb)} 硬盘 · ${s.ports} 个端口${
      days ? ` · 有效 ${days} 天，到期封存` : ''
    }`;
  };
  // 本次创建的端口额度：有券看券，没券看自己配的规格。
  const portQuota = () => (draft.voucher ? draft.voucher.ports : draft.spec.ports);
  const customOk = () =>
    state.user.role === 'admin' || state.user.quota.allowCustomImage || !!draft.voucher?.allowCustomImage;
  const voucherLine = (v) =>
    `内存 ${v.memoryMb} MB · CPU ${v.cpus} 核 · 端口 ${v.ports} 个${v.diskMb ? ` · 硬盘 ${fmtMb(v.diskMb)}` : ''} · 剩余可用 ${
      v.remaining
    } 次${v.allowCustomImage ? ' · 允许自定义镜像' : ''} · ${
      v.instanceDays ? `实例有效 ${v.instanceDays} 天，到期封存` : '实例永久有效'
    }`;
  // 静态网页专用券在这条路上走不通，第 1 步就说清楚，别让人填完四页才被驳回。
  const SITE_ONLY_MSG =
    '这是静态网页专用券，只能拿去「静态站点」发网页，创建实例请向管理员另要一张';

  const foot = (nextLabel = `下一步${icon('arrow-right')}`) => `
    <div class="nv-foot">
      ${
        step
          ? `<button type="button" class="ghost" data-nv-back>${icon('arrow-left')}上一步</button>`
          : ''
      }
      <div class="spacer" style="flex:1"></div>
      <button class="primary" type="submit">${nextLabel}</button>
    </div>`;

  function go(n) {
    step = n;
    draw();
    window.scrollTo(0, 0);
  }

  function draw() {
    document.getElementById('nv-sub').textContent = `第 ${step + 1} / ${TITLES.length} 步`;
    document.getElementById('nv-steps').innerHTML = TITLES.map((title, n) => {
      const inner = `<i>${n < step ? icon('check') : n + 1}</i>${title}`;
      return `<li class="${n === step ? 'on' : n < step ? 'past' : ''}">${
        n < step ? `<button type="button" data-nv-step="${n}">${inner}</button>` : `<span>${inner}</span>`
      }</li>`;
    }).join('');
    document
      .querySelectorAll('[data-nv-step]')
      .forEach((b) => (b.onclick = () => go(Number(b.dataset.nvStep))));
    [drawPay, drawTemplate, drawConfig, drawReview][step]();
    const back = slot.querySelector('[data-nv-back]');
    if (back) back.onclick = () => go(step - 1);
  }

  /* --- 第 1 步：支付方式。默认花积分、规格自己配；填券则换券上的规格。 --- */
  function drawPay() {
    const idle = `不填券 = 按上面选的套餐花积分；填一张券 = 用券上的规格，不扣积分。`;
    const admin = state.user.role === 'admin';
    const d = state.cfg?.voucherDefaults ?? {};
    const b = pSpec();
    const a = pAdd();
    const bal = state.user.points ?? 0;
    // 固定档位（128MB 起的小机）+ 管理员在后台配的套餐；和套餐撞规格的
    // 固定档不显示，套餐卡上写的是后台配的名称和打包价。
    const fixed = [
      { name: '标配版', memoryMb: 128, cpus: 0.1 },
      { name: '中配版', memoryMb: 256, cpus: 0.2 },
      { name: '进阶版', memoryMb: 512, cpus: 0.4 },
      { name: '高配版', memoryMb: 1024, cpus: 1 },
      { name: '顶配版', memoryMb: 2048, cpus: 2 },
      { name: '旗舰版', memoryMb: 4096, cpus: 4 },
      { name: '超凡版', memoryMb: 8192, cpus: 4 },
      { name: '至尊版', memoryMb: 16384, cpus: 8 },
    ];
    const bund = state.cfg?.points?.bundles ?? [];
    const inRange = (t) =>
      t.memoryMb >= b.memoryMb &&
      t.cpus >= b.cpus &&
      t.memoryMb <= a.maxMemoryMb &&
      t.cpus <= a.maxCpus &&
      (t.memoryMb - b.memoryMb) % a.memStepMb === 0;
    const tiers = [
      // 固定档位只避开「还有库存」的套餐；售罄的套餐卡照常显示，但标灰点不了
      ...fixed.filter(
        (t) =>
          inRange(t) &&
          !bund.some(
            (x) => x.stock !== 0 && x.memoryMb === t.memoryMb && Math.round(x.cpus * 10) === Math.round(t.cpus * 10)
          )
      ),
      ...bund.filter(inRange).map((x) => ({ ...x, name: x.name || `${x.memoryMb} MB`, bundle: true })),
    ];
    // 第一次进来按当前规格反查该亮哪张卡；对不上任何套餐（或套餐已售罄）就算自定义。
    if (!draft.planId) {
      const hit = tiers.findIndex(
        (t) =>
          t.memoryMb === draft.spec.memoryMb &&
          Math.round(t.cpus * 10) === Math.round(draft.spec.cpus * 10) &&
          t.stock !== 0
      );
      draft.planId = hit >= 0 ? String(hit) : '__custom__';
    }
    const row = (ico, label, val) => `<div>${icon(ico)}<span>${label}</span><b>${val}</b></div>`;
    // 卡上价：内存+CPU+硬盘的实付价（打包优先）；命中打包时额外返回划线原价。
    const priceTag = (t) => {
      const bnd = pBundle(t);
      if (!bnd) return `<b>${pFull(t)}</b> 分`;
      return `<s>${pFull(t)}</s> <b>${bnd.cost}</b> 分`;
    };
    // 套餐自带的时长优先；NULL = 跟随全局基础时长
    const daysText = (t) => {
      const dd = t.bundle ? (t.days == null ? b.days : t.days) : b.days;
      return dd ? `${dd} 天，到期封存` : '';
    };
    const stockText = (t) => (t.stock < 0 ? '不限量' : t.stock > 0 ? `剩余 ${t.stock} 份` : '已售罄');
    const planCard = (t, i) => `
      <div class="card plan ${t.stock === 0 ? 'sold' : ''}" data-plan="${i}"${
        t.stock === 0 ? ' aria-disabled="true"' : ''
      }>
        <span class="tick">${icon('check', { size: '12px' })}</span>
        <div class="plan-head"><span class="plan-name">${t.name}${
          pBundle(t) ? '<span class="plan-tag">直减</span>' : ''
        }${t.stock === 0 ? '<span class="plan-tag sold">已售罄</span>' : ''}</span>
          <span class="plan-price">${t.stock === 0 ? '—' : priceTag(t)}</span></div>
        <div class="plan-rows">
          ${row('cpu', 'CPU', `${t.cpus} 核`)}
          ${row('memory-stick', '内存', `${t.memoryMb} MB`)}
          ${row('hard-drive', '硬盘', fmtMb(t.diskMb ?? b.diskMb))}
          ${daysText(t) ? row('clock', '有效期', daysText(t)) : ''}
          ${t.bundle ? row('layers', '余量', stockText(t)) : ''}
        </div>
      </div>`;
    // 自定义那张卡和套餐排在一起：选中后下面才展开内存 / CPU / 硬盘三个下拉。
    const customCard = `
      <div class="card plan" data-plan="__custom__">
        <span class="tick">${icon('check', { size: '12px' })}</span>
        <div class="plan-head"><span class="plan-name">自定义配置</span>
          <span class="plan-price" id="nv-custom-price">按档计价</span></div>
        <div class="plan-rows">
          ${row('cpu', 'CPU', `${b.cpus} - ${a.maxCpus} 核`)}
          ${row('memory-stick', '内存', `${b.memoryMb} - ${a.maxMemoryMb} MB`)}
          ${row('hard-drive', '硬盘', `${fmtMb(b.diskMb)} - ${fmtMb(a.maxDiskMb)}`)}
          ${b.days ? row('clock', '有效期', `${b.days} 天，到期封存`) : ''}
        </div>
      </div>`;
    // 下拉档位照价目表现生成：改环境变量就是改价目，前端不用跟着动。
    const plus = (n) => (n ? `+${n} 分` : '含在基础价里');
    const memOpts = [];
    for (let mb = b.memoryMb; mb <= a.maxMemoryMb; mb += a.memStepMb) {
      const c = ((mb - b.memoryMb) / a.memStepMb) * a.memStepCost;
      memOpts.push(
        `<option value="${mb}" ${draft.spec.memoryMb === mb ? 'selected' : ''}>${mb} MB（${plus(c)}）</option>`
      );
    }
    const cpuOpts = [];
    for (let t = Math.round(b.cpus * 10); t <= Math.round(a.maxCpus * 10); t++) {
      const c = (t - Math.round(b.cpus * 10)) * a.cpuStepCost;
      cpuOpts.push(
        `<option value="${t / 10}" ${Math.round(draft.spec.cpus * 10) === t ? 'selected' : ''}>${t / 10} 核（${plus(c)}）</option>`
      );
    }
    const diskOpts = [];
    for (let mb = b.diskMb; mb <= a.maxDiskMb; mb += a.diskStepMb) {
      const c = ((mb - b.diskMb) / a.diskStepMb) * a.diskStepCost;
      diskOpts.push(
        `<option value="${mb}" ${draft.spec.diskMb === mb ? 'selected' : ''}>${fmtMb(mb)}（${plus(c)}）</option>`
      );
    }
    slot.innerHTML = `
      <form id="nv-form">
        <fieldset id="nv-spec" style="border:0;padding:0;margin:0;min-width:0">
          ${cat('layers', '套餐', { flush: true })}
          <div class="grid cols plans" id="nv-plans">${tiers.map(planCard).join('')}${customCard}</div>
          <div class="card nv-card" id="nv-custom" ${
            draft.planId === '__custom__' ? '' : 'hidden'
          } style="margin-top:14px">
            <div class="two">
              <label class="field"><span>${icon('memory-stick')}内存</span>
                <select name="mem">${memOpts.join('')}</select></label>
              <label class="field"><span>${icon('cpu')}CPU</span>
                <select name="cpu">${cpuOpts.join('')}</select></label>
            </div>
            <label class="field" style="margin-top:14px"><span>${icon('hard-drive')}硬盘</span>
              <select name="disk">${diskOpts.join('')}</select>
              <div class="hint">实例数据卷配额，超出会自动停止（轮询兜底，不是硬限）</div></label>
          </div>
          ${cat('plug', '对外端口')}
          <div class="card nv-card">
            <div class="row" style="align-items:center">
              <div class="stepper">
                <button type="button" class="small ghost" id="nv-pminus">−</button>
                <b id="nv-pcount">${draft.spec.ports}</b>
                <button type="button" class="small ghost" id="nv-pplus">+</button>
              </div>
              <span class="sub">第 ${b.ports} 个含在基础价里，之后每个 +${a.portCost} 分，最多 ${
                a.maxPorts
              } 个</span>
            </div>
            <div class="hint" style="margin-top:8px">模板要几个端口就得配几个；下一步选模板时不够会提醒。</div>
          </div>
        </fieldset>
        ${cat('sparkles', '支付')}
        <div class="card nv-card">
          <div class="hint" id="nv-price" style="margin-bottom:14px"></div>
          <label class="field"><span>${icon('ticket')}实例资源券（可选）</span>
            <input name="code" value="${esc(draft.voucherCode)}"
              placeholder="${admin ? '留空用积分；也可以粘一张券，或点下面按钮给自己开一张' : '留空用积分；有券的话粘进来，规格以券为准'}"
              autocomplete="off" />
            <div class="hint" id="nv-vinfo">${idle}</div>
          </label>
          ${
            // 券是资源额度的唯一载体，管理员也得有一张；但让他为了给自己开台机器
            // 先绕去邀请码页手填一遍再复制回来，纯属仪式。
            admin
              ? `<div class="row">
                   <button type="button" class="small" id="nv-self">${icon('ticket')}给自己开一张券</button>
                   <span class="sub">${d.memoryMb ?? 1024} MB · ${d.cpus ?? 1} 核 · ${
                     d.ports ?? 2
                   } 端口，一次性，可在下一步改用别的券</span>
                 </div>`
              : ''
          }
          <div class="err" data-err></div>
          ${foot()}
        </div>
      </form>`;
    const form = document.getElementById('nv-form');
    const info = document.getElementById('nv-vinfo');
    const specBox = document.getElementById('nv-spec');
    const priceEl = document.getElementById('nv-price');
    const customBox = document.getElementById('nv-custom');
    const customPrice = document.getElementById('nv-custom-price');
    const pcount = document.getElementById('nv-pcount');
    // 选卡、调端口、换下拉都走这一个刷新口；一旦有生效的券，整个规格区
    // 置灰（fieldset:disabled 的 CSS 顺带挡掉卡片点击）—— 规格以券为准。
    const paint = () => {
      specBox.disabled = !!draft.voucher;
      specBox
        .querySelectorAll('[data-plan]')
        .forEach((el) => el.classList.toggle('on', el.dataset.plan === draft.planId));
      customBox.hidden = draft.planId !== '__custom__';
      customPrice.innerHTML =
        draft.planId === '__custom__' ? priceTag(draft.spec) : '按档计价';
      pcount.textContent = draft.spec.ports;
      if (draft.voucher) {
        priceEl.innerHTML = `${icon('ticket')}本次用券支付，不扣积分，上面选的套餐和端口不生效。`;
        return;
      }
      const c = pCost();
      priceEl.innerHTML = `合计 <b>${c}</b> 积分 · 你现在有 <b>${bal}</b> 分${
        c > bal ? '（不够 —— 换个便宜的套餐、填张券，或到「账号」页兑换积分）' : ''
      }`;
    };
    specBox.querySelectorAll('[data-plan]').forEach((el) => {
      el.onclick = () => {
        draft.planId = el.dataset.plan;
        if (draft.planId === '__custom__') {
          // 自定义卡记得住自己的下拉：切回来时按下拉当前值算
          draft.spec.memoryMb = Number(form.mem.value);
          draft.spec.cpus = Number(form.cpu.value);
          draft.spec.diskMb = Number(form.disk.value);
        } else {
          const t = tiers[Number(draft.planId)];
          if (t && t.stock === 0) return; // 售罄的卡点不动
          draft.spec.memoryMb = t.memoryMb;
          draft.spec.cpus = t.cpus;
          draft.spec.diskMb = t.diskMb ?? b.diskMb;
        }
        paint();
      };
    });
    [form.mem, form.cpu, form.disk].forEach(
      (sel) =>
        (sel.onchange = () => {
          draft.spec.memoryMb = Number(form.mem.value);
          draft.spec.cpus = Number(form.cpu.value);
          draft.spec.diskMb = Number(form.disk.value);
          paint();
        })
    );
    document.getElementById('nv-pminus').onclick = () => {
      draft.spec.ports = Math.max(b.ports, draft.spec.ports - 1);
      paint();
    };
    document.getElementById('nv-pplus').onclick = () => {
      draft.spec.ports = Math.min(a.maxPorts, draft.spec.ports + 1);
      paint();
    };
    const show = (v) => {
      const ok = !v.siteOnly;
      info.style.color = ok ? 'var(--success)' : 'var(--danger)';
      info.textContent = ok ? `✓ ${voucherLine(v)}` : SITE_ONLY_MSG;
    };
    if (draft.voucher) show(draft.voucher);
    paint();

    let timer;
    form.code.oninput = () => {
      clearTimeout(timer);
      draft.voucher = null;
      paint();
      const code = form.code.value.trim();
      if (code.length < 4) {
        info.style.color = '';
        info.textContent = idle;
        return;
      }
      timer = setTimeout(async () => {
        try {
          const { voucher } = await api(`/auth/voucher/${encodeURIComponent(code)}`);
          if (form.code.value.trim() !== code) return; // 输入又变了，别把旧结果盖上去
          draft.voucher = voucher;
          draft.voucherCode = code;
          show(voucher);
          paint();
        } catch (err) {
          info.style.color = 'var(--danger)';
          info.textContent = err.message;
        }
      }, 350);
    };

    const self = document.getElementById('nv-self');
    if (self) {
      self.onclick = async () => {
        self.disabled = true;
        try {
          const { voucher } = await api('/admin/invites/self', { method: 'POST', body: {} });
          draft.voucher = voucher;
          draft.voucherCode = voucher.code;
          form.code.value = voucher.code;
          show(voucher);
          paint();
          toast(`已开出资源券 ${voucher.code}`, 'ok');
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          self.disabled = false;
        }
      };
    }

    form.onsubmit = async (e) => {
      e.preventDefault();
      const errEl = form.querySelector('[data-err]');
      errEl.textContent = '';
      const code = form.code.value.trim();
      try {
        if (!code) {
          // 积分路径：余额在这里先拦一道，别让人填完四页才被服务端退回来。
          if ((state.user.points ?? 0) < pCost()) {
            errEl.innerHTML = `积分不够：这个配置要 ${pCost()} 分，你只有 ${
              state.user.points ?? 0
            } 分 —— 换个便宜的套餐、向管理员要张券，或到 <a href="#/account">账号页</a>兑换积分`;
            return;
          }
          draft.voucher = null;
          draft.voucherCode = '';
          go(1);
          return;
        }
        if (!draft.voucher || draft.voucherCode !== code) {
          const { voucher } = await api(`/auth/voucher/${encodeURIComponent(code)}`);
          draft.voucher = voucher;
          draft.voucherCode = code;
        }
        if (draft.voucher.siteOnly) {
          errEl.innerHTML = `${esc(SITE_ONLY_MSG)} —— <a href="#/sites">现在就去发个网页</a>`;
          return;
        }
        go(1);
      } catch (err) {
        errEl.textContent = err.message;
      }
    };
  }

  /* --- 第 2 步:选模板。点卡片直接进下一步。 --- */
  function drawTemplate() {
    const quota = portQuota();
    const quotaName = draft.voucher ? '这张券' : '你配的规格';
    const cats = [...new Set(state.templates.map((t) => t.category))];
    // Categories come from the template file; anything unlisted falls back to
    // the generic stack glyph rather than dropping out of alignment.
    const CAT_ICON = {
      AI: 'sparkles',
      Web: 'globe',
      媒体: 'clapperboard',
      工具: 'wrench',
      建站: 'file-code',
      开发: 'terminal',
      数据库: 'database',
      游戏: 'gamepad-2',
    };
    const card = (t) => {
      const short = t.ports.length > quota;
      return `<div class="card tpl ${draft.tplId === t.id ? 'on' : ''}" data-tpl="${esc(t.id)}">
          <div class="icon">${t.icon}</div>
          <div><div class="t-name">${esc(t.name)}</div>
            <div class="t-desc">${esc(t.description)}</div>
            <div class="t-desc mono" style="margin-top:6px">${esc(t.image)}</div>
            <div class="t-desc" style="margin-top:4px">建议额度 ${t.defaults.memoryMb}MB · ${
        t.defaults.cpus
      } 核 · ${t.ports.length} 端口</div>
            ${
              short
                ? `<div class="t-desc" style="margin-top:4px;color:var(--danger)">${icon(
                    'triangle-alert'
                  )}${quotaName}只有 ${quota} 个端口额度，不够这个模板用</div>`
                : ''
            }</div>
        </div>`;
    };
    const ok = customOk();
    slot.innerHTML = `
      ${cats
        .map(
          (c) => `${cat(CAT_ICON[c] || 'layers', c)}
          <div class="grid cols">${state.templates
            .filter((t) => t.category === c)
            .map(card)
            .join('')}</div>`
        )
        .join('')}
      ${cat('puzzle', '自定义')}
      <div class="grid cols">
        <div class="card tpl ${draft.tplId === '__custom__' ? 'on' : ''}" data-tpl="__custom__" style="${
      ok ? '' : 'opacity:.5;cursor:not-allowed'
    }">
          <div class="icon">${icon('puzzle')}</div>
          <div><div class="t-name">自定义镜像</div>
            <div class="t-desc">${
              ok
                ? '手动填写任意镜像、端口与环境变量。'
                : draft.voucher
                  ? '这张券和你的账号都没有自定义镜像权限，请联系管理员。'
                  : '积分实例不支持自定义镜像；需要账号权限或一张带该权限的券。'
            }</div></div>
        </div>
      </div>
      ${
        state.cfg?.sites?.enabled
          ? `${cat('globe', '不用容器')}
             <div class="grid cols">
               <a class="card tpl" href="#/sites" style="text-decoration:none;color:inherit">
                 <div class="icon">${icon('file-code')}</div>
                 <div><div class="t-name">静态网页</div>
                   <div class="t-desc">把 HTML 文件或整个文件夹拖进来就上线，不花内存、不占端口、不用等审批。</div>
                   <div class="t-desc" style="margin-top:4px">发一个花 ${
                     state.cfg?.points?.siteCost ?? 50
                   } 积分，比实例便宜一半</div></div>
               </a>
             </div>`
          : ''
      }
      <div class="nv-foot">
        <button type="button" class="ghost" data-nv-back>${icon('arrow-left')}上一步</button>
        <div class="spacer" style="flex:1"></div>
        ${
          draft.tplId
            ? `<button type="button" class="primary" data-nv-next>下一步${icon('arrow-right')}</button>`
            : `<span class="sub">${icon('list-checks')}点一张卡片继续</span>`
        }
      </div>`;

    const pick = (id) => {
      if (id === '__custom__' && !customOk()) return;
      const t = id === '__custom__' ? null : state.templates.find((x) => x.id === id);
      if (t && t.ports.length > quota) {
        toast(`${quotaName}只有 ${quota} 个端口额度，「${t.name}」需要 ${t.ports.length} 个`, 'err');
        return;
      }
      if (draft.tplId !== id) {
        draft.tplId = id;
        draft.env = {}; // 换了模板，上一个模板的环境变量没意义
      }
      go(2);
    };
    slot.querySelectorAll('[data-tpl]').forEach((el) => (el.onclick = () => pick(el.dataset.tpl)));
    const next = slot.querySelector('[data-nv-next]');
    if (next) next.onclick = () => pick(draft.tplId);
  }

  /* --- 第 3 步：配置 --- */
  function drawConfig() {
    const t = tpl();
    slot.innerHTML = `
      <form class="card nv-card" id="nv-form">
        <div class="hint" style="margin-bottom:14px">${
          t
            ? `${t.icon} ${esc(t.name)} · <span class="mono">${esc(t.image)}</span>`
            : `${icon('puzzle')}自定义镜像`
        }</div>
        <div class="two">
          <label class="field"><span>${icon('boxes')}实例名 *</span>
            <input name="name" required placeholder="my-app" pattern="[a-z0-9][a-z0-9-]{1,28}[a-z0-9]"
              value="${esc(draft.name)}" />
            <div class="hint">小写字母、数字、连字符，3-30 位</div></label>
          ${
            t
              ? `<label class="field"><span>${icon('container')}镜像</span>
                 <input value="${esc(t.image)}" disabled /></label>`
              : `<label class="field"><span>${icon('container')}镜像 *</span>
                 <input name="image" required placeholder="nginx:alpine" value="${esc(draft.image)}" />
                 <div class="hint">留空 tag 时默认 :latest</div></label>`
          }
        </div>
        ${
          t
            ? t.env.map((f) => envFieldHtml(f, draft.env[f.key])).join('') +
              (t.ports.length
                ? `<div class="hint">${icon('plug')}将自动分配 ${t.ports.length} 个对外端口：${t.ports
                    .map((p) => `${p.label} (${p.container}/${p.protocol})`)
                    .join('、')}</div>`
                : '')
            : `<label class="field"><span>${icon('plug')}容器端口</span>
                <input name="ports" placeholder="8080, 25565/udp" value="${esc(draft.portsText)}" />
                <div class="hint">逗号分隔；每个端口会自动分配一个对外端口。留空表示不暴露。</div></label>
               <label class="field"><span>${icon('settings')}环境变量</span>
                <textarea name="envText" rows="4" placeholder="KEY=value&#10;ANOTHER=value">${esc(
                  draft.envText
                )}</textarea></label>
               <label class="field"><span>${icon('hard-drive')}数据卷挂载路径</span>
                <input name="volumePath" placeholder="/data" value="${esc(draft.volumePath)}" />
                <div class="hint">留空则容器无持久化存储，删除即丢失。</div></label>
               <label class="field"><span>${icon('terminal')}启动命令（可选）</span>
                <input name="cmdText" placeholder="sleep infinity" value="${esc(draft.cmdText)}" /></label>`
        }
        ${sleepFieldHtml(t, draft)}
        ${cfTunnelFieldHtml(t)}
        ${foot()}
      </form>`;

    const form = document.getElementById('nv-form');
    form.onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      draft.name = String(fd.get('name') || '').trim();
      if (t) {
        for (const f of t.env) {
          const v = fd.get(`env_${f.key}`);
          if (v !== null) draft.env[f.key] = String(v);
        }
      } else {
        draft.image = String(fd.get('image') || '').trim();
        draft.portsText = String(fd.get('ports') || '');
        draft.envText = String(fd.get('envText') || '');
        draft.volumePath = String(fd.get('volumePath') || '');
        draft.cmdText = String(fd.get('cmdText') || '');
      }
      if (state.cfg?.sleep?.enabled && form.sleepEnabled) {
        draft.sleepEnabled = form.sleepEnabled.checked;
        draft.idleMinutes = Number(fd.get('idleMinutes')) || null;
      }
      if (state.cfg?.cfTunnel && state.user.role === 'admin' && form.autoTunnel) {
        draft.autoTunnel = form.autoTunnel.checked;
      }
      go(3);
    };
  }

  /* --- 第 4 步：确认提交 --- */
  function drawReview() {
    const t = tpl();
    const v = draft.voucher;
    const rows = [
      [`${icon('layers')}模板`, t ? `${t.icon} ${esc(t.name)}` : `${icon('puzzle')}自定义镜像`],
      [`${icon('container')}镜像`, `<span class="mono">${esc(t ? t.image : draft.image)}</span>`],
      [`${icon('boxes')}实例名`, `<span class="mono">${esc(draft.name)}</span>`],
      [
        `${icon('ticket')}支付方式`,
        v
          ? `资源券 <span class="mono">${esc(draft.voucherCode)}</span> — ${voucherLine(v)}`
          : `${icon('sparkles')}花 ${pCost()} 积分 — ${pointsLine()}（当前余额 ${
              state.user.points ?? 0
            }）`,
      ],
    ];
    if (t) {
      rows.push([
        `${icon('plug')}对外端口`,
        t.ports.length
          ? t.ports.map((p) => `${esc(p.label)} (${p.container}/${p.protocol})`).join('、')
          : '不暴露',
      ]);
      for (const f of t.env) {
        const val = draft.env[f.key] ?? f.default ?? '';
        rows.push([
          esc(f.label || f.key),
          f.type === 'password'
            ? val
              ? '••••••'
              : f.generate === 'password'
                ? '将自动生成强密码'
                : '（空）'
            : esc(val) || '（空）',
        ]);
      }
    } else {
      rows.push([`${icon('plug')}容器端口`, esc(draft.portsText.trim()) || '不暴露']);
      const envLines = draft.envText.split('\n').filter((l) => l.indexOf('=') > 0);
      rows.push([`${icon('settings')}环境变量`, envLines.length ? `${envLines.length} 条` : '无']);
      if (draft.volumePath.trim())
        rows.push([`${icon('hard-drive')}数据卷`, `<span class="mono">${esc(draft.volumePath.trim())}</span>`]);
      if (draft.cmdText.trim())
        rows.push([`${icon('terminal')}启动命令`, `<span class="mono">${esc(draft.cmdText.trim())}</span>`]);
    }
    if (state.cfg?.sleep?.enabled && draft.sleepEnabled !== null) {
      rows.push([
        `${icon('moon')}闲时休眠`,
        draft.sleepEnabled ? `空闲 ${draft.idleMinutes ?? state.cfg.sleep.idleMinutes} 分钟后休眠` : '不休眠',
      ]);
    }
    if (state.cfg?.cfTunnel && state.user.role === 'admin') {
      rows.push([
        `${icon('cloud')}自动穿透`,
        draft.autoTunnel
          ? `自动建 Cloudflare 隧道，域名 https://&lt;实例名&gt;.${esc(state.cfg.cfTunnel.domain)}`
          : '不自动（需手动配穿透）',
      ]);
    }

    slot.innerHTML = `
      <form class="card nv-card" id="nv-form">
        <div class="nv-summary">${rows
          .map(([k, val]) => `<span>${k}</span><span>${val}</span>`)
          .join('')}</div>
        <label class="field"><span>${icon('scroll-text')}给管理员的说明（可选）</span>
          <input name="note" placeholder="比如：想要 example.com 这个域名指过来" value="${esc(draft.note)}" />
          <div class="hint">提交后由管理员配置内网穿透并放行，通过之后容器才会真正创建。</div></label>
        <div class="err" data-err></div>
        ${foot(`${icon('rocket')}提交申请`)}
      </form>`;

    const form = document.getElementById('nv-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      draft.note = String(new FormData(form).get('note') || '');
      const btn = form.querySelector('button[type=submit]');
      const errEl = form.querySelector('[data-err]');
      btn.disabled = true;
      errEl.textContent = '';
      try {
        const body = {
          name: draft.name,
          inviteCode: draft.voucher ? draft.voucherCode : undefined,
          // 积分路径把配好的规格一并送去，扣多少分由服务端重新核价
          spec: draft.voucher ? undefined : draft.spec,
          templateId: t?.id,
          note: draft.note,
          env: {},
        };
        if (state.cfg?.sleep?.enabled && draft.sleepEnabled !== null) {
          body.sleep = { enabled: draft.sleepEnabled, idleMinutes: draft.idleMinutes || undefined };
        }
        if (state.cfg?.cfTunnel && state.user.role === 'admin') {
          body.autoTunnel = draft.autoTunnel ? true : undefined;
        }
        if (t) {
          for (const f of t.env) if (draft.env[f.key] !== undefined) body.env[f.key] = draft.env[f.key];
        } else {
          body.image = draft.image;
          body.ports = draft.portsText
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => {
              const [p, proto] = s.split('/');
              return { container: Number(p), protocol: proto === 'udp' ? 'udp' : 'tcp', label: `端口 ${p}` };
            });
          for (const line of draft.envText.split('\n')) {
            const eq = line.indexOf('=');
            if (eq > 0) body.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
          }
          const cmd = draft.cmdText.trim();
          if (cmd) body.cmd = cmd.split(/\s+/);
          const vp = draft.volumePath.trim();
          if (vp) body.volumePath = vp;
        }
        const { id, generated, status } = await api('/instances', { method: 'POST', body });
        if (generated && Object.keys(generated).length) {
          toast(`已自动生成密码：${Object.entries(generated).map(([k, val]) => `${k}=${val}`).join('  ')}`, 'ok');
        }
        toast(
          status === 'pending'
            ? '申请已提交，等管理员配置好内网穿透后就会自动创建'
            : draft.autoTunnel
              ? '正在创建容器并自动配置 Cloudflare 隧道，域名就绪后即可访问'
              : '已跳过审批，正在创建容器；穿透配好后到「访问地址」改成实际地址',
          'ok'
        );
        location.hash = `#/i/${id}`;
      } catch (err) {
        errEl.textContent = err.message;
        btn.disabled = false;
      }
    };
  }

  draw();
}

/** Idle-sleep opt-in on the create form. UDP services cannot be woken. */
function sleepFieldHtml(t, saved = {}) {
  const cfg = state.cfg?.sleep;
  if (!cfg?.enabled) return '';
  const udp = t ? t.ports.some((p) => p.protocol === 'udp') : false;
  const none = t ? t.ports.length === 0 : false;
  const blocked = udp
    ? '这个模板用的是 UDP 端口，没法靠连接唤醒，所以不能休眠。'
    : none
      ? '这个模板不暴露端口，休眠后没有东西能唤醒它。'
      : '';
  const on = blocked ? false : (saved.sleepEnabled ?? cfg.defaultOn);
  return `<div class="field">
      <label class="row" style="gap:8px">
        <input type="checkbox" name="sleepEnabled" style="width:auto" ${on ? 'checked' : ''} ${
          blocked ? 'disabled' : ''
        } />
        <span>${icon('moon')}闲时休眠 —— 没人用就自动停，有人访问再自动起</span>
      </label>
      <div class="row" style="gap:8px;margin-top:8px;align-items:center">
        <span class="sub">空闲</span>
        <input name="idleMinutes" type="number" min="1" max="1440" value="${saved.idleMinutes ?? cfg.idleMinutes}"
          style="width:90px" ${blocked ? 'disabled' : ''} />
        <span class="sub">分钟后停止容器</span>
      </div>
      <div class="hint">${
        blocked ||
        '休眠期间不占内存和 CPU；面板替它守着端口，第一个连上来的人会等几秒冷启动，然后照常访问。仅支持 TCP。'
      }</div>
    </div>`;
}

/** 管理员专属：新建实例时勾选「自动穿透」，放行（跳过审批）时自动建隧道。 */
function cfTunnelFieldHtml(t) {
  const cf = state.cfg?.cfTunnel;
  if (!cf || state.user.role !== 'admin') return '';
  const none = t ? t.ports.length === 0 : false;
  const udpOnly = t ? t.ports.length > 0 && t.ports.every((p) => p.protocol === 'udp') : false;
  const blocked = none || udpOnly;
  return `<div class="field">
      <label class="row" style="gap:8px">
        <input type="checkbox" name="autoTunnel" style="width:auto" ${blocked ? 'disabled' : ''} />
        <span>${icon('cloud')}自动穿透 —— 自动建 Cloudflare 隧道，免手动配置</span>
      </label>
      <div class="hint">${
        blocked
          ? udpOnly
            ? '这个模板全是 UDP 端口，Cloudflare 隧道无法承载 UDP，不能自动穿透。'
            : '这个模板不暴露端口，不需要穿透。'
          : `放行后自动分配 <code>https://&lt;实例名&gt;.${esc(cf.domain)}</code> 域名并填好对外地址，无需手动配穿透。仅 TCP 端口有效；UDP 端口仍要手动转发。`
      }</div>
    </div>`;
}

/* ---------------- instance detail ---------------- */
function sleepCardHtml(i) {
  const s = i.sleep;
  const locked = !!s.problem && !s.enabled;
  return `<div class="card">
      ${cat('moon', '闲时休眠', { flush: true })}
      <label class="row" style="gap:8px">
        <input type="checkbox" id="sleep-toggle" style="width:auto" ${s.enabled ? 'checked' : ''} ${
          locked ? 'disabled' : ''
        } />
        <span>没人访问就停掉容器，有人连上来再自动启动</span>
      </label>
      <div class="row" style="gap:8px;margin-top:12px;align-items:center">
        <span class="sub">空闲</span>
        <input id="sleep-mins" type="number" min="1" max="1440" value="${s.idleMinutes}" style="width:92px" ${
          locked ? 'disabled' : ''
        } />
        <span class="sub">分钟后休眠</span>
        <button class="small" id="sleep-save" ${locked ? 'disabled' : ''}>${icon('save')}保存</button>
      </div>
      <div class="hint">${
        s.problem
          ? esc(s.problem)
          : '休眠时容器停止运行，不占内存和 CPU；面板替它守着对外端口，第一个连进来的请求会等几秒冷启动。'
      }</div>
      ${
        s.sleptAt || s.wokeAt
          ? `<div class="kv" style="margin-top:8px">
               ${s.sleptAt ? `<span>${icon('moon')}上次休眠 ${when(s.sleptAt)}</span>` : ''}
               ${s.wokeAt ? `<span>${icon('sunrise')}上次唤醒 ${when(s.wokeAt)}</span>` : ''}
             </div>`
          : ''
      }
    </div>`;
}

async function viewInstance(id) {
  shell('instances', loader());
  let tab = 'overview';
  // Kept out here so the file tab reopens where it was left, not at the volume
  // root, when the user goes off to read the logs and comes back.
  let filesCwd = null;

  const paint = async () => {
    const { instance: i } = await api(`/instances/${id}`);
    const envRows = Object.entries(i.env)
      .map(
        ([k, v]) =>
          `<tr><td class="mono">${esc(k)}</td><td class="mono" style="word-break:break-all">${esc(v)}</td>
           <td><button class="small ghost" data-copy="${esc(v)}">${icon('copy')}复制</button></td></tr>`
      )
      .join('');

    const waiting = i.status === 'pending' || i.status === 'rejected';
    const creating = i.status === 'creating';

    const overview = creating
      ? `
      <div class="grid" style="grid-template-columns:1fr;gap:16px">
        <div class="card">
          ${cat('rotate-cw', '创建日志', { flush: true })}
          <p style="margin:0 0 10px">${icon('hourglass')}容器正在创建，请稍等片刻。创建完成后会自动进入运行状态。</p>
          <pre class="logs" id="events" style="max-height:260px">等待事件…</pre>
        </div>
      </div>`
      : `
      <div class="grid" style="grid-template-columns:1fr;gap:16px">
        ${
          i.status === 'pending'
            ? `<div class="card" style="box-shadow:var(--shadow-sm),0 0 0 2px var(--primary)">
                 ${cat('hourglass', '等待管理员放行', { flush: true })}
                 <p style="margin:0 0 10px">申请已提交，管理员会为你配置好内网穿透后再创建容器。已经为你预留的主机端口：
                   <b class="mono">${i.ports.map((p) => p.host).join('、') || '无'}</b></p>
                 <div class="sub">这期间容器还不存在，日志和监控要等放行之后才有。</div>
               </div>`
            : ''
        }
        ${
          i.status === 'rejected'
            ? `<div class="card" style="box-shadow:var(--shadow-sm),0 0 0 2px var(--danger)">
                 ${cat('ban', '申请被驳回', { flush: true })}
                 <div class="err">${icon('triangle-alert')}${esc(i.rejectReason || '未说明原因')}</div>
                 <div class="sub" style="margin-top:8px">资源券的次数已退回，可以删掉这条记录后重新申请。</div>
               </div>`
            : ''
        }
        ${
          i.status !== 'archived' && expiringSoon(i.life)
            ? `<div class="card" style="box-shadow:var(--shadow-sm),0 0 0 2px var(--warning)">
                 ${cat('hourglass', '快到有效期了', { flush: true })}
                 <p style="margin:0 0 10px">这台实例 ${when(i.life.expiresAt)} 到期（${lasts(
                   i.life.remainingMs
                 )}），到时候会自动封存：容器停掉、端口收回，控制台和文件管理都会关上。</p>
                 <div class="sub">封存后数据还会保留 ${state.cfg?.life?.archiveRetentionDays || 7} 天，
                   期间可以积分续期或下载数据。趁现在续期就不用中断服务了。</div>
                 <div class="row" style="margin-top:10px">
                   <button class="primary small" data-renew="${esc(i.id)}"
                     data-cost="${esc(state.cfg?.life?.renewal?.cost || 100)}"
                     data-days="${esc(state.cfg?.life?.renewal?.days || 7)}">${icon('rotate-cw')}积分续期</button>
                 </div>
               </div>`
            : ''
        }
        ${
          i.status === 'archived'
            ? `<div class="card" style="box-shadow:var(--shadow-sm),0 0 0 2px var(--default-400)">
                 ${cat('archive', '实例已封存', { flush: true })}
                 <p style="margin:0 0 10px">这台实例的有效期在 ${when(
                   i.life?.expiresAt
                 )} 到了，面板已于 ${when(i.life?.archivedAt)} 停掉容器、收回它占着的端口。</p>
                 ${
                   i.life?.graceRemainingMs != null && i.life.graceRemainingMs > 0
                     ? `<div class="sub">数据还保留 ${lasts(i.life.graceRemainingMs)}，
                         之后彻底删除。可以积分续期恢复使用，或下载数据卷备份。</div>
                        <div class="row" style="margin-top:10px">
                          <button class="primary small" data-renew="${esc(i.id)}"
                            data-cost="${esc(state.cfg?.life?.renewal?.cost || 100)}"
                            data-days="${esc(state.cfg?.life?.renewal?.days || 7)}">${icon('rotate-cw')}积分续期</button>
                          <button class="small" data-dl="${esc(i.id)}">${icon('download')}下载数据</button>
                        </div>`
                     : `<div class="sub">宽限期已过，数据已永久删除。删除这条记录即可清理。</div>`
                 }
               </div>`
            : ''
        }
        ${
          waiting
            ? ''
            : `<div class="card">
          ${cat('link', '访问地址', { flush: true })}
          <div class="row">${
            i.ports
              .map(
                (p) =>
                  `<span class="addr" data-copy="${esc(p.address)}">${icon('link')}${esc(
                    p.address
                  )}<small>${esc(p.label)} · 容器 ${p.container}/${p.protocol}</small>${icon('copy', {
                    cls: 'trail',
                  })}</span>`
              )
              .join('') || '<span class="sub">该实例没有暴露端口</span>'
          }</div>
          ${
            i.tunnel
              ? `<div class="hint" style="margin-top:8px">${icon('cloud')}由 Cloudflare 隧道自动提供：
                   <code>${esc(i.tunnel.hostnames.join('</code>、<code>'))}</code>
                   <span class="badge ${i.tunnel.running ? 'running' : 'warning'}">${i.tunnel.running ? '隧道运行中' : '隧道未运行'}</span>${
                     i.tunnel.output?.length
                       ? `<span class="sub" style="display:block;margin-top:6px">${esc(i.tunnel.output.at(-1) || '')}</span>`
                       : ''
                   }</div>`
              : ''
          }
          ${
            // Only a port still on the fallback is actually showing localhost —
            // once every address has been set by hand, PUBLIC_HOST is moot.
            state.cfg?.publicHost || !i.ports.some((p) => !p.public)
              ? ''
              : `<div class="hint">${icon(
                  'triangle-alert'
                )}管理员还没有配置 PUBLIC_HOST，没有单独填地址的端口显示的是 localhost，外网访问请让管理员设置对外主机名。</div>`
          }
          ${
            // admin-only: edit public addresses and expiry
            state.user.role === 'admin' && !waiting
              ? `<div class="row" style="margin-top:12">
                   ${i.ports.length ? `<button class="small ghost" id="addr-edit">${icon('pencil')}改对外地址</button>` : ''}
                   <button class="small ghost" id="expiry-edit">${icon('clock')}修改过期时间</button>
                 </div>
                 <div id="addr-slot"></div>
                 <div id="expiry-slot"></div>`
              : ''
        }
        </div>`
        }
          ${cat(waiting ? 'scroll-text' : 'activity', waiting ? '申请内容' : '运行状态', { flush: true })}
          ${waiting ? '' : '<div class="row" style="gap:26px" id="stats"><span class="sub">读取中…</span></div>'}
          ${waiting ? '' : '<div class="stat-charts" id="stat-charts"></div>'}
          <div class="kv" style="margin-top:12px">
            <span>${icon('container')}镜像 <code>${esc(i.image)}</code></span>
            <span>${icon('memory-stick')}内存上限 ${i.memoryMb} MB</span>
            <span>${icon('cpu')}CPU ${i.cpus}</span>
            <span>${icon('hard-drive')}数据卷 <code>${esc(i.volumeName || '无')}</code></span>
            ${
              i.disk?.quotaMb
                ? `<span>${icon('gauge')}磁盘 ${
                    i.disk.usedBytes != null ? bytes(i.disk.usedBytes) : '?'
                  } / ${i.disk.quotaMb}MB</span>`
                : ''
            }
            <span>${icon('ticket')}资源券 <code>${esc(i.inviteCode || '—')}</code></span>
            <span>${icon('calendar')}${waiting ? '申请于' : '创建于'} ${when(i.createdAt)}</span>
            ${
              i.life?.expiresAt
                ? `<span${
                    expiringSoon(i.life) && i.status !== 'archived' ? ' class="warn"' : ''
                  }>${icon('hourglass')}有效期至 ${when(i.life.expiresAt)}${
                    i.status === 'archived' ? '' : `（${lasts(i.life.remainingMs)}）`
                  }</span>`
                : i.life?.days
                  ? `<span>${icon('hourglass')}放行后有效 ${i.life.days} 天</span>`
                  : `<span>${icon('hourglass')}永久有效</span>`
            }
            ${
              i.reviewedBy
                ? `<span>${icon('shield')}由 ${esc(i.reviewedBy)} 于 ${when(i.reviewedAt)} 处理</span>`
                : ''
            }
            ${i.state?.startedAt ? `<span>${icon('play')}启动于 ${when(i.state.startedAt)}</span>` : ''}
            ${i.state?.exitCode ? `<span>${icon('power')}退出码 ${i.state.exitCode}</span>` : ''}
          </div>
          ${i.note ? `<div class="hint">${icon('scroll-text')}备注：${esc(i.note)}</div>` : ''}
        ${!waiting && i.status !== 'archived' && i.sleep?.available ? sleepCardHtml(i) : ''}
        ${
          envRows
            ? `<div class="card">${cat('settings', '环境变量', { flush: true })}
               <div class="table-wrap"><table class="cards">${envRows}</table></div></div>`
            : ''
        }
        <div class="card">
          ${cat('list-checks', waiting ? '申请动态' : '部署进度', { flush: true })}
          <pre class="logs" id="events" style="max-height:200px">等待事件…</pre>
        </div>
      </div>`;

    const logs = `<div class="card">
        <div class="row" style="margin-bottom:10px">
          <button class="small" id="reload-logs">${icon('refresh-cw')}刷新</button>
          <label class="row" style="gap:6px;font-size:13px;color:var(--default-500)">
            <input type="checkbox" id="follow" style="width:auto" /> ${icon('activity')}实时跟随
          </label>
        </div>
        <pre class="logs" id="logbox">${loader({ inline: true })}</pre>
      </div>`;

    /* 容器没在跑的时候，控制台是一块什么都做不了的黑框：接不上、也不会说为什么。
       给一条明确的出路，比让人对着「未连接」猜要好。 */
    const isMc =
      i.templateId === 'minecraft' || i.templateId === 'minecraft-bedrock' || /itzg\/minecraft/i.test(i.image || '');
    // Java 版（itzg/minecraft-server）的控制台页签直接放服务器日志，不走 shell。
    const mcJava = i.templateId === 'minecraft' || /itzg\/minecraft-server/i.test(i.image || '');
    const consoleTab =
      i.status === 'running' || i.status === 'sleeping'
        ? `<div class="card term-card" id="term-card">
        <div class="row term-bar">
          <!-- 连接状态是低频的，值得播报；输出区不行 —— role="log" 自带
               aria-live，终端一刷屏就等于让读屏软件念个不停。 -->
          <span class="dot busy" id="term-status" aria-live="polite">连接中…</span>
          <span class="sub term-sub">${
            mcJava
              ? '服务器控制台实时日志（latest.log），命令经 RCON 发送'
              : '容器内的实时终端，相当于 <code>docker exec -it</code>'
          }</span>
          <div style="flex:1"></div>
          <div class="row term-tools">
            <button class="small ghost" id="term-mode" title="直连键盘：按键直接发给容器，Tab 补全、vim、top 才能用">${icon(
              'keyboard'
            )}<span>直连键盘</span></button>
            <button class="small ghost icon-only" id="term-copy" title="复制全部输出" aria-label="复制全部输出">${icon(
              'copy'
            )}</button>
            <button class="small ghost icon-only" id="term-dl" title="下载全部输出" aria-label="下载全部输出">${icon(
              'download'
            )}</button>
            <button class="small ghost icon-only" id="term-full" title="最大化" aria-label="最大化">${icon(
              'maximize'
            )}</button>
            <button class="small ghost term-desk" id="term-int" title="Ctrl+C">${icon('ban')}中断</button>
            <button class="small ghost term-desk" id="term-clear" title="Ctrl+L">${icon('eraser')}清屏</button>
            <button class="small" id="term-restart" title="结束当前 shell，开一个全新的">${icon(
              'rotate-cw'
            )}重启会话</button>
          </div>
        </div>
        ${
          isMc
            ? `<div class="row mc-cmd">
                <span class="mc-cmd-ico" aria-hidden="true">${icon('terminal')}</span>
                <input id="mc-cmd-in" class="mono" placeholder="游戏命令（经 RCON 发到服务器控制台），如 give @a diamond 1"
                       autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
                <button class="primary small" id="mc-cmd-send">发送</button>
              </div>`
            : ''
        }
        <div class="term-body">
          <pre class="term" id="term" tabindex="0" role="region" aria-label="容器控制台输出"></pre>
          <button class="term-jump" id="term-jump" hidden>${icon('chevrons-down')}回到底部</button>
        </div>
        <div class="term-foot">
          <div class="term-keys" id="term-keys"></div>
          <form class="term-input" id="term-form">
            <span class="mono caret" id="term-caret">❯</span>
            <!-- autocorrect and the smart-punctuation it brings would quietly turn a
                 shell command into something else (straight quotes into curly ones,
                 -- into an em dash); enterkeyhint labels the phone's return key. -->
            <input id="term-in" class="mono" autocomplete="off" autocapitalize="off" autocorrect="off"
                   spellcheck="false" inputmode="text" enterkeyhint="send"
                   placeholder="输入命令后回车" disabled />
            <button class="primary small" type="submit" id="term-send">发送</button>
            <div class="term-note" id="term-note"></div>
          </form>
        </div>
        <div class="hint" id="term-hint"></div>
      </div>`
        : i.status === 'archived'
          ? `<div class="card term-empty">
          ${icon('archive', { cls: 'lg' })}
          <h3>实例已封存</h3>
          <p class="sub">有效期已过，容器不会再启动，控制台也就没得连了。<br />
            ${
              i.life?.graceRemainingMs != null && i.life.graceRemainingMs > 0
                ? `数据还保留 ${lasts(i.life.graceRemainingMs)}，之后永久删除。`
                : '宽限期已过，数据已永久删除。'
            }</p>
        </div>`
          : `<div class="card term-empty">
          ${icon('terminal', { cls: 'lg' })}
          <h3>容器没在运行</h3>
          <p class="sub">控制台是在容器里开一个 shell，所以得先让容器跑起来。</p>
          ${
            // 正在创建 / 重启的实例，等它自己走完就行，这时给个启动按钮只会添乱。
            ['creating', 'restarting', 'waking'].includes(i.status)
              ? `<div class="sub">${icon('rotate-cw')}正在准备，稍等片刻…</div>`
              : `<button class="primary" data-act="start" data-id="${esc(i.id)}">${icon('play')}启动容器</button>`
          }
        </div>`;

    shell(
      'instances',
      `<div class="page-title">
         <a href="#/instances" class="btn small">${icon('arrow-left')}返回</a>
         <h1>${esc(i.name)}</h1>${badge(i.status)}
         ${state.user.role === 'admin' && i.owner !== state.user.username ? `<span class="sub">属于 ${esc(i.owner)}</span>` : ''}
         <div class="spacer" style="flex:1"></div>
         <div class="row">
            ${
              waiting
                ? state.user.role === 'admin' && i.status === 'pending'
                  ? `<a class="btn small primary" href="#/admin/pending">${icon('check-check')}去审批</a>`
                  : ''
                : i.status === 'archived' && i.life?.graceRemainingMs != null && i.life.graceRemainingMs > 0
                  ? `<button class="primary small" data-renew="${esc(i.id)}"
                      data-cost="${esc(state.cfg?.life?.renewal?.cost || 100)}"
                      data-days="${esc(state.cfg?.life?.renewal?.days || 7)}">${icon('rotate-cw')}积分续期</button>
                     <button class="small" data-dl="${esc(i.id)}">${icon('download')}下载数据</button>`
                    : i.status === 'archived'
                    ? ''
                    : i.status === 'creating'
                      ? ''
                      : i.status === 'running'
                    ? `${i.life?.days ? `<button class="primary small" data-renew="${esc(i.id)}"
                        data-cost="${esc(state.cfg?.life?.renewal?.cost || 100)}"
                        data-days="${esc(state.cfg?.life?.renewal?.days || 7)}">${icon('rotate-cw')}积分续期</button>` : ''}
                       <button class="small" data-act="stop" data-id="${esc(i.id)}">${icon('square')}停止</button>
                       <button class="small" data-act="restart" data-id="${esc(i.id)}">${icon(
                         'rotate-cw'
                       )}重启</button>`
                    : `${i.life?.days ? `<button class="primary small" data-renew="${esc(i.id)}"
                        data-cost="${esc(state.cfg?.life?.renewal?.cost || 100)}"
                        data-days="${esc(state.cfg?.life?.renewal?.days || 7)}">${icon('rotate-cw')}积分续期</button>` : ''}
                       <button class="small" data-act="start" data-id="${esc(i.id)}">${icon('play')}启动</button>`
            }
           <button class="small danger" data-del="${esc(i.id)}" data-name="${esc(i.name)}" ${
             i.status === 'pending' ? 'data-pending="1"' : ''
           }>${i.status === 'pending' ? `${icon('undo-2')}撤回申请` : `${icon('trash-2')}删除`}</button>
         </div>
       </div>
       ${
         i.error
           ? `<div class="card" style="box-shadow:var(--shadow-sm),0 0 0 2px var(--danger);margin-bottom:16px">
                <div class="err">${icon('triangle-alert')}${esc(i.error)}</div></div>`
           : ''
       }
       <div class="tabbar">
         <button data-tab="overview" class="${tab === 'overview' ? 'on' : ''}">${icon(
           'layout-dashboard'
         )}概览</button>
         ${
           waiting || creating
             ? ''
             : `<button data-tab="logs" class="${tab === 'logs' ? 'on' : ''}">${icon('scroll-text')}日志</button>
                <button data-tab="console" class="${tab === 'console' ? 'on' : ''}">${icon(
                  'terminal'
                )}控制台</button>
                ${
                  state.cfg?.files?.enabled
                    ? `<button data-tab="files" class="${tab === 'files' ? 'on' : ''}">${icon(
                        'folder-open'
                      )}文件</button>`
                    : ''
                }`
         }
       </div>
       ${
         tab === 'overview'
           ? overview
           : tab === 'logs'
             ? logs
             : tab === 'files'
               ? filesTabHtml(i)
               : consoleTab
       }`
    );

    app.querySelectorAll('[data-tab]').forEach(
      (b) =>
        (b.onclick = () => {
          tab = b.dataset.tab;
          clearTimers();
          paint();
        })
    );
    revealActive('.tabbar', 'button.on');
    wireInstanceActions(paint);

    if (tab === 'overview' && (waiting || creating)) {
      hookEvents(i.id);
      // The admin may approve at any moment; repaint once the status moves on.
      timers.push(
        setInterval(async () => {
          try {
            const { instance: fresh } = await api(`/instances/${id}`);
            if (fresh.status !== i.status) {
              clearTimers();
              paint();
            }
          } catch {
            /* ignore */
          }
        }, 5000)
      );
    }

    if (tab === 'overview' && !waiting && !creating) {
      hookEvents(i.id);
      const saveSleep = document.getElementById('sleep-save');
      if (saveSleep) {
        const apply = async () => {
          saveSleep.disabled = true;
          try {
            await api(`/instances/${i.id}/sleep`, {
              method: 'PATCH',
              body: {
                enabled: document.getElementById('sleep-toggle').checked,
                idleMinutes: Number(document.getElementById('sleep-mins').value) || undefined,
              },
            });
            toast('闲时休眠设置已保存', 'ok');
            clearTimers();
            await paint();
          } catch (e) {
            toast(e.message, 'err');
            saveSleep.disabled = false;
          }
        };
        saveSleep.onclick = apply;
        document.getElementById('sleep-toggle').onchange = apply;
      }

      // Same table the approval queue shows, reachable after the fact.
      const addrEdit = document.getElementById('addr-edit');
      if (addrEdit) {
        addrEdit.onclick = () => {
          const slot = document.getElementById('addr-slot');
          if (slot.firstChild) return slot.replaceChildren();
          slot.innerHTML = `
            <form id="addr-form" style="margin-top:12px">
              <div class="table-wrap"><table class="cards">
                <tr><th style="width:96px">主机端口</th><th>用途</th><th>对外地址（留空用默认）</th></tr>
                ${i.ports
                  .map(
                    (p) => `<tr>
                      <td class="mono"><b>${p.host}</b></td>
                      <td class="sub">${esc(p.label)} · 容器 ${p.container}/${p.protocol}</td>
                      <td><input class="mono" data-port="${p.host}" value="${esc(p.public || '')}"
                            placeholder="${esc(p.address)}" /></td>
                    </tr>`
                  )
                  .join('')}
              </table></div>
              <div class="err" data-err></div>
              <div class="row">
                <button class="primary small" type="submit">${icon('save')}保存</button>
                <span class="sub">${icon(
                  'info'
                )}只改面板显示给用户的地址，穿透还是要你自己配好</span>
              </div>
            </form>`;
          // Injected after shell() has run, so it misses the labelCards() pass
          // that gives the phone layout its per-cell column labels.
          labelCards(slot);
          const form = document.getElementById('addr-form');
          form.onsubmit = async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button[type=submit]');
            const errEl = form.querySelector('[data-err]');
            btn.disabled = true;
            errEl.textContent = '';
            const addresses = {};
            form.querySelectorAll('[data-port]').forEach((inp) => {
              addresses[inp.dataset.port] = inp.value.trim();
            });
            try {
              await api(`/admin/instances/${i.id}/addresses`, { method: 'PATCH', body: { addresses } });
              toast('对外地址已更新', 'ok');
              clearTimers();
              await paint();
            } catch (err) {
              errEl.textContent = err.message;
              btn.disabled = false;
            }
          };
        };
      }

      const expiryEdit = document.getElementById('expiry-edit');
      if (expiryEdit) {
        expiryEdit.onclick = () => {
          const slot = document.getElementById('expiry-slot');
          if (slot.firstChild) return slot.replaceChildren();
          const cur = i.life?.expiresAt ? i.life.expiresAt.slice(0, 10) : '';
          slot.innerHTML = `
            <form id="expiry-form" style="margin-top:12px">
              <label class="field"><span>过期日期（YYYY-MM-DD，留空 = 永久）</span>
                <input name="expiryDate" type="date" value="${esc(cur)}" /></label>
              <div class="err" data-err></div>
              <div class="row">
                <button class="primary small" type="submit">${icon('save')}保存</button>
                <button class="small ghost" type="button" id="expiry-permanent">${icon('undo-2')}设为永久</button>
              </div>
            </form>`;
          const form = document.getElementById('expiry-form');
          form.onsubmit = async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button[type=submit]');
            const errEl = form.querySelector('[data-err]');
            btn.disabled = true;
            errEl.textContent = '';
            const val = new FormData(form).get('expiryDate');
            try {
              const expiresAt = val ? new Date(val).toISOString() : null;
              await api(`/admin/instances/${i.id}/expiry`, { method: 'PATCH', body: { expiresAt } });
              toast(expiresAt ? `过期时间已更新为 ${expiresAt.slice(0, 10)}` : '已设为永久有效', 'ok');
              clearTimers();
              await paint();
            } catch (err) {
              errEl.textContent = err.message;
              btn.disabled = false;
            }
          };
          document.getElementById('expiry-permanent').onclick = async () => {
            try {
              await api(`/admin/instances/${i.id}/expiry`, { method: 'PATCH', body: { expiresAt: null } });
              toast('已设为永久有效', 'ok');
              clearTimers();
              await paint();
            } catch (err) {
              form.querySelector('[data-err]').textContent = err.message;
            }
          };
        };
      }

      /* 运行状态历史：每 4s 攒一个样本，画成迷你走势图（最近 4 分钟）。
         服务端按容器保留一份样本，重进详情页时先补上，走势不从头开始。 */
      const MAX_PTS = 60;
      const hist = { cpu: [], mem: [], rx: [], tx: [] };
      let lastNet = null; // { t, rx, tx }，t 用 Date.now() 纪元
      let seeded = false;
      const sparkPts = (vals, max) => {
        const m = Math.max(max, ...vals, 1);
        return vals.map(
          (v, i) => `${(2 + (i / (MAX_PTS - 1)) * 116).toFixed(1)},${(30 - (v / m) * 28).toFixed(1)}`
        );
      };
      const sparkSvg = (vals, max, stroke) =>
        vals.length < 2
          ? '<span class="spark-ghost">…</span>'
          : `<svg class="spark" viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden="true">
              <polyline points="${sparkPts(vals, max).join(' ')}" fill="none" stroke="${stroke}" stroke-width="2"
                vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
      const chartsHtml = () => {
        const rxMax = Math.max(...hist.rx, ...hist.tx, 1);
        return `<div class="stat-chart">
            <div class="cap"><span>CPU</span><span>${hist.cpu[hist.cpu.length - 1] ?? 0}%</span></div>
            ${sparkSvg(hist.cpu, 100, '#3b82f6')}
          </div>
          <div class="stat-chart">
            <div class="cap"><span>内存</span><span>${hist.mem[hist.mem.length - 1] ?? 0}%</span></div>
            ${sparkSvg(hist.mem, 100, '#22c55e')}
          </div>
          <div class="stat-chart">
            <div class="cap"><span>网络</span><span>${bytes(
              hist.rx[hist.rx.length - 1] ?? 0
            )}/s 入 · ${bytes(hist.tx[hist.tx.length - 1] ?? 0)}/s 出</span></div>
            <svg class="spark" viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden="true">
              <polyline points="${sparkPts(hist.rx, rxMax).join(' ')}" fill="none" stroke="#06b6d4" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
              <polyline points="${sparkPts(hist.tx, rxMax).join(' ')}" fill="none" stroke="#f59e0b" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
            </svg>
            <div class="lgd"><span class="lgd-dot" style="background:#06b6d4"></span>入站<span class="lgd-dot" style="background:#f59e0b"></span>出站</div>
          </div>`;
      };

      const pollStats = async () => {
        try {
          const { stats, history } = await api(`/instances/${i.id}/stats`);
          const box = document.getElementById('stats');
          if (!box) return;
          const charts = document.getElementById('stat-charts');
          if (!stats) {
            box.innerHTML = `<span class="sub">${icon('power')}容器未运行</span>`;
            if (charts) charts.innerHTML = '';
            return;
          }
          if (!seeded && history?.length) {
            const src = history.slice(-MAX_PTS);
            for (let k = 1; k < src.length; k++) {
              const a = src[k - 1];
              const b = src[k];
              const dt = Math.max(0.1, (b.t - a.t) / 1000);
              hist.cpu.push(b.cpu);
              hist.mem.push(b.mem);
              hist.rx.push(Math.max(0, (b.rx - a.rx) / dt));
              hist.tx.push(Math.max(0, (b.tx - a.tx) / dt));
            }
            const last = src[src.length - 1];
            lastNet = { t: last.t, rx: last.rx, tx: last.tx };
            seeded = true;
          }
          hist.cpu.push(stats.cpuPercent);
          hist.mem.push(stats.memPercent);
          const t = Date.now();
          const dt = lastNet ? Math.max(0.1, (t - lastNet.t) / 1000) : 0;
          hist.rx.push(lastNet ? Math.max(0, (stats.netRx - lastNet.rx) / dt) : 0);
          hist.tx.push(lastNet ? Math.max(0, (stats.netTx - lastNet.tx) / dt) : 0);
          lastNet = { t, rx: stats.netRx, tx: stats.netTx };
          for (const k of Object.keys(hist)) if (hist[k].length > MAX_PTS) hist[k].shift();
          const high = (pct) => pct >= 85;
          const netRate = (arr) => arr[arr.length - 1] ?? 0;
          const highNet = netRate(hist.rx) >= 1048576 || netRate(hist.tx) >= 1048576; // ≥ 1 MB/s
          const cls = (on) => ` class="stat${on ? ' high' : ''}"`;
          box.innerHTML = `<div${cls(high(stats.cpuPercent))} title="${high(stats.cpuPercent) ? 'CPU 使用率较高' : ''}"><b>${stats.cpuPercent}%</b><span>${icon('cpu')}CPU</span></div>
               <div${cls(high(stats.memPercent))} title="${high(stats.memPercent) ? '内存占用较高' : ''}"><b>${bytes(stats.memUsage)}</b><span>${icon('memory-stick')}内存 / ${bytes(
                 stats.memLimit
               )} (${stats.memPercent}%)</span></div>
               <div${cls(highNet)} title="${highNet ? '当前带宽较高' : ''}"><b>${bytes(stats.netRx)}</b>
                 <span>${icon('arrow-down-to-line')}入站流量</span></div>
               <div${cls(highNet)} title="${highNet ? '当前带宽较高' : ''}"><b>${bytes(stats.netTx)}</b>
                 <span>${icon('arrow-up-from-line')}出站流量</span></div>`;
          if (charts) charts.innerHTML = chartsHtml();
        } catch {
          /* ignore */
        }
      };
      pollStats();
      timers.push(setInterval(pollStats, 4000));
    }

    if (tab === 'logs') {
      const box = document.getElementById('logbox');
      const load = async () => {
        try {
          const { logs: text } = await api(`/instances/${i.id}/logs?tail=400`);
          box.textContent = text || '(暂无日志)';
          box.scrollTop = box.scrollHeight;
        } catch (e) {
          box.textContent = e.message;
        }
      };
      load();
      document.getElementById('reload-logs').onclick = load;
      document.getElementById('follow').onchange = (e) => {
        if (e.target.checked) {
          const es = new EventSource(`/api/instances/${i.id}/logs/stream`);
          es.onmessage = (m) => {
            box.textContent += JSON.parse(m.data).line;
            box.scrollTop = box.scrollHeight;
          };
          es.onerror = () => es.close();
          timers.push(() => es.close());
        } else {
          clearTimers();
          load();
        }
      };
    }

    if (tab === 'console') wireConsole(i);

    if (tab === 'files') {
      wireFiles(i, { get: () => filesCwd, set: (p) => (filesCwd = p) });
    }
  };

  await paint().catch((e) => {
    toast(e.message, 'err');
    location.hash = '#/instances';
  });
}

function hookEvents(id) {
  const box = document.getElementById('events');
  if (!box) return;
  box.textContent = '';
  const es = new EventSource(`/api/instances/${id}/events`);
  let got = false;
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    got = true;
    box.textContent += `${new Date(e.t).toLocaleTimeString('zh-CN', { hour12: false })}  ${e.line}\n`;
    box.scrollTop = box.scrollHeight;
    if (e.kind === 'done' || e.kind === 'error') es.close();
  };
  es.onerror = () => es.close();
  timers.push(() => es.close());
  // Backlog arrives asynchronously, so only fall back to the placeholder once
  // it is clear nothing is coming.
  const placeholder = setTimeout(() => {
    if (!got) box.textContent = '（暂无动态）';
  }, 2000);
  timers.push(() => clearTimeout(placeholder));
}

/* ---------------- console ---------------- */

/* 256 色里第 16 号往后是程序自己指定的绝对颜色（6×6×6 色立方 + 24 级灰阶），
   跟主题无关，直接算成十六进制；前 16 个走 style.css 里的 --t0..--t15，
   那套是按明暗两种背景分别调过的，不然「黑色」在黑底上就没了。 */
const CUBE = [0, 95, 135, 175, 215, 255];
const hx = (n) => n.toString(16).padStart(2, '0');
function xterm256(n) {
  if (n < 16) return `var(--t${n})`;
  if (n < 232) {
    const i = n - 16;
    return `#${hx(CUBE[Math.floor(i / 36) % 6])}${hx(CUBE[Math.floor(i / 6) % 6])}${hx(CUBE[i % 6])}`;
  }
  const v = 8 + (n - 232) * 10;
  return `#${hx(v)}${hx(v)}${hx(v)}`;
}

/* 一支「笔」= 当前的 SGR 状态。相同的笔在整屏里会重复成千上万次，
   所以把它驻留成一个 id，渲染时只按 id 分段包 <span>。 */
const PEN0 = { fg: '', bg: '', b: 0, d: 0, i: 0, u: 0, r: 0, h: 0, s: 0 };
const penKey = (p) => `${p.fg}|${p.bg}|${p.b}${p.d}${p.i}${p.u}${p.r}${p.h}${p.s}`;
const penIds = new Map([[penKey(PEN0), 0]]);
const penCss = [''];

function penStyle(p) {
  // 反显是把前景背景对调，没指定颜色时对调的就是终端自己的底色和字色。
  let fg = p.r ? p.bg || 'var(--term-bg)' : p.fg;
  let bg = p.r ? p.fg || 'var(--term-fg)' : p.bg;
  const out = [];
  if (p.h) out.push('color:transparent');
  else if (fg) out.push(`color:${fg}`);
  if (bg) out.push(`background-color:${bg}`);
  if (p.b) out.push('font-weight:600');
  if (p.d) out.push('opacity:.7');
  if (p.i) out.push('font-style:italic');
  const deco = [p.u ? 'underline' : '', p.s ? 'line-through' : ''].filter(Boolean).join(' ');
  if (deco) out.push(`text-decoration:${deco}`);
  return out.join(';');
}

/* 驻留表要封顶：24 位真彩有一千六百万种颜色，容器里 cat 一张用真彩打印的图，
   每个像素都是一支新笔，这张表会一直涨到把标签页撑死。超过上限就不再新建，
   多出来的那些按默认色画 —— 丢的是一张 ASCII 图的颜色，换的是不会崩。 */
const PEN_MAX = 4096;
function penId(p) {
  const k = penKey(p);
  let id = penIds.get(k);
  if (id === undefined) {
    if (penCss.length >= PEN_MAX) return 0;
    id = penCss.length;
    penCss.push(penStyle(p));
    penIds.set(k, id);
  }
  return id;
}

/**
 * 够用的 VT 子集：颜色、粗体/下划线/反显、光标定位、滚动区域、备用屏幕缓冲区。
 *
 * 不引 xterm.js —— 全站零依赖零构建，为一个终端破例不值得；但「够用」的下限
 * 也不是原来那样把颜色全丢掉：容器里跑的 ls、git、npm、apt 全靠颜色分信息。
 *
 * 屏幕 = 缓冲区末尾的 rows 行。普通缓冲区里往下换行就是往缓冲区追加（这才有
 * 回滚），只有在滚动区域或备用屏幕里才真的滚动 —— vim / top / less 因此能
 * 画在自己的一块地方，退出后原来的内容还在。
 *
 * 每行一个 DOM 节点，只有改过的行会重画：`yes` 刷屏时不该整页重排。
 */
function makeTerm(el, { maxLines = 3000, onScroll } = {}) {
  const mk = () => ({ c: [], a: [], n: null });
  let lines = [mk()];
  let cur = 0;
  let col = 0;
  let rows = 24;
  let pen = { ...PEN0 };
  let attr = 0;
  let saved = null;
  let parked = null; // 备用屏幕开着时，正常缓冲区连同它的 DOM 节点在这里等
  let top = 0; // 滚动区域（相对屏幕的行号）
  let bot = -1; // -1 = 一直到屏幕底
  const dirty = new Set();
  let queued = false;
  let restructured = true;
  let stick = true;

  /* ---- 缓冲区与屏幕 ---- */
  const screenTop = () => Math.max(0, lines.length - rows);
  const regTop = () => screenTop() + top;
  const regBot = () => screenTop() + (bot < 0 ? rows - 1 : bot);
  /** 整屏都归自己、又没设滚动区域时，换行是「长出新的一行」而不是滚动。 */
  const grows = () => !parked && top === 0 && bot < 0;

  const touch = (i) => {
    if (i >= 0 && i < lines.length) dirty.add(lines[i]);
  };

  const trim = () => {
    if (lines.length <= maxLines) return;
    const n = lines.length - maxLines;
    for (let i = 0; i < n; i++) lines[i].n?.remove();
    lines.splice(0, n);
    cur = Math.max(0, cur - n);
  };

  /** 在滚动区域里上滚 n 行：顶上的走掉，底下补空行。 */
  const scrollRegion = (n) => {
    const a = regTop();
    const b = regBot();
    const count = Math.min(n, b - a + 1);
    if (count <= 0) return;
    const fresh = Array.from({ length: count }, mk);
    for (let i = a; i < a + count; i++) lines[i].n?.remove();
    lines.splice(a, count);
    lines.splice(b - count + 1, 0, ...fresh);
    restructured = true;
  };

  const feed = () => {
    if (cur >= regBot() && !grows()) return scrollRegion(1);
    cur += 1;
    while (cur >= lines.length) {
      lines.push(mk());
      restructured = true;
    }
    trim();
  };

  /** 反向换行（\x1bM 与滚动区域顶部的上滚）。 */
  const rfeed = () => {
    if (cur <= regTop()) {
      const a = regTop();
      const b = regBot();
      lines[b].n?.remove();
      lines.splice(b, 1);
      lines.splice(a, 0, mk());
      restructured = true;
      return;
    }
    cur -= 1;
  };

  const line = () => lines[cur] ?? (lines[cur] = mk());

  const put = (s) => {
    const l = line();
    while (l.c.length < col) {
      l.c.push(' ');
      l.a.push(0);
    }
    for (let k = 0; k < s.length; k++) {
      l.c[col] = s[k];
      l.a[col] = attr;
      col += 1;
    }
    dirty.add(l);
  };

  /** 把某一段清成空白（保留当前笔的背景色，`clear` 之后的底色才不会突变）。 */
  const erase = (l, from, to) => {
    for (let i = from; i <= to && i < l.c.length; i++) {
      l.c[i] = ' ';
      l.a[i] = attr;
    }
    if (to >= l.c.length - 1) {
      l.c.length = Math.min(l.c.length, from);
      l.a.length = l.c.length;
    }
    dirty.add(l);
  };

  const blankLine = (i) => {
    const l = lines[i];
    if (!l) return;
    l.c.length = 0;
    l.a.length = 0;
    dirty.add(l);
  };

  /* ---- SGR ---- */
  const sgr = (params) => {
    const ps = params.split(';');
    for (let i = 0; i < ps.length; i++) {
      // 38:5:n / 38:2:r:g:b 的冒号写法：拆开当成同一串数字看待。
      const parts = ps[i].split(':');
      const n = parseInt(parts[0], 10) || 0;
      const sub = parts.length > 1 ? parts.slice(1).map((x) => parseInt(x, 10) || 0) : null;
      const take = () => (sub ? sub.shift() : parseInt(ps[++i], 10) || 0);
      switch (n) {
        case 0: pen = { ...PEN0 }; break;
        case 1: pen.b = 1; break;
        case 2: pen.d = 1; break;
        case 3: pen.i = 1; break;
        case 4: pen.u = 1; break;
        case 7: pen.r = 1; break;
        case 8: pen.h = 1; break;
        case 9: pen.s = 1; break;
        case 21: case 22: pen.b = 0; pen.d = 0; break;
        case 23: pen.i = 0; break;
        case 24: pen.u = 0; break;
        case 27: pen.r = 0; break;
        case 28: pen.h = 0; break;
        case 29: pen.s = 0; break;
        case 39: pen.fg = ''; break;
        case 49: pen.bg = ''; break;
        case 38:
        case 48: {
          const mode = take();
          let v = '';
          if (mode === 5) v = xterm256(take());
          else if (mode === 2) v = `#${hx(take() & 255)}${hx(take() & 255)}${hx(take() & 255)}`;
          if (v) pen[n === 38 ? 'fg' : 'bg'] = v;
          break;
        }
        default:
          if (n >= 30 && n <= 37) pen.fg = `var(--t${n - 30})`;
          else if (n >= 40 && n <= 47) pen.bg = `var(--t${n - 40})`;
          else if (n >= 90 && n <= 97) pen.fg = `var(--t${n - 90 + 8})`;
          else if (n >= 100 && n <= 107) pen.bg = `var(--t${n - 100 + 8})`;
          break;
      }
    }
    attr = penId(pen);
  };

  /* ---- 备用屏幕缓冲区 ---- */
  const useAlt = (on) => {
    if (on === !!parked) return;
    if (on) {
      const keep = document.createDocumentFragment();
      for (const l of lines) if (l.n) keep.append(l.n);
      parked = { lines, cur, col, frag: keep };
      lines = Array.from({ length: rows }, mk);
      cur = 0;
      col = 0;
    } else {
      for (const l of lines) l.n?.remove();
      lines = parked.lines;
      cur = Math.min(parked.cur, lines.length - 1);
      col = parked.col;
      el.append(parked.frag);
      parked = null;
    }
    top = 0;
    bot = -1;
    restructured = true;
    dirty.clear();
  };

  /* ---- CSI ---- */
  const csi = (raw, final) => {
    const priv = /^[?<=>]/.test(raw);
    const body = priv ? raw.slice(1) : raw;
    if (final === 'm' && !priv) return sgr(body);
    const ps = body.split(';').map((x) => parseInt(x, 10));
    const p1 = Number.isFinite(ps[0]) ? ps[0] : 0;
    // 重复次数夹在一屏之内：程序可以写 [9999S，照着滚 9999 次只是白烧 CPU
    const n1 = Math.min(Math.max(1, p1), Math.max(rows, 200));
    const l = line();

    if (priv && (final === 'h' || final === 'l')) {
      // 1049/1047/47 都是「切到备用屏幕」的不同年代写法；其余（隐藏光标、
      // 括号粘贴、鼠标上报…）我们没有对应概念，静静忽略比乱画强。
      if (p1 === 1049 || p1 === 1047 || p1 === 47) useAlt(final === 'h');
      return;
    }

    switch (final) {
      case 'A': cur = Math.max(regTop(), cur - n1); break;
      case 'B': cur = Math.min(lines.length - 1, cur + n1); break;
      case 'C': col += n1; break;
      case 'D': col = Math.max(0, col - n1); break;
      case 'E': cur = Math.min(lines.length - 1, cur + n1); col = 0; break;
      case 'F': cur = Math.max(regTop(), cur - n1); col = 0; break;
      case 'G': case '`': col = Math.max(0, n1 - 1); break;
      case 'd': cur = Math.min(lines.length - 1, screenTop() + n1 - 1); break;
      case 'H':
      case 'f': {
        // 行号必须夹在屏幕高度里。补空行的循环条件是 screenTop()+r-1 >= lines.length，
        // 而 screenTop() 本身就是 lines.length-rows —— 一旦 r 超过 rows，补一行
        // 条件就往后退一行，永远退不出来。重放别的尺寸下存下来的快照就会撞上这个。
        const r = Math.min(rows, Math.max(1, Number.isFinite(ps[0]) ? ps[0] : 1));
        const c = Math.max(1, Number.isFinite(ps[1]) ? ps[1] : 1);
        while (!parked && screenTop() + r - 1 >= lines.length) {
          lines.push(mk());
          restructured = true;
        }
        cur = Math.min(lines.length - 1, screenTop() + r - 1);
        col = c - 1;
        break;
      }
      case 'J':
        if (p1 === 3) {
          // 只有 3J 才是「连回滚一起清」。clear 命令发的正是 H + 2J + 3J，
          // 所以用户敲 clear 依然得到干净的一屏；而 top 这类程序只发 2J，
          // 它清的是自己那一屏，凭什么把用户之前的输出也抹掉。
          const above = screenTop();
          if (!parked && above > 0) {
            for (let k = 0; k < above; k++) lines[k].n?.remove();
            lines.splice(0, above);
            cur = Math.max(0, cur - above);
            restructured = true;
          }
        } else if (p1 === 2) {
          for (let k = screenTop(); k < lines.length; k++) blankLine(k);
        } else if (p1 === 1) {
          for (let i = screenTop(); i < cur; i++) blankLine(i);
          erase(l, 0, col - 1);
        } else {
          erase(l, col, l.c.length - 1);
          for (let i = cur + 1; i < lines.length; i++) blankLine(i);
        }
        break;
      case 'K':
        if (p1 === 1) erase(l, 0, col - 1);
        else if (p1 === 2) blankLine(cur);
        else erase(l, col, l.c.length - 1);
        break;
      case 'P': // 删除字符，右边补上来
        l.c.splice(col, n1);
        l.a.splice(col, n1);
        dirty.add(l);
        break;
      case 'X': // 就地擦掉 n 个字符
        erase(l, col, col + n1 - 1);
        break;
      case '@': // 插入 n 个空格
        for (let k = 0; k < n1; k++) {
          l.c.splice(col, 0, ' ');
          l.a.splice(col, 0, attr);
        }
        dirty.add(l);
        break;
      case 'L': { // 在光标行插入 n 行（区域内下滚）
        const b = regBot();
        for (let k = 0; k < n1 && cur <= b; k++) {
          lines[b].n?.remove();
          lines.splice(b, 1);
          lines.splice(cur, 0, mk());
        }
        restructured = true;
        break;
      }
      case 'M': { // 删除 n 行（区域内上滚）
        const b = regBot();
        for (let k = 0; k < n1 && cur <= b; k++) {
          lines[cur].n?.remove();
          lines.splice(cur, 1);
          lines.splice(b, 0, mk());
        }
        restructured = true;
        break;
      }
      case 'S': scrollRegion(n1); break;
      case 'T': for (let k = 0; k < n1; k++) rfeed(); break;
      case 'r': // 设置滚动区域
        top = Number.isFinite(ps[0]) ? Math.max(0, ps[0] - 1) : 0;
        bot = Number.isFinite(ps[1]) ? Math.min(rows - 1, ps[1] - 1) : -1;
        cur = regTop();
        col = 0;
        break;
      case 's': saved = { cur, col, pen: { ...pen }, attr }; break;
      case 'u':
        if (saved) ({ cur, col, attr } = saved), (pen = { ...saved.pen });
        break;
      default:
        break;
    }
    if (col < 0) col = 0;
  };

  /* ---- 绘制 ---- */
  const esc = (s) =>
    s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

  const html = (l) => {
    if (!l.c.length) return '';
    let out = '';
    let i = 0;
    while (i < l.c.length) {
      const a = l.a[i] || 0;
      let j = i;
      while (j < l.c.length && (l.a[j] || 0) === a) j++;
      const text = esc(l.c.slice(i, j).join(''));
      out += a ? `<span style="${penCss[a]}">${text}</span>` : text;
      i = j;
    }
    return out;
  };

  const paint = () => {
    queued = false;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (restructured) {
      restructured = false;
      // 只补新节点、只按顺序插回，已有节点原地不动（appendChild 会搬走它们）。
      let ref = el.firstChild;
      for (const l of lines) {
        if (!l.n) {
          l.n = document.createElement('div');
          l.n.className = 'tl';
          l.n.innerHTML = html(l);
          dirty.delete(l);
          el.insertBefore(l.n, ref);
        } else if (l.n !== ref) {
          el.insertBefore(l.n, ref);
        } else {
          ref = ref.nextSibling;
          continue;
        }
      }
    }
    for (const l of dirty) if (l.n) l.n.innerHTML = html(l);
    dirty.clear();
    if (stick || atBottom) el.scrollTop = el.scrollHeight;
    onScroll?.(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(paint);
  };

  /* ---- 解析 ---- */
  // 一段转义序列可能正好被 SSE 切成两半，尾巴留到下一段再解析，
  // 否则半截序列会被当成普通字符吐在屏幕上。
  let carry = '';

  const write = (text) => {
    const s = carry + text;
    carry = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\x1b') {
        const next = s[i + 1];
        if (next === undefined) {
          carry = s.slice(i);
          break;
        }
        if (next === '[') {
          let j = i + 2;
          while (j < s.length && !/[@-~]/.test(s[j])) j++;
          if (j >= s.length) {
            carry = s.slice(i);
            break;
          }
          csi(s.slice(i + 2, j), s[j]);
          i = j;
        } else if (next === ']' || next === 'P' || next === '^' || next === '_') {
          // OSC / DCS / PM / APC：一直到 BEL 或 ST 为止，内容我们不关心
          let j = i + 2;
          while (j < s.length && s[j] !== '\x07' && !(s[j] === '\x1b' && s[j + 1] === '\\')) j++;
          if (j >= s.length) {
            carry = s.slice(i);
            break;
          }
          i = s[j] === '\x1b' ? j + 1 : j;
        } else if (next === '7') {
          saved = { cur, col, pen: { ...pen }, attr };
          i += 1;
        } else if (next === '8') {
          if (saved) ({ cur, col, attr } = saved), (pen = { ...saved.pen });
          i += 1;
        } else if (next === 'M') {
          rfeed();
          i += 1;
        } else if (next === 'D') {
          feed();
          i += 1;
        } else if (next === 'E') {
          feed();
          col = 0;
          i += 1;
        } else if (next === '(' || next === ')' || next === '#' || next === '%') {
          i += 2; // 字符集选择，跳过它和它的参数
        } else {
          i += 1;
        }
        continue;
      }
      if (ch === '\r') {
        col = 0;
        continue;
      }
      if (ch === '\n') {
        feed();
        continue;
      }
      if (ch === '\b') {
        col = Math.max(0, col - 1);
        continue;
      }
      if (ch === '\t') {
        put(' '.repeat(8 - (col % 8)));
        continue;
      }
      if (ch < ' ' || ch === '\x7f') continue;
      let j = i;
      while (j < s.length && s[j] >= ' ' && s[j] !== '\x7f') j++;
      put(s.slice(i, j));
      i = j - 1;
    }
    // 一段没完没了的 OSC（或者干脆是二进制垃圾）会让 carry 一直攒下去。攒到这个
    // 份上就不可能是一段正常的转义序列了，丢掉，别让它把内存一路吃上去。
    if (carry.length > 8192) carry = '';
    schedule();
  };

  const wipe = () => {
    for (const l of lines) l.n?.remove();
    lines = [mk()];
    cur = 0;
    col = 0;
    dirty.clear();
    restructured = true;
  };

  return {
    write,
    /** 屏幕高度，决定绝对定位和滚动区域怎么算；跟着盒子高度走。 */
    setRows(n) {
      rows = Math.max(5, n | 0);
      if (parked) {
        while (lines.length < rows) {
          lines.push(mk());
          restructured = true;
        }
        schedule();
      }
    },
    /** 用户是否被钉在底部：滚上去看历史时不该被新输出拽回来。 */
    setStick(on) {
      stick = !!on;
      if (on) {
        el.scrollTop = el.scrollHeight;
        onScroll?.(true);
      }
    },
    clear() {
      wipe();
      schedule();
    },
    reset(text = '') {
      useAlt(false);
      wipe();
      pen = { ...PEN0 };
      attr = 0;
      carry = '';
      stick = true;
      write(text);
    },
    /** 「复制全部」和「下载」都要纯文本，别把 span 一起带走。 */
    text: () => lines.map((l) => l.c.join('').replace(/\s+$/, '')).join('\n'),
    /** 光标所在处往上第一行有字的内容。识别「Password:」这种问话要看它，
        而且必须问渲染器要 —— 原始流里那行可能被 SSE 切成两半、还夹着颜色转义。 */
    tail() {
      for (let k = Math.min(cur, lines.length - 1); k >= 0; k--) {
        const t = lines[k].c.join('');
        if (t.trim()) return t;
      }
      return '';
    },
  };
}

/* 粘贴多行时先给人看清楚。剪贴板里的东西可能不是自己复制的（网页可以往剪贴板里
   塞看不见的行），所以预览是全文、可滚动、用 textContent 塞进去，绝不 innerHTML；
   默认焦点落在「取消」上，回车顺手确认不该等于执行别人的脚本。 */
function pasteDialog(text) {
  return new Promise((resolve) => {
    document.getElementById('paste-dlg')?.remove();
    const rows = text.split('\n').length;
    const dlg = document.createElement('dialog');
    dlg.id = 'paste-dlg';
    dlg.className = 'paste-dlg';
    dlg.setAttribute('aria-labelledby', 'paste-title');
    dlg.innerHTML = `
      <h3 id="paste-title">${icon('files')}粘贴了 ${rows} 行，共 ${text.length} 个字符</h3>
      <div class="hint">「逐行执行」会把它们当成 ${rows} 条命令依次送进容器。先看清楚下面的内容。</div>
      <pre class="logs paste-preview"></pre>
      <div class="row" style="justify-content:flex-end;margin-top:16px">
        <button class="ghost" data-v="">取消</button>
        <button class="ghost" data-v="join">合并成一行</button>
        <button class="danger" data-v="run">${icon('play')}逐行执行</button>
      </div>`;
    dlg.querySelector('.paste-preview').textContent = text;
    document.body.append(dlg);
    dlg.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => dlg.close(b.dataset.v)));
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close('');
    });
    dlg.onclose = () => {
      const v = dlg.returnValue;
      dlg.remove();
      resolve(v || '');
    };
    dlg.showModal();
    dlg.querySelector('[data-v=""]').focus();
  });
}

function wireConsole(i) {
  const box = document.getElementById('term');
  if (!box) return; // 容器没在跑，这一页渲染的是空状态
  const input = document.getElementById('term-in');
  const dot = document.getElementById('term-status');
  const form = document.getElementById('term-form');
  const caret = document.getElementById('term-caret');
  const note = document.getElementById('term-note');
  const keys = document.getElementById('term-keys');
  const jump = document.getElementById('term-jump');
  const card = document.getElementById('term-card');

  let stuck = true;
  const term = makeTerm(box, {
    onScroll: (atBottom) => {
      if (atBottom === stuck) return;
      stuck = atBottom;
      jump.hidden = atBottom;
    },
  });

  /* ---- Minecraft：看日志而不是开 shell ----
     MC 服务端是容器的 PID 1，shell 根本够不着它；控制台页签对 Java 版 MC
     实例改放服务器日志（latest.log 实时 tail），命令走上面的 RCON 条。
     shell 专用控件收起来，复制 / 下载 / 清屏 / 最大化 / 回到底部照常可用。 */
  const mcLog = i.templateId === 'minecraft' || /itzg\/minecraft-server/i.test(i.image || '');
  if (mcLog) {
    for (const id of ['term-mode', 'term-int', 'term-restart', 'term-keys', 'term-form']) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    const hint = document.getElementById('term-hint');
    if (hint) {
      hint.textContent =
        '这里是服务器控制台实时日志，服务器重启后会自动续上；游戏命令从上面的输入条经 RCON 发给服务端。';
    }
  }

  /* ---- Minecraft 游戏命令 ----
     MC 服务端只从自己的 stdin 读命令，docker exec 的 shell 敲不进去；
     这条命令条走 RCON（itzg 镜像默认开启），结果直接打进终端输出区。 */
  const mcIn = document.getElementById('mc-cmd-in');
  const mcSend = document.getElementById('mc-cmd-send');
  if (mcIn && mcSend) {
    const sendMc = async () => {
      const cmd = mcIn.value.trim();
      if (!cmd) return;
      mcSend.disabled = true;
      term.write(`\r\n\x1b[90m> ${cmd}\x1b[0m\r\n`);
      try {
        const r = await api(`/instances/${i.id}/minecraft/command`, { method: 'POST', body: { command: cmd } });
        term.write(`${(r.output || '').trim() || '(服务器无输出)'}\r\n`);
        term.setStick(true);
      } catch (err) {
        term.write(`\x1b[31m${err.message}\x1b[0m\r\n`);
      } finally {
        mcSend.disabled = false;
        mcIn.focus();
      }
    };
    mcSend.onclick = sendMc;
    mcIn.onkeydown = (e) => {
      if (e.key === 'Enter') sendMc();
    };
  }

  /* 命令历史按实例存，跨刷新还在 —— 终端的历史本来就是这个预期，
     每次回到这一页都从零开始翻不动上一条实在别扭。 */
  const HKEY = `lh.term.hist.${i.id}`;
  let history = [];
  try {
    const saved = JSON.parse(localStorage.getItem(HKEY) || '[]');
    if (Array.isArray(saved)) history = saved.filter((x) => typeof x === 'string').slice(-200);
  } catch {
    /* 存不了就不存，历史不值得为它报错 */
  }
  const remember = (line) => {
    // 密码态下这一行是口令，一个字都不能留；开头带空格的按 shell 的老规矩也不记。
    if (secret || !line.trim() || line.startsWith(' ') || history[history.length - 1] === line) return;
    history.push(line);
    if (history.length > 200) history.shift();
    try {
      localStorage.setItem(HKEY, JSON.stringify(history));
    } catch {
      /* 隐私模式下写不进去，历史仍在内存里管用 */
    }
  };
  let hist = history.length;
  let draft = ''; // 翻历史之前手里那半行，翻回底部要还给用户
  let sid = null;
  let es = null;
  let attached = false;
  let ended = false;
  let secret = false;
  let stopped = false; // 离开这一页之后，任何在途的重试都不该再建会话
  let direct = localStorage.getItem('lh.term.direct') === '1';

  timers.push(() => {
    stopped = true;
  });

  const status = (text, kind) => {
    dot.textContent = text;
    dot.className = `dot ${kind}`;
  };
  /* 连着才有得敲。按键条的按钮也要跟着走 —— send() 在未连接时是静默返回的，
     按下去毫无反应比按钮变灰糟得多。 */
  const setEnabled = (on) => {
    input.disabled = !on;
    keys.classList.toggle('off', !on);
    keys.querySelectorAll('button').forEach((b) => (b.disabled = !on));
  };
  const setNote = (text) => {
    note.textContent = text || '';
    note.hidden = !text;
  };

  /* 告诉 shell 这块屏幕有多大。字符宽度实测而不是写死：字体栈里 Consolas 和
     SF Mono 的宽度就不一样，页面缩放也会变，猜错的后果是浏览器先于 shell 折行，
     readline 的光标算术全部落在错误的位置上。
     行数同理 —— 以前恒定报 30 行，于是 top / vim 永远按 30 行作画，
     而盒子实际显示的是二十几行或四十几行。
     20 列是服务端接受的下限，也是手机竖屏能塞下的宽度。 */
  const metrics = () => {
    const probe = document.createElement('span');
    probe.textContent = 'M'.repeat(50);
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    box.append(probe);
    const chw = probe.getBoundingClientRect().width / 50 || 7.2;
    probe.remove();
    const cs = getComputedStyle(box);
    const lh = parseFloat(cs.lineHeight) || 20;
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    return {
      cols: Math.max(20, Math.min(240, Math.floor((box.clientWidth - padX) / chw))),
      rows: Math.max(5, Math.min(200, Math.floor((box.clientHeight - padY) / lh))),
    };
  };

  const post = (path, body) =>
    api(`/instances/${i.id}/console${path}`, { method: 'POST', body: { sid, ...body } });

  /* ---- 输入队列 ----
     一次只放一个请求在路上，飞行期间敲的键攒进下一发。浏览器能同时开好几条连接，
     两个 POST 谁先到服务端并不保证 —— 整行整行发的时候看不出来，一秒十个按键
     就会把命令的字符顺序打乱。顺序由这个队列说了算，长粘贴也顺带切成了片。
     4000 远小于服务端 8192 的上限，只是给分片一个稳定的粒度。 */
  const CHUNK = 4000;
  let pending = '';
  let inflight = false;

  const flush = async () => {
    if (inflight || !pending || !attached) return;
    inflight = true;
    const mySid = sid;
    let cut = Math.min(CHUNK, pending.length);
    // 别把一个代理对劈成两半：拼回去就是一个 U+FFFD 落进容器里
    const cc = pending.charCodeAt(cut - 1);
    if (cut < pending.length && cc >= 0xd800 && cc <= 0xdbff) cut -= 1;
    const piece = pending.slice(0, cut);
    try {
      await post('/input', { data: piece });
      if (sid !== mySid) return; // 中途重连过，这一片属于上一个会话，丢掉
      pending = pending.slice(cut);
      setNote('');
    } catch (err) {
      if (err.status === 404 || err.status === 410) {
        // 会话在服务端没了（闲置回收、容器重启过）。这能自愈，接回去就行，
        // 但攒着的按键属于那个已经死掉的 shell，不能倒进新的里面。
        pending = '';
        attached = false;
        status('会话已失效，正在重新接回…', 'busy');
        retry(0);
      } else if (err.status === 413) {
        pending = '';
        setNote('这段输入太长，没有送出去');
      } else {
        // 请求可能是在服务端已经写进 pty 之后才失败的，自动重发等于把命令跑两遍。
        // 宁可少送一次也不要多送一次：留在队首，下次敲回车自然带出去。
        setNote('网络不稳，这段输入没送出去，再按一次回车重试');
      }
      return;
    } finally {
      inflight = false;
    }
    if (pending) flush();
  };

  const send = (data) => {
    if (!attached || !data) return;
    pending += data;
    // 自己敲的东西一定要看得见，哪怕刚才翻上去看历史了。已经在底部就别再拨一次
    // scrollTop —— 直连模式下这是每个按键都会走的路。
    if (!stuck) {
      term.setStick(true);
      stuck = true;
      jump.hidden = true;
    }
    flush();
  };

  /* ---- 密码提示 ----
     远端把回显关掉了，屏幕上确实不显示密码 —— 但面板的输入框不是 tty，密码会
     明明白白躺在里面直到回车，然后被记进历史。所以看渲染器交出来的最后一行：
     那一行已经去掉了颜色转义、也补齐了被 SSE 切开的半句。宁可误判（代价是这条
     命令不进历史），也不能漏判。 */
  const SECRET_RE = /(password|passphrase|pin|secret|token|密码|口令|密碼)[^:：\n]{0,40}[:：]\s*$/i;
  const SECRET_ENTER = /^\s*Enter (passphrase|PIN)/i;
  const maskable = CSS.supports?.('-webkit-text-security', 'disc');
  const setSecret = (on) => {
    if (on === secret) return;
    secret = on;
    form.classList.toggle('secret', on);
    caret.innerHTML = on ? icon('lock-keyhole') : '❯';
    // 不支持 -webkit-text-security 时才退到 type=password，而且只在框是空的时候切：
    // 切 type 会招来密码管理器，它会提示保存、把口令写进浏览器的凭据库。
    if (!maskable && !input.value) input.type = on ? 'password' : 'text';
    setNote(on ? '检测到密码提示：输入不显示，也不会记进历史' : '');
  };
  const checkSecret = () => {
    const t = term.tail();
    setSecret(SECRET_RE.test(t) || SECRET_ENTER.test(t));
  };

  /* ---- 重连 ----
     SSE 断掉断的只是浏览器到面板这一段，容器里的 shell、它的工作目录、正在跑的
     pip install 都还活着，attach 会原样接回来。所以默认动作是「接回去」而不是
     「重启」—— 以前那句「点重启会话重来」等于教用户亲手杀掉自己还在跑的程序。
     退避 1s → 2s → 4s → 8s，封顶 15s，最多 6 次：一个忘在后台的手机标签页
     无限重连会一直握着 sleeper 的 hold，让容器永远睡不着，那是用户在付钱。 */
  const MAX_RETRY = 6;
  let backoff = 0;
  let retryTimer = null;
  let connecting = false;

  const giveUp = () => {
    status('连接不上，点这里重试', 'err');
    dot.classList.add('clickable');
  };
  const retry = (delay = Math.min(15000, 1000 * 2 ** backoff)) => {
    clearTimeout(retryTimer);
    if (stopped || ended) return;
    if (backoff >= MAX_RETRY) return giveUp();
    backoff += 1;
    if (delay) status(`连接断开，${Math.round(delay / 1000)} 秒后重连…`, 'busy');
    retryTimer = setTimeout(() => connect(false, true), delay);
  };
  timers.push(() => clearTimeout(retryTimer));

  /* ---- MC 日志模式没有会话握手：直接开 SSE。错误也走消息（服务端一律先回
     200），EventSource 拿到 4xx 只会无限重连，那条消息会替它说出来。 */
  const connectMc = () => {
    if (stopped) return;
    es?.close();
    es = null;
    ended = false;
    attached = true;
    backoff = 0;
    setEnabled(false);
    dot.classList.remove('clickable');
    status('连接中…', 'busy');
    const stream = new EventSource(`/api/instances/${i.id}/minecraft/logs/stream`);
    es = stream;
    timers.push(() => stream.close());
    stream.onopen = () => {
      if (stream !== es) return;
      status('已连接', 'ok');
    };
    stream.onmessage = (m) => {
      if (stream !== es) return;
      const d = JSON.parse(m.data);
      if (d.line) term.write(d.line);
      if (d.closed) {
        attached = false;
        ended = true;
        status(d.note || '日志流已结束', 'err');
        dot.classList.add('clickable');
        stream.close();
      }
    };
    stream.onerror = () => {
      if (stream !== es) return;
      if (ended || stopped) {
        stream.close();
        return;
      }
      // 服务端发了 retry: 1000，EventSource 会自己接回去
      status('连接断开，正在重连…', 'busy');
    };
  };

  const connect = async (restart = false, isRetry = false) => {
    if (stopped || connecting) return;
    if (mcLog) return connectMc();
    connecting = true;
    clearTimeout(retryTimer);
    es?.close();
    es = null;
    attached = false;
    ended = false;
    pending = '';
    setEnabled(false);
    dot.classList.remove('clickable');
    status(restart ? '重启会话…' : isRetry ? '重新连接…' : '连接中…', 'busy');
    let session;
    const m = metrics();
    term.setRows(m.rows);
    try {
      ({ session } = await api(`/instances/${i.id}/console`, {
        method: 'POST',
        body: { cols: m.cols, rows: m.rows, restart },
      }));
    } catch (err) {
      // 容器没跑起来之类的 4xx 再试也是同样的结果，说清楚就停手。
      if (err.status >= 400 && err.status < 500) {
        status('未连接', 'err');
        dot.classList.add('clickable');
        term.write(`\r\n\x1b[31m${err.message}\x1b[0m\r\n`);
        return;
      }
      retry();
      return;
    } finally {
      connecting = false;
    }
    if (stopped) return;
    sid = session.sid;
    // 处理器里一律用这个局部引用：重连之后外层的 es 已经指向新的流，
    // 旧流迟到的一个 error 不该去动新流的状态。
    const stream = new EventSource(`/api/instances/${i.id}/console/stream?sid=${encodeURIComponent(sid)}`);
    es = stream;
    timers.push(() => stream.close());
    stream.onmessage = (m) => {
      if (stream !== es) return;
      const d = JSON.parse(m.data);
      if (d.snapshot !== undefined) {
        // 重新接上：服务端那份 scrollback 就是真相，整块替掉屏幕上的内容。
        term.reset(d.snapshot);
        attached = true;
        backoff = 0;
        setEnabled(true);
        status('已连接', 'ok');
        setNote('');
        checkSecret();
        // 悄悄重连时不要抢焦点：手机上那会无端弹起键盘，打断用户正在做的事。
        if (!isRetry) input.focus();
        flush();
        return;
      }
      if (d.out) {
        term.write(d.out);
        checkSecret();
      }
      if (d.closed) {
        attached = false;
        ended = true;
        setEnabled(false);
        setSecret(false);
        // kind 分得清「重启一下就好」和「得先把容器启动起来」。
        status(d.kind === 'stopped' ? '容器已停止' : d.note || '会话已结束', 'err');
        dot.classList.add('clickable');
        stream.close();
      }
    };
    stream.onerror = () => {
      if (stream !== es) return;
      if (ended || stopped) {
        stream.close();
        return;
      }
      attached = false;
      setEnabled(false);
      // EventSource 自己会重连（服务端也发了 retry: 1000），这一类只要等着就行，
      // 别把它关掉再自己建一个。只有连接被判死（服务端返了非 2xx，通常是会话
      // 已经被回收）才需要重新走一次 attach。
      if (stream.readyState === EventSource.CONNECTING) {
        status('连接断开，正在重连…', 'busy');
        return;
      }
      stream.close();
      retry();
    };
  };

  /* 手机切后台、笔记本合盖之后 EventSource 常常已经悄悄死了。回到前台先看一眼。
     只在「已经在重连、且预算没耗尽」时自动试 —— 否则一个搁置几小时的标签页
     切回前台就会静默唤醒一个已经睡下的容器。 */
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (attached || ended || stopped || backoff === 0 || backoff >= MAX_RETRY) return;
    retry(0);
  };
  document.addEventListener('visibilitychange', onVisible);
  timers.push(() => document.removeEventListener('visibilitychange', onVisible));

  dot.onclick = () => {
    if (dot.classList.contains('clickable')) {
      backoff = 0;
      connect(false);
    }
  };

  /* ---- 逐行模式的输入 ---- */
  form.onsubmit = (e) => {
    e.preventDefault();
    if (direct) return;
    const line = input.value;
    remember(line);
    hist = history.length;
    draft = '';
    input.value = '';
    send(`${line}\n`);
  };

  /* ---- 直连键盘 ----
     按键直接变成字节发给 pty，回显由容器自己发回来。于是 Tab 补全、readline 的
     全套快捷键、vim / top 的按键、y/n 提问全部原生可用，密码也再不会经过浏览器
     的任何一个可见控件。代价是每个字符都要走一个来回，网络差的时候打字会发糊，
     而且屏幕阅读器赖以浏览的方向键会被吃掉 —— 所以逐行模式永久保留，默认还是它。
     可打印字符走 beforeinput 而不是 keydown：安卓输入法的 keydown 大量返回
     keyCode 229 / 'Unidentified'，只认 keydown 在那儿基本不工作。 */
  const KEYMAP = {
    Enter: '\r',
    Backspace: '\x7f',
    Tab: '\t',
    Escape: '\x1b',
    ArrowUp: '\x1b[A',
    ArrowDown: '\x1b[B',
    ArrowRight: '\x1b[C',
    ArrowLeft: '\x1b[D',
    Home: '\x1b[H',
    End: '\x1b[F',
    PageUp: '\x1b[5~',
    PageDown: '\x1b[6~',
    Delete: '\x1b[3~',
    Insert: '\x1b[2~',
  };

  input.addEventListener('beforeinput', (e) => {
    if (!direct) return;
    if (e.isComposing) return; // 合成中的候选字交给输入法，别抢
    e.preventDefault();
    const t = e.inputType;
    if (t === 'insertText' && e.data) send(e.data);
    else if (t === 'insertLineBreak' || t === 'insertParagraph') send('\r');
    else if (t === 'deleteContentBackward') send('\x7f');
    else if (t === 'deleteContentForward') send('\x1b[3~');
  });
  input.addEventListener('compositionend', (e) => {
    if (!direct) return;
    if (e.data) send(e.data);
    input.value = '';
  });

  input.onkeydown = (e) => {
    // 输入法合成期间一个键都不能碰，也不能 preventDefault —— 那个键是输入法的。
    if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return;
    if (e.metaKey) return; // macOS 的 Cmd 组合归系统

    if (e.ctrlKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'v' || k === 'x') return; // 让浏览器自己粘贴/剪切
      // 有选区时 Ctrl+C 是复制，没选区才是中断。直连模式下选中的是输出区，
      // 得问 window.getSelection，输入框自己的 selectionStart 不算数。
      const picked = direct ? window.getSelection()?.toString() : input.selectionStart !== input.selectionEnd;
      if (k === 'c' && !picked) {
        e.preventDefault();
        interrupt();
        return;
      }
      if (direct && k >= 'a' && k <= 'z' && k.length === 1) {
        e.preventDefault();
        send(String.fromCharCode(k.charCodeAt(0) - 96));
        return;
      }
      if (!direct) {
        if (k === 'd') return e.preventDefault(), send('\x04');
        if (k === 'l') return e.preventDefault(), term.clear();
        if (k === 'z') return e.preventDefault(), send('\x1a');
      }
    }

    if (direct) {
      // Shift+Tab 不发出去，留作键盘用户离开这个框的出口 —— 否则 Tab 一被吃掉，
      // 光靠键盘就再也走不出控制台了。
      if (e.key === 'Tab' && e.shiftKey) return;
      const seq = KEYMAP[e.key];
      if (seq) {
        e.preventDefault();
        send(seq);
      }
      return; // 可打印字符交给 beforeinput
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (secret || !history.length) return; // 密码态下别把上一条命令拉进已掩码的框里
      if (hist === history.length) draft = input.value;
      hist = Math.max(0, hist - 1);
      input.value = history[hist];
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (secret) return;
      hist = Math.min(history.length, hist + 1);
      input.value = hist === history.length ? draft : history[hist];
      input.setSelectionRange(input.value.length, input.value.length);
    }
  };

  /* 多行粘贴：默认被 <input> 悄悄拼成一行，于是三条命令变成一条谁也看不懂的东西。
     拦下来问一句，顺便让人看清剪贴板里到底是什么。 */
  input.addEventListener('paste', async (e) => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (!text.includes('\n')) return; // 单行就照常粘
    e.preventDefault();
    const choice = await pasteDialog(text);
    if (choice === 'run') {
      // 末尾没有换行的话，最后一行留在输入框里让人再看一眼 —— 这也是终端
      // bracketed paste 的行为。
      const nl = text.lastIndexOf('\n');
      send(text.slice(0, nl + 1));
      input.value = text.slice(nl + 1);
      input.focus();
    } else if (choice === 'join') {
      const merged = text.replace(/\s*\n+\s*/g, ' ').trim();
      const at = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, at) + merged + input.value.slice(input.selectionEnd ?? at);
      input.focus();
      input.setSelectionRange(at + merged.length, at + merged.length);
    }
  });

  const interrupt = () => {
    // 排在队列里还没发出去的东西一起丢掉：粘了 10KB 再点中断，Ctrl+C 不该
    // 排在三个来回后面才到。
    pending = '';
    input.value = '';
    send('\x03');
  };

  /* ---- 按键条 ----
     手机的软键盘上没有 Esc、没有 Ctrl、没有方向键，而 hint 里写着的操作全靠它们。
     逐行模式下只给逃生用的控制字符（Tab 补全在逐行模式下不可能实现，放一个按了
     不动的键是误导）；直连模式下才补上 Tab 和方向键。 */
  // 第二项是要发出去的字节；'clear' 是个例外，逐行模式下它只清本地屏幕，
  // 跟工具栏的「清屏」是同一件事（那个按钮在触摸设备上是收起来的）。
  const KEYBAR = {
    line: [
      ['Esc', '\x1b'],
      ['Ctrl+C', '\x03'],
      ['Ctrl+D', '\x04'],
      ['Ctrl+Z', '\x1a'],
      ['清屏', 'clear'],
    ],
    direct: [
      ['Esc', '\x1b'],
      ['Tab', '\t'],
      ['Ctrl+C', '\x03'],
      ['Ctrl+D', '\x04'],
      ['Ctrl+Z', '\x1a'],
      ['↑', '\x1b[A'],
      ['↓', '\x1b[B'],
      ['←', '\x1b[D'],
      ['→', '\x1b[C'],
      ['清屏', 'clear'],
    ],
  };
  const drawKeys = () => {
    keys.innerHTML = (direct ? KEYBAR.direct : KEYBAR.line)
      .map(([label], n) => `<button type="button" tabindex="-1" data-k="${n}">${esc(label)}</button>`)
      .join('');
    keys.querySelectorAll('[data-k]').forEach((b) => {
      // 按下就把焦点从输入框抢走的话，软键盘会收起来，等于每按一次键条都要
      // 重新点一次输入框。
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => {
        const [, seqRaw] = (direct ? KEYBAR.direct : KEYBAR.line)[Number(b.dataset.k)];
        if (seqRaw === '\x03') interrupt();
        else if (seqRaw !== 'clear') send(seqRaw);
        else if (direct) send('\x0c');
        else term.clear();
      };
    });
  };

  const setMode = (on) => {
    direct = on;
    try {
      localStorage.setItem('lh.term.direct', on ? '1' : '0');
    } catch {
      /* 存不下就只在这一次会话里生效 */
    }
    card.classList.toggle('direct', on);
    document.getElementById('term-mode').classList.toggle('on', on);
    input.placeholder = on ? '按键直接发给容器' : '输入命令后回车';
    input.value = '';
    drawKeys();
    document.getElementById('term-hint').textContent = on
      ? `直连键盘：按键直接发给容器，Tab 补全、vim、top 都能用；Shift+Tab 离开输入框。会话保持在服务端，刷新回来工作目录和还在跑的程序都还在（闲置 ${
          state.cfg?.console?.idleMinutes ?? 30
        } 分钟后回收）。`
      : `↑↓ 翻历史 · Ctrl+C 中断 · Ctrl+D 退出。会话保持在服务端：切换标签页或刷新后回来，工作目录和还在跑的程序都还在（闲置 ${
          state.cfg?.console?.idleMinutes ?? 30
        } 分钟后回收）。要用 vim、top 或 Tab 补全，打开「直连键盘」。`;
    input.focus();
  };

  document.getElementById('term-mode').onclick = () => setMode(!direct);
  document.getElementById('term-int').onclick = () => {
    interrupt();
    input.focus();
  };
  document.getElementById('term-clear').onclick = () => {
    // 直连模式下只清本地会让渲染器和 shell 各自记着一份不一样的屏幕，
    // 交给 shell 自己清。
    if (direct) send('\x0c');
    else term.clear();
    input.focus();
  };
  document.getElementById('term-restart').onclick = async () => {
    const yes = await askDialog({
      title: '重启会话？',
      ok: '重启',
      kind: 'danger',
      hint: '会结束容器里这个 shell —— 正在跑的程序会被一起结束，工作目录也回到初始位置。只是网络断了的话不用重启，面板会自己接回去。',
    });
    if (yes) {
      backoff = 0;
      connect(true);
    }
  };

  jump.onclick = () => {
    term.setStick(true);
    stuck = true;
    jump.hidden = true;
    input.focus();
  };

  document.getElementById('term-copy').onclick = async () => {
    const text = term.text();
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${text.split('\n').length} 行输出`, 'ok');
    } catch {
      toast('复制失败，浏览器不给剪贴板权限', 'err');
    }
  };

  document.getElementById('term-dl').onclick = () => {
    const blob = new Blob([term.text()], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${i.name}-console.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const full = document.getElementById('term-full');
  full.onclick = () => {
    const on = card.classList.toggle('full');
    document.body.classList.toggle('term-full-open', on);
    full.innerHTML = icon(on ? 'minimize' : 'maximize');
    full.title = on ? '退出最大化' : '最大化';
    onResize();
    input.focus();
  };
  timers.push(() => {
    card.classList.remove('full');
    document.body.classList.remove('term-full-open');
  });

  box.addEventListener('scroll', () => {
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (atBottom === stuck) return;
    stuck = atBottom;
    jump.hidden = atBottom;
    term.setStick(atBottom);
  });

  // 点输出区不该把键盘从输入框抢走（除非是在划词复制）。
  box.onclick = () => {
    if (!window.getSelection()?.toString()) input.focus();
  };

  let resizeTimer = null;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const m = metrics();
      term.setRows(m.rows);
      // MC 日志模式没有 pty，谈不上改窗口大小
      if (attached && !mcLog) post('/resize', { cols: m.cols, rows: m.rows }).catch(() => {});
    }, 300);
  };
  window.addEventListener('resize', onResize);
  timers.push(() => {
    window.removeEventListener('resize', onResize);
    clearTimeout(resizeTimer);
  });

  /* 软键盘弹起来时 dvh 不会跟着缩，于是吸底的输入行被键盘埋在下面。
     visualViewport 是唯一知道键盘占了多高的东西；把它写成 --kb，让终端让出
     那一段。iOS 惯性滚动时这个事件很密，所以合并到一帧里、值没变就不写。 */
  const vv = window.visualViewport;
  if (vv) {
    let kb = 0;
    let vvQueued = false;
    const fit = () => {
      vvQueued = false;
      const next = document.activeElement === input ? Math.round(Math.max(0, innerHeight - vv.height - vv.offsetTop)) : 0;
      if (next === kb) return;
      kb = next;
      // 高度一变，「离底部还有多远」的判断也跟着变，不先记下来就会永久失去自动贴底。
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      document.documentElement.style.setProperty('--kb', `${kb}px`);
      requestAnimationFrame(() => {
        if (atBottom) box.scrollTop = box.scrollHeight;
      });
    };
    const onVV = () => {
      if (vvQueued) return;
      vvQueued = true;
      requestAnimationFrame(fit);
    };
    vv.addEventListener('resize', onVV);
    vv.addEventListener('scroll', onVV);
    input.addEventListener('blur', onVV);
    timers.push(() => {
      vv.removeEventListener('resize', onVV);
      vv.removeEventListener('scroll', onVV);
      document.documentElement.style.removeProperty('--kb');
    });
  }

  if (mcLog) mcIn?.focus();
  else setMode(direct);
  connect();
}

/* ---------------- files ----------------
   A file manager for the inside of a container. Listing and mkdir/rm/mv are
   `docker exec` underneath, so this tab wants the container running just like
   the console does; content moves over the same endpoints `docker cp` uses, so
   uploads land without tar or unzip existing in the image (see src/files.js).

   Everything below repaints only the table, never the page: navigating into a
   directory should not cost a full instance fetch. */

/** Small modal in the panel's own dress, instead of prompt()/confirm(). */
function askDialog({ title, label, value = '', ok = '确定', kind = '', hint = '', match = '' }) {
  return new Promise((resolve) => {
    document.getElementById('ask-dlg')?.remove();
    const dlg = document.createElement('dialog');
    dlg.id = 'ask-dlg';
    dlg.innerHTML = `<form method="dialog">
        <h3>${esc(title)}</h3>
        ${label ? `<label class="field"><span>${esc(label)}</span><input name="v" /></label>` : ''}
        ${hint ? `<div class="hint">${hint}</div>` : ''}
        <div class="row" style="justify-content:flex-end;margin-top:18px">
          <button class="ghost" value="">取消</button>
          <button class="${kind || 'primary'}" value="ok">${esc(ok)}</button>
        </div>
      </form>`;
    document.body.append(dlg);
    const input = dlg.querySelector('input');
    if (input) input.value = value;
    const okBtn = dlg.querySelector('button[value="ok"]');
    if (match && input && okBtn) {
      okBtn.disabled = true;
      input.addEventListener('input', () => (okBtn.disabled = input.value !== match));
    }
    // Esc closes with returnValue '' — same as 取消, so both land on null.
    dlg.onclose = () => {
      const answer = dlg.returnValue === 'ok' ? (input ? input.value : true) : null;
      dlg.remove();
      resolve(answer);
    };
    dlg.showModal();
    if (input) {
      input.focus();
      // Select the stem, not the extension: renaming rarely means retyping ".conf".
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : value.length);
    }
  });
}

const FILE_ICON = { d: 'folder', ld: 'folder', o: 'file' };
/** Extensions the editor is offered for; everything else downloads. */
const TEXTISH =
  /\.(txt|log|md|markdown|json|ya?ml|toml|ini|conf|cfg|properties|env|sh|bash|zsh|fish|py|rb|pl|php|lua|js|mjs|cjs|ts|tsx|jsx|css|scss|less|html?|xml|svg|sql|csv|tsv|gitignore|dockerfile|lock)$/i;
const editable = (e) => !e.dir && (TEXTISH.test(e.name) || !e.name.includes('.'));

function filesTabHtml(i) {
  const jumps = [...new Set([...(i.volumePaths || []), '/', '/etc'])];
  return `<div class="card fm">
      <div class="fm-bar">
        <button class="small ghost" id="fm-up" title="上一级目录" aria-label="上一级目录">${icon(
          'corner-left-up'
        )}</button>
        <div class="fm-crumbs" id="fm-crumbs"></div>
        <div class="spacer" style="flex:1"></div>
        <button class="small ghost" id="fm-refresh" title="刷新" aria-label="刷新">${icon('refresh-cw')}</button>
        <!-- The labels are wrapped so a narrow toolbar can drop to icons only
             without losing the accessible name. -->
        <button class="small" id="fm-mkdir" aria-label="新建文件夹">${icon('folder-plus')}<span>新建文件夹</span></button>
        <button class="small" id="fm-touch" aria-label="新建文件">${icon('file-plus')}<span>新建文件</span></button>
      </div>
      ${
        jumps.length
          ? `<div class="fm-jump">
               <span class="sub">${icon('hard-drive')}快速跳转</span>
               ${jumps
                 .map(
                   (p) =>
                     `<button class="chip" data-jump="${esc(p)}">${icon(
                       p === '/' ? 'house' : 'folder'
                     )}${esc(p)}${(i.volumePaths || []).includes(p) ? '<small>数据卷</small>' : ''}</button>`
                 )
                 .join('')}
             </div>`
          : ''
      }
      <div class="table-wrap">
        <table class="fm-table">
          <thead><tr><th>名称</th><th class="num">大小</th><th>修改时间</th><th></th></tr></thead>
          <tbody id="fm-list"><tr><td colspan="4">${loader({ inline: true })}</td></tr></tbody>
        </table>
      </div>
      <div id="fm-drop" class="dropzone small">
        <div class="head">${icon('upload')}${
          canDrag() ? '把文件或文件夹拖到这里，上传到当前目录' : '上传到当前目录'
        }</div>
        <div class="row" style="margin-top:8px">
          <button type="button" class="small" data-pick="file">${icon('file-up')}选择文件</button>
          <button type="button" class="small" data-pick="dir">${icon('folder-up')}选择文件夹</button>
        </div>
      </div>
      <div class="hint" id="fm-note">单次上传上限 ${bytes(
        state.cfg?.files?.uploadMaxBytes ?? 0
      )}、最多 ${state.cfg?.files?.uploadMaxFiles ?? 0} 个文件；超过 ${bytes(
        state.cfg?.files?.editMaxBytes ?? 0
      )} 的文件只能下载，不能在线编辑。写入会保留原文件的权限和归属者。</div>
    </div>`;
}

/**
 * `cwd` is handed in and out so switching to 日志 and back does not lose the
 * directory the user was in.
 */
function wireFiles(i, cwd) {
  const listBox = document.getElementById('fm-list');
  const crumbs = document.getElementById('fm-crumbs');
  const note = document.getElementById('fm-note');
  const noteText = note.innerHTML;
  let dir = cwd.get() ?? (i.volumePaths?.[0] || '/');
  let busy = false;

  const url = (sub, path) => `/instances/${i.id}/files${sub}?path=${encodeURIComponent(path)}`;

  const fail = (err) => {
    listBox.innerHTML = `<tr><td colspan="4"><div class="err">${icon('triangle-alert')}${esc(
      err.message
    )}</div></td></tr>`;
  };

  const drawCrumbs = () => {
    const parts = dir.split('/').filter(Boolean);
    crumbs.innerHTML = [
      `<button data-go="/" title="根目录">${icon('house')}</button>`,
      ...parts.map(
        (p, n) => `<span>/</span><button data-go="${esc(`/${parts.slice(0, n + 1).join('/')}`)}">${esc(p)}</button>`
      ),
    ].join('');
    crumbs.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go)));
    // The trail scrolls on a phone; the end of it — where you are — is the part
    // worth showing when a path is deeper than the row is wide.
    crumbs.scrollLeft = crumbs.scrollWidth;
  };

  const row = (e) => {
    // Icon-only buttons, so each carries an aria-label as well as the tooltip —
    // a title alone is not an accessible name a screen reader will announce, and
    // on a phone there is no hover to reveal it either.
    const label = (what) => `${what}${e.name}`;
    const acts = [
      !e.dir && editable(e)
        ? `<button class="small ghost" data-edit="${esc(e.path)}" title="编辑内容"
             aria-label="${esc(label('编辑 '))}">${icon('file-pen')}</button>`
        : '',
      `<button class="small ghost" data-dl="${esc(e.path)}" title="${e.dir ? '打包下载 .tar' : '下载'}"
         aria-label="${esc(label(e.dir ? '打包下载 ' : '下载 '))}">${icon('download')}</button>`,
      `<button class="small ghost" data-ren="${esc(e.path)}" data-name="${esc(e.name)}" title="重命名"
         aria-label="${esc(label('重命名 '))}">${icon('pencil')}</button>`,
      `<button class="small ghost danger" data-rm="${esc(e.path)}" data-name="${esc(e.name)}" data-dir="${
        e.dir ? 1 : 0
      }" title="删除" aria-label="${esc(label('删除 '))}">${icon('trash-2')}</button>`,
    ].join('');
    return `<tr>
        <td><button class="fm-name${e.dir ? ' dir' : ''}" ${
          e.dir ? `data-cd="${esc(e.path)}"` : `data-open="${esc(e.path)}"`
        }>${icon(FILE_ICON[e.type] ?? (editable(e) ? 'file-text' : 'file'))}<span>${esc(e.name)}</span>${
          e.link ? icon('link-2', { cls: 'muted' }) : ''
        }</button></td>
        <td class="num mono">${e.size == null ? '—' : bytes(e.size)}</td>
        <td class="sub">${e.mtime ? when(e.mtime) : '—'}</td>
        <td class="fm-acts">${acts}</td>
      </tr>`;
  };

  async function go(next, { quiet = false } = {}) {
    if (busy) return;
    busy = true;
    if (!quiet) listBox.innerHTML = `<tr><td colspan="4">${loader({ inline: true })}</td></tr>`;
    try {
      const res = await api(url('', next));
      dir = res.path;
      cwd.set(dir);
      drawCrumbs();
      document.getElementById('fm-up').disabled = res.parent === null;
      listBox.innerHTML =
        res.entries.map(row).join('') ||
        `<tr><td colspan="4"><span class="sub">${icon('inbox')}这个目录是空的</span></td></tr>`;
      note.innerHTML = res.truncated
        ? `<span class="err">${icon('triangle-alert')}这个目录条目太多，只显示了前 ${
            state.cfg?.files?.maxEntries ?? 1000
          } 个。</span>`
        : noteText;
      wireRows();
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
  }

  const reload = () => go(dir, { quiet: true });

  /** Same-origin GET with the session cookie — no token to smuggle into a URL. */
  const download = (path) => {
    const a = document.createElement('a');
    a.href = `/api${url('/download', path)}`;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  };

  /** Fetch, then hand the file to editor.js — this side only does the plumbing. */
  async function openEditor(path) {
    let file;
    try {
      file = await api(url('/content', path));
    } catch (err) {
      return toast(err.message, 'err');
    }
    if (file.binary) {
      toast('这是二进制文件，改不了，已开始下载', '');
      return download(path);
    }
    openTextEditor({
      path: file.path,
      text: file.text,
      size: file.size,
      truncated: file.truncated,
      ask: askDialog,
      toast,
      bytes,
      save: (text) => api(`/instances/${i.id}/files/content`, { method: 'PUT', body: { path, text } }),
      // A write changes the size and mtime the table behind the dialog is
      // showing, but the user is still in the file — repaint the rows quietly.
      onSaved: reload,
    });
  }

  function wireRows() {
    listBox.querySelectorAll('[data-cd]').forEach((b) => (b.onclick = () => go(b.dataset.cd)));
    listBox.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openEditor(b.dataset.open)));
    listBox.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openEditor(b.dataset.edit)));
    listBox.querySelectorAll('[data-dl]').forEach((b) => (b.onclick = () => download(b.dataset.dl)));

    listBox.querySelectorAll('[data-ren]').forEach(
      (b) =>
        (b.onclick = async () => {
          const name = await askDialog({
            title: '重命名',
            label: '新名称',
            value: b.dataset.name,
            ok: '重命名',
          });
          if (name === null || name === b.dataset.name) return;
          try {
            await api(`/instances/${i.id}/files/rename`, {
              method: 'POST',
              body: { path: b.dataset.ren, name },
            });
            reload();
          } catch (err) {
            toast(err.message, 'err');
          }
        })
    );

    listBox.querySelectorAll('[data-rm]').forEach(
      (b) =>
        (b.onclick = async () => {
          const isDir = b.dataset.dir === '1';
          const yes = await askDialog({
            title: `删除${isDir ? '文件夹' : '文件'}`,
            ok: '删除',
            kind: 'danger',
            // The path goes on its own line: inline in the sentence it is the one
            // thing a narrow dialog clips, and this is an irreversible action, so
            // "which file" must never be the part that gets cut off.
            hint: `<div class="mono" style="margin:6px 0;overflow-wrap:anywhere">${esc(b.dataset.rm)}</div>将被删除${
              isDir ? '<b>，及其中所有内容</b>' : ''
            }。容器里的文件删掉就没有了，面板没有回收站。`,
          });
          if (!yes) return;
          try {
            await api(`/instances/${i.id}/files?path=${encodeURIComponent(b.dataset.rm)}`, { method: 'DELETE' });
            toast('已删除', 'ok');
            reload();
          } catch (err) {
            toast(err.message, 'err');
          }
      })
  );
}

  document.getElementById('fm-up').onclick = () => go(`${dir}/..`);
  document.getElementById('fm-refresh').onclick = reload;
  app.querySelectorAll('[data-jump]').forEach((b) => (b.onclick = () => go(b.dataset.jump)));

  document.getElementById('fm-mkdir').onclick = async () => {
    const name = await askDialog({ title: '新建文件夹', label: '文件夹名', ok: '创建' });
    if (!name) return;
    try {
      await api(`/instances/${i.id}/files/mkdir`, { method: 'POST', body: { path: dir, name } });
      reload();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  document.getElementById('fm-touch').onclick = async () => {
    const name = await askDialog({ title: '新建文件', label: '文件名', ok: '创建' });
    if (!name) return;
    try {
      const { path } = await api(`/instances/${i.id}/files/touch`, {
        method: 'POST',
        body: { path: dir, name },
      });
      await go(dir, { quiet: true });
      openEditor(path);
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  // Dotfiles are the whole point of poking around a container, so unlike the
  // static-site drop this keeps them.
  const drop = document.getElementById('fm-drop');
  wireDropzone(
    drop,
    async (list) => {
      if (!list.length) return toast('没有可上传的文件', 'err');
      const max = state.cfg?.files?.uploadMaxBytes ?? Infinity;
      if (totalBytes(list) > max) return toast(`这批文件共 ${bytes(totalBytes(list))}，超过上限`, 'err');
      drop.classList.add('busy');
      try {
        const res = await uploadFiles(`/instances/${i.id}/files/upload`, list, { path: dir });
        toast(`已上传 ${res.count} 个文件到 ${res.path}`, 'ok');
        reload();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        drop.classList.remove('busy');
      }
    },
    { keepHidden: true }
  );

  go(dir);
}

/* ---------------- account ---------------- */
function viewAccount() {
  const q = state.user.quota;
  const ob = state.onboarding;
  shell(
    'account',
    `<div class="page-title"><span class="page-ico">${icon('circle-user')}</span><h1>账号</h1></div>
     <div class="grid cols">
       ${
         ob
           ? `<div class="card">
                ${cat('graduation-cap', '新手指引', { flush: true })}
                <div class="row" style="align-items:center;gap:12px">
                  <span class="meter ob-meter" style="flex:1"><i style="width:${Math.round(
                    (ob.done / ob.total) * 100
                  )}%"></i></span>
                  <span class="sub">${ob.done} / ${ob.total} 完成</span>
                </div>
                <div class="row" style="margin-top:14px">
                  <button class="small" data-ob-open="0">${icon('graduation-cap')}重看一遍向导</button>
                  ${
                    ob.state === 'done' && !ob.allDone
                      ? `<button class="small ghost" data-ob-show>${icon(
                          'list-checks'
                        )}把清单放回页面顶部</button>`
                      : ''
                  }
                </div>
                <div class="hint">向导只讲流程，勾选状态是按你实际建过的实例和站点算的。</div>
              </div>`
           : ''
       }
       <div class="card">
         ${cat('circle-user', '我的账号', { flush: true })}
         <div class="table-wrap"><table>
           <tr><td>${icon('boxes')}最多同时运行实例</td><td>${q.maxInstances}</td></tr>
           <tr><td>${icon('layers')}已创建</td><td>${state.usage?.instances ?? 0}</td></tr>
           <tr><td>${icon('puzzle')}账号级自定义镜像</td><td>${
             q.allowCustomImage
               ? `${icon('circle-check')}已开启`
               : '未开启（可由资源券单独授予）'
           }</td></tr>
         </table></div>
         <div class="hint">${icon(
           'sparkles'
         )}积分实例的内存 / CPU / 端口都能加分往上配（有封顶）；超出封顶的规格，向管理员要一张资源券即可。</div>
       </div>
       <div class="card" id="my-points">
         ${cat('sparkles', '我的积分', { flush: true })}
         <div class="stat"><b>${state.user.points ?? 0}</b><span>当前余额</span></div>
         <div class="hint">发一个静态站点 ${state.cfg?.points?.siteCost ?? 50} 分；开实例 ${
           state.cfg?.points?.instanceCost ?? 100
         } 分起（含 ${state.cfg?.points?.instanceSpec?.cpus ?? 0.1} 核 · ${
           state.cfg?.points?.instanceSpec?.memoryMb ?? 128
         } MB · 1 端口${
           state.cfg?.points?.instanceSpec?.days ? ` · 有效 ${state.cfg.points.instanceSpec.days} 天` : ''
         }），内存、CPU、端口加配另计。删除会退回。</div>
         <form class="row" id="redeem-form" style="margin-top:12px;gap:8px">
           <input name="code" placeholder="有兑换码？粘进来换积分" autocomplete="off" style="flex:1" />
           <button class="small" type="submit">${icon('sparkles')}兑换</button>
         </form>
         <div class="err" id="redeem-err"></div>
         <div id="points-txns" style="margin-top:10px"><div class="sub">${loader({ inline: true })}</div></div>
       </div>
       <div class="card" id="my-vouchers">
         ${cat('ticket', '面板送我的券', { flush: true })}
         <div class="sub">${loader({ inline: true })}</div>
       </div>
       <form class="card" id="pw-form">
         ${cat('key-round', '修改密码', { flush: true })}
         <label class="field"><span>${icon('lock-keyhole')}当前密码</span>
           <input type="password" name="currentPassword" required /></label>
         <label class="field"><span>${icon('key-round')}新密码</span>
           <input type="password" name="newPassword" required minlength="8" /></label>
         <div class="err" data-err></div>
         <button class="primary" type="submit">${icon('save')}保存</button>
       </form>
     </div>`
  );
  // 老券在这里永远找得回来 —— 现在的见面礼是积分，但发出去的券照旧能用。
  api('/auth/vouchers')
    .then(({ vouchers }) => {
      const box = document.getElementById('my-vouchers');
      if (!box) return;
      box.querySelector('.sub').outerHTML = vouchers.length
        ? `<div class="table-wrap"><table class="cards">
             ${vouchers
               .map(
                 (v) => `<tr>
                   <td><code>${esc(v.code)}</code></td>
                   <td class="sub">${v.siteOnly ? `${icon('globe')}仅静态网页 · ` : ''}${v.memoryMb} MB · ${
                     v.cpus
                   } 核${v.diskMb ? ` · 硬盘 ${fmtMb(v.diskMb)}` : ''}</td>
                   <td class="sub">${v.remaining > 0 ? `还能用 ${v.remaining} 次` : '已用完'}</td>
                   <td><button class="small" data-copy="${esc(v.code)}">${icon('copy')}复制</button></td>
                 </tr>`
               )
               .join('')}
           </table></div>
           <div class="hint">${icon('globe')}静态网页券在「静态站点」页面用掉，一个站点按 ${
             state.cfg?.sites?.cpus ?? 0.1
           } 核 · ${state.cfg?.sites?.memoryMb ?? 32} MB 记账。</div>`
        : '<div class="sub">没有可用的券。积分就够开基础实例；要更大规格再向管理员要一张资源券。</div>';
      box.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
    })
    .catch(() => {});

  // 积分流水：每一笔进出都查得到，「这钱花哪了」不用来问管理员。
  const TXN_LABELS = {
    welcome: '注册见面礼',
    redeem: '兑换码',
    'site.create': '发布站点',
    'site.delete': '删除站点退回',
    'site.create_failed': '发布失败退回',
    'instance.create': '创建实例',
    'instance.delete': '删除实例退回',
    'instance.reject': '申请被驳回退回',
    'instance.create_failed': '创建失败退回',
    'admin.adjust': '管理员调整',
  };
  api('/auth/points')
    .then(({ txns }) => {
      const box = document.getElementById('points-txns');
      if (!box) return;
      box.innerHTML = txns.length
        ? `<div class="table-wrap"><table class="cards">
             ${txns
               .map(
                 (t) => `<tr>
                   <td style="color:${t.delta > 0 ? 'var(--success)' : 'var(--danger)'}">${
                     t.delta > 0 ? `+${t.delta}` : t.delta
                   }</td>
                   <td class="sub">${esc(TXN_LABELS[t.reason] || t.reason)}${
                     t.ref ? ` · <span class="mono">${esc(t.ref)}</span>` : ''
                   }</td>
                   <td class="sub">余 ${t.balance}</td>
                   <td class="sub">${when(t.createdAt)}</td>
                 </tr>`
               )
               .join('')}
           </table></div>`
        : '<div class="sub">还没有积分流水。</div>';
    })
    .catch(() => {});

  const redeemForm = document.getElementById('redeem-form');
  redeemForm.onsubmit = async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('redeem-err');
    errEl.textContent = '';
    const code = redeemForm.code.value.trim();
    if (!code) return;
    try {
      const { added, points } = await api('/auth/redeem', { method: 'POST', body: { code } });
      toast(`兑换成功：+${added} 积分，余额 ${points}`, 'ok');
      await syncMe();
      viewAccount(); // 余额和流水都变了，重画最省事
    } catch (err) {
      errEl.textContent = err.message;
    }
  };

  const form = document.getElementById('pw-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const errEl = form.querySelector('[data-err]');
    errEl.textContent = '';
    try {
      await api('/auth/password', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      toast('密码已更新，其它设备已下线', 'ok');
      form.reset();
    } catch (err) {
      errEl.textContent = err.message;
    }
  };
}

/* ---------------- static sites (drag & drop) ---------------- */
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
const junky = (p) => JUNK.test(p) || p.split('/').some((s) => s.startsWith('.')) || p.includes('node_modules/');

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Walks whatever was dropped — a lone .html, a bunch of files, or a folder. */
async function filesFromDrop(dt) {
  const roots = [...dt.items]
    .filter((i) => i.kind === 'file')
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!roots.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));

  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + entry.name });
      return;
    }
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
    }
  };
  for (const r of roots) await walk(r, '');
  return out;
}

const fromInput = (input) => [...input.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));

/**
 * `keepHidden` is for the container file manager: a site drop has no business
 * carrying .git or .DS_Store, but uploading a .env into a container is half the
 * reason someone opens that tab.
 */
function tidy(list, { keepHidden = false } = {}) {
  return list
    .map((x) => ({ ...x, path: x.path.replace(/\\/g, '/').replace(/^\.?\//, '') }))
    .filter((x) => keepHidden ? !JUNK.test(x.path) : !junky(x.path));
}

const totalBytes = (list) => list.reduce((a, x) => a + x.file.size, 0);

/** Common leading folder, so the summary matches what the server will store. */
function withoutRoot(list) {
  if (list.length < 2 && !list[0]?.path.includes('/')) return list;
  const first = list[0].path.split('/')[0];
  if (!list.every((x) => x.path.startsWith(`${first}/`))) return list;
  const stripped = list.map((x) => ({ ...x, path: x.path.slice(first.length + 1) }));
  return stripped.some((x) => !x.path) ? list : withoutRoot(stripped);
}

/** Mirrors pickEntry() on the server: which file will answer "/". */
function entryOf(list) {
  const paths = withoutRoot(list).map((x) => x.path);
  const index = paths.find((p) => /^index\.html?$/i.test(p));
  if (index) return index;
  const roots = paths.filter((p) => !p.includes('/') && /\.html?$/i.test(p));
  if (roots.length === 1) return roots[0];
  const any = paths.filter((p) => /\.html?$/i.test(p));
  if (!roots.length && any.length === 1) return any[0];
  return null;
}

/** Turns a box into a drop target that also opens a picker when clicked. */
function wireDropzone(el, onFiles, opts = {}) {
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  el.addEventListener('dragover', (e) => {
    stop(e);
    el.classList.add('over');
  });
  el.addEventListener('dragleave', (e) => {
    stop(e);
    el.classList.remove('over');
  });
  el.addEventListener('drop', async (e) => {
    stop(e);
    el.classList.remove('over');
    try {
      onFiles(tidy(await filesFromDrop(e.dataTransfer), opts));
    } catch (err) {
      toast(`读取文件失败：${err.message}`, 'err');
    }
  });
  el.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      pickFiles(btn.dataset.pick === 'dir', onFiles, opts);
    };
  });
  el.onclick = () => pickFiles(false, onFiles, opts);
}

/** One reusable pair of hidden inputs — file picker and folder picker. */
function pickFiles(directory, onFiles, opts = {}) {
  const id = directory ? 'pick-dir' : 'pick-file';
  let input = document.getElementById(id);
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.id = id;
    input.multiple = true;
    input.style.display = 'none';
    if (directory) input.webkitdirectory = true;
    document.body.append(input);
  }
  input.value = '';
  input.onchange = () => onFiles(tidy(fromInput(input), opts));
  input.click();
}

async function uploadFiles(path, list, extra = {}) {
  const files = [];
  for (const x of list) files.push({ path: x.path, base64: await fileToBase64(x.file) });
  return api(path, { method: 'POST', body: { ...extra, files } });
}

/** True where dragging a file is not a thing the user can do — a phone. */
const canDrag = () => !matchMedia('(hover: none) and (pointer: coarse)').matches;

function dropzoneHtml(id, { small = false } = {}) {
  // On a touch device the headline cannot be "drag it here": there is nothing to
  // drag with, and the two buttons underneath are the only way in — so they get
  // to be the message instead of the fallback.
  return `<div class="dropzone ${small ? 'small' : ''}" id="${id}">
      <div class="big">${icon('upload')}</div>
      <div class="head">${canDrag() ? '把 index.html 或整个网页文件夹拖到这里' : '选择要发布的网页文件'}</div>
      <div>${canDrag() ? '也可以点一下选择文件' : '整个文件夹选进来也可以，首页要叫 index.html'}</div>
      <div class="row" style="margin-top:8px">
        <button type="button" class="${canDrag() ? 'small' : 'primary small'}" data-pick="file">${icon(
          'file-up'
        )}选择文件</button>
        <button type="button" class="small" data-pick="dir">${icon('folder-up')}选择文件夹</button>
      </div>
    </div>`;
}

function siteCard(s) {
  return `<div class="card inst" data-site="${esc(s.id)}">
      <div class="head">
        <div style="flex:1;min-width:0">
          <div class="name">${esc(s.slug)}</div>
          <div class="img mono">${esc(s.entry)}</div>
        </div>
        <span class="badge running">${icon('circle-check')}已上线</span>
      </div>
      <div class="row">
        <a class="addr" href="${esc(s.path)}" target="_blank" rel="noopener noreferrer">${icon('globe')}${esc(
          s.address
        )}<small>点击打开</small>${icon('external-link', { cls: 'trail' })}</a>
      </div>
      <div class="kv">
        <span>${icon('files')}${s.fileCount} 个文件</span>
        <span>${icon('hard-drive')}${bytes(s.sizeBytes)}</span>
        <span>${icon('cpu')}${s.cpus} 核 · ${s.memoryMb} MB</span>
        <span>${icon('eye')}访问 ${s.hits} 次</span>
        <span>${icon('calendar')}更新于 ${when(s.updatedAt)}</span>
      </div>
      <div class="row" style="margin-top:auto">
        <button class="small" data-copysite="${esc(s.address)}">${icon('copy')}复制地址</button>
        <button class="small" data-redeploy="${esc(s.id)}" data-slug="${esc(s.slug)}">${icon(
          'upload'
        )}重新部署</button>
        <button class="small" data-rename="${esc(s.id)}" data-slug="${esc(s.slug)}">${icon(
          'pencil'
        )}改名</button>
        <button class="small danger" data-delsite="${esc(s.id)}" data-slug="${esc(s.slug)}">${icon(
          'trash-2'
        )}删除</button>
      </div>
      <div data-redeploy-slot="${esc(s.id)}"></div>
    </div>`;
}

async function viewSites() {
  shell('sites', loader());
  let staged = null; // files waiting to be published

  const paint = async () => {
    const [{ sites, limits }, { vouchers }] = await Promise.all([
      api('/sites'),
      api('/auth/vouchers').catch(() => ({ vouchers: [] })),
      syncMe(),
    ]);
    const siteCost = state.cfg?.points?.siteCost ?? 50;
    const bal = state.user.points ?? 0;
    // 老券仍然能直接用：手里有没用完的券就替人填上（不白花积分），没有就走积分。
    const mine = vouchers
      .filter((v) => v.remaining > 0 && (!v.expiresAt || new Date(v.expiresAt) > new Date()))
      .sort((a, b) => Number(b.siteOnly) - Number(a.siteOnly));
    const summary = staged
      ? `<div class="card" style="margin-top:14px">
           ${cat('inbox', `待发布：${staged.length} 个文件 · ${bytes(totalBytes(staged))}`, {
             flush: true,
           })}
           <div class="filelist">${withoutRoot(staged)
             .map((f) => `<div><span class="mono">${esc(f.path)}</span><span class="sub">${bytes(f.file.size)}</span></div>`)
             .join('')}</div>
           ${
             entryOf(staged)
               ? `<div class="hint">${icon('file-code')}首页是 <code class="mono">${esc(
                   entryOf(staged)
                 )}</code></div>`
               : `<div class="err" style="margin-top:10px">${icon(
                   'triangle-alert'
                 )}分不清哪个是首页，请把它命名为 index.html 再拖一次。</div>`
           }
         </div>`
      : '';

    shell(
      'sites',
      `<div class="page-title"><span class="page-ico">${icon('globe')}</span><h1>静态站点</h1>
         <span class="sub">拖个 HTML 进来就上线，不用容器、不用端口</span>
         <div class="spacer" style="flex:1"></div>
         <span class="sub">${icon('files')}${sites.length} / ${limits.maxSites}</span></div>

       <div class="card">
         ${dropzoneHtml('dz')}
         ${summary}
         <form id="site-form" style="margin-top:16px">
           <div class="two">
             <label class="field"><span>${icon('globe')}站点名 *</span>
               <input name="slug" required autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="my-page" pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" />
               <div class="hint">决定访问地址：<code class="mono">/s/站点名/</code>，3-40 位小写字母、数字、连字符</div></label>
             ${
               limits.requireInvite
                 ? `<label class="field"><span>${icon('ticket')}资源券（可选）</span>
                      <input name="inviteCode" value="${esc(mine[0]?.code ?? '')}"
                        placeholder="留空则花 ${siteCost} 积分发布" autocomplete="off" />
                      <div class="hint">${
                        mine.length
                          ? `${icon('sparkles')}已经替你填上${
                              mine[0].siteOnly ? '静态网页券' : '你手上的券'
                            }，还能用 ${mine[0].remaining} 次；清空则改花 ${siteCost} 积分`
                          : `发布花 ${siteCost} 积分（你现在有 ${bal} 分），删除退回；手里有券也可以填券`
                      }</div>
                      ${
                        mine.length > 1
                          ? `<div class="row" style="flex-wrap:wrap;gap:6px;margin-top:6px">${mine
                              .map(
                                (v) =>
                                  `<button type="button" class="small" data-usevoucher="${esc(v.code)}">${icon(
                                    'ticket'
                                  )}${esc(v.code)}${v.siteOnly ? ' · 仅网页' : ''} ×${v.remaining}</button>`
                              )
                              .join('')}</div>`
                          : ''
                      }</label>`
                 : '<div></div>'
             }
           </div>
           <div class="err" data-err></div>
           <button class="primary" type="submit" ${staged ? '' : 'disabled'}>${icon('rocket')}发布${
             staged ? `（${staged.length} 个文件）` : '（先拖文件进来）'
           }</button>
           <div class="hint">${icon('info')}上限 ${limits.maxFiles} 个文件 / ${bytes(
             limits.maxBytes
           )}；一个站点只按 ${limits.cpus} 核 · ${limits.memoryMb} MB 记账，不管是积分还是券发的。
             站点由面板直接提供，只要面板能被访问，它就能被访问。</div>
         </form>
       </div>

       ${cat('globe', '我的站点')}
       ${
         sites.length
           ? `<div class="grid cols">${sites.map(siteCard).join('')}</div>`
           : `<div class="card empty"><div class="big">${icon(
               'globe'
             )}</div>还没有发布过站点。把一个 HTML 文件拖到上面的框里试试。</div>`
       }`
    );

    wireDropzone(document.getElementById('dz'), (list) => {
      if (!list.length) return toast('没有可用的文件（隐藏文件和 node_modules 会被忽略）', 'err');
      staged = list;
      const form = document.getElementById('site-form');
      // A dropped folder names the site; a lone index.html tells us nothing.
      const dropped = list[0].path.includes('/') ? list[0].path.split('/')[0] : list[0].path.replace(/\.html?$/i, '');
      const guess = dropped
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      if (form && !form.slug.value && guess.length >= 3 && guess !== 'index') form.slug.value = guess;
      const keep = form ? Object.fromEntries(new FormData(form)) : null;
      paint().then(() => {
        const f = document.getElementById('site-form');
        if (f && keep) for (const [k, v] of Object.entries(keep)) if (f[k]) f[k].value = v;
      });
    });

    const form = document.getElementById('site-form');
    app
      .querySelectorAll('[data-usevoucher]')
      .forEach((b) => (b.onclick = () => (form.inviteCode.value = b.dataset.usevoucher)));

    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!staged) return;
      const btn = form.querySelector('button[type=submit]');
      const errEl = form.querySelector('[data-err]');
      btn.disabled = true;
      errEl.textContent = '';
      btn.innerHTML = `${icon('upload')}上传中…`;
      try {
        const { site } = await uploadFiles('/sites', staged, {
          slug: form.slug.value.trim().toLowerCase(),
          inviteCode: form.inviteCode?.value.trim(),
        });
        staged = null;
        toast(`已发布：${site.address}`, 'ok');
        await paint();
      } catch (err) {
        errEl.textContent = err.message;
        btn.disabled = false;
        btn.innerHTML = `${icon('rocket')}发布`;
      }
    };

    wireSiteActions(paint);
  };

  await paint().catch((e) => toast(e.message, 'err'));
}

function wireSiteActions(refresh) {
  app.querySelectorAll('[data-copysite]').forEach((b) => (b.onclick = () => copy(b.dataset.copysite)));

  app.querySelectorAll('[data-redeploy]').forEach(
    (b) =>
      (b.onclick = () => {
        const slot = app.querySelector(`[data-redeploy-slot="${b.dataset.redeploy}"]`);
        if (slot.firstChild) return slot.replaceChildren();
        slot.innerHTML = `<div style="margin-top:12px">${dropzoneHtml(`dz-${b.dataset.redeploy}`, {
          small: true,
        })}</div>`;
        // On a phone the box opens below the fold of a tall card, so the button
        // appears to do nothing at all. Bring it to where the tap happened.
        slot.scrollIntoView({ block: 'center', behavior: 'smooth' });
        wireDropzone(document.getElementById(`dz-${b.dataset.redeploy}`), async (list) => {
          if (!list.length) return toast('没有可用的文件', 'err');
          const box = document.getElementById(`dz-${b.dataset.redeploy}`);
          box.classList.add('loaded');
          box.innerHTML = `<div class="big">${icon('upload')}</div><div class="head">上传中…</div>`;
          try {
            await uploadFiles(`/sites/${b.dataset.redeploy}/files`, list);
            toast(`${b.dataset.slug} 已更新（${list.length} 个文件）`, 'ok');
            await refresh();
          } catch (err) {
            toast(err.message, 'err');
            await refresh();
          }
        });
      })
  );

  app.querySelectorAll('[data-rename]').forEach(
    (b) =>
      (b.onclick = async () => {
        const slug = prompt('新的站点名（会改变访问地址）：', b.dataset.slug);
        if (!slug || slug === b.dataset.slug) return;
        try {
          await api(`/sites/${b.dataset.rename}`, { method: 'PATCH', body: { slug } });
          toast('已改名', 'ok');
          await refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      })
  );

  app.querySelectorAll('[data-delsite]').forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm(`删除站点「${b.dataset.slug}」？文件会被清除，地址立刻失效。`)) return;
        try {
          const r = await api(`/sites/${b.dataset.delsite}`, { method: 'DELETE' });
          toast(
            r.refundedPoints
              ? `已删除，${r.refundedPoints} 积分已退回`
              : r.refundedInvite
                ? `已删除，资源券 ${r.refundedInvite} 的次数已退回`
                : '已删除',
            'ok'
          );
          await refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      })
  );
}

/* ---------------- admin ---------------- */
function pendingCard(i) {
  const envRows = Object.entries(i.env)
    .map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="mono" style="word-break:break-all">${esc(v)}</td></tr>`)
    .join('');
  const portRows = i.ports.length
    ? i.ports
        .map(
          (p) => `<tr>
            <td class="mono"><b>${p.host}</b></td>
            <td class="sub">${esc(p.label)} · 容器 ${p.container}/${p.protocol}</td>
            <td><input class="mono" data-port="${p.host}" placeholder="${esc(p.address)}" value="" /></td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="3" class="sub">这个实例不需要对外端口</td></tr>';

  return `<div class="card" data-pcard="${esc(i.id)}" style="margin-bottom:16px">
    <div class="row" style="align-items:flex-start">
      <div style="flex:1;min-width:0">
        <div class="name" style="font-size:16px;font-weight:650">${esc(i.name)}
          <span class="sub" style="font-weight:400">by ${esc(i.owner)}</span></div>
        <div class="img mono sub">${esc(i.image)}</div>
      </div>
      ${badge('pending')}
    </div>
    <div class="kv" style="margin:10px 0">
      <span>${icon('memory-stick')}内存 ${i.memoryMb} MB</span><span>${icon('cpu')}CPU ${i.cpus}</span>
      <span>${icon('hard-drive')}数据卷 <code>${esc(i.volumeName || '无')}</code></span>
      <span>${icon('ticket')}${
        i.inviteCode
          ? `资源券 <code>${esc(i.inviteCode)}</code>`
          : `积分支付 <code>${i.paidPoints ?? 0} 分</code>`
      }</span>
      <span>${icon('calendar')}申请于 ${when(i.createdAt)}</span>
    </div>
    ${i.note ? `<div class="hint">${icon('scroll-text')}用户备注：${esc(i.note)}</div>` : ''}
    ${cat('plug', '要转发的主机端口 → 用户看到的地址')}
    <div class="table-wrap"><table class="cards">
      <tr><th style="width:90px">主机端口</th><th>用途</th><th>对外地址（留空用默认）</th></tr>
      ${portRows}
    </table></div>
    ${
      envRows
        ? `${cat('settings', '环境变量')}<div class="table-wrap"><table class="cards">${envRows}</table></div>`
        : ''
    }
    <div class="row" style="margin-top:16px">
      <button class="primary" data-approve="${esc(i.id)}">${icon('check-check')}配好了，放行创建</button>
      <button class="danger" data-reject="${esc(i.id)}" data-name="${esc(i.name)}">${icon('ban')}驳回</button>
    </div>
    ${
      state.cfg?.cfTunnel
        ? `<label class="row" style="gap:8px;margin-top:12px;align-items:flex-start">
             <input type="checkbox" id="autotunnel-${esc(i.id)}" style="width:auto;margin-top:3px" ${
             i.ports.every((p) => p.protocol === 'udp') ? 'disabled' : ''
           } />
             <span>${icon('cloud')}自动创建 Cloudflare Tunnel —— 不手动配穿透，自动分配
               <code>https://&lt;实例名&gt;.${esc(state.cfg.cfTunnel.domain)}</code> 并填好地址
               ${i.ports.some((p) => p.protocol === 'udp') ? '（UDP 端口无法走隧道）' : ''}</span>
           </label>`
        : ''
    }
  </div>`;
}

async function viewAdmin() {
  shell('admin', loader());
  let tab = location.hash.split('/')[2] || 'pending';
  // How many audit rows the 操作日志 tab is currently showing; null = the default
  // for this screen size. Lives out here so 再看 40 条 survives the repaint.
  let auditShown = null;
  // 后台标签页切换也走异步 paint：连点两个标签时，慢的那个晚到会盖住新的。
  // 每个 paint 领一个序号，画之前对不上号就放弃。
  let paintSeq = 0;

  const paint = async () => {
    const seq = ++paintSeq;
    let body = loader();
    await syncMe();
    if (tab === 'pending') {
      const { pending, hint } = await api('/admin/pending');
      state.pendingCount = pending.length;
      body = pending.length
        ? `<div class="hint" style="margin-bottom:14px">
             ${icon('info')}穿透客户端应指向 <code>${esc(hint.bindAddress)}:&lt;主机端口&gt;</code>，
             端口池 <code>${esc(hint.portPool)}</code>。
             把下面列出的主机端口转发出去之后，填上用户实际要访问的地址再放行；留空则显示
             <code>${esc(hint.publicHost || 'localhost')}:主机端口</code>。
             ${
               hint.cfTunnel
                 ? `也可以勾选每张卡片上的「自动创建 Cloudflare Tunnel」：面板自动建隧道、分配
                   <code>https://&lt;实例名&gt;.${esc(hint.cfTunnel.domain)}</code> 域名并填好地址，什么都不用配。`
                 : ''
             }
           </div>` +
          pending.map(pendingCard).join('')
        : `<div class="card empty"><div class="big">${icon(
            'inbox'
          )}</div>没有待审批的申请。</div>`;
    } else if (tab === 'overview') {
      const o = await api('/admin/overview');
      const d = o.docker?.error;
      const idle = [o.sleeping ? `${o.sleeping} 个休眠中` : '', o.archived ? `${o.archived} 个已封存` : '']
        .filter(Boolean)
        .join('，');
      body = `<div class="grid cols">
        <div class="card"><div class="stat"><b>${o.users}</b><span>${icon('users')}用户</span></div></div>
        <div class="card"><div class="stat"><b>${o.instances}</b><span>${icon('boxes')}实例${
          idle ? `（${idle}）` : ''
        }</span></div></div>
        <div class="card"><div class="stat"><b>${o.sites ?? 0}</b><span>${icon(
          'globe'
        )}静态站点 · ${bytes(o.sitesBytes ?? 0)}</span></div></div>
        <div class="card"><div class="stat"><b>${o.ports.used} / ${o.ports.total}</b>
          <span>${icon('plug')}端口占用 (${o.ports.start}-${o.ports.end})</span></div>
          <div class="meter" style="margin-top:8px"><i style="width:${(o.ports.used / o.ports.total) * 100}%"></i></div></div>
        <div class="card"><div class="stat"><b style="color:${d ? 'var(--danger)' : 'var(--success)'}">${
        d ? '未连接' : o.docker.Version
      }</b><span>${icon('container')}Docker ${
        d ? esc(d) : `${o.docker.Os}/${o.docker.Arch}`
      }</span></div></div>
        ${
          o.disk
            ? `<div class="card"><div class="stat"><b>${bytes(o.disk.images)}</b>
                 <span>${icon('layers')}镜像占用</span></div></div>
               <div class="card"><div class="stat"><b>${bytes(o.disk.volumes)}</b>
                 <span>${icon('hard-drive')}数据卷占用</span></div></div>`
            : ''
        }
      </div>
      <div class="card" style="margin-top:16px">
        ${cat('sparkles', '品牌设置', { flush: true })}
        <div class="row" style="align-items:flex-end;gap:10px;flex-wrap:wrap">
          <label class="field" style="flex:1;min-width:220px;margin:0"><span>${icon('globe')}面板名称</span>
            <input id="panel-name" value="${esc(state.cfg?.panelName || 'localhosting')}" maxlength="40" />
            <div class="hint">显示在登录页、顶栏和浏览器标签上；改完立即生效，不用重启</div></label>
          <label class="field" style="margin:0"><span>${icon('settings')}主题色</span>
            <span class="row" style="gap:10px;padding-top:2px">
              <input type="color" id="panel-color" value="${esc(state.cfg?.panelColor || '#006fee')}"
                style="width:52px;height:38px;padding:2px;background:var(--default-100);border-radius:var(--radius-sm)" />
              <span class="sub mono" id="panel-color-hex">${esc((state.cfg?.panelColor || '#006fee').toLowerCase())}</span>
            </span>
            <div class="hint">logo 和整套强调色都由它派生</div></label>
          <button class="primary" id="panel-name-save">${icon('save')}保存</button>
        </div>
        <div class="err" id="panel-name-err"></div>
      </div>
      <div class="card" style="margin-top:16px">
        ${cat('shield', '验证码严格程度', { flush: true })}
        <label class="field" style="margin:0;max-width:460px"><span>${icon('key-round')}登录 / 注册 / 签到时的验证强度</span>
          <select id="captcha-mode">
            <option value="normal" ${state.cfg?.captchaMode === 'strict' ? '' : 'selected'}>普通 —— 行为检测，拿不准时才出图片验证码</option>
            <option value="strict" ${state.cfg?.captchaMode === 'strict' ? 'selected' : ''}>严格 —— 每次都要求完成图片验证码</option>
          </select>
          <div class="hint">严格模式更防脚本和批量注册，但每次验证都要把图片转正，体验稍重。改完立即生效，不用重启。</div>
        </label>
        <div class="row" style="margin-top:10px;align-items:center;gap:10px">
          <button class="primary" id="captcha-mode-save">${icon('save')}保存</button>
          <div class="err" id="captcha-mode-err"></div>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        ${cat('settings', '对外访问配置', { flush: true })}
        <div class="table-wrap"><table>
          <tr><td>${icon('globe')}PUBLIC_HOST</td><td class="mono">${esc(
            o.config.publicHost || '(未设置 → 显示 localhost)'
          )}</td></tr>
          <tr><td>${icon('network')}Docker 绑定地址</td><td class="mono">${esc(o.config.bindAddress)}</td></tr>
          <tr><td>${icon('plug')}端口偏移</td><td class="mono">${o.config.publicPortOffset}</td></tr>
          <tr><td>${icon('network')}容器网络</td><td class="mono">${esc(o.config.network)}</td></tr>
          <tr><td>${icon('file-code')}静态站点</td><td class="mono">${
            o.config.sitesEnabled ? '已开启 → /s/&lt;站点名&gt;/' : '未开启'
          }</td></tr>
          <tr><td>${icon('moon')}闲时休眠默认时长</td><td class="mono">${esc(o.config.idleSleep)}</td></tr>
        </table></div>
        <div class="hint">${icon('info')}改这些值请编辑 .env 后重启面板。内网穿透只需把 ${o.ports.start}-${
          o.ports.end
        } 整段端口转发出去。</div>
      </div>`;
    } else if (tab === 'users') {
      const { users } = await api('/admin/users');
      body = `<div class="card table-wrap"><table class="cards">
        <tr><th>用户</th><th>角色</th><th>积分</th><th>当前用量</th><th>实例数上限</th><th>自定义镜像</th><th>最后登录</th><th></th></tr>
        ${users
          .map(
            (u) => `<tr>
          <td><b>${esc(u.username)}</b>${
            u.disabled ? ` <span class="badge error">${icon('ban')}已停用</span>` : ''
          }</td>
          <td>${
            u.role === 'admin' ? `${icon('shield')}管理员` : `${icon('user')}用户`
          }</td>
          <td class="sub">${u.points ?? 0}</td>
          <td class="sub">${u.usage.instances} 实例 · ${u.usage.memoryMb}MB · ${u.usage.cpus} 核 · ${u.usage.ports} 端口</td>
          <td class="sub">${u.quota.maxInstances}</td>
          <td>${u.quota.allowCustomImage ? icon('circle-check', { cls: 'ok' }) : '—'}</td>
          <td class="sub">${when(u.lastLoginAt)}</td>
          <td class="row"><button class="small" data-edit="${u.id}">${icon('pencil')}编辑</button>
            ${
              u.id === state.user.id
                ? ''
                : `<button class="small danger" data-deluser="${u.id}" data-name="${esc(
                    u.username
                  )}">${icon('trash-2')}删除</button>`
            }</td>
        </tr>`
          )
          .join('')}
      </table></div>
      <dialog id="user-dlg"></dialog>`;
    } else if (tab === 'invites') {
      const { invites } = await api('/admin/invites');
      const row = (i) => `<tr>
            <td><code>${esc(i.code)}</code></td>
            ${
              i.type === 'instance'
                ? `<td class="sub">${
                    i.scope === 'site' ? `${icon('globe')}仅静态网页 · ` : ''
                  }${i.memory_mb} MB · ${i.cpus} 核 · ${i.ports} 端口${
                    i.disk_mb ? ` · 硬盘 ${fmtMb(i.disk_mb)}` : ''
                  }${i.allow_custom_image ? ' · 自定义镜像' : ''}${i.issued_to ? ' · 注册赠送' : ''}</td>`
                : i.type === 'points'
                  ? `<td class="sub">${icon('sparkles')}每次兑换 ${i.points} 积分</td>`
                  : '<td class="sub">开通一个账号</td>'
            }
            <td>${i.uses} / ${i.max_uses}</td>
            <td class="sub">${
              i.type === 'instance'
                ? i.instance_days
                  ? `${icon('hourglass')}${i.instance_days} 天`
                  : '永久'
                : '—'
            }</td>
            <td class="sub">${i.expires_at ? when(i.expires_at) : '永久'}</td>
            <td class="sub">${esc(i.note)}</td>
            <td class="row"><button class="small" data-copy="${esc(i.code)}">${icon('copy')}复制</button>
              <button class="small danger" data-delinv="${esc(i.code)}">${icon('trash-2')}删除</button></td>
          </tr>`;
      // 「实例有效期」和「券过期」是两件事：前者管建出来的机器能活多久，
      // 后者管这张券本身什么时候作废。表里分成两列，免得看成一个。
      const table = (list, emptyText) => `<div class="card table-wrap"><table class="cards">
          <tr><th>邀请码</th><th>额度</th><th>使用</th><th>实例有效期</th><th>券过期</th><th>备注</th><th></th></tr>
          ${list.map(row).join('') || `<tr><td colspan="7" class="sub">${emptyText}</td></tr>`}
        </table></div>`;

      body = `<form class="card" id="inv-form">
          ${cat('ticket', '生成邀请码', { flush: true })}
          <label class="field"><span>${icon('layers')}类型</span>
            <select name="type" id="inv-type">
              <option value="points">积分兑换码 —— 用户在「账号」页兑成积分</option>
              <option value="instance">实例资源券 —— 用户凭它创建一个定制规格的实例</option>
              <option value="register">注册邀请码 —— 用户凭它开通账号</option>
            </select></label>
          <label class="field" id="inv-points"><span>${icon('sparkles')}每次兑换的积分</span>
            <input name="points" type="number" min="1" max="1000000" value="${
              state.cfg?.points?.instanceCost ?? 100
            }" />
            <div class="hint">参考：发一个站点 ${state.cfg?.points?.siteCost ?? 50} 分，开一台基础实例 ${
              state.cfg?.points?.instanceCost ?? 100
            } 分。一个码可设多次数，但每人只能兑一次。</div></label>
          <div id="inv-res">
            <label class="field"><span>${icon('layers')}用途</span>
              <select name="scope" id="inv-scope">
                <option value="any">建实例 / 发静态网页都行</option>
                <option value="site">只能发静态网页 —— 不占端口，按 ${
                  state.cfg?.sites?.cpus ?? 0.1
                } 核 · ${state.cfg?.sites?.memoryMb ?? 32} MB 记账</option>
              </select>
              <div class="hint" id="inv-scope-hint">新用户注册直接送积分；资源券现在是给需要定制规格的人额外发的。</div></label>
            <div class="two">
              <label class="field"><span>${icon('memory-stick')}内存 (MB)</span>
                <input name="memoryMb" type="number" min="64" step="64" value="${
                  state.cfg?.voucherDefaults?.memoryMb ?? 1024
                }" /></label>
              <label class="field"><span>${icon('cpu')}CPU 核数</span>
                <input name="cpus" type="number" min="0.1" step="0.1" value="${
                  state.cfg?.voucherDefaults?.cpus ?? 1
                }" /></label>
            </div>
            <div class="two" id="inv-ports">
              <label class="field"><span>${icon('plug')}对外端口数</span>
                <input name="ports" type="number" min="0" max="32" value="${
                  state.cfg?.voucherDefaults?.ports ?? 2
                }" />
                <div class="hint">模板需要几个端口，券就至少要给几个</div></label>
              <label class="field"><span>&nbsp;</span>
                <label class="row" style="gap:6px;padding-top:9px"><input type="checkbox" name="allowCustomImage" style="width:auto" /> ${icon(
                  'puzzle'
                )}允许用自定义镜像</label></label>
            </div>
            <label class="field" id="inv-disk"><span>${icon('hard-drive')}硬盘 (MB)</span>
              <input name="diskMb" type="number" min="128" step="128" placeholder="留空 = ${
                state.cfg.disk?.quotaMb ?? 2048
              }MB（跟随全局默认）" />
              <div class="hint">用这张券建出来的实例，数据卷最多占这么多（128MB - 1TB）。只对建实例有效。</div></label>
            <label class="field" id="inv-life"><span>${icon('hourglass')}实例有效天数（0 = 永久）</span>
              <input name="instanceDays" type="number" min="0" max="3650" value="${
                state.cfg?.voucherDefaults?.instanceDays ?? 0
              }" />
              <div class="hint">用这张券建出来的实例能活多久，从放行创建那一刻算起。到期后自动封存：
                容器停掉、端口收回，数据卷留 ${state.cfg?.life?.archiveRetentionDays || 7} 天供下载或积分续期，超期后彻底删除。</div></label>
          </div>
          <div class="two">
            <label class="field"><span>${icon('list-checks')}可用次数</span>
              <input name="maxUses" type="number" value="1" min="1" />
              <div class="hint">资源券一次开一个实例；兑换码一次给一份积分（每人限兑一次）</div></label>
            <label class="field"><span>${icon('clock')}券本身多少天后作废（留空永久）</span>
              <input name="expiresInDays" type="number" min="1" />
              <div class="hint">过了这个期限这张码就没法再用；已经用它建出来的东西不受影响</div></label>
          </div>
          <label class="field"><span>${icon('scroll-text')}备注</span>
            <input name="note" placeholder="给谁用的" /></label>
          <button class="primary" type="submit">${icon('ticket')}生成</button>
        </form>
        ${cat('sparkles', '积分兑换码')}
        ${table(invites.filter((i) => i.type === 'points'), '还没有积分兑换码')}
        ${cat('ticket', '实例资源券')}
        ${table(invites.filter((i) => i.type === 'instance'), '还没有资源券')}
        ${cat('user-plus', '注册邀请码')}
        ${table(invites.filter((i) => i.type !== 'instance' && i.type !== 'points'), '还没有注册邀请码')}`;
    } else if (tab === 'bundles') {
      const { bundles } = await api('/admin/bundles');
      const fmt = (mb) => (mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`);
      body = `
        <form class="card" id="bundle-form">
          ${cat('layers', '积分套餐', { flush: true })}
          <div class="hint" style="margin-bottom:12px">套餐是「内存 + CPU + 硬盘」的打包价：用户在支付页选到这些规格时按打包价付（比逐档加配便宜），端口费另算。改完立即生效，新建实例按新价结算。</div>
          <div class="two">
            <label class="field"><span>名称</span>
              <input name="name" placeholder="如：2c2g 旗舰" /></label>
            <label class="field"><span>${icon('sparkles')}价格（积分）</span>
              <input name="cost" type="number" min="0" step="1" required /></label>
          </div>
          <div class="two">
            <label class="field"><span>${icon('memory-stick')}内存 (MB)</span>
              <input name="memoryMb" type="number" min="64" step="64" required /></label>
            <label class="field"><span>${icon('cpu')}CPU 核数</span>
              <input name="cpus" type="number" min="0.1" step="0.1" required /></label>
          </div>
          <div class="two">
            <label class="field"><span>${icon('hard-drive')}硬盘 (MB)</span>
              <input name="diskMb" type="number" min="128" step="128" value="2048" required />
              <div class="hint">实例数据卷配额，超量自动停止（轮询兜底，非硬限）；老实例回退全局 DISK_QUOTA_MB</div></label>
            <label class="field"><span>${icon('hourglass')}实例时长（天）</span>
              <input name="days" type="number" min="0" max="3650" placeholder="留空 = 跟随全局" />
              <div class="hint">用它建出来的实例能活多久：0 = 永久，留空 = 用全局基础时长（${
                state.cfg?.points?.instanceSpec?.days ?? 7
              } 天）</div></label>
          </div>
          <div class="two">
            <label class="field"><span>${icon('layers')}余量（剩余可购份数）</span>
              <input name="stock" type="number" min="0" max="1000000" placeholder="留空 = 不限量" />
              <div class="hint">每建一个实例扣 1 份，扣完自动售罄；驳回 / 创建失败 / 删除实例时退 1 份</div></label>
            <label class="field"><span>状态</span>
              <label class="row" style="gap:6px;padding-top:9px"><input type="checkbox" name="enabled" checked style="width:auto" /> 上架（支付页可见）</label></label>
          </div>
          <input type="hidden" name="id" />
          <div class="row" style="gap:8px">
            <button class="primary" type="submit">${icon('plus')}添加套餐</button>
            <button type="button" class="ghost" id="bundle-cancel" hidden>${icon('x')}取消编辑</button>
          </div>
        </form>
        ${cat('layers', '套餐列表', { flush: true })}
        <div class="card table-wrap"><table class="cards">
          <tr><th>名称</th><th>规格</th><th>硬盘</th><th>时长</th><th>余量</th><th>价格</th><th>状态</th><th></th></tr>
          ${
            bundles.length
              ? bundles
                  .map(
                    (b) => `<tr>
              <td><b>${esc(b.name || '未命名')}</b></td>
              <td class="sub">${b.memoryMb} MB · ${b.cpus} 核</td>
              <td class="sub">${fmt(b.diskMb)}</td>
              <td class="sub">${b.days == null ? '跟随全局' : b.days === 0 ? '永久' : `${b.days} 天`}</td>
              <td class="sub">${b.stock < 0 ? '不限量' : b.stock === 0 ? '<span class="badge error">售罄</span>' : `剩 ${b.stock} 份`}</td>
              <td><b>${b.cost}</b> 分</td>
              <td>${b.enabled ? '<span class="ok">上架中</span>' : '<span class="sub">已下架</span>'}</td>
              <td class="row">
                <button class="small" data-editb="${b.id}" data-name="${esc(b.name)}" data-memory="${b.memoryMb}"
                  data-cpus="${b.cpus}" data-disk="${b.diskMb}" data-cost="${b.cost}"
                  data-days="${b.days == null ? '' : b.days}" data-stock="${b.stock < 0 ? '' : b.stock}"
                  data-enabled="${b.enabled ? 1 : 0}">${icon('pencil')}编辑</button>
                <button class="small" data-toggleb="${b.id}" data-enabled="${b.enabled ? 1 : 0}">${icon(
                      'power'
                    )}${b.enabled ? '下架' : '上架'}</button>
                <button class="small danger" data-delb="${b.id}" data-label="${esc(b.name || `${b.memoryMb}MB/${b.cpus}核`)}">${icon(
                      'trash-2'
                    )}删除</button>
              </td>
            </tr>`
                  )
                  .join('')
              : '<tr><td colspan="6" class="sub">还没有套餐 —— 用上面的表单添加；首次启动时的默认档位来自 .env 的 POINTS_BUNDLES</td></tr>'
          }
        </table></div>`;
    } else if (tab === 'instances') {
      const { instances } = await api('/admin/instances');
      body = `<div class="card table-wrap"><table class="cards">
        <tr><th>实例</th><th>属主</th><th>镜像</th><th>状态</th><th>资源</th><th>端口</th><th>到期</th><th></th></tr>
        ${
          instances
            .map(
              (i) => `<tr>
          <td><a href="#/i/${esc(i.id)}">${esc(i.name)}</a></td>
          <td>${esc(i.owner)}</td>
          <td class="mono">${esc(i.image)}</td>
          <td>${badge(i.status)}</td>
          <td class="sub">${i.memoryMb}MB · ${i.cpus} 核</td>
          <td class="sub mono">${i.ports.map((p) => p.host).join(', ') || '—'}</td>
          <td class="sub mono nowrap">${
            i.life?.expiresAt
              ? `<span data-exp-label="${esc(i.id)}">${i.life.expiresAt.slice(0, 10)}</span>
                 <button class="tiny ghost" data-setexp="${esc(i.id)}" data-current="${esc(i.life.expiresAt)}"
                   title="修改过期时间">${icon('pencil')}</button>`
              : i.life?.days
                ? `<span class="sub">放行后 ${i.life.days} 天</span>`
                : `<span class="sub" data-exp-label="${esc(i.id)}">永久</span>
                   <button class="tiny ghost" data-setexp="${esc(i.id)}" data-current=""
                     title="设置过期时间">${icon('pencil')}</button>`
          }</td>
          <td><button class="small danger" data-del="${esc(i.id)}" data-name="${esc(i.name)}">${icon(
            'trash-2'
          )}删除</button></td>
        </tr>`
            )
            .join('') || '<tr><td colspan="8" class="sub">还没有实例</td></tr>'
        }
      </table></div>`;
    } else if (tab === 'sites') {
      const { sites } = await api('/admin/sites');
      body = `<div class="card table-wrap"><table class="cards">
        <tr><th>站点</th><th>属主</th><th>地址</th><th>文件</th><th>访问</th><th>更新</th><th></th></tr>
        ${
          sites
            .map(
              (s) => `<tr>
          <td><b>${esc(s.slug)}</b></td>
          <td>${esc(s.owner)}</td>
          <td><a href="${esc(s.path)}" target="_blank" rel="noopener noreferrer" class="mono">${esc(
            s.address
          )}${icon('external-link', { cls: 'trail' })}</a></td>
          <td class="sub">${s.fileCount} 个 · ${bytes(s.sizeBytes)} · ${s.cpus} 核/${s.memoryMb}MB</td>
          <td class="sub">${s.hits}</td>
          <td class="sub">${when(s.updatedAt)}</td>
          <td><button class="small danger" data-deladminsite="${esc(s.id)}" data-slug="${esc(
            s.slug
          )}">${icon('trash-2')}删除</button></td>
        </tr>`
            )
            .join('') || '<tr><td colspan="7" class="sub">还没有静态站点</td></tr>'
        }
      </table></div>`;
    } else if (tab === 'announcements') {
      const { announcements: anns } = await api('/admin/announcements');
      const prioBadge = (p) => {
        const cfg = { info: { cls: 'info', label: '信息' }, warning: { cls: 'warning', label: '提醒' }, critical: { cls: 'critical', label: '重要' } }[p] || { cls: 'info', label: p };
        return `<span class="badge ${cfg.cls}">${esc(cfg.label)}</span>`;
      };
      const yes = (v) => v ? `${icon('check', { cls: 'ok' })}` : '—';
      const row = (a) => `<tr>
        <td><b>${esc(a.title)}</b>${a.html ? `<div class="sub" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.content.slice(0, 60))}</div>` : ''}</td>
        <td>${prioBadge(a.priority)}</td>
        <td>${a.active ? icon('circle-check', { cls: 'ok' }) : '—'}</td>
        <td>${yes(a.dismissible)}</td>
        <td class="sub">${a.startsAt ? when(a.startsAt) : '—'} ~ ${a.endsAt ? when(a.endsAt) : '—'}</td>
        <td class="sub">${a.creatorName ? esc(a.creatorName) : '—'}</td>
        <td class="row"><button class="small" data-editann="${a.id}">${icon('pencil')}编辑</button>
          <button class="small danger" data-delann="${a.id}" data-title="${esc(a.title)}">${icon('trash-2')}删除</button></td>
      </tr>`;
      body = `<form class="card" id="ann-form">
          ${cat('info', '发布公告', { flush: true })}
          <input type="hidden" name="id" value="" />
          <label class="field"><span>${icon('scroll-text')}标题</span>
            <input name="title" placeholder="公告标题" maxlength="200" required /></label>
          <label class="field"><span>${icon('wrap-text')}内容（支持 Markdown）</span>
            <textarea name="content" rows="6" required></textarea></label>
          <div class="row" style="gap:8px;margin:-4px 0 2px">
            <button type="button" class="small" id="ann-img-btn">${icon('image')}插入图片</button>
            <span class="sub">上传后以 Markdown 插到光标处（PNG / JPG / GIF / WebP / AVIF，≤${bytes(state.cfg?.announcementImages?.maxBytes ?? 4194304)}）</span>
            <input type="file" id="ann-img-file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" hidden />
          </div>
          <label class="field"><span>${icon('layers')}格式</span>
            <select name="format"><option value="markdown">Markdown</option><option value="text">纯文本</option></select></label>
          <div class="two">
            <label class="field"><span>${icon('triangle-alert')}优先级</span>
              <select name="priority">
                <option value="info">信息</option><option value="warning">提醒</option><option value="critical">重要</option>
              </select></label>
            <label class="field"><span>${icon('eye')}状态</span>
              <label class="row" style="gap:6px;padding-top:9px"><input type="checkbox" name="active" checked style="width:auto" /> 立即生效</label>
              <label class="row" style="gap:6px"><input type="checkbox" name="dismissible" checked style="width:auto" /> 允许用户关闭</label></label>
          </div>
          <div class="two">
            <label class="field"><span>${icon('clock')}开始时间（留空立即）</span>
              <input name="startsAt" type="datetime-local" /></label>
            <label class="field"><span>${icon('clock')}结束时间（留空永久）</span>
              <input name="endsAt" type="datetime-local" /></label>
          </div>
          <div class="row">
            <button class="primary" type="submit" id="ann-submit-btn">${icon('info')}发布</button>
            <button class="ghost" type="button" id="ann-cancel-btn" style="display:none">${icon('x')}取消编辑</button>
          </div>
        </form>
        <div class="card table-wrap"><table class="cards">
          <tr><th>标题</th><th>优先级</th><th>生效</th><th>可关闭</th><th>有效期</th><th>发布者</th><th></th></tr>
          ${anns.length ? anns.map(row).join('') : '<tr><td colspan="7" class="sub">还没有公告</td></tr>'}
        </table></div>`;
    } else {
      const { entries } = await api('/admin/audit?limit=200');
      // A phone shows each row as a card, so 200 of them is a 99,000px page you
      // scroll past for a minute to reach nothing. Show the most recent page of
      // them and let the rest be asked for — the log is read newest-first anyway.
      const step = auditShown ?? (innerWidth <= 640 ? 40 : 200);
      const shown = entries.slice(0, step);
      const more = entries.length - shown.length;
      body = `<div class="card table-wrap"><table class="cards">
        <tr><th>时间</th><th>用户</th><th>动作</th><th>对象</th><th>详情</th></tr>
        ${shown
          .map(
            (e) => `<tr><td class="sub">${when(e.created_at)}</td><td>${esc(e.username || '—')}</td>
            <td class="mono">${esc(e.action)}</td><td>${esc(e.target || '—')}</td>
            <td class="sub wrap">${esc(e.detail || '')}</td></tr>`
          )
          .join('')}
      </table>${
        more > 0
          ? `<div class="row" style="justify-content:center;margin-top:14px">
               <button class="small" id="audit-more">${icon('history')}再看 ${Math.min(
                 more,
                 40
               )} 条（还有 ${more} 条）</button>
             </div>`
          : ''
      }</div>`;
    }

    // Built after the body so the pending badge reflects what was just loaded.
    const nav = ['pending', 'overview', 'users', 'invites', 'bundles', 'instances', 'sites', 'announcements', 'audit']
      .filter((t) => t !== 'sites' || state.cfg?.sites?.enabled)
      .map((t) => {
        const { label, ico } = {
          pending: { label: '待审批', ico: 'inbox' },
          overview: { label: '总览', ico: 'gauge' },
          users: { label: '用户', ico: 'users' },
          invites: { label: '邀请码', ico: 'ticket' },
          bundles: { label: '套餐', ico: 'layers' },
          instances: { label: '全部实例', ico: 'boxes' },
          sites: { label: '静态站点', ico: 'globe' },
          announcements: { label: '公告', ico: 'info' },
          audit: { label: '操作日志', ico: 'history' },
        }[t];
        const n = t === 'pending' && state.pendingCount ? ` (${state.pendingCount})` : '';
        return `<button data-atab="${t}" class="${tab === t ? 'on' : ''}">${icon(
          ico
        )}${label}${n}</button>`;
      })
      .join('');

    if (seq !== paintSeq) return; // 等待接口期间又被更新的标签页取代，放弃本次绘制

    shell(
      'admin',
      `<div class="page-title"><span class="page-ico">${icon('shield')}</span><h1>管理后台</h1></div>
       <div class="tabbar">${nav}</div>${body}`
    );

    revealActive('.tabbar', 'button.on');
    app.querySelectorAll('[data-atab]').forEach(
      (b) =>
        (b.onclick = () => {
          tab = b.dataset.atab;
          auditShown = null; // a fresh tab starts from the top of the log again
          history.replaceState(null, '', `#/admin/${tab}`);
          paint();
        })
    );
    const auditMore = document.getElementById('audit-more');
    if (auditMore) {
      auditMore.onclick = () => {
        auditShown = (auditShown ?? (innerWidth <= 640 ? 40 : 200)) + 40;
        paint();
      };
    }
    app.querySelectorAll('[data-copy]').forEach((el) => (el.onclick = () => copy(el.dataset.copy)));
    wireInstanceActions(paint);
    wireAdmin(paint);
  };

  await paint().catch((e) => toast(e.message, 'err'));
}

function wireAdmin(refresh) {
  app.querySelectorAll('[data-approve]').forEach(
    (b) =>
      (b.onclick = async () => {
        const card = b.closest('[data-pcard]');
        const addresses = {};
        card.querySelectorAll('[data-port]').forEach((inp) => {
          if (inp.value.trim()) addresses[inp.dataset.port] = inp.value.trim();
        });
        const autoTunnel = card.querySelector(`#autotunnel-${b.dataset.approve}`)?.checked ?? false;
        b.disabled = true;
        try {
          await api(`/admin/instances/${b.dataset.approve}/approve`, {
            method: 'POST',
            body: { addresses, autoTunnel },
          });
          toast(autoTunnel ? '已放行：正在创建容器并配置 Cloudflare 隧道' : '已放行，正在创建容器', 'ok');
          await refresh();
        } catch (e) {
          toast(e.message, 'err');
          b.disabled = false;
        }
      })
  );

  app.querySelectorAll('[data-reject]').forEach(
    (b) =>
      (b.onclick = async () => {
        const reason = prompt(`驳回「${b.dataset.name}」的理由（会显示给用户）：`, '');
        if (reason === null) return;
        b.disabled = true;
        try {
          await api(`/admin/instances/${b.dataset.reject}/reject`, { method: 'POST', body: { reason } });
          toast('已驳回，积分 / 券已退回', 'ok');
          await refresh();
        } catch (e) {
          toast(e.message, 'err');
          b.disabled = false;
        }
      })
  );

  const invForm = document.getElementById('inv-form');
  if (invForm) {
    const typeSel = document.getElementById('inv-type');
    const scopeSel = document.getElementById('inv-scope');
    const resBox = document.getElementById('inv-res');
    const pointsBox = document.getElementById('inv-points');
    const portsBox = document.getElementById('inv-ports');
    const lifeBox = document.getElementById('inv-life');
    const diskBox = document.getElementById('inv-disk');
    const syncType = () => {
      resBox.style.display = typeSel.value === 'instance' ? '' : 'none';
      pointsBox.style.display = typeSel.value === 'points' ? '' : 'none';
    };
    // 静态网页券没有端口、也不谈自定义镜像，额度直接跳到站点的记账口径；
    // 它背后没有容器，也就没有到期封存和硬盘配额这回事。
    const syncScope = () => {
      const siteOnly = scopeSel.value === 'site';
      portsBox.style.display = siteOnly ? 'none' : '';
      lifeBox.style.display = siteOnly ? 'none' : '';
      diskBox.style.display = siteOnly ? 'none' : '';
      const siteMb = state.cfg?.sites?.memoryMb ?? 32;
      invForm.memoryMb.value = siteOnly ? siteMb : (state.cfg?.voucherDefaults?.memoryMb ?? 1024);
      // min/step are written for containers (64MB floor, 64MB grid). A page has
      // no container, so a site-only voucher has to be allowed below that —
      // otherwise the browser refuses to submit the value we just filled in.
      invForm.memoryMb.min = siteOnly ? Math.min(64, siteMb) : 64;
      invForm.memoryMb.step = siteOnly ? 1 : 64;
      invForm.cpus.value = siteOnly ? (state.cfg?.sites?.cpus ?? 0.1) : (state.cfg?.voucherDefaults?.cpus ?? 1);
    };
    typeSel.onchange = syncType;
    scopeSel.onchange = syncScope;
    syncType();

    invForm.onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(invForm));
      const isInstance = typeSel.value === 'instance';
      const isPoints = typeSel.value === 'points';
      const siteOnly = isInstance && scopeSel.value === 'site';
      try {
        const { invite } = await api('/admin/invites', {
          method: 'POST',
          body: {
            type: typeSel.value,
            maxUses: Number(fd.maxUses),
            expiresInDays: fd.expiresInDays ? Number(fd.expiresInDays) : null,
            note: fd.note,
            ...(isPoints ? { points: Number(fd.points) } : {}),
            ...(isInstance
              ? {
                  scope: scopeSel.value,
                  memoryMb: Number(fd.memoryMb),
                  cpus: Number(fd.cpus),
                  ports: siteOnly ? 0 : Number(fd.ports),
                  diskMb: siteOnly ? null : fd.diskMb ? Number(fd.diskMb) : null,
                  allowCustomImage: !siteOnly && !!fd.allowCustomImage,
                  instanceDays: siteOnly ? 0 : Number(fd.instanceDays || 0),
                }
              : {}),
          },
        });
        copy(invite.code);
        toast(
          `${
            isInstance
              ? siteOnly
                ? '静态网页券'
                : '资源券'
              : isPoints
                ? `积分兑换码（${invite.points} 分）`
                : '注册邀请码'
          } ${invite.code} 已生成并复制`,
          'ok'
        );
        await refresh();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }

  // 面板名称 / 主题色：改完刷新配置并重绘，顶栏 / 登录页 / 标签标题跟着变；
  // 主题色即时应用到当前页面（CSS 变量 + favicon）。
  const panelNameSave = document.getElementById('panel-name-save');
  if (panelNameSave) {
    const input = document.getElementById('panel-name');
    const colorInput = document.getElementById('panel-color');
    const colorHex = document.getElementById('panel-color-hex');
    const errEl = document.getElementById('panel-name-err');
    colorInput.addEventListener('input', () => {
      colorHex.textContent = colorInput.value.toLowerCase();
      applyTheme(colorInput.value);
    });
    panelNameSave.onclick = async () => {
      errEl.textContent = '';
      try {
        const { panelName, panelColor } = await api('/admin/settings', {
          method: 'PATCH',
          body: { panelName: input.value, panelColor: colorInput.value },
        });
        state.cfg = { ...(state.cfg || {}), panelName, panelColor };
        document.title = `${panelName} · 容器面板`;
        applyTheme(panelColor);
        toast('品牌设置已保存', 'ok');
        refresh();
      } catch (err) {
        errEl.textContent = err.message;
        // 预览归位：保存失败时颜色/名称恢复到当前已保存的值
        applyTheme(state.cfg?.panelColor);
        colorHex.textContent = (state.cfg?.panelColor || '#006fee').toLowerCase();
        colorInput.value = state.cfg?.panelColor || '#006fee';
        input.value = state.cfg?.panelName || 'localhosting';
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') panelNameSave.click();
    });
  }

  // 验证码严格程度：normal = 行为检测；strict = 每次都出图片验证码。
  const captchaSave = document.getElementById('captcha-mode-save');
  if (captchaSave) {
    captchaSave.onclick = async () => {
      const errEl = document.getElementById('captcha-mode-err');
      errEl.textContent = '';
      try {
        const r = await api('/admin/settings', {
          method: 'PATCH',
          body: { captchaMode: document.getElementById('captcha-mode').value },
        });
        state.cfg = { ...(state.cfg || {}), captchaMode: r.captchaMode };
        toast(`验证码已切换为${r.captchaMode === 'strict' ? '严格' : '普通'}模式`, 'ok');
        refresh();
      } catch (err) {
        errEl.textContent = err.message;
      }
    };
  }

  // 套餐管理：表单添加/编辑，列表里上架下架、删除。改完顺手刷新一次配置，
  // 支付页的套餐卡下次打开就是新的。
  const bf = document.getElementById('bundle-form');
  if (bf) {
    const refreshCfg = async () => {
      try { state.cfg = await api('/config'); } catch {}
    };
    bf.onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(bf));
      fd.enabled = bf.enabled.checked;
      const id = fd.id;
      delete fd.id;
      try {
        if (id) await api(`/admin/bundles/${id}`, { method: 'PATCH', body: fd });
        else await api('/admin/bundles', { method: 'POST', body: fd });
        await refreshCfg();
        toast('套餐已保存', 'ok');
        refresh();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
    app.querySelectorAll('[data-editb]').forEach((btn) => {
      btn.onclick = () => {
        const d = btn.dataset;
        bf.id.value = d.editb;
        bf.name.value = d.name;
        bf.cost.value = d.cost;
        bf.memoryMb.value = d.memory;
        bf.cpus.value = d.cpus;
        bf.diskMb.value = d.disk;
        bf.days.value = d.days;
        bf.stock.value = d.stock;
        bf.enabled.checked = d.enabled === '1';
        bf.querySelector('button[type=submit]').innerHTML = `${icon('save')}保存修改`;
        document.getElementById('bundle-cancel').hidden = false;
        bf.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });
    document.getElementById('bundle-cancel').onclick = () => refresh();
    app.querySelectorAll('[data-toggleb]').forEach((btn) => {
      btn.onclick = async () => {
        const id = Number(btn.dataset.toggleb);
        const enabled = btn.dataset.enabled === '1';
        try {
          await api(`/admin/bundles/${id}`, { method: 'PATCH', body: { enabled: !enabled } });
          await refreshCfg();
          refresh();
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    });
    app.querySelectorAll('[data-delb]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm(`确定删除套餐「${btn.dataset.label}」？已创建的实例不受影响，之后无法再按打包价购买这个规格。`)) return;
        try {
          await api(`/admin/bundles/${btn.dataset.delb}`, { method: 'DELETE' });
          await refreshCfg();
          toast('已删除', 'ok');
          refresh();
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    });
  }

  app.querySelectorAll('[data-delinv]').forEach(
    (b) =>
      (b.onclick = async () => {
        await api(`/admin/invites/${encodeURIComponent(b.dataset.delinv)}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        refresh();
      })
  );

  app.querySelectorAll('[data-deladminsite]').forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm(`删除站点「${b.dataset.slug}」？文件会被清除。`)) return;
        try {
          await api(`/admin/sites/${b.dataset.deladminsite}`, { method: 'DELETE' });
          toast('已删除', 'ok');
          refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      })
  );

  app.querySelectorAll('[data-deluser]').forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm(`删除用户「${b.dataset.name}」及其全部实例？不可恢复。`)) return;
        try {
          await api(`/admin/users/${b.dataset.deluser}`, { method: 'DELETE' });
          toast('用户已删除', 'ok');
          refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      })
  );

  app.querySelectorAll('[data-setexp]').forEach(
    (b) =>
      (b.onclick = async () => {
        const current = b.dataset.current || '';
        const val = prompt(
          `修改过期时间（YYYY-MM-DD 格式，留空 = 永久有效）：`,
          current ? current.slice(0, 10) : ''
        );
        if (val === null) return;
        b.disabled = true;
        try {
          const expiresAt = val.trim() ? new Date(val.trim()).toISOString() : null;
          if (val.trim() && isNaN(new Date(val.trim()).getTime())) throw new Error('日期格式无效');
          await api(`/admin/instances/${b.dataset.setexp}/expiry`, { method: 'PATCH', body: { expiresAt } });
          const label = document.querySelector(`[data-exp-label="${b.dataset.setexp}"]`);
          if (label) label.textContent = expiresAt ? expiresAt.slice(0, 10) : '永久';
          b.dataset.current = expiresAt || '';
          toast(expiresAt ? `过期时间已更新为 ${expiresAt.slice(0, 10)}` : '已设为永久有效', 'ok');
          await refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
        b.disabled = false;
      })
  );

  app.querySelectorAll('[data-edit]').forEach(
    (b) =>
      (b.onclick = async () => {
        const { users } = await api('/admin/users');
        const u = users.find((x) => String(x.id) === b.dataset.edit);
        const dlg = document.getElementById('user-dlg');
        dlg.innerHTML = `<form method="dialog">
          <h3 style="margin-top:0">${icon('pencil')}编辑 ${esc(u.username)}</h3>
          <label class="field"><span>${icon('boxes')}最多同时运行实例</span>
            <input name="maxInstances" type="number" value="${u.quota.maxInstances}" />
            <div class="hint">内存 / CPU / 端口由积分规格或资源券决定，这里只限制总数量</div></label>
          <label class="field"><span>${icon('sparkles')}积分余额</span>
            <input name="points" type="number" min="0" value="${u.points ?? 0}" />
            <div class="hint">直接改到目标值，差额会记进对方的积分流水</div></label>
          <label class="field"><span>${icon('shield')}角色</span><select name="role">
            <option value="user" ${u.role === 'user' ? 'selected' : ''}>普通用户</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理员</option>
          </select></label>
          <label class="field"><span>${icon('key-round')}重置密码（留空不改）</span>
            <input name="newPassword" type="text" placeholder="至少 8 位" /></label>
          <div class="row" style="margin-bottom:14px">
            <label class="row" style="gap:6px"><input type="checkbox" name="allowCustomImage" style="width:auto" ${
              u.quota.allowCustomImage ? 'checked' : ''
            } /> ${icon('puzzle')}允许自定义镜像</label>
            <label class="row" style="gap:6px"><input type="checkbox" name="disabled" style="width:auto" ${
              u.disabled ? 'checked' : ''
            } /> ${icon('ban')}停用账号</label>
          </div>
           <button class="small ghost" id="reset-checkin" style="margin-top:4px">${icon('calendar')}重置今日签到</button>
           <div class="row"><button value="cancel" class="ghost">${icon('x')}取消</button>
            <button value="save" class="primary" id="save-user">${icon('save')}保存</button></div>
        </form>`;
        dlg.querySelector('#reset-checkin').onclick = async () => {
          if (!confirm(`确定重置 ${u.username} 的今日签到状态？重置后该用户可以再次签到。`)) return;
          try {
            await api(`/admin/users/${u.id}/reset-checkin`, { method: 'POST' });
            toast('已重置签到状态', 'ok');
            refresh();
          } catch (err) {
            toast(err.message, 'err');
          }
        };
        dlg.showModal();
        dlg.querySelector('form').onsubmit = async (ev) => {
          if (ev.submitter?.value !== 'save') return;
          const f = ev.target;
          try {
            await api(`/admin/users/${u.id}`, {
              method: 'PATCH',
              body: {
                maxInstances: Number(f.maxInstances.value),
                points: Number(f.points.value),
                role: f.role.value,
                allowCustomImage: f.allowCustomImage.checked,
                disabled: f.disabled.checked,
                newPassword: f.newPassword.value || undefined,
              },
            });
            toast('已保存', 'ok');
            refresh();
          } catch (err) {
            toast(err.message, 'err');
          }
        };
      })
  );

  const annForm = document.getElementById('ann-form');
  if (annForm) {
    const cancelEdit = () => {
      annForm.reset();
      annForm.id.value = '';
      annForm.querySelector('#ann-cancel-btn').style.display = 'none';
      annForm.querySelector('#ann-submit-btn').innerHTML = `${icon('info')}发布`;
    };

    annForm.querySelector('#ann-cancel-btn').onclick = cancelEdit;

    annForm.onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(annForm));
      const editId = fd.id ? Number(fd.id) : null;
      const body = {
        title: fd.title,
        content: fd.content,
        format: fd.format,
        priority: fd.priority,
        active: !!fd.active,
        dismissible: !!fd.dismissible,
        startsAt: fd.startsAt || null,
        endsAt: fd.endsAt || null,
      };
      try {
        if (editId) {
          await api(`/admin/announcements/${editId}`, { method: 'PATCH', body });
          toast('公告已更新', 'ok');
        } else {
          await api('/admin/announcements', { method: 'POST', body });
          toast('公告已发布', 'ok');
        }
        cancelEdit();
        await refresh();
      } catch (err) {
        toast(err.message, 'err');
      }
    };

    const annImgBtn = document.getElementById('ann-img-btn');
    const annImgFile = document.getElementById('ann-img-file');
    if (annImgBtn) annImgBtn.onclick = () => annImgFile.click();
    if (annImgFile) {
      annImgFile.onchange = async () => {
        const f = annImgFile.files?.[0];
        annImgFile.value = '';
        if (!f) return;
        const max = state.cfg?.announcementImages?.maxBytes ?? 4 * 1024 * 1024;
        if (f.size > max) return toast(`图片超过大小上限（${Math.round(max / 1048576)} MB）`, 'err');
        const base64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
          r.onerror = () => reject(new Error('读取文件失败'));
          r.readAsDataURL(f);
        });
        try {
          const { url } = await api('/admin/announcement-images/upload', { method: 'POST', body: { base64 } });
          const ta = annForm.content;
          const start = ta.selectionStart ?? ta.value.length;
          const end = ta.selectionEnd ?? start;
          const md = `\n\n![](${url})\n`;
          ta.value = ta.value.slice(0, start) + md + ta.value.slice(end);
          ta.selectionStart = ta.selectionEnd = start + md.length;
          ta.focus();
          toast('图片已上传并插入', 'ok');
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    }
  }

  app.querySelectorAll('[data-editann]').forEach(b => {
    b.onclick = async () => {
      const { announcements: anns } = await api('/admin/announcements');
      const a = anns.find(x => x.id === Number(b.dataset.editann));
      if (!a) return;
      annForm.id.value = a.id;
      annForm.title.value = a.title;
      annForm.content.value = a.content;
      annForm.format.value = a.format || 'markdown';
      annForm.priority.value = a.priority || 'info';
      annForm.active.checked = a.active;
      annForm.dismissible.checked = a.dismissible;
      annForm.startsAt.value = a.startsAt ? a.startsAt.slice(0, 16) : '';
      annForm.endsAt.value = a.endsAt ? a.endsAt.slice(0, 16) : '';
      annForm.querySelector('#ann-cancel-btn').style.display = '';
      annForm.querySelector('#ann-submit-btn').innerHTML = `${icon('save')}保存修改`;
      annForm.scrollIntoView({ behavior: 'smooth' });
    };
  });

  app.querySelectorAll('[data-delann]').forEach(b => {
    b.onclick = async () => {
      if (!confirm(`删除公告「${b.dataset.title}」？`)) return;
      try {
        await api(`/admin/announcements/${b.dataset.delann}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        await refresh();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  });
}

/* ---------------- 404 ---------------- */
/** Unknown #/… section. Only ever reached signed-in — route() hands guests to
    the sign-in screen and the empty hash to 概览 before this is picked. */
function view404() {
  shell(
    '',
    `<div class="page-title"><span class="page-ico">${icon('circle-help')}</span><h1>页面不存在</h1></div>
     <div style="height:16px"></div>
     <div class="card empty"><div class="big">${icon('circle-help')}</div>
       这个页面不存在。<a href="#/instances">回到概览</a>吧。</div>`
  );
}

/* ---------------- router ---------------- */
/* 快速连点导航时，上一个页面可能还在等接口，它晚到的渲染会盖住新页面，
   并带着自己刚注册的轮询定时器赖着不走 —— 这就是「切太快卡在上一页」。
   处理办法是把路由渲染串成一条链：
     1. 新路由等上一个路由彻底画完才开始（晚到的渲染永远排在新页面之前）；
     2. 等待期间如果又来了更新的路由，这个任务直接作废（序号对不上就跳过）；
     3. 渲染前再清一次定时器，把上一个页面刚注册的轮询一并收掉。
   最终画面永远是最后一次点击对应的页面。 */
let renderChain = Promise.resolve();
let routeSeq = 0;

function route() {
  const seq = ++routeSeq;
  const task = renderChain.then(async () => {
    if (seq !== routeSeq) return; // 等待期间被更新的路由取代，放弃本次渲染
    clearTimers();
    // 停用页优先于任何路由：hash 是可以随手改的，别让它绕回面板。
    if (state.disabled) return renderDisabled(state.disabled);
    if (!state.user) return renderAuth();
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    const section = parts[0] || 'instances';
    const arg = parts[1];

    switch (section) {
      case 'new':
        return viewNew();
      case 'sites':
        return state.cfg?.sites?.enabled ? viewSites() : viewInstances();
      case 'i':
        return viewInstance(arg);
      case 'admin':
        return state.user.role === 'admin' ? viewAdmin() : viewInstances();
      case 'account':
        return viewAccount();
      case 'instances':
        return viewInstances();
      default:
        // 打错的 hash 不该悄悄变成实例列表 —— 说清楚这一页不存在。
        return view404();
    }
  });
  renderChain = task.catch(() => {});
  return task;
}

async function boot() {
  try {
    // /auth/me 不依赖 config/templates，三个请求一起发，首屏少两个往返。
    const [cfg, tpl, me] = await Promise.all([api('/config'), api('/templates'), syncMe()]);
    state.cfg = cfg;
    state.templates = tpl.templates;
    // 面板名称是管理后台可改的，浏览器标签跟着它走。
    document.title = `${cfg.panelName || 'localhosting'} · 容器面板`;
    applyTheme(cfg.panelColor);
    // syncMe 已经把停用页画出来了，这里不能再往下走去渲染面板。
    if (me.disabled) return;
    state.user = me.user ?? null;
  } catch (e) {
    app.className = 'boot';
    app.innerHTML = `<div class="row" style="gap:8px">${icon('triangle-alert')}<span></span></div>`;
    app.querySelector('span').textContent = `无法连接面板服务：${e.message}`;
    return;
  }
  if (!state.user) return renderAuth();
  await route();
  maybeOpenWizard();
}

// 公告配图点开灯箱：app 是常驻元素，事件委托绑一次，页面怎么重绘都在。
app.addEventListener('click', (e) => {
  const img = e.target.closest('.announcement-banner-body img, .announcement-item-body img');
  if (!img) return;
  e.preventDefault();
  openAnnouncementLightbox(img);
});

window.addEventListener('hashchange', route);
boot();
