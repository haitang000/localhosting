import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { captchaStrict } from './settings.js';
import { loadPuzzles, rotateToPng, obscurePuzzle } from './rotate-image.js';

/* ================================================================
   验证体系分四层，成本由低到高：

   1. 行为分析（鼠标轨迹 / 打字节奏）—— 信号全部客户端自报、可伪造，
      所以通过线每次请求都随机浮动，伪造者没法精确命中一套阈值。
   2. 工作量证明 PoW —— 服务端发前缀 + 难度，客户端必须算出
      sha256(前缀+nonce) 前 N 位为 0 的 nonce。对人类零感知，
      对脚本是每个 token 实打实的算力开销，也是唯一没法「伪造」的一层。
   3. 图片回正挑战 —— 行为落进不确定区时下发；真实照片在服务端像素层
      旋转（见 rotate-image.js），标记里没有任何角度信息，只能真的去看图。
      发题前还会随机裁剪 + 缩放 + 像素噪声，拿公开题图旋转后逐像素比对
      的脚本路也堵上。
   4. 一次性 token + IP 绑定 + 时间约束 —— 签发、求解、使用三环各有
      最低间隔，token 只能在签发的 IP 上用，用完即作废。
   ================================================================ */

/* ---- 一次性行为验证 Token ---- */
const turnstileStore = new Map(); // token -> { ip, issuedAt, expires }
const TURNSTILE_TTL = 5 * 60_000;

/* ---- 工作量证明 ---- */
const powStore = new Map(); // prefix -> { ip, bits, expires }
const POW_TTL = 2 * 60_000;

/* ---- 每 IP 失败声誉（自适应难度） ---- */
const reputation = new Map(); // ip -> number[] 失败时间戳
const REPUTATION_WINDOW = 10 * 60_000;

function recordReputation(ip) {
  const arr = reputation.get(ip) ?? [];
  arr.push(Date.now());
  if (arr.length > 40) arr.shift();
  reputation.set(ip, arr);
}

/** 最近失败越多，PoW 难度越高（上限 +4 位）。 */
function powBitsFor(ip) {
  const recent = (reputation.get(ip) ?? []).filter((t) => Date.now() - t < REPUTATION_WINDOW);
  let extra = 0;
  if (recent.length >= 3) extra = 2;
  if (recent.length >= 8) extra = 3;
  if (recent.length >= 20) extra = 4;
  return Math.min(config.captchaPowBits + extra, config.captchaPowBits + 4);
}

export function createPow(ip) {
  const bits = powBitsFor(ip);
  const prefix = crypto.randomBytes(16).toString('hex');
  powStore.set(prefix, { ip, bits, expires: Date.now() + POW_TTL });
  return { prefix, bits };
}

/** 校验 PoW 答案：前缀一次性、绑定 IP、哈希前导零位数达标。 */
export function verifyPow(prefix, nonce, ip) {
  const rec = powStore.get(prefix);
  if (!rec) return false;
  powStore.delete(prefix); // 一次性，防止同一份工作反复用
  if (rec.expires < Date.now() || rec.ip !== ip) return false;
  if (typeof nonce !== 'string' || !nonce || nonce.length > 32 || !/^\d+$/.test(nonce)) return false;
  const hex = crypto.createHash('sha256').update(prefix + nonce).digest('hex');
  return leadingZeroBits(hex) >= rec.bits;
}

/** 十六进制串的前导零位数（每 nibble 4 位）。 */
function leadingZeroBits(hex) {
  let zeros = 0;
  for (let i = 0; i < hex.length; i++) {
    const nib = parseInt(hex[i], 16);
    if (nib === 0) {
      zeros += 4;
      continue;
    }
    for (let b = 0x8; b > 0 && (nib & b) === 0; b >>= 1) zeros++;
    break;
  }
  return zeros;
}

/* ---- 行为分析 ---- */

/**
 * 鼠标/触摸轨迹分析：区分人类操作和自动化脚本。
 *
 * 评分维度：
 *   - 路径弯曲度（人类不画直线）
 *   - 方向角方差（人类轨迹的角度变化比脚本丰富）
 *   - 移动速度波动（人类抖动多，脚本匀速）
 *   - 末尾减速（靠近目标时人会自然减速）
 *   - 路径长度与耗时
 *
 * 满分 8 分。通过线由 createTurnstile 每次随机浮动；这里只负责打原始分
 * 和判「铁定是机器」（返回 0 的那些情况）。
 */
export function analyzeTrajectory(points) {
  if (!Array.isArray(points) || points.length < 5) return 0;

  const n = points.length;
  const totalTime = points[n - 1].t - points[0].t;
  if (totalTime < 200) return 0;

  // 逐段计算距离、耗时、路径总长
  let pathLen = 0;
  const segs = [];
  for (let i = 1; i < n; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const d = Math.hypot(dx, dy);
    const dt = points[i].t - points[i - 1].t;
    pathLen += d;
    segs.push({ dist: d, dt });
  }
  if (pathLen < 60) return 0;

  // 逐段间隔全部近乎相等 = 固定频率采样 = 脚本特征
  const dts = segs.map((s) => s.dt).filter((d) => d > 0);
  if (dts.length >= 5) {
    const dm = dts.reduce((a, b) => a + b, 0) / dts.length;
    const spread = (Math.max(...dts) - Math.min(...dts)) / dm;
    if (spread < 0.01) return 0;
  }

  // 弯曲度
  const dx0 = points[n - 1].x - points[0].x;
  const dy0 = points[n - 1].y - points[0].y;
  const directDist = Math.hypot(dx0, dy0);
  const straightness = pathLen / Math.max(directDist, 1);

  // 方向角方差
  let angleSum = 0, angleSumSq = 0, angleCount = 0;
  for (let i = 2; i < n; i++) {
    const x1 = points[i - 1].x - points[i - 2].x;
    const y1 = points[i - 1].y - points[i - 2].y;
    const x2 = points[i].x - points[i - 1].x;
    const y2 = points[i].y - points[i - 1].y;
    const d1 = Math.hypot(x1, y1);
    const d2 = Math.hypot(x2, y2);
    if (d1 < 2 || d2 < 2) continue;
    const dot = (x1 * x2 + y1 * y2) / (d1 * d2);
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    angleSum += angle;
    angleSumSq += angle * angle;
    angleCount++;
  }
  if (angleCount < 3) return 0;
  const angleVar = angleSumSq / angleCount - (angleSum / angleCount) ** 2;

  // 速度波动度 = std(speeds) / mean(speeds)，人类 > 0.25
  let speedVar = 0;
  const speeds = segs.filter((s) => s.dt > 4).map((s) => s.dist / Math.max(s.dt, 1));
  if (speeds.length >= 3) {
    const sm = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    if (sm > 0.01) {
      speedVar = Math.sqrt(speeds.reduce((a, s) => a + (s - sm) ** 2, 0) / speeds.length) / sm;
    }
  }

  // 末尾减速：最后 20% 段落比前 80% 慢，说明靠近目标
  let decelerates = false;
  const mid = Math.max(1, Math.ceil(segs.length * 0.8));
  const early = segs.slice(0, mid).filter((s) => s.dt > 4);
  const late = segs.slice(mid).filter((s) => s.dt > 4);
  if (early.length >= 2 && late.length >= 1) {
    const earlySpd = early.reduce((a, s) => a + s.dist / Math.max(s.dt, 1), 0) / early.length;
    const lateSpd = late.reduce((a, s) => a + s.dist / Math.max(s.dt, 1), 0) / late.length;
    decelerates = earlySpd > 0.02 && lateSpd < earlySpd * 0.75;
  }

  let score = 0;
  if (straightness > 1.03) score += 1;
  if (angleVar > 0.008) score += 1;
  if (totalTime > 400) score += 1;
  if (totalTime > 800) score += 1;
  if (pathLen > 150) score += 1;
  if (speedVar > 0.25) score += 2;
  if (decelerates) score += 1;

  return score;
}

/**
 * 表单填写行为分析：打字节拍、焦点切换规律。
 *
 * 评分维度：
 *   - 总填写耗时
 *   - 焦点切换次数
 *   - 逐字段的按键间隔均值和方差（自然打字 vs 自动填充）
 *   - 多字段独立输入
 *
 * 满分 7 分。通过线同样由 createTurnstile 随机浮动。
 */
export function analyzeFormBehavior(data) {
  if (!data || typeof data.totalMs !== 'number') return 0;
  if (data.totalMs < 800) return 0;

  const fields = Object.values(data.fields ?? {});
  const totalKeystrokes = fields.reduce((s, f) => s + (f.n || 0), 0);
  if (totalKeystrokes < 3) return 0;
  // 我们的表单最多两三个输入框，报出 8 个以上焦点切换只能是脚本编的
  if (data.focusOrder?.length > 8) return 0;

  let score = 0;
  if (data.totalMs > 3000) score += 1;
  if (data.focusOrder?.length >= 1) score += 1;

  let typedFields = 0;
  for (const f of fields) {
    if (f.n < 2) continue;
    typedFields++;
    if (f.meanGap >= 25 && f.meanGap <= 600) score += 1;
    if (f.varGap > 80) score += 1;
  }
  if (typedFields >= 2) score += 1;

  return score;
}

/* ---- 客户端自报信号的合理性校验（软门槛的硬底线） ---- */

/** hints 缺失 = 中性（老页面）；给了但数值自相矛盾 = 判机器。 */
function plausibleHints(h) {
  if (!h) return true;
  if (typeof h !== 'object') return false;
  if (!Number.isFinite(h.dpr) || h.dpr < 0.5 || h.dpr > 4) return false;
  if (!Number.isFinite(h.sw) || !Number.isFinite(h.sh)) return false;
  if (h.sw < 200 || h.sw > 10000 || h.sh < 100 || h.sh > 10000) return false;
  if (!Number.isFinite(h.tz) || h.tz < -14 * 60 || h.tz > 14 * 60) return false;
  if (!Array.isArray(h.lang) || h.lang.length < 1 || h.lang.length > 8) return false;
  for (const l of h.lang) {
    if (typeof l !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l)) return false;
  }
  return true;
}

/** 轨迹必须落在屏幕范围内（多留 2000px 余量给滚动弹跳），时间严格递增。 */
function plausibleTrajectory(points, hints) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 150) return false;
  let prevT = -1;
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.t)) return false;
    if (p.t <= prevT) return false;
    prevT = p.t;
    if (hints && hints.sw > 0 && hints.sh > 0) {
      const slack = 2000;
      if (p.x < -slack || p.y < -slack || p.x > hints.sw + slack || p.y > hints.sh + slack) return false;
    }
  }
  return true;
}

/* ---- 图片回正验证（不确定行为时的兜底关卡）----
   服务端把一张方向明确的真实照片按随机角度旋转后发给客户端，人把图转回
   正位即通过。角度容差、最低求解耗时都可配；记录一次性消费、5 分钟过期。 */

const CHALLENGE_TTL = 5 * 60_000;
const CHALLENGE_TRIES = 3; // 转歪一点可以调整重试，试完作废

/** 启动时把题图 PNG 解码成像素（每张都以「上」为正）。
 *  默认用仓库自带的 src/captcha-images/（公开题库，能做角度比对攻击）；
 *  配置了 CAPTCHA_IMAGES_DIR 就用自备题图 —— 图不在公开仓库里，比对就没基准。 */
const puzzles = loadPuzzles(
  config.captchaImagesDir
    ? path.resolve(config.captchaImagesDir)
    : fileURLToPath(new URL('./captcha-images/', import.meta.url))
);
if (!puzzles.length) {
  console.warn(
    '[captcha] 没找到题图（src/captcha-images/ 或 CAPTCHA_IMAGES_DIR 下要有 PNG），图片回正挑战将无法签发'
  );
}

const challengeStore = new Map(); // id -> { answer, ip, createdAt, tries, expires }

/** 签发一张回正挑战。每 IP 未解的挑战数有上限，防止并行穷举。
 *  发题前先 obscurePuzzle：随机裁剪 + 缩放 + 像素噪声，让挑战图和公开的
 *  原题图在像素层对不上号 —— 拿原图旋转后逐角度比对的脚本会在这里失手。 */
function createChallenge(ip) {
  let open = 0;
  for (const v of challengeStore.values()) {
    if (v.ip === ip && v.expires > Date.now()) open++;
  }
  if (open >= config.captchaMaxChallengesPerIp) return null;
  if (!puzzles.length) return null;

  const pic = puzzles[Math.floor(Math.random() * puzzles.length)];
  const answer = Math.floor(Math.random() * 360); // 全角度随机，30° 步进那套穷举法没用了
  const id = crypto.randomBytes(16).toString('hex');
  const png = rotateToPng(obscurePuzzle(pic), answer);
  challengeStore.set(id, { answer, ip, createdAt: Date.now(), tries: CHALLENGE_TRIES, expires: Date.now() + CHALLENGE_TTL });
  return {
    id,
    image: `data:image/png;base64,${png.toString('base64')}`,
  };
}

/** 两角之间最短的带符号差，范围 (-180, 180]。 */
export function angleDiff(a, b) {
  let diff = (a - b) % 360;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

/** 校验回正角度；成功返回一次性 token，否则 null。
    题是别人 IP 签发的直接作废（防止拿去当穷举预言机）；
    签发后 1 秒内求解判脚本；容差外重试几次，次数用尽或成功后作废。

    角度约定：服务端把照片按 answer 顺时针旋转（CSS 正角 = 顺时针），
    用户把它转回正位 = 逆时针 answer，即 CSS 顺时针 (360 − answer) 度，
    提交的正是这个值。所以这里跟 −answer 比，跟 +answer 比只有
    answer≈0/180 时碰巧能过 —— 那就是「明明回正了却验证失败」的来源。 */
export function verifyChallenge(id, angle, ip) {
  if (!id || typeof angle !== 'number' || !Number.isFinite(angle)) return null;
  const rec = challengeStore.get(id);
  if (!rec || rec.expires < Date.now()) {
    if (rec) challengeStore.delete(id);
    return null;
  }
  if (rec.ip !== ip) {
    challengeStore.delete(id);
    return null;
  }
  if (Date.now() - rec.createdAt < config.captchaMinSolveMs) return null;
  if (Math.abs(angleDiff(angle, -rec.answer)) > config.captchaTolerance) {
    rec.tries -= 1;
    if (rec.tries <= 0) challengeStore.delete(id);
    return null;
  }
  challengeStore.delete(id);
  return mintToken(ip);
}

/** 签发一次性 token，记下 IP 和签发时刻。 */
export function mintToken(ip) {
  const token = crypto.randomBytes(32).toString('hex');
  turnstileStore.set(token, { ip, issuedAt: Date.now(), expires: Date.now() + TURNSTILE_TTL });
  return token;
}

/**
 * 校验一次性 token。
 *   - 跨 IP 使用 = 可疑，直接作废；
 *   - 签发后立刻就用（间隔 < CAPTCHA_MIN_TOKEN_AGE_MS）也判机器，
 *     但太年轻不消费 token —— 真人看见「验证通过」再点提交，几乎不可能
 *     快到这个程度，真撞上重试一次就好。
 */
export function verifyTurnstile(token, ip) {
  if (!token) return false;
  const rec = turnstileStore.get(token);
  if (!rec || rec.expires < Date.now()) {
    if (rec) turnstileStore.delete(token);
    return false;
  }
  if (rec.ip !== ip) {
    turnstileStore.delete(token);
    return false;
  }
  if (Date.now() - rec.issuedAt < config.captchaMinTokenAgeMs) return false;
  turnstileStore.delete(token);
  return true;
}

/**
 * 行为验证总入口。
 *   - 所有提供项都通过            → { token }
 *   - 有提供项落在不确定区（无明确失败）→ { challenge: { id, image } }
 *   - 任一提供项明确失败或没给数据  → null（调用方 400）
 * 通过线每次随机浮动；失败记入该 IP 的声誉，提高后续 PoW 难度。
 */
export function createTurnstile(trajectory, formBehavior, hints, ip) {
  if (!trajectory && !formBehavior) return null;
  if (!plausibleHints(hints) || (trajectory && !plausibleTrajectory(trajectory, hints))) {
    recordReputation(ip);
    return null;
  }

  if (captchaStrict()) {
    // 严格模式：行为分析不看了，每次都要求完成图片回正。
    // 先把该 IP 未解的旧题作废 —— 否则攒满每 IP 上限后新题签不出来，
    // 验证会静默失效（客户端拿不到 challenge，提交时才发现没 token）。
    for (const [k, v] of challengeStore) {
      if (v.ip === ip && v.expires > Date.now()) challengeStore.delete(k);
    }
    const ch = createChallenge(ip);
    if (!ch) {
      recordReputation(ip);
      return null;
    }
    return { challenge: ch };
  }

  const trajPass = 4 + (Math.random() < 0.5 ? 1 : 0); // 4 或 5
  const trajUncertain = 2 + (Math.random() < 0.5 ? 1 : 0); // 2 或 3
  const formPass = 3 + (Math.random() < 0.5 ? 1 : 0); // 3 或 4
  const formUncertain = 1 + (Math.random() < 0.5 ? 1 : 0); // 1 或 2

  let uncertain = false;
  if (trajectory) {
    const s = analyzeTrajectory(trajectory);
    if (s < trajUncertain) {
      recordReputation(ip);
      return null;
    }
    if (s < trajPass) uncertain = true;
  }
  if (formBehavior) {
    const s = analyzeFormBehavior(formBehavior);
    if (s < formUncertain) {
      recordReputation(ip);
      return null;
    }
    if (s < formPass) uncertain = true;
  }

  if (uncertain) {
    const ch = createChallenge(ip);
    if (!ch) {
      recordReputation(ip);
      return null;
    }
    return { challenge: ch };
  }

  return { token: mintToken(ip) };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of turnstileStore) if (v.expires < now) turnstileStore.delete(k);
  for (const [k, v] of challengeStore) if (v.expires < now) challengeStore.delete(k);
  for (const [k, v] of powStore) if (v.expires < now) powStore.delete(k);
}, 60_000);
