import { db, now } from './db.js';
import { config } from './config.js';

/**
 * 面板级设置（key-value，存 settings 表）：管理后台可改、改完立即生效，
 * 不用重启面板。首次启动（表里还没有对应键）时用环境变量播种，之后以
 * 数据库里的值为准 —— 和套餐同一套逻辑。
 */

export function seedSettings() {
  const seeds = {
    panel_name: config.panelName,
    panel_color: config.panelColor,
    panel_description: config.panelDescription,
    captcha_mode: config.captchaStrict ? 'strict' : 'normal',
    guard_auto_ban: config.guardAutoBan ? '1' : '0',
    maintenance_mode: config.maintenanceMode ? '1' : '0',
  };
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  for (const [key, value] of Object.entries(seeds)) {
    if (value == null) continue;
    if (!get.get(key)) ins.run(key, String(value), now());
  }
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(key, String(value), now());
}

/** 面板品牌名：登录页、顶栏、浏览器标题都用它。 */
export function panelName() {
  return getSetting('panel_name', config.panelName);
}

/** 主题色（#rrggbb）：logo 和主强调色都由它派生。 */
export function panelColor() {
  const v = getSetting('panel_color', config.panelColor);
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : config.panelColor;
}

/** 站点描述（SEO）：首页 <meta name="description"> 的出处。 */
export function panelDescription() {
  return getSetting('panel_description', config.panelDescription);
}

/** 维护模式：开启后非管理员一律 503。管理后台可开关，立即生效。 */
export function maintenanceMode() {
  return getSetting('maintenance_mode', config.maintenanceMode ? '1' : '0') === '1';
}

/** 验证码严格程度：normal = 行为检测、拿不准才出图；strict = 每次都出图。 */
export function captchaMode() {
  const v = getSetting('captcha_mode', config.captchaStrict ? 'strict' : 'normal');
  return v === 'strict' ? 'strict' : 'normal';
}

export const captchaStrict = () => captchaMode() === 'strict';

/** 危险预警自动封禁：开启时新命中的可运行实例会自动封禁并结案。 */
export function guardAutoBan() {
  return getSetting('guard_auto_ban', config.guardAutoBan ? '1' : '0') === '1';
}
