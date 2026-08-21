import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { logger } from './logger.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'panel.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash      TEXT    NOT NULL,
  role               TEXT    NOT NULL DEFAULT 'user',
  disabled           INTEGER NOT NULL DEFAULT 0,
  max_instances      INTEGER NOT NULL,
  max_memory_mb      INTEGER NOT NULL,
  max_cpus           REAL    NOT NULL,
  max_ports          INTEGER NOT NULL,
  allow_custom_image INTEGER NOT NULL DEFAULT 0,
  -- 新手引导的 UI 状态（走到第几步、跳没跳过），进度本身由实例/站点推导
  onboarding_json    TEXT,
  created_at         TEXT    NOT NULL,
  last_login_at      TEXT
);

-- type = 'register' 注册邀请码 | 'instance' 实例资源券（带内存/CPU/端口额度）
-- scope（只对资源券有意义）= 'any' 建实例和发静态网页都行 | 'site' 只能发静态网页
-- issued_to 有值时表示这张券是面板送给某个人的（注册见面礼），只有他自己看得到
-- expires_at 是「券本身什么时候作废」，instance_days 是「用它建出来的实例能活多久」，
-- 两件不同的事：一张三天后作废的券，也可以换一台跑一年的机器
CREATE TABLE IF NOT EXISTS invites (
  code               TEXT PRIMARY KEY,
  type               TEXT NOT NULL DEFAULT 'register',
  scope              TEXT NOT NULL DEFAULT 'any',
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_to          INTEGER REFERENCES users(id) ON DELETE CASCADE,
  note               TEXT NOT NULL DEFAULT '',
  max_uses           INTEGER NOT NULL DEFAULT 1,
  uses               INTEGER NOT NULL DEFAULT 0,
  memory_mb          INTEGER,
  cpus               REAL,
  ports              INTEGER,
  allow_custom_image INTEGER NOT NULL DEFAULT 0,
  expires_at         TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Only a short, server-derived device label and a masked network hint are
  -- retained. This makes sessions recognisable without storing a full UA/IP.
  device_label TEXT NOT NULL DEFAULT '',
  ip_hint      TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instances (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  container_id TEXT,
  image        TEXT NOT NULL,
  template_id  TEXT,
  memory_mb    INTEGER NOT NULL,
  cpus         REAL NOT NULL,
  env_json     TEXT NOT NULL DEFAULT '{}',
  dependencies_json TEXT NOT NULL DEFAULT '{}',
  ports_json   TEXT NOT NULL DEFAULT '[]',
  volume_name  TEXT,
  invite_code  TEXT,
  -- 用户提交申请时保存下来，管理员批准后才拿去真正建容器
  cmd_json          TEXT,
  volume_paths_json TEXT,
  note              TEXT,
  reject_reason     TEXT,
  reviewed_by       TEXT,
  reviewed_at       TEXT,
  -- pending → creating → running / stopped，或 pending → rejected
  -- 到期后还会走到 archived（封存）：容器停掉，数据卷原样留着
  status       TEXT NOT NULL DEFAULT 'pending',
  error        TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (user_id, name)
);

-- 拖进来的静态站点：没有容器、不占端口，面板自己按 /s/<slug>/ 提供
-- memory_mb / cpus 是发布时按 SITE_MEMORY_MB / SITE_CPUS 记下的名义占用（默认 32MB / 0.1 核），
-- 不管花的是哪种券都按这个口径算 —— 发个网页不该按一整台机器计费
CREATE TABLE IF NOT EXISTS sites (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  invite_code TEXT,
  memory_mb   INTEGER NOT NULL DEFAULT 32,
  cpus        REAL    NOT NULL DEFAULT 0.1,
  entry       TEXT NOT NULL DEFAULT 'index.html',
  file_count  INTEGER NOT NULL DEFAULT 0,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  hits        INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS port_allocations (
  port        INTEGER PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  allocated_at TEXT NOT NULL
);

-- 积分流水：每一笔发放/消费/退回都留一行，balance 是记账后的余额快照，
-- 对账时不用把 delta 从头加一遍。ref 是关联对象（站点 slug、实例名、兑换码）。
CREATE TABLE IF NOT EXISTS point_txns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta      INTEGER NOT NULL,
  balance    INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  ref        TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  username   TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS announcements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  format      TEXT NOT NULL DEFAULT 'markdown',
  priority    TEXT NOT NULL DEFAULT 'info',
  active      INTEGER NOT NULL DEFAULT 1,
  dismissible INTEGER NOT NULL DEFAULT 1,
  starts_at   TEXT,
  ends_at     TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 用户站内通知：业务状态提醒与公告分开，通知只属于一个账号。
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  priority    TEXT NOT NULL DEFAULT 'info',
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  href        TEXT,
  dedupe_key  TEXT NOT NULL,
  read_at     TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, dedupe_key)
);

-- 积分套餐（管理后台「套餐」页维护）：内存 + CPU + 硬盘打包价。
-- 首次启动用 POINTS_BUNDLES 播种，之后以这里的记录为准，改环境变量不再生效。
-- days：用它建出来的实例能活几天（NULL = 跟随全局 POINTS_INSTANCE_DAYS，0 = 永久）；
-- stock：剩余可购份数（-1 = 不限量），每建一个实例扣 1，驳回/失败/删除退 1。
CREATE TABLE IF NOT EXISTS bundles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL DEFAULT '',
  memory_mb  INTEGER NOT NULL,
  cpus       REAL    NOT NULL,
  disk_mb    INTEGER NOT NULL DEFAULT 2048,
  cost       INTEGER NOT NULL,
  days       INTEGER,
  stock      INTEGER NOT NULL DEFAULT -1,
  enabled    INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

-- 危险操作预警（src/guard.js）：命中挖矿等特征时记一条，管理员在后台处理。
-- user_id / instance_id 故意不设外键 —— 实例和用户可能先被删掉，预警（连同
-- 封禁依据）要留下来，所以 username / instance_name 是写入时的快照。
-- source：process（进程扫描）/ console（控制台输入）/ create（创建参数）/ upload（上传文件名）
-- status：open（待处理）→ resolved；action 记管理员最终怎么处置的。
CREATE TABLE IF NOT EXISTS alerts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER,
  username       TEXT    NOT NULL,
  instance_id    TEXT,
  instance_name  TEXT,
  source         TEXT    NOT NULL,
  rule           TEXT    NOT NULL,
  label          TEXT    NOT NULL,
  detail         TEXT    NOT NULL DEFAULT '',
  status         TEXT    NOT NULL DEFAULT 'open',
  action         TEXT,
  seen_count     INTEGER NOT NULL DEFAULT 1,
  first_seen_at  TEXT    NOT NULL,
  last_seen_at   TEXT    NOT NULL,
  resolved_by    TEXT,
  resolved_at    TEXT
);

-- 面板级设置（key-value）：管理后台可改、不需要重启生效的东西。
-- 首次启动用环境变量播种，之后以数据库里的值为准。
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_instances_user ON instances(user_id);
CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_instance ON alerts(instance_id, status);
CREATE INDEX IF NOT EXISTS idx_point_txns_user ON point_txns(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_at, id DESC);
`);

// Lightweight forward migrations for databases created by earlier versions.
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  logger.debug('db.migration.applied', { table, column });
}
addColumn('users', 'onboarding_json', 'TEXT');
addColumn('invites', 'type', "TEXT NOT NULL DEFAULT 'register'");
addColumn('invites', 'scope', "TEXT NOT NULL DEFAULT 'any'");
addColumn('invites', 'issued_to', 'INTEGER');
addColumn('invites', 'memory_mb', 'INTEGER');
addColumn('invites', 'cpus', 'REAL');
addColumn('invites', 'ports', 'INTEGER');
addColumn('invites', 'allow_custom_image', 'INTEGER NOT NULL DEFAULT 0');
addColumn('invites', 'instance_days', 'INTEGER');
addColumn('sites', 'memory_mb', 'INTEGER NOT NULL DEFAULT 32');
addColumn('sites', 'cpus', 'REAL NOT NULL DEFAULT 0.1');
addColumn('instances', 'invite_code', 'TEXT');
addColumn('instances', 'dependencies_json', "TEXT NOT NULL DEFAULT '{}'");
addColumn('instances', 'cmd_json', 'TEXT');
addColumn('instances', 'volume_paths_json', 'TEXT');
addColumn('instances', 'reject_reason', 'TEXT');
addColumn('instances', 'reviewed_by', 'TEXT');
addColumn('instances', 'reviewed_at', 'TEXT');
addColumn('instances', 'note', 'TEXT');
addColumn('instances', 'sleep_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('instances', 'idle_minutes', 'INTEGER');
addColumn('instances', 'slept_at', 'TEXT');
addColumn('instances', 'woke_at', 'TEXT');
// 有效期：life_days 是建实例时从资源券上抄下来的天数（NULL/0 = 永久），
// expires_at 等容器真的建起来了才落地 —— 排队等审批的日子不该算进寿命里。
addColumn('instances', 'life_days', 'INTEGER');
addColumn('instances', 'expires_at', 'TEXT');
addColumn('instances', 'archived_at', 'TEXT');
// 用户最近同意的《用户协议》和《隐私政策》版本及时间；完整历史在 audit_log
addColumn('users', 'terms_agreed_version', 'TEXT');
addColumn('users', 'terms_agreed_at', 'TEXT');
addColumn('users', 'privacy_agreed_version', 'TEXT');
addColumn('users', 'privacy_agreed_at', 'TEXT');
// 积分：新用户注册送一笔，发站点/建实例用它付账；老资源券仍然可用，两条路并存
addColumn('users', 'points', 'INTEGER NOT NULL DEFAULT 0');
// 积分兑换码（invites.type = 'points'）每次兑换给多少分
addColumn('invites', 'points', 'INTEGER');
// 资源券自带的数据卷配额（MB）；老券没有这列 = 用全局 DISK_QUOTA_MB
addColumn('invites', 'disk_mb', 'INTEGER');
// 这个站点/实例是花积分开的话，花了多少 —— 删除/失败时照这个数退，退完置 NULL 防双退
addColumn('sites', 'paid_points', 'INTEGER');
addColumn('instances', 'paid_points', 'INTEGER');
// 每日签到日期（YYYY-MM-DD），空 = 从未签到。用于阻止同一天多次签到。
addColumn('users', 'last_checkin_date', 'TEXT');
// 积分实例的数据卷配额（MB）；老实例没有这列，回退到全局 DISK_QUOTA_MB。
addColumn('instances', 'disk_mb', 'INTEGER');
// 花积分开、且命中了打包套餐的实例记下套餐 id：删除/驳回/创建失败时把套餐余量退回去。
addColumn('instances', 'bundle_id', 'INTEGER');
// 套餐字段：实例时长（NULL=跟随全局，0=永久）、剩余份数（-1=不限量）
addColumn('bundles', 'days', 'INTEGER');
addColumn('bundles', 'stock', 'INTEGER NOT NULL DEFAULT -1');
// 自动穿透：Cloudflare Tunnel 记录（tunnelId / hostnames / 凭据文件路径 / pid）
addColumn('instances', 'tunnel_json', 'TEXT');
// Existing installations receive session-management metadata without invalidating
// their active sessions. Old rows simply appear as an unknown device.
addColumn('sessions', 'device_label', "TEXT NOT NULL DEFAULT ''");
addColumn('sessions', 'ip_hint', "TEXT NOT NULL DEFAULT ''");

export const now = () => new Date().toISOString();

logger.info('db.ready', { dataDir: config.dataDir });

export function audit(user, action, target, detail) {
  db.prepare(
    'INSERT INTO audit_log (user_id, username, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(user?.id ?? null, user?.username ?? null, action, target ?? null, detail ? String(detail) : null, now());
  logger.debug('audit.write', {
    userId: user?.id ?? null,
    action,
    target: target ?? null,
  });
}
