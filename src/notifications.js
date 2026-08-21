import { db, now } from './db.js';

const RETENTION_DAYS = 90;
const MAX_PAGE = 100;

function publicRow(row) {
  return {
    id: row.id,
    type: row.type,
    priority: row.priority,
    title: row.title,
    message: row.message,
    href: row.href || null,
    read: Boolean(row.read_at),
    readAt: row.read_at || null,
    createdAt: row.created_at,
  };
}

/** Create one notification. The dedupe key makes lifecycle retries idempotent. */
export function create(userId, { type = 'system', priority = 'info', title, message, href = null, dedupeKey }) {
  if (!Number.isInteger(Number(userId)) || !title || !message) return null;
  const key = String(dedupeKey || `${type}:${userId}:${title}:${message}`);
  const result = db.prepare(
    `INSERT OR IGNORE INTO notifications
      (user_id, type, priority, title, message, href, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(Number(userId), String(type), ['info', 'success', 'warning', 'critical'].includes(priority) ? priority : 'info',
    String(title).slice(0, 200), String(message).slice(0, 1000), href ? String(href).slice(0, 300) : null, key.slice(0, 300), now());
  return result.changes ? db.prepare('SELECT * FROM notifications WHERE id = last_insert_rowid()').get() : null;
}

export function listForUser(userId, { page = 1, limit = 20 } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const n = Math.min(MAX_PAGE, Math.max(1, Number(limit) || 20));
  const total = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?').get(userId).c;
  const unread = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).c;
  const rows = db.prepare(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(userId, n, (p - 1) * n);
  return { notifications: rows.map(publicRow), unread, total, page: p, limit: n, pages: Math.max(1, Math.ceil(total / n)) };
}

export function recentForUser(userId, limit = 5) {
  return listForUser(userId, { page: 1, limit }).notifications;
}

export function markRead(userId, id) {
  const result = db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').run(now(), Number(id), userId);
  return result.changes > 0;
}

export function markAllRead(userId) {
  return db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), userId).changes;
}

export function unreadCount(userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).c;
}

export function cleanup() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
  return db.prepare('DELETE FROM notifications WHERE created_at < ?').run(cutoff).changes;
}

let timer;
export function start() {
  cleanup();
  timer = setInterval(cleanup, 24 * 3600_000);
  timer.unref();
}
export function stop() { if (timer) clearInterval(timer); timer = null; }

