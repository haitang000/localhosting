import crypto from 'node:crypto';

/* ---- 一次性行为验证 Token ---- */
const turnstileStore = new Map();
const TURNSTILE_TTL = 5 * 60_000;

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
 * 满分 8 分，≥4 分通过。
 */
export function analyzeTrajectory(points) {
  if (!Array.isArray(points) || points.length < 5) return false;

  const n = points.length;
  const totalTime = points[n - 1].t - points[0].t;
  if (totalTime < 200) return false;

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
  if (pathLen < 60) return false;

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
  if (angleCount < 3) return false;
  const angleVar = angleSumSq / angleCount - (angleSum / angleCount) ** 2;

  // 速度波动度 = std(speeds) / mean(speeds)，人类 > 0.25
  let speedVar = 0;
  const speeds = segs.filter(s => s.dt > 4).map(s => s.dist / Math.max(s.dt, 1));
  if (speeds.length >= 3) {
    const sm = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    if (sm > 0.01) {
      speedVar = Math.sqrt(speeds.reduce((a, s) => a + (s - sm) ** 2, 0) / speeds.length) / sm;
    }
  }

  // 末尾减速：最后 20% 段落比前 80% 慢，说明靠近目标
  let decelerates = false;
  const mid = Math.max(1, Math.ceil(segs.length * 0.8));
  const early = segs.slice(0, mid).filter(s => s.dt > 4);
  const late = segs.slice(mid).filter(s => s.dt > 4);
  if (early.length >= 2 && late.length >= 1) {
    const earlySpd = early.reduce((a, s) => a + s.dist / Math.max(s.dt, 1), 0) / early.length;
    const lateSpd = late.reduce((a, s) => a + s.dist / Math.max(s.dt, 1), 0) / late.length;
    decelerates = earlySpd > 0.02 && lateSpd < earlySpd * 0.75;
  }

  let score = 0;
  if (straightness > 1.03)       score += 1;
  if (angleVar > 0.008)          score += 1;
  if (totalTime > 400)           score += 1;
  if (totalTime > 800)           score += 1;
  if (pathLen > 150)             score += 1;
  if (speedVar > 0.25)           score += 2;
  if (decelerates)               score += 1;

  return score >= 4;
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
 * 满分 7 分，≥3 分通过。
 */
export function analyzeFormBehavior(data) {
  if (!data || typeof data.totalMs !== 'number') return false;
  if (data.totalMs < 800) return false;

  const fields = Object.values(data.fields ?? {});
  const totalKeystrokes = fields.reduce((s, f) => s + (f.n || 0), 0);
  if (totalKeystrokes < 3) return false;

  let score = 0;
  if (data.totalMs > 3000)       score += 1;
  if (data.focusOrder?.length >= 1) score += 1;

  let typedFields = 0;
  for (const f of fields) {
    if (f.n < 2) continue;
    typedFields++;
    if (f.meanGap >= 25 && f.meanGap <= 600) score += 1;
    if (f.varGap > 80) score += 1;
  }
  if (typedFields >= 2) score += 1;

  return score >= 3;
}

export function createTurnstile(trajectory, formBehavior) {
  if (!trajectory && !formBehavior) return null;
  if (trajectory && !analyzeTrajectory(trajectory)) return null;
  if (formBehavior && !analyzeFormBehavior(formBehavior)) return null;
  const token = crypto.randomBytes(32).toString('hex');
  turnstileStore.set(token, { expires: Date.now() + TURNSTILE_TTL });
  return token;
}

export function verifyTurnstile(token) {
  if (!token) return false;
  const rec = turnstileStore.get(token);
  if (rec) turnstileStore.delete(token);
  if (!rec || rec.expires < Date.now()) return false;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of turnstileStore) if (v.expires < now) turnstileStore.delete(k);
}, 60_000);
