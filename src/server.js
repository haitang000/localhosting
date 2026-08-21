import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import compression from 'compression';
import { config, ROOT, panelBaseUrl, panelAddressUnset, siteAddress } from './config.js';
import { preloadStaticAssets, servePrecompressed } from './static-assets.js';
import * as seo from './seo.js';
import { renderLanding } from './landing.js';
import { attachUser, bootstrapAdmin } from './auth.js';
import { publicTemplates } from './templates.js';
import { poolStats } from './ports.js';
import { reconcile, HttpError } from './instances.js';
import { db } from './db.js';
import * as dk from './docker.js';
import * as sleeper from './sleeper.js';
import * as lifespan from './lifespan.js';
import * as diskguard from './diskguard.js';
import * as guard from './guard.js';
import * as cftunnel from './cftunnel.js';
import { sweepOrphanDirs } from './sites.js';
import { TERMS_VERSION, TERMS_UPDATED, TERMS_HTML } from './terms.js';
import * as announcements from './announcements.js';
import { router as authRoutes } from './routes/auth.js';
import { router as instanceRoutes } from './routes/instances.js';
import { router as fileRoutes } from './routes/files.js';
import { router as adminRoutes, announcementImageRouter } from './routes/admin.js';
import { router as siteRoutes, serveRouter as siteServeRoutes } from './routes/sites.js';
import { router as checkinRoutes } from './routes/checkin.js';
import { seedBundles, listBundles } from './bundles.js';
import { seedSettings, panelName, panelColor, panelDescription, captchaMode, maintenanceMode } from './settings.js';
import { logger, requestLogger, logUnhandledErrors } from './logger.js';
import { runStartupSelfCheck } from './self-check.js';

seedBundles();
seedSettings();

const app = express();
logUnhandledErrors();
app.use(requestLogger);
if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

// 给所有可压缩的响应上 brotli/gzip。SSE 流自带 Cache-Control: no-transform，
// compression 会自动跳过；预压缩的静态资源带 Content-Encoding，也不会被二次压缩。
app.use(compression({ threshold: 1024 }));

// ── 安全响应头 ──
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  // 面板本身不许被 iframe（防点击劫持）；静态站点和公告图片是给别人引用的，不加框限制。
  if (!req.path.startsWith('/s/') && !req.path.startsWith('/announcement-images/')) {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  }
  next();
});

// ── CSRF 门：/api 的写操作必须带自定义头 X-Lh-Csrf ──
// 跨站的表单提交带不了自定义头；跨源 fetch 想带自定义头必须先过 CORS 预检，
// 而这个面板从不回 Access-Control-Allow-*，预检必然失败。头本身不是秘密，
// 是「跨站代码根本带不上它」这件事在把关——静态站点同站 CSRF 的路就此堵死。
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.headers['x-lh-csrf'] === '1') return next();
  return res.status(403).json({ error: '拒绝跨站请求' });
});

/* ── 维护模式 ──
   开启后只有管理员能进；本机直连（localhost/127.0.0.1 且无 X-Forwarded-For，
   即不走 cloudflared 隧道的直接访问）也放行，方便在机器上调试。
   放行清单是「渲染维护页 / 登录页要用的静态资源」+
   「管理员被关在外面之后的退路」：/api/auth/*（登录、验证码、me）和
   /api/config、/api/health、/terms。其余页面（/、/s/、robots、sitemap）
   和 API 一律 503 —— 非管理员拿维护页，管理员凭会话照常使用面板。 */
const MAINT_OPEN_EXACT = [
  '/api/config',
  '/api/health',
  '/api/terms',
  '/api/auth/me',
  '/api/auth/login',
  '/api/auth/pow',
  '/api/auth/turnstile',
  '/api/auth/captcha',
  '/terms',
  '/terms.html',
  '/style.css',
  '/landing.css',
  '/landing-hero.js',
  '/landing-scroll.js',
  '/app.js',
  '/editor.js',
  '/icons.js',
];
/** 本机直连判定：面板绑在 127.0.0.1，cloudflared 隧道转发也是从本机连进来，
 *  所以靠 X-Forwarded-For 区分 —— 代理链路会带上真实访客 IP，直连不会带。 */
function isLocalDirect(req) {
  const addr = req.socket?.remoteAddress || '';
  const loopback =
    addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('::ffff:127.');
  return loopback && !req.headers['x-forwarded-for'];
}

app.use((req, res, next) => {
  if (!maintenanceMode()) return next();
  if (req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  // 维护模式放行本机直连：管理员在机器上维护时，浏览器 / curl 走 localhost 照常能用。
  if (isLocalDirect(req)) return next();
  const p = req.path;
  if (MAINT_OPEN_EXACT.includes(p) || p.startsWith('/announcement-images/') || p.startsWith('/vendor/')) {
    return next();
  }
  attachUser(req, res, () => {
    if (req.user?.role === 'admin') return next();
    if (p.startsWith('/api/')) {
      return res.status(503).json({ error: '面板维护中，请稍后再来', maintenance: true });
    }
    res.status(503).setHeader('Cache-Control', 'no-cache').type('html').send(maintenanceHtml(panelName()));
  });
});

/** 维护页：和 404 页同一套外观，503 语义（搜索引擎会当作临时下线，不降权）。
 *  下方带上当前生效的公告（listActive 已按优先级排序），维护期间正好是
 *  用户最该读到通知的时候。 */
const escHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function maintenanceHtml(name) {
  const esc = escHtml(name);
  const activeAnns = announcements.listActive();
  const annItems = activeAnns
    .map((a) => `
        <div class="announcement-item ${a.priority}">
          <div class="announcement-item-head">
            <span class="badge ${a.priority}">${({ critical: '重要', warning: '提醒', info: '信息' })[a.priority] || a.priority}</span>
            ${a.title ? `<b>${escHtml(a.title)}</b>` : ''}
          </div>
          <div class="announcement-item-body">${a.html}</div>
        </div>`)
    .join('');
  const annBlock = annItems
    ? `<div class="nf-anns">
        <div class="nf-anns-head"><b>公告</b><span class="sub">${activeAnns.length} 条</span></div>
        ${annItems}
      </div>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>维护中 · ${esc}</title>
    <meta name="robots" content="noindex" />
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <main class="nf-page">
      <div class="nf">
        <svg class="dotmark assemble" viewBox="0 0 32 32" role="img" aria-label="${esc}">
          <defs>
            <linearGradient id="dotmark-ink" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" /><stop offset="1" />
            </linearGradient>
          </defs>
          <g fill="url(#dotmark-ink)"><circle cx="3.53" cy="9.40" r="0.45" style="animation-delay:-427ms,459ms" /><circle cx="3.53" cy="10.87" r="0.45" style="animation-delay:-533ms,33ms" /><circle cx="3.53" cy="12.33" r="0.45" style="animation-delay:-638ms,435ms" /><circle cx="3.53" cy="13.80" r="0.45" style="animation-delay:-744ms,236ms" /><circle cx="3.53" cy="15.27" r="0.45" style="animation-delay:-850ms,653ms" /><circle cx="3.53" cy="16.73" r="0.45" style="animation-delay:-955ms,558ms" /><circle cx="3.53" cy="18.20" r="0.45" style="animation-delay:-1061ms,170ms" /><circle cx="3.53" cy="19.67" r="0.45" style="animation-delay:-1166ms,147ms" /><circle cx="3.53" cy="21.13" r="0.45" style="animation-delay:-1272ms,76ms" /><circle cx="3.53" cy="22.60" r="0.45" style="animation-delay:-1378ms,662ms" /><circle cx="5.00" cy="6.47" r="0.45" style="animation-delay:-322ms,421ms" /><circle cx="5.00" cy="7.93" r="0.45" style="animation-delay:-427ms,605ms" /><circle cx="5.00" cy="9.40" r="0.45" style="animation-delay:-533ms,132ms" /><circle cx="5.00" cy="10.87" r="0.45" style="animation-delay:-638ms,208ms" /><circle cx="5.00" cy="12.33" r="0.45" style="animation-delay:-744ms,639ms" /><circle cx="5.00" cy="13.80" r="0.45" style="animation-delay:-850ms,516ms" /><circle cx="5.00" cy="15.27" r="0.45" style="animation-delay:-955ms,388ms" /><circle cx="5.00" cy="16.73" r="0.45" style="animation-delay:-1061ms,440ms" /><circle cx="5.00" cy="18.20" r="0.45" style="animation-delay:-1166ms,118ms" /><circle cx="5.00" cy="19.67" r="0.45" style="animation-delay:-1272ms,85ms" /><circle cx="5.00" cy="21.13" r="0.45" style="animation-delay:-1378ms,184ms" /><circle cx="5.00" cy="22.60" r="0.45" style="animation-delay:-1483ms,331ms" /><circle cx="5.00" cy="24.07" r="0.45" style="animation-delay:-1589ms,142ms" /><circle cx="5.00" cy="25.53" r="0.45" style="animation-delay:-1694ms,695ms" /><circle cx="6.47" cy="5.00" r="0.45" style="animation-delay:-322ms,0ms" /><circle cx="6.47" cy="6.47" r="0.45" style="animation-delay:-427ms,634ms" /><circle cx="6.47" cy="7.93" r="0.45" style="animation-delay:-533ms,464ms" /><circle cx="6.47" cy="9.40" r="0.45" style="animation-delay:-638ms,577ms" /><circle cx="6.47" cy="10.87" r="0.45" style="animation-delay:-744ms,123ms" /><circle cx="6.47" cy="12.33" r="0.45" style="animation-delay:-850ms,293ms" /><circle cx="6.47" cy="13.80" r="0.45" style="animation-delay:-955ms,449ms" /><circle cx="6.47" cy="15.27" r="0.45" style="animation-delay:-1061ms,497ms" /><circle cx="6.47" cy="16.73" r="0.45" style="animation-delay:-1166ms,251ms" /><circle cx="6.47" cy="18.20" r="0.45" style="animation-delay:-1272ms,166ms" /><circle cx="6.47" cy="19.67" r="0.45" style="animation-delay:-1378ms,43ms" /><circle cx="6.47" cy="21.13" r="0.45" style="animation-delay:-1483ms,657ms" /><circle cx="6.47" cy="22.60" r="0.45" style="animation-delay:-1589ms,52ms" /><circle cx="6.47" cy="24.07" r="0.45" style="animation-delay:-1694ms,71ms" /><circle cx="6.47" cy="25.53" r="0.45" style="animation-delay:-1800ms,336ms" /><circle cx="6.47" cy="27.00" r="0.45" style="animation-delay:-1906ms,66ms" /><circle cx="7.93" cy="5.00" r="0.45" style="animation-delay:-427ms,487ms" /><circle cx="7.93" cy="6.47" r="0.45" style="animation-delay:-533ms,620ms" /><circle cx="7.93" cy="25.53" r="0.45" style="animation-delay:-1906ms,312ms" /><circle cx="7.93" cy="27.00" r="0.45" style="animation-delay:-2011ms,445ms" /><circle cx="9.40" cy="3.53" r="0.45" style="animation-delay:-427ms,194ms" /><circle cx="9.40" cy="5.00" r="0.45" style="animation-delay:-533ms,222ms" /><circle cx="9.40" cy="6.47" r="0.45" style="animation-delay:-638ms,676ms" /><circle cx="9.40" cy="25.53" r="0.45" style="animation-delay:-2011ms,14ms" /><circle cx="9.40" cy="27.00" r="0.45" style="animation-delay:-2117ms,553ms" /><circle cx="9.40" cy="28.47" r="0.45" style="animation-delay:-2222ms,355ms" /><circle cx="10.87" cy="3.53" r="0.45" style="animation-delay:-533ms,298ms" /><circle cx="10.87" cy="5.00" r="0.45" style="animation-delay:-638ms,667ms" /><circle cx="10.87" cy="6.47" r="0.45" style="animation-delay:-744ms,407ms" /><circle cx="10.87" cy="25.53" r="0.45" style="animation-delay:-2117ms,393ms" /><circle cx="10.87" cy="27.00" r="0.45" style="animation-delay:-2222ms,615ms" /><circle cx="10.87" cy="28.47" r="0.45" style="animation-delay:-2328ms,99ms" /><circle cx="12.33" cy="3.53" r="0.45" style="animation-delay:-638ms,629ms" /><circle cx="12.33" cy="5.00" r="0.45" style="animation-delay:-744ms,643ms" /><circle cx="12.33" cy="6.47" r="0.45" style="animation-delay:-850ms,492ms" /><circle cx="12.33" cy="25.53" r="0.45" style="animation-delay:-2222ms,568ms" /><circle cx="12.33" cy="27.00" r="0.45" style="animation-delay:-2328ms,378ms" /><circle cx="12.33" cy="28.47" r="0.45" style="animation-delay:-2434ms,24ms" /><circle cx="13.80" cy="3.53" r="0.45" style="animation-delay:-744ms,289ms" /><circle cx="13.80" cy="5.00" r="0.45" style="animation-delay:-850ms,265ms" /><circle cx="13.80" cy="6.47" r="0.45" style="animation-delay:-955ms,525ms" /><circle cx="13.80" cy="25.53" r="0.45" style="animation-delay:-2328ms,359ms" /><circle cx="13.80" cy="27.00" r="0.45" style="animation-delay:-2434ms,539ms" /><circle cx="13.80" cy="28.47" r="0.45" style="animation-delay:-2539ms,5ms" /><circle cx="15.27" cy="3.53" r="0.45" style="animation-delay:-850ms,9ms" /><circle cx="15.27" cy="5.00" r="0.45" style="animation-delay:-955ms,203ms" /><circle cx="15.27" cy="6.47" r="0.45" style="animation-delay:-1061ms,473ms" /><circle cx="15.27" cy="25.53" r="0.45" style="animation-delay:-2434ms,322ms" /><circle cx="15.27" cy="27.00" r="0.45" style="animation-delay:-2539ms,270ms" /><circle cx="15.27" cy="28.47" r="0.45" style="animation-delay:-2645ms,199ms" /><circle cx="16.73" cy="3.53" r="0.45" style="animation-delay:-955ms,426ms" /><circle cx="16.73" cy="5.00" r="0.45" style="animation-delay:-1061ms,218ms" /><circle cx="16.73" cy="6.47" r="0.45" style="animation-delay:-1166ms,369ms" /><circle cx="16.73" cy="25.53" r="0.45" style="animation-delay:-2539ms,161ms" /><circle cx="16.73" cy="27.00" r="0.45" style="animation-delay:-2645ms,189ms" /><circle cx="16.73" cy="28.47" r="0.45" style="animation-delay:-2750ms,241ms" /><circle cx="18.20" cy="3.53" r="0.45" style="animation-delay:-1061ms,520ms" /><circle cx="18.20" cy="5.00" r="0.45" style="animation-delay:-1166ms,586ms" /><circle cx="18.20" cy="6.47" r="0.45" style="animation-delay:-1272ms,397ms" /><circle cx="18.20" cy="25.53" r="0.45" style="animation-delay:-2645ms,411ms" /><circle cx="18.20" cy="27.00" r="0.45" style="animation-delay:-2750ms,572ms" /><circle cx="18.20" cy="28.47" r="0.45" style="animation-delay:-2856ms,468ms" /><circle cx="19.67" cy="3.53" r="0.45" style="animation-delay:-1166ms,364ms" /><circle cx="19.67" cy="5.00" r="0.45" style="animation-delay:-1272ms,232ms" /><circle cx="19.67" cy="6.47" r="0.45" style="animation-delay:-1378ms,601ms" /><circle cx="19.67" cy="25.53" r="0.45" style="animation-delay:-2750ms,374ms" /><circle cx="19.67" cy="27.00" r="0.45" style="animation-delay:-2856ms,175ms" /><circle cx="19.67" cy="28.47" r="0.45" style="animation-delay:-2962ms,246ms" /><circle cx="21.13" cy="3.53" r="0.45" style="animation-delay:-1272ms,596ms" /><circle cx="21.13" cy="5.00" r="0.45" style="animation-delay:-1378ms,326ms" /><circle cx="21.13" cy="6.47" r="0.45" style="animation-delay:-1483ms,57ms" /><circle cx="21.13" cy="25.53" r="0.45" style="animation-delay:-2856ms,307ms" /><circle cx="21.13" cy="27.00" r="0.45" style="animation-delay:-2962ms,383ms" /><circle cx="21.13" cy="28.47" r="0.45" style="animation-delay:-3067ms,478ms" /><circle cx="22.60" cy="3.53" r="0.45" style="animation-delay:-1378ms,549ms" /><circle cx="22.60" cy="5.00" r="0.45" style="animation-delay:-1483ms,19ms" /><circle cx="22.60" cy="6.47" r="0.45" style="animation-delay:-1589ms,47ms" /><circle cx="22.60" cy="25.53" r="0.45" style="animation-delay:-2962ms,80ms" /><circle cx="22.60" cy="27.00" r="0.45" style="animation-delay:-3067ms,137ms" /><circle cx="22.60" cy="28.47" r="0.45" style="animation-delay:-3173ms,350ms" /><circle cx="24.07" cy="5.00" r="0.45" style="animation-delay:-1589ms,544ms" /><circle cx="24.07" cy="6.47" r="0.45" style="animation-delay:-1694ms,610ms" /><circle cx="24.07" cy="25.53" r="0.45" style="animation-delay:-3067ms,109ms" /><circle cx="24.07" cy="27.00" r="0.45" style="animation-delay:-3173ms,563ms" /><circle cx="25.53" cy="5.00" r="0.45" style="animation-delay:-1694ms,279ms" /><circle cx="25.53" cy="6.47" r="0.45" style="animation-delay:-1800ms,506ms" /><circle cx="25.53" cy="7.93" r="0.45" style="animation-delay:-1906ms,402ms" /><circle cx="25.53" cy="9.40" r="0.45" style="animation-delay:-2011ms,104ms" /><circle cx="25.53" cy="10.87" r="0.45" style="animation-delay:-2117ms,317ms" /><circle cx="25.53" cy="12.33" r="0.45" style="animation-delay:-2222ms,341ms" /><circle cx="25.53" cy="13.80" r="0.45" style="animation-delay:-2328ms,255ms" /><circle cx="25.53" cy="15.27" r="0.45" style="animation-delay:-2434ms,691ms" /><circle cx="25.53" cy="16.73" r="0.45" style="animation-delay:-2539ms,303ms" /><circle cx="25.53" cy="18.20" r="0.45" style="animation-delay:-2645ms,534ms" /><circle cx="25.53" cy="19.67" r="0.45" style="animation-delay:-2750ms,38ms" /><circle cx="25.53" cy="21.13" r="0.45" style="animation-delay:-2856ms,672ms" /><circle cx="25.53" cy="22.60" r="0.45" style="animation-delay:-2962ms,114ms" /><circle cx="25.53" cy="24.07" r="0.45" style="animation-delay:-3067ms,686ms" /><circle cx="25.53" cy="25.53" r="0.45" style="animation-delay:-3173ms,582ms" /><circle cx="25.53" cy="27.00" r="0.45" style="animation-delay:-3278ms,61ms" /><circle cx="27.00" cy="6.47" r="0.45" style="animation-delay:-1906ms,90ms" /><circle cx="27.00" cy="7.93" r="0.45" style="animation-delay:-2011ms,624ms" /><circle cx="27.00" cy="9.40" r="0.45" style="animation-delay:-2117ms,274ms" /><circle cx="27.00" cy="10.87" r="0.45" style="animation-delay:-2222ms,681ms" /><circle cx="27.00" cy="12.33" r="0.45" style="animation-delay:-2328ms,591ms" /><circle cx="27.00" cy="13.80" r="0.45" style="animation-delay:-2434ms,482ms" /><circle cx="27.00" cy="15.27" r="0.45" style="animation-delay:-2539ms,648ms" /><circle cx="27.00" cy="16.73" r="0.45" style="animation-delay:-2645ms,213ms" /><circle cx="27.00" cy="18.20" r="0.45" style="animation-delay:-2750ms,151ms" /><circle cx="27.00" cy="19.67" r="0.45" style="animation-delay:-2856ms,454ms" /><circle cx="27.00" cy="21.13" r="0.45" style="animation-delay:-2962ms,416ms" /><circle cx="27.00" cy="22.60" r="0.45" style="animation-delay:-3067ms,501ms" /><circle cx="27.00" cy="24.07" r="0.45" style="animation-delay:-3173ms,511ms" /><circle cx="27.00" cy="25.53" r="0.45" style="animation-delay:-3278ms,95ms" /><circle cx="28.47" cy="9.40" r="0.45" style="animation-delay:-2222ms,345ms" /><circle cx="28.47" cy="10.87" r="0.45" style="animation-delay:-2328ms,156ms" /><circle cx="28.47" cy="12.33" r="0.45" style="animation-delay:-2434ms,227ms" /><circle cx="28.47" cy="13.80" r="0.45" style="animation-delay:-2539ms,28ms" /><circle cx="28.47" cy="15.27" r="0.45" style="animation-delay:-2645ms,260ms" /><circle cx="28.47" cy="16.73" r="0.45" style="animation-delay:-2750ms,284ms" /><circle cx="28.47" cy="18.20" r="0.45" style="animation-delay:-2856ms,128ms" /><circle cx="28.47" cy="19.67" r="0.45" style="animation-delay:-2962ms,180ms" /><circle cx="28.47" cy="21.13" r="0.45" style="animation-delay:-3067ms,530ms" /><circle cx="28.47" cy="22.60" r="0.45" style="animation-delay:-3173ms,430ms" /></g>
        </svg>
        <p class="nf-code">503</p>
        <h1>维护中</h1>
        <p class="sub">面板正在维护，暂时无法访问；管理员操作完成后会自动恢复，请稍后再来。</p>
        ${annBlock}
      </div>
    </main>
  </body>
</html>
`;
}

// Published static sites. Mounted before the JSON parser so page requests never
// touch it, and before the SPA fallback so /s/... is never swallowed by it.
if (config.sitesEnabled) {
  app.use('/s', siteServeRoutes);
  // Dropped files arrive base64'd inside the JSON body, hence the own limit.
  app.use(
    '/api/sites',
    attachUser,
    express.json({ limit: `${Math.ceil((config.siteMaxBytes * 1.4) / 1048576) + 1}mb` }),
    siteRoutes
  );
}

// Container file uploads also carry their bytes base64'd in a JSON body, so they
// bring their own limit and therefore have to be mounted ahead of the small
// global parser. Only /api/instances/:id/files* matches here; everything else
// falls through to the routers below.
if (config.filesEnabled) app.use('/api/instances', attachUser, fileRoutes);

// Announcement image uploads do the same trick (base64 in JSON), so they get
// their own body limit too — mounted ahead of the 256kb global parser.
app.use('/api/admin/announcement-images', attachUser, announcementImageRouter);

app.use(express.json({ limit: '256kb' }));

app.get('/api/health', async (_req, res) => {
  try {
    const v = await dk.ping();
    res.json({ ok: true, docker: { version: v.Version, api: v.ApiVersion, os: v.Os, arch: v.Arch } });
  } catch (err) {
    // 错误细节（管道名 / socket 路径 / 连接栈）只进服务端日志，不透给匿名访客。
    console.warn('[health] Docker 连接失败：', err.message);
    res.status(503).json({ ok: false, error: '无法连接 Docker' });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({
    panelName: panelName(),
    panelColor: panelColor(),
    panelDescription: panelDescription(),
    captchaMode: captchaMode(),
    maintenance: maintenanceMode(),
    publicHost: config.publicHost || null,
    publicScheme: config.publicScheme,
    // 面板自己的对外入口。addressUnset = 还没人告诉过面板它在公网上叫什么，
    // 站点地址只能显示本机地址。
    panel: { baseUrl: panelBaseUrl(), addressUnset: panelAddressUnset() },
    openRegistration: config.openRegistration,
    // 登录/注册表单是否要勾《用户协议》。null = 管理员关掉了这道门。
    terms: config.termsRequired ? { version: TERMS_VERSION, updated: TERMS_UPDATED } : null,
    ports: poolStats(),
    allowCustomImageByDefault: config.defaultAllowCustomImage,
    sites: {
      enabled: config.sitesEnabled,
      requireInvite: config.siteRequireInvite,
      maxBytes: config.siteMaxBytes,
      maxFiles: config.siteMaxFiles,
      maxSites: config.defaultMaxSites,
      memoryMb: config.siteMemoryMb,
      cpus: config.siteCpus,
    },
    welcomePoints: config.welcomePoints || null,
    // 积分定价：基础价含的规格 + 加配价目表，前端支付页拿它现算报价
    points: {
      siteCost: config.sitePointsCost,
      instanceCost: config.instancePointsCost,
      instanceSpec: {
        memoryMb: config.pointsInstanceMemoryMb,
        cpus: config.pointsInstanceCpus,
        ports: config.pointsInstancePorts,
        days: config.pointsInstanceDays || null,
        diskMb: config.pointsInstanceDiskMb,
      },
      addons: {
        memStepMb: config.pointsMemStepMb,
        memStepCost: config.pointsMemStepCost,
        cpuStepCost: config.pointsCpuStepCost,
        portCost: config.pointsPortCost,
        maxMemoryMb: config.pointsMaxMemoryMb,
        maxCpus: config.pointsMaxCpus,
        maxPorts: config.pointsMaxPorts,
        diskStepMb: config.pointsDiskStepMb,
        diskStepCost: config.pointsDiskStepCost,
        maxDiskMb: config.pointsMaxDiskMb,
      },
      // 打包套餐：管理后台维护，内存 + CPU + 硬盘三样全对才认直减价
      bundles: listBundles({ enabledOnly: true }),
    },
    console: { idleMinutes: config.consoleIdleMinutes },
    files: {
      enabled: config.filesEnabled,
      editMaxBytes: config.fileEditMaxBytes,
      uploadMaxBytes: config.fileUploadMaxBytes,
      uploadMaxFiles: config.fileUploadMaxFiles,
      maxEntries: config.fileMaxEntries,
    },
    announcementImages: { maxBytes: config.announcementImageMaxBytes },
    sleep: {
      enabled: config.idleSleepEnabled,
      defaultOn: config.idleSleepDefault,
      idleMinutes: config.idleMinutes,
    },
    // 自动穿透可用性（只给域名，凭据永不出服务端）
    cfTunnel: cftunnel.enabled() ? { domain: config.cfTunnelDomain } : null,
    disk: {
      guardEnabled: config.diskGuardEnabled,
      quotaMb: config.diskQuotaMb,
    },
    voucherDefaults: {
      memoryMb: config.voucherDefaultMemoryMb,
      cpus: config.voucherDefaultCpus,
      ports: config.voucherDefaultPorts,
      // 券给出的实例有效天数，0 = 永久。到期后实例封存，没有续期。
      instanceDays: config.voucherDefaultDays,
    },
    refundInviteOnDelete: config.refundInviteOnDelete,
    // 封存宽限期 / 积分续期
    life: {
      archiveRetentionDays: config.archiveRetentionDays || null,
      renewal: config.archiveRetentionDays
        ? { days: config.renewalDays, fallbackCost: config.renewalPointsCost }
        : null,
    },
  });
});

app.get('/api/templates', (_req, res) => res.json({ templates: publicTemplates() }));

// 《用户协议》正文。登录页的弹窗和独立页 /terms 都从这里取，正文只有一份。
app.get('/api/terms', (_req, res) => {
  res.json({ version: TERMS_VERSION, updated: TERMS_UPDATED, html: TERMS_HTML, required: config.termsRequired });
});

app.get('/api/announcements', (_req, res) => {
  res.json({ announcements: announcements.listActive() });
});

/* ------------------------------------------------------------ SEO ----------
   首页壳按请求渲染（面板名/描述存在 settings 表，管理员改了立即生效），所以
   它不走静态资源管线，也不进启动时的预压缩缓存。页面很小，每次现拼没成本。
   canonical / og:url / sitemap 只在面板知道自己的公网地址时才给出 ——
   不然会把 localhost 写进搜索引擎。 */

/* 首页按人分流：已登录的直接给 SPA 壳（常客不该多点一下），陌生访客给
   landing 介绍页。登录页从此有了固定地址 /login —— landing 上的「进入
   面板 / 注册」和所有外部书签都指向它。 */
const renderPanelShell = (res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html');
  res.send(
    seo.renderIndex({
      name: panelName(),
      color: panelColor(),
      description: panelDescription(),
      baseUrl: panelBaseUrl(),
      hasPublicUrl: !panelAddressUnset(),
    })
  );
};

// landing 模板区点名的「招牌」：从模板库里按 id 取名字，模板下架了就自然消失。
const LANDING_STAR_TEMPLATES = [
  'nginx', 'wordpress', 'halo', 'code-server', 'jupyter', 'postgresql',
  'mysql', 'redis', 'grafana', 'jellyfin', 'open-webui', 'minecraft',
];

app.get('/', attachUser, (req, res) => {
  if (req.user) return renderPanelShell(res);
  // 分类计数现数现用：landing 上写的「N 个模板、几大类」跟着模板库走。
  const tpl = publicTemplates();
  const byCat = new Map();
  for (const t of tpl) byCat.set(t.category, (byCat.get(t.category) || 0) + 1);
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html');
  res.send(
    renderLanding({
      name: panelName(),
      color: panelColor(),
      description: panelDescription(),
      baseUrl: panelBaseUrl(),
      hasPublicUrl: !panelAddressUnset(),
      openRegistration: config.openRegistration,
      welcomePoints: config.welcomePoints || null,
      sitesEnabled: config.sitesEnabled,
      templateTotal: tpl.length,
      categories: [...byCat.entries()].map(([label, count]) => ({ label, count })),
      stars: LANDING_STAR_TEMPLATES.map((id) => tpl.find((t) => t.id === id)?.name).filter(Boolean),
    })
  );
});

app.get(['/index.html', '/login'], (_req, res) => renderPanelShell(res));

app.get('/robots.txt', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('text/plain');
  res.send(seo.robotsTxt(panelAddressUnset() ? null : panelBaseUrl()));
});

app.get('/sitemap.xml', (_req, res) => {
  if (panelAddressUnset()) return sendNotFoundPage(res);
  // 公开发布的静态站点是面板上唯一由用户产生、又对搜索引擎可见的内容，一并列上。
  const slugs = config.sitesEnabled
    ? db.prepare('SELECT slug FROM sites ORDER BY updated_at DESC').all().map((r) => r.slug)
    : [];
  const urls = [panelBaseUrl() + '/', panelBaseUrl() + '/terms'];
  for (const slug of slugs) urls.push(siteAddress(slug));
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/xml');
  res.send(seo.sitemapXml(urls));
});

// 会话鉴权只挂在需要它的 API 路由上：静态资源、/s/ 站点页、公告图片这些
// 不带 cookie 的请求不再查一次 SQLite，登录用户的每个页面加载能省好几笔查询。
app.use('/api/auth', attachUser, authRoutes);
app.use('/api/instances', attachUser, instanceRoutes);
app.use('/api/admin', attachUser, adminRoutes);
app.use('/api/checkin', attachUser, checkinRoutes);

// 404 页只从这一个出口送出：status 恒为 404；文件哪天丢了也只回纯文本兜底，
// 不让 ENOENT 带着绝对路径穿到错误处理器再原样漏给访客。
const sendNotFoundPage = (res) =>
  res.status(404).sendFile(path.join(ROOT, 'public', '404.html'), (err) => {
    if (err && !res.headersSent) res.type('text/plain; charset=utf-8').send('404 — 页面不存在');
    else if (err) res.end();
  });

// Announcement images: uploaded by admins, served straight from disk.
app.use('/announcement-images', express.static(config.announcementImagesDir));

// 404.html 自己也躺在 public/ 里；先截下来，别让 static 拿 200 把「页面不存在」当活页发出去。
app.get(['/404', '/404.html'], (_req, res) => sendNotFoundPage(res));

// 强制浏览器每次请求静态资源都带 If-None-Match / If-Modified-Since 回服务器
// 校验一次。文件没变时返回 304 Not Modified（仅几百字节），有改动时才发新文件。
// 这样更新面板后不再需要 Ctrl+F5 清缓存。
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache');
  next();
});
// 面板自己的静态资源：启动时预压缩成 brotli 存内存，命中就直接发字节，
// 每次请求都现压一遍会把首屏加载的 CPU 吃掉。不支持 br 的客户端或
// 未收录的文件继续落到下面的 express.static。
app.use(servePrecompressed());
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
// 面板的页面路由全躲在 #/… 里，路径入口只有 /，所以能落到这里的地址是真不存在。
// 以前拿 index.html 当万能回退，错地址也长得像首页 —— 现在老实给 404 页。
app.use((_req, res) => sendNotFoundPage(res));

// eslint-disable-next-line no-unused-vars -- express identifies error handlers by arity
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  const writeError = status >= 500 ? logger.error : logger.warn;
  writeError('http.error', {
    requestId: _req.requestId,
    method: _req.method,
    path: _req.path,
    status,
    error: err,
  });
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: err instanceof HttpError || status < 500 ? err.message : '服务器内部错误',
  });
});

const boot = bootstrapAdmin();
preloadStaticAssets();

// 在监听端口前完成本地环境自检。自检失败只阻止明显不安全/不可写的
// 环境继续启动；Docker 属于可选运行时依赖，仍由下方启动流程单独探测。
const startupSelfCheck = runStartupSelfCheck();
if (!startupSelfCheck.ok) {
  logger.error('server.selfcheck.blocked', {
    failed: startupSelfCheck.checks.filter((item) => !item.ok).map((item) => item.name),
  });
  console.error('  ✖ 启动自检未通过，请修复上面的错误后重试。');
  process.exit(1);
}
console.log(`  ✓ 启动自检通过（${startupSelfCheck.checks.length} 项）`);

// ── 首次启动检测 ──
const envPath = path.join(ROOT, '.env');
const isFirstLaunch = !fs.existsSync(envPath) || (!config.publicHost && !config.panelPublicUrl);
if (isFirstLaunch) {
  if (process.stdin.isTTY) {
    console.log('');
    console.log('  ╔═══════════════════════════════════════════╗');
    console.log('  ║    欢迎使用 localhosting 面板！            ║');
    console.log('  ║    检测到首次启动，需要进行基础配置。      ║');
    console.log('  ╚═══════════════════════════════════════════╝');
    console.log('');
    process.stdout.write('  现在打开设置向导？(Y/n) ');
    const buf = [];
    let onData;
    await new Promise((resolve) => {
      onData = (chunk) => {
        for (const b of chunk) { if (b === 0x0d || b === 0x0a) { resolve(); return; } buf.push(b); }
      };
      process.stdin.on('data', onData);
      process.stdin.once('end', resolve);
    });
    process.stdin.off('data', onData);
    const answer = Buffer.from(buf).toString('utf8').trim().toLowerCase();
    if (answer !== 'n' && answer !== 'no') {
      console.log('');
      const cp = spawn(process.execPath, [path.join(ROOT, 'scripts', 'setup.js')], {
        stdio: 'inherit', cwd: ROOT,
      });
      await new Promise((resolve) => cp.on('exit', resolve));
      console.log('\n  ✅ 配置完成，面板将继续启动。\n');
    } else {
      console.log('  已跳过，可随时运行 npm run setup 重新配置。\n');
    }
  } else {
    console.warn('');
    console.warn('  ╔═══════════════════════════════════════════╗');
    console.warn('  ║  首次启动：缺少公网地址或关键配置。       ║');
    console.warn('  ║  请先运行 npm run setup 完成基础设置。    ║');
    console.warn('  ╚═══════════════════════════════════════════╝');
    console.warn('');
    console.warn('  或手动编辑 .env，确保以下项至少一项非空：');
    console.warn('    PUBLIC_HOST       — 内网穿透/公网域名');
    console.warn('    PANEL_PUBLIC_URL  — 面板完整入口地址');
    console.warn('');
  }
}

const server = app.listen(config.port, config.host, async () => {
  logger.info('server.started', {
    host: config.host,
    port: config.port,
    node: process.version,
    platform: process.platform,
    logLevel: config.logLevel,
    httpLogging: config.logHttp,
  });
  console.log(`\n  localhosting 面板已启动  →  http://localhost:${config.port}`);
  console.log(`  端口池 ${config.portPoolStart}-${config.portPoolEnd}，对外主机名 ${config.publicHost || '(未设置，显示 localhost)'}`);
  if (boot) {
    console.log('\n  ── 已创建初始管理员 ──');
    console.log(`  用户名：${boot.username}`);
    console.log(`  密码：  ${boot.password}${boot.generated ? '   ← 随机生成，请立刻登录后修改' : ''}`);
    console.log('  ─────────────────────\n');
  }
  if (config.sitesEnabled) {
    sweepOrphanDirs();
    console.log(`  静态站点已开启，发布后可从 ${config.sitePublicBase || `${panelBaseUrl()}/s`}/<站点名>/ 访问`);
    if (panelAddressUnset()) {
      console.warn('  ⚠ 没设 PANEL_PUBLIC_URL，站点地址只能显示成 localhost，外网打不开');
      console.warn('    面板端口在公网上是什么地址，就把它填进 .env 的 PANEL_PUBLIC_URL\n');
    }
  }
  announcements.sweepImages();
  try {
    const v = await dk.ping();
    console.log(`  Docker 已连接：${v.Version} (${v.Os}/${v.Arch})\n`);
    const startupStep = async (name, task) => {
      const started = process.hrtime.bigint();
      logger.debug('startup.step.begin', { name });
      try {
        const result = await task();
        logger.debug('startup.step.complete', {
          name,
          durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
        });
        return result;
      } catch (error) {
        logger.error('startup.step.failed', { name, error });
        throw error;
      }
    };
    await startupStep('reconcile', reconcile);
    // Before the sleeper: an instance that expired while the panel was down
    // should never get its ports parked for a wake that will not be allowed.
    await startupStep('lifespan', () => lifespan.start());
    await startupStep('sleeper', () => sleeper.start());
    await startupStep('diskguard', () => diskguard.start());
    // 危险操作预警：定期扫容器进程 + 各检测点已经在路由里挂好
    await startupStep('guard', () => guard.start());
    // 面板重启后把断掉的 cloudflared 进程拉起来（看护循环在里面）
    logger.debug('startup.step.begin', { name: 'cloudflare-tunnel' });
    cftunnel.start();
    logger.debug('startup.step.complete', { name: 'cloudflare-tunnel' });
  } catch (err) {
    logger.warn('server.dependencies_unavailable', { dependency: 'docker', error: err });
    console.warn(`  ⚠ 暂时连不上 Docker：${err.message}`);
    console.warn('    面板仍可登录，但创建实例会失败。请启动 Docker Desktop / dockerd 后重试。\n');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logger.info('server.shutdown', { signal: sig });
    console.log('\n正在关闭...');
    sleeper.stop().catch(() => {});
    lifespan.stop();
    diskguard.stop();
    guard.stop();
    cftunnel.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
