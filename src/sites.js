import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, siteAddress } from './config.js';
import { db, now, audit } from './db.js';
import { HttpError } from './instances.js';
import { getInvite, inviteProblem, consume, refund } from './invites.js';
import { spendPoints, refundPoints, balanceOf } from './points.js';
import * as notifications from './notifications.js';

/**
 * Static sites: the user drops an .html file (or a whole folder) on the panel
 * and it is live immediately. No container, no port, no tunnel of its own —
 * the panel serves the bytes itself under /s/<slug>/, so the only thing that
 * has to be reachable from outside is the panel port you already forward.
 *
 * A site costs SITE_POINTS_COST 积分 (SITE_REQUIRE_INVITE)，或者一张老资源券
 * 的一次 —— 填了券就走券，没填就扣分。不管哪条路，都按 SITE_MEMORY_MB /
 * SITE_CPUS (32MB / 0.1 核) 记账。
 */

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const bad = (msg) => new HttpError(400, msg);

export const siteDir = (id) => path.join(config.sitesDir, id);

/** Windows-hostile or traversal-y names we refuse to write to disk. */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function checkSegment(seg) {
  if (!seg || seg === '.' || seg === '..') throw bad(`文件路径 "${seg}" 不合法`);
  if (seg.length > 100) throw bad('文件名过长');
  if (/[\\/:*?"<>|]/.test(seg) || /[\u0000-\u001f]/.test(seg)) throw bad(`文件名 "${seg}" 含非法字符`);
  if (seg !== seg.trim() || seg.endsWith('.')) throw bad(`文件名 "${seg}" 不能以空格或点结尾`);
  if (WIN_RESERVED.test(seg)) throw bad(`文件名 "${seg}" 是系统保留名`);
}

/** "a/b/../c.html" or "C:\x\y.html" never make it past this. */
export function cleanRelPath(raw) {
  const p = String(raw || '').replace(/\\/g, '/').replace(/^\.?\//, '').trim();
  if (!p) throw bad('文件路径为空');
  if (p.length > 200) throw bad('文件路径过长');
  const segs = p.split('/').filter((s) => s !== '');
  if (!segs.length) throw bad('文件路径为空');
  if (segs.length > 12) throw bad('目录层级太深');
  segs.forEach(checkSegment);
  return segs.join('/');
}

/** Dropping a folder gives "myfolder/index.html" — peel that wrapper off. */
function stripCommonRoot(files) {
  if (files.length < 2 && !files[0]?.path.includes('/')) return files;
  const first = files[0].path.split('/')[0];
  if (!files.every((f) => f.path.startsWith(`${first}/`))) return files;
  const stripped = files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
  return stripped.some((f) => !f.path) ? files : stripCommonRoot(stripped);
}

/** Which file answers "/". index.html wins; a lone .html is accepted too. */
function pickEntry(paths) {
  const index = paths.find((p) => /^index\.html?$/i.test(p));
  if (index) return index;
  const roots = paths.filter((p) => !p.includes('/') && /\.html?$/i.test(p));
  if (roots.length === 1) return roots[0];
  const any = paths.filter((p) => /\.html?$/i.test(p));
  if (!roots.length && any.length === 1) return any[0];
  throw bad(
    any.length
      ? '有好几个 HTML 文件，分不清哪个是首页；请把首页改名为 index.html 再拖进来'
      : '这堆文件里没有 HTML，请至少放一个 index.html'
  );
}

/**
 * body.files = [{ path, base64 }]  (the browser reads the dropped files and
 * base64s them; there is no multipart parser and no upload dependency).
 */
function decodeFiles(raw) {
  if (!Array.isArray(raw) || !raw.length) throw bad('没有收到任何文件');
  if (raw.length > config.siteMaxFiles) throw bad(`文件数超过上限（${config.siteMaxFiles} 个）`);

  let total = 0;
  const files = raw.map((f) => {
    const rel = cleanRelPath(f?.path);
    const data = Buffer.from(String(f?.base64 || ''), 'base64');
    total += data.length;
    if (total > config.siteMaxBytes) throw bad(`站点总大小超过上限（${Math.round(config.siteMaxBytes / 1048576)} MB）`);
    return { path: rel, data };
  });

  const deduped = stripCommonRoot(files);
  const seen = new Set();
  for (const f of deduped) {
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw bad(`文件 ${f.path} 重复了`);
    seen.add(key);
  }
  return { files: deduped, total };
}

/** Writes into a scratch directory and swaps it in, so a failed redeploy
 *  cannot leave a half-written site behind. */
async function writeFiles(id, files) {
  const dir = siteDir(id);
  const tmp = `${dir}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  try {
    for (const f of files) {
      const abs = path.join(tmp, f.path);
      // Belt and braces: cleanRelPath already rejected traversal.
      if (!abs.startsWith(tmp + path.sep)) throw bad(`文件路径 ${f.path} 不合法`);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, f.data);
    }
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rename(tmp, dir);
  } catch (err) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export function countForUser(userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM sites WHERE user_id = ?').get(userId).c;
}

export function serialize(row) {
  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id);
  return {
    id: row.id,
    slug: row.slug,
    owner: owner?.username ?? '?',
    userId: row.user_id,
    entry: row.entry,
    memoryMb: row.memory_mb,
    cpus: row.cpus,
    fileCount: row.file_count,
    sizeBytes: row.size_bytes,
    hits: row.hits,
    lastHitAt: row.last_hit_at,
    note: row.note,
    inviteCode: row.invite_code,
    paidPoints: row.paid_points ?? null,
    address: siteAddress(row.slug),
    path: `/s/${row.slug}/`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSites(user, { all = false } = {}) {
  const rows = all
    ? db.prepare('SELECT * FROM sites ORDER BY updated_at DESC').all()
    : db.prepare('SELECT * FROM sites WHERE user_id = ? ORDER BY updated_at DESC').all(user.id);
  return rows.map(serialize);
}

export function getSite(id, user) {
  const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, '站点不存在');
  if (row.user_id !== user.id && user.role !== 'admin') throw new HttpError(404, '站点不存在');
  return row;
}

export const siteBySlug = (slug) =>
  db.prepare('SELECT * FROM sites WHERE slug = ?').get(String(slug || '')) || null;

export async function createSite(user, body) {
  if (!config.sitesEnabled) throw new HttpError(403, '管理员没有开启静态站点功能');

  const slug = String(body.slug || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw bad('站点名需为 3-40 位小写字母、数字或连字符，且不能以连字符开头/结尾');
  if (siteBySlug(slug)) throw bad('这个站点名已经被占用了，换一个');

  const maxSites = config.defaultMaxSites;
  if (user.role !== 'admin' && countForUser(user.id) >= maxSites) {
    throw new HttpError(403, `站点数已达上限（${maxSites}）`);
  }

  const { files, total } = decodeFiles(body.files);
  const entry = pickEntry(files.map((f) => f.path));

  // Same gate as instances: publishing costs points, or one use of an old
  // resource voucher when the user still has one and typed it in.
  let invite = null;
  let paidPoints = 0;
  const inviteCode = String(body.inviteCode || '').trim();
  if (config.siteRequireInvite) {
    if (inviteCode) {
      invite = getInvite(inviteCode);
      const problem = inviteProblem(invite, 'instance', 'site');
      if (problem) throw new HttpError(403, problem);
      if (!consume(invite.code)) throw new HttpError(403, '这张资源券刚刚被用完了');
    } else {
      paidPoints = config.sitePointsCost;
      if (!spendPoints(user, paidPoints, 'site.create', slug)) {
        throw new HttpError(
          403,
          `积分不够：发布一个站点需要 ${paidPoints} 积分，你当前有 ${balanceOf(user.id)} 积分`
        );
      }
    }
  }

  const id = crypto.randomUUID();
  try {
    await writeFiles(id, files);
    db.prepare(
      `INSERT INTO sites (id, user_id, slug, invite_code, paid_points, memory_mb, cpus, entry, file_count, size_bytes, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      user.id,
      slug,
      invite?.code ?? null,
      paidPoints || null,
      config.siteMemoryMb,
      config.siteCpus,
      entry,
      files.length,
      total,
      String(body.note || '').slice(0, 500),
      now(),
      now()
    );
  } catch (err) {
    await fsp.rm(siteDir(id), { recursive: true, force: true }).catch(() => {});
    if (invite) refund(invite.code);
    if (paidPoints) refundPoints(user.id, paidPoints, 'site.create_failed', slug);
    notifications.create(user.id, {
      type: 'site.create_failed',
      priority: 'critical',
      title: '静态站点发布失败',
      message: `站点「${slug}」发布失败：${err.message}`,
      href: '#/sites',
      dedupeKey: `site.create_failed:${id}`,
    });
    throw err;
  }

  audit(
    user,
    'site.create',
    slug,
    `${files.length} 个文件 / ${total} 字节 / ${config.siteMemoryMb}MB · ${config.siteCpus} 核${
      invite ? ` (券 ${invite.code})` : paidPoints ? ` (${paidPoints} 积分)` : ''
    }`
  );
  notifications.create(user.id, {
    type: 'site.created',
    priority: 'success',
    title: '静态站点已上线',
    message: `站点「${slug}」已发布，可以访问 ${siteAddress(slug)}。`,
    href: '#/sites',
    dedupeKey: `site.created:${id}`,
  });
  return serialize(db.prepare('SELECT * FROM sites WHERE id = ?').get(id));
}

/** Re-drop over an existing site: files are replaced, the address stays. */
export async function redeploySite(row, user, body) {
  const { files, total } = decodeFiles(body.files);
  const entry = pickEntry(files.map((f) => f.path));
  await writeFiles(row.id, files);
  db.prepare('UPDATE sites SET entry = ?, file_count = ?, size_bytes = ?, updated_at = ? WHERE id = ?').run(
    entry,
    files.length,
    total,
    now(),
    row.id
  );
  audit(user, 'site.redeploy', row.slug, `${files.length} 个文件 / ${total} 字节`);
  notifications.create(user.id, {
    type: 'site.redeployed',
    priority: 'success',
    title: '静态站点已更新',
    message: `站点「${row.slug}」内容已更新。`,
    href: '#/sites',
    dedupeKey: `site.redeployed:${row.id}:${now()}`,
  });
  return serialize(db.prepare('SELECT * FROM sites WHERE id = ?').get(row.id));
}

export async function destroySite(row, user) {
  await fsp.rm(siteDir(row.id), { recursive: true, force: true }).catch(() => {});
  db.prepare('DELETE FROM sites WHERE id = ?').run(row.id);
  let refunded = false;
  let refundedPoints = 0;
  if (config.refundInviteOnDelete && row.invite_code) {
    refund(row.invite_code);
    refunded = true;
  }
  // 花积分发的站，删掉把分退回去 —— 和退券同一个开关管。
  if (config.refundInviteOnDelete && row.paid_points) {
    refundPoints(row.user_id, row.paid_points, 'site.delete', row.slug);
    refundedPoints = row.paid_points;
  }
  audit(
    user,
    'site.delete',
    row.slug,
    refunded ? `退回资源券 ${row.invite_code}` : refundedPoints ? `退回 ${refundedPoints} 积分` : null
  );
  return { refundedInvite: refunded ? row.invite_code : null, refundedPoints: refundedPoints || null };
}

/** Flat listing of what is actually on disk, for the site detail view. */
export function listFiles(row) {
  const root = siteDir(row.id);
  const out = [];
  const walk = (dir, prefix) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (e.isFile()) out.push({ path: rel, size: fs.statSync(path.join(dir, e.name)).size });
    }
  };
  walk(root, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Hit counting, batched so a busy page does not hammer SQLite. */
const pendingHits = new Map();
export function noteHit(id) {
  pendingHits.set(id, (pendingHits.get(id) ?? 0) + 1);
}
function flushHits() {
  if (!pendingHits.size) return;
  const stmt = db.prepare('UPDATE sites SET hits = hits + ?, last_hit_at = ? WHERE id = ?');
  const ts = now();
  for (const [id, n] of pendingHits) {
    try {
      stmt.run(n, ts, id);
    } catch {
      /* site was deleted mid-flight */
    }
  }
  pendingHits.clear();
}
setInterval(flushHits, 15_000).unref();

/**
 * Drops directories that no longer have a row (crash between write and insert)
 * and leftover scratch dirs. Only touches names this module could have created,
 * so a mis-set SITES_DIR cannot turn into a delete of someone's folder.
 */
const OURS = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.tmp-[0-9a-f]{8})?$/i;

export function sweepOrphanDirs() {
  if (!config.sitesEnabled || !fs.existsSync(config.sitesDir)) return;
  const known = new Set(db.prepare('SELECT id FROM sites').all().map((r) => r.id));
  for (const name of fs.readdirSync(config.sitesDir)) {
    if (known.has(name) || !OURS.test(name)) continue;
    fs.rmSync(path.join(config.sitesDir, name), { recursive: true, force: true });
  }
}
