import path from 'node:path';
import { Router } from 'express';
import { config } from '../config.js';
import { db, audit, now } from '../db.js';
import { requireAuth } from '../auth.js';
import * as svc from '../sites.js';

/* ---------------------------------------------------------------- API ---- */

export const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json({
    sites: svc.listSites(req.user),
    limits: {
      maxSites: config.defaultMaxSites,
      maxBytes: config.siteMaxBytes,
      maxFiles: config.siteMaxFiles,
      requireInvite: config.siteRequireInvite,
      // 一个站点占多少 —— 券再大也按这个数记
      memoryMb: config.siteMemoryMb,
      cpus: config.siteCpus,
    },
  });
});

router.post('/', async (req, res) => {
  res.status(201).json({ site: await svc.createSite(req.user, req.body || {}) });
});

router.get('/:id', (req, res) => {
  const row = svc.getSite(req.params.id, req.user);
  res.json({ site: svc.serialize(row), files: svc.listFiles(row) });
});

/** Drop new files over an existing site — same address, new content. */
router.post('/:id/files', async (req, res) => {
  const row = svc.getSite(req.params.id, req.user);
  res.json({ site: await svc.redeploySite(row, req.user, req.body || {}) });
});

router.patch('/:id', (req, res) => {
  const row = svc.getSite(req.params.id, req.user);
  const b = req.body || {};
  if (b.slug !== undefined) {
    const slug = String(b.slug).trim().toLowerCase();
    if (!svc.SLUG_RE.test(slug)) return res.status(400).json({ error: '站点名需为 3-40 位小写字母、数字或连字符' });
    const clash = svc.siteBySlug(slug);
    if (clash && clash.id !== row.id) return res.status(400).json({ error: '这个站点名已经被占用了' });
    db.prepare('UPDATE sites SET slug = ?, updated_at = ? WHERE id = ?').run(slug, now(), row.id);
    audit(req.user, 'site.rename', row.slug, `→ ${slug}`);
  }
  if (b.note !== undefined) {
    db.prepare('UPDATE sites SET note = ? WHERE id = ?').run(String(b.note).slice(0, 500), row.id);
  }
  res.json({ site: svc.serialize(db.prepare('SELECT * FROM sites WHERE id = ?').get(row.id)) });
});

router.delete('/:id', async (req, res) => {
  const row = svc.getSite(req.params.id, req.user);
  res.json({ ok: true, ...(await svc.destroySite(row, req.user)) });
});

/* ------------------------------------------------------- public serving --- */

// User pages run on the panel's own origin. The sandbox header gives every page
// an opaque origin, so a published page cannot read panel cookies or call the
// panel API as the visitor. Turn SITE_SANDBOX off only when you serve sites
// from a separate hostname.
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

function siteHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
  if (config.siteSandbox) res.setHeader('Content-Security-Policy', SANDBOX);
}

/* Styled like the panel's own 404.html, but self-contained: these responses
   wear the sandbox header (opaque origin) and may one day be served from a
   separate hostname, so they can't lean on /style.css. Colours are the panel
   palette, hard-coded. */
const nfPage = (title, hint) => `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
<title>404 · ${title}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    background: #ffffff; color: #11181c; text-align: center;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI",
      "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", system-ui, sans-serif;
    font-size: 15px; line-height: 1.6; -webkit-font-smoothing: antialiased;
  }
  svg { display: block; width: 56px; height: 56px; margin: 0 auto 20px; }
  svg rect { fill: none; stroke: #006fee; stroke-width: 3; }
  .code { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: 0.18em; color: #71717a; }
  h1 { margin: 4px 0 8px; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
  p { margin: 0; font-size: 13px; color: #71717a; text-wrap: balance; }
  @media (prefers-color-scheme: dark) {
    body { background: #000000; color: #ecedee; }
    svg rect { stroke: #338ef7; }
    .code, p { color: #a1a1aa; }
  }
</style></head>
<body><main>
  <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="5" width="22" height="22" rx="7" /></svg>
  <p class="code">404</p>
  <h1>${title}</h1>
  <p>${hint}</p>
</main></body></html>`;

const notFound = (res, dir) => {
  siteHeaders(res);
  res.status(404);
  if (dir) {
    // 站点自带 404.html 的永远先用它 —— 这一页长什么样，站主说了算。
    return res.sendFile('404.html', { root: dir, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.type('html').send(nfPage('页面不存在', '站点里没有这个页面。'));
      else if (err) res.end();
    });
  }
  res.type('html').send(nfPage('站点不存在', '这个站点不存在，或者已经被删除。'));
};

export const serveRouter = Router();

// Mounted at /s, so req.path here is "/<slug>/<file...>". Parsed by hand rather
// than with a wildcard route: fewer surprises around encoding and trailing
// slashes, and it keeps the traversal check in one obvious place.
serveRouter.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  let decoded;
  try {
    decoded = req.path.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return res.status(400).type('text/plain; charset=utf-8').send('400 — 路径编码不合法');
  }
  if (!decoded.length) return notFound(res, null);

  const [slug, ...rest] = decoded;
  const site = svc.siteBySlug(slug);
  if (!site) return notFound(res, null);

  // Without the trailing slash every relative link in the page would resolve
  // one level too high.
  if (!rest.length && !req.path.endsWith('/')) {
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    return res.redirect(302, `/s/${encodeURIComponent(slug)}/${qs}`);
  }

  // 段在解码后复查：%2e%2e%2f 解码会变成含 / 的段，字面检查拦不住，
  // 靠 sendFile 的根目录包含检查兜底之外，这里直接拒绝（文件名里不可能有 /）。
  if (rest.some((s) => !s || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0'))) {
    return res.status(400).type('text/plain; charset=utf-8').send('400 — 路径不合法');
  }

  const dir = svc.siteDir(site.id);
  const rel = !rest.length
    ? site.entry
    : req.path.endsWith('/')
      ? path.posix.join(rest.join('/'), 'index.html')
      : rest.join('/');

  siteHeaders(res);
  svc.noteHit(site.id);
  res.sendFile(rel, { root: dir, dotfiles: 'deny', maxAge: 0 }, (err) => {
    if (!err) return;
    if (res.headersSent) return res.end();
    notFound(res, dir);
  });
});
