import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import compression from 'compression';
import { config, ROOT, panelBaseUrl, panelAddressUnset } from './config.js';
import { preloadStaticAssets, servePrecompressed } from './static-assets.js';
import { attachUser, bootstrapAdmin } from './auth.js';
import { publicTemplates } from './templates.js';
import { poolStats } from './ports.js';
import { reconcile, HttpError } from './instances.js';
import * as dk from './docker.js';
import * as sleeper from './sleeper.js';
import * as lifespan from './lifespan.js';
import * as diskguard from './diskguard.js';
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
import { seedSettings, panelName, panelColor, captchaMode } from './settings.js';

seedBundles();
seedSettings();

const app = express();
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
    res.status(503).json({ ok: false, error: `无法连接 Docker：${err.message}` });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({
    panelName: panelName(),
    panelColor: panelColor(),
    captchaMode: captchaMode(),
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
        ? { days: config.renewalDays, cost: config.renewalPointsCost }
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
  if (status >= 500) console.error('[error]', err);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: err instanceof HttpError || status < 500 ? err.message : '服务器内部错误',
  });
});

const boot = bootstrapAdmin();
preloadStaticAssets();

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
    await reconcile();
    // Before the sleeper: an instance that expired while the panel was down
    // should never get its ports parked for a wake that will not be allowed.
    await lifespan.start();
    await sleeper.start();
    await diskguard.start();
    // 面板重启后把断掉的 cloudflared 进程拉起来（看护循环在里面）
    cftunnel.start();
  } catch (err) {
    console.warn(`  ⚠ 暂时连不上 Docker：${err.message}`);
    console.warn('    面板仍可登录，但创建实例会失败。请启动 Docker Desktop / dockerd 后重试。\n');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在关闭...');
    sleeper.stop().catch(() => {});
    lifespan.stop();
    diskguard.stop();
    cftunnel.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
