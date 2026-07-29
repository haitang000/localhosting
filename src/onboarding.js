import { db } from './db.js';

/**
 * 新用户引导：一个全屏分步向导 + 一张常驻清单。
 *
 * 清单的四项进度全部由真实数据推导（验没验过券、有没有实例/站点、有没有拿到地址），
 * 只有「向导停在第几步、跳没跳过」这类纯 UI 状态才落在 users.onboarding_json 上。
 * 这样换个浏览器、或者从别的入口把某一步做掉了，进度都不会对不上。
 */

const TOTAL = 4; // account / voucher(现在是「手里有积分/券」) / deploy / live
const DEFAULT = { state: 'new', step: 0, voucherSeen: false };
const STATES = ['new', 'checklist', 'done'];

/** 实例被驳回、还没审批、或者创建失败时，用户手上还没有能访问的东西。 */
const NOT_LIVE = new Set(['pending', 'rejected', 'error', 'creating']);

function facts(userId) {
  return {
    instances: db.prepare('SELECT status, invite_code, paid_points FROM instances WHERE user_id = ?').all(userId),
    sites: db.prepare('SELECT invite_code, paid_points FROM sites WHERE user_id = ?').all(userId),
    // 面板送过券的老用户也算「手里有弹药」
    granted: db.prepare('SELECT COUNT(*) AS c FROM invites WHERE issued_to = ?').get(userId).c,
    // 新用户注册就送积分，所以这一步对新人天生就是勾上的 —— 引导的
    // 重点落在后两步（把东西部署上去）
    points: db.prepare('SELECT points FROM users WHERE id = ?').get(userId)?.points ?? 0,
  };
}

function stored(user, f) {
  let raw = null;
  try {
    raw = user.onboarding_json ? JSON.parse(user.onboarding_json) : null;
  } catch {
    raw = null;
  }
  if (raw && typeof raw === 'object') return { ...DEFAULT, ...raw };
  // 从没存过状态的账号：已经建过东西的当老用户看待，别拿向导挡在人家面前。
  return { ...DEFAULT, state: f.instances.length || f.sites.length ? 'done' : 'new' };
}

function derive(f, saved) {
  const spent =
    f.instances.some((i) => i.invite_code || i.paid_points) || f.sites.some((s) => s.invite_code || s.paid_points);
  return {
    account: true,
    voucher: saved.voucherSeen || spent || f.granted > 0 || f.points > 0,
    deploy: f.instances.length > 0 || f.sites.length > 0,
    live: f.instances.some((i) => !NOT_LIVE.has(i.status)) || f.sites.length > 0,
  };
}

/** 管理员不吃这套引导（积分和券都是他自己发的），返回 null 让前端整个隐藏。 */
export function publicOnboarding(user) {
  if (!user || user.role === 'admin') return null;
  const f = facts(user.id);
  const saved = stored(user, f);
  const progress = derive(f, saved);
  const done = Object.values(progress).filter(Boolean).length;
  return {
    state: saved.state,
    step: saved.step,
    progress,
    done,
    total: TOTAL,
    allDone: done === TOTAL,
  };
}

export function updateOnboarding(user, patch = {}) {
  if (!user || user.role === 'admin') return null;
  const next = stored(user, facts(user.id));
  if (STATES.includes(patch.state)) next.state = patch.state;
  if (Number.isFinite(Number(patch.step))) {
    next.step = Math.max(0, Math.min(TOTAL, Math.trunc(Number(patch.step))));
  }
  if (patch.voucherSeen) next.voucherSeen = true;

  const json = JSON.stringify(next);
  db.prepare('UPDATE users SET onboarding_json = ? WHERE id = ?').run(json, user.id);
  user.onboarding_json = json; // 同一个请求里后面还要用 req.user，顺手更新
  return publicOnboarding(user);
}

/** 用户成功查了一次资源券 —— 不管是在向导里还是在创建页 —— 就算「拿到券」了。 */
export const markVoucherSeen = (user) => updateOnboarding(user, { voucherSeen: true });
