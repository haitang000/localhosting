import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { db } from './db.js';
import { logger } from './logger.js';

/**
 * Run the checks that are safe to perform every time the service starts.
 * Docker is deliberately not checked here: it is an optional runtime
 * dependency and the panel is designed to remain usable while Docker is down.
 */
export function runStartupSelfCheck() {
  const checks = [];
  const check = (name, fn, { optional = false } = {}) => {
    try {
      fn();
      checks.push({ name, ok: true, optional });
    } catch (error) {
      checks.push({ name, ok: false, optional, error: error.message });
    }
  };

  check('node', () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 5)) {
      throw new Error(`需要 Node.js >= 22.5.0，当前为 ${process.versions.node}`);
    }
  });

  check('config', () => {
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new Error(`PANEL_PORT 无效：${config.port}`);
    }
    if (!Number.isInteger(config.portPoolStart) || !Number.isInteger(config.portPoolEnd)
      || config.portPoolStart < 1 || config.portPoolEnd > 65535
      || config.portPoolStart > config.portPoolEnd) {
      throw new Error(`PORT_POOL 无效：${config.portPoolStart}-${config.portPoolEnd}`);
    }
    if (config.diskQuotaMb <= 0) throw new Error('DISK_QUOTA_MB 必须大于 0');
  });

  for (const [name, dir] of [
    ['data-dir', config.dataDir],
    ['sites-dir', config.sitesDir],
    ['announcement-images-dir', config.announcementImagesDir],
    ['cloudflared-credentials-dir', config.cfTunnelCredDir],
  ]) {
    check(name, () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
      const probe = path.join(dir, `.startup-check-${process.pid}`);
      try {
        fs.writeFileSync(probe, 'ok', { flag: 'wx' });
      } finally {
        try { fs.unlinkSync(probe); } catch { /* the write may have failed before creating it */ }
      }
    });
  }

  check('database', () => {
    const result = db.prepare('PRAGMA quick_check').get();
    if (!result || result.quick_check !== 'ok') {
      throw new Error(`SQLite quick_check 返回 ${result?.quick_check || '未知结果'}`);
    }
  });

  for (const file of ['public/index.html', 'public/style.css']) {
    check(`static:${file}`, () => {
      const stat = fs.statSync(path.join(ROOT, file));
      if (!stat.isFile() || stat.size === 0) throw new Error('文件不存在或为空');
    });
  }

  const failed = checks.filter((item) => !item.ok);
  for (const item of checks) {
    if (item.ok) logger.debug('startup.selfcheck.passed', { check: item.name });
    else logger[item.optional ? 'warn' : 'error']('startup.selfcheck.failed', {
      check: item.name,
      error: item.error,
      optional: item.optional,
    });
  }
  if (!failed.length) logger.info('startup.selfcheck.passed', { checks: checks.length });
  return {
    ok: failed.every((item) => item.optional),
    checks,
  };
}
