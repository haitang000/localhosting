import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { config } from './config.js';
import { db, now } from './db.js';

const PRIORITY_ORDER = { critical: 3, warning: 2, info: 1 };

const ALLOWED_TAGS = ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'b', 'i',
  'a', 'ul', 'ol', 'li', 'code', 'pre', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'del', 'ins', 'sup', 'sub', 'img', 'span', 'div', 'kbd', 'mark'];

const ALLOWED_ATTRS = { a: ['href', 'title', 'target'], img: ['src', 'alt', 'title', 'width', 'height'] };
const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:', 'data:'];
const SAFE_TARGETS = ['_blank', '_self'];

function sanitizeHtml(html) {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/gi;
  let out = '';
  let last = 0;
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    out += escText(html.slice(last, match.index));
    if (ALLOWED_TAGS.indexOf(tag) === -1) { last = match.index + match[0].length; continue; }
    const full = match[0];
    if (full.startsWith('</')) { out += `</${tag}>`; last = match.index + full.length; continue; }
    const selfClose = full.endsWith('/>');
    out += '<' + tag;
    const attrStr = full.slice(tag.length + 1).replace(/\/?>$/, '');
    const allowed = ALLOWED_ATTRS[tag];
    if (allowed && attrStr) {
      const attrRe = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
      let am;
      while ((am = attrRe.exec(attrStr)) !== null) {
        const name = am[1].toLowerCase();
        const value = am[2] ?? am[3] ?? am[4] ?? '';
        if (allowed.indexOf(name) === -1) continue;
        if (name === 'href' || name === 'src') {
          const lv = value.toLowerCase();
          if (!SAFE_PROTOCOLS.some(p => lv.startsWith(p)) && !lv.startsWith('/') && !lv.startsWith('#') && !lv.startsWith('.')) continue;
        }
        if (name === 'target' && SAFE_TARGETS.indexOf(value) === -1) continue;
        out += ` ${name}="${escAttr(value)}"`;
      }
    }
    out += selfClose ? ' />' : '>';
    last = match.index + full.length;
  }
  out += escText(html.slice(last));
  return out;
}

function escText(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function renderHtml(text, format) {
  if (format === 'markdown') return sanitizeHtml(marked.parse(String(text), { breaks: true, headerIds: false }));
  return '<p>' + escText(String(text)).replace(/\n/g, '<br>') + '</p>';
}

function row(r) {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    format: r.format || 'markdown',
    html: renderHtml(r.content, r.format),
    priority: r.priority || 'info',
    active: !!r.active,
    dismissible: !!r.dismissible,
    startsAt: r.starts_at || null,
    endsAt: r.ends_at || null,
    createdBy: r.created_by || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export { row };

export function listActive() {
  const rows = db.prepare(
    `SELECT * FROM announcements WHERE active = 1
     AND (starts_at IS NULL OR starts_at <= ?)
     AND (ends_at IS NULL OR ends_at >= ?)
     ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC`
  ).all(now(), now());
  return rows.map(row);
}

export function listAll() {
  const rows = db.prepare(
    `SELECT a.*, u.username AS creator_name FROM announcements a
     LEFT JOIN users u ON u.id = a.created_by ORDER BY a.created_at DESC`
  ).all();
  return rows.map(r => ({ ...row(r), creatorName: r.creator_name || null }));
}

export function create(fields, user) {
  const title = String(fields.title || '').trim();
  if (!title || title.length > 200) throw Object.assign(new Error('标题不能为空且不超过 200 字'), { status: 400 });
  const content = String(fields.content || '');
  if (!content) throw Object.assign(new Error('内容不能为空'), { status: 400 });
  const format = fields.format === 'text' ? 'text' : 'markdown';
  const priority = ['info', 'warning', 'critical'].includes(fields.priority) ? fields.priority : 'info';
  const active = fields.active === undefined || fields.active === null ? 1 : (fields.active ? 1 : 0);
  const dismissible = fields.dismissible === undefined || fields.dismissible === null ? 1 : (fields.dismissible ? 1 : 0);
  const startsAt = fields.startsAt ? String(fields.startsAt) : null;
  const endsAt = fields.endsAt ? String(fields.endsAt) : null;

  const ts = now();
  db.prepare(
    `INSERT INTO announcements (title, content, format, priority, active, dismissible, starts_at, ends_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, content, format, priority, active, dismissible, startsAt, endsAt, user.id, ts, ts);
  return db.prepare('SELECT * FROM announcements WHERE id = last_insert_rowid()').get();
}

export function update(id, fields) {
  const ann = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  if (!ann) throw Object.assign(new Error('公告不存在'), { status: 404 });

  const sets = [];
  const vals = [];
  const add = (col, val) => { sets.push(`${col} = ?`); vals.push(val); };

  if (fields.title !== undefined) {
    const t = String(fields.title || '').trim();
    if (!t || t.length > 200) throw Object.assign(new Error('标题不能为空且不超过 200 字'), { status: 400 });
    add('title', t);
  }
  if (fields.content !== undefined) {
    if (!fields.content) throw Object.assign(new Error('内容不能为空'), { status: 400 });
    add('content', String(fields.content));
  }
  if (fields.format !== undefined) add('format', fields.format === 'text' ? 'text' : 'markdown');
  if (fields.priority !== undefined) add('priority', ['info', 'warning', 'critical'].includes(fields.priority) ? fields.priority : 'info');
  if (fields.active !== undefined) add('active', fields.active ? 1 : 0);
  if (fields.dismissible !== undefined) add('dismissible', fields.dismissible ? 1 : 0);
  if (fields.startsAt !== undefined) add('starts_at', fields.startsAt ? String(fields.startsAt) : null);
  if (fields.endsAt !== undefined) add('ends_at', fields.endsAt ? String(fields.endsAt) : null);

  if (sets.length === 0) return ann;

  add('updated_at', now());
  db.prepare(`UPDATE announcements SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
}

export function del(id) {
  const ann = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  if (!ann) throw Object.assign(new Error('公告不存在'), { status: 404 });
  db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
}

// ---------- announcement images ----------

// Detected by magic bytes, not by trusting the client's filename or MIME type.
// SVG is deliberately absent: an uploaded SVG can carry scripts, and it would
// be served from the panel's own origin.
const IMAGE_MAGIC = [
  { ext: 'png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', test: (b) => b.length > 6 && b.toString('ascii', 0, 4) === 'GIF8' },
  { ext: 'webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { ext: 'avif', test: (b) => b.length > 12 && ['ftypavif', 'ftypavis'].includes(b.toString('ascii', 4, 12)) },
];

/** base64 comes inside a JSON body (no multipart parser, like the site drop). */
export function uploadImage(base64) {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) throw Object.assign(new Error('没有收到图片数据'), { status: 400 });
  if (buf.length > config.announcementImageMaxBytes) {
    throw Object.assign(
      new Error(`图片超过大小上限（${Math.round(config.announcementImageMaxBytes / 1048576)} MB）`),
      { status: 400 }
    );
  }
  const hit = IMAGE_MAGIC.find((m) => m.test(buf));
  if (!hit) throw Object.assign(new Error('不支持的图片格式（支持 PNG / JPG / GIF / WebP / AVIF）'), { status: 400 });
  const name = `${crypto.randomBytes(8).toString('hex')}.${hit.ext}`;
  fs.writeFileSync(path.join(config.announcementImagesDir, name), buf);
  return { name, url: `/announcement-images/${name}`, bytes: buf.length };
}

/** 启动时清掉公告里已不再引用、还躺在目录里的上传图片。 */
export function sweepImages() {
  let referenced = new Set();
  try {
    for (const r of db.prepare('SELECT content FROM announcements').all()) {
      const re = /\/announcement-images\/([a-f0-9]{16}\.[a-z0-9]+)/g;
      let m;
      while ((m = re.exec(String(r.content))) !== null) referenced.add(m[1]);
    }
  } catch {
    return;
  }
  const pattern = /^[a-f0-9]{16}\.(png|jpg|gif|webp|avif)$/;
  for (const entry of fs.readdirSync(config.announcementImagesDir)) {
    if (!pattern.test(entry) || referenced.has(entry)) continue;
    try { fs.unlinkSync(path.join(config.announcementImagesDir, entry)); } catch {}
  }
}
