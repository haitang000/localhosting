/**
 * Landing page：未登录访客打开 / 看到的介绍页。
 *
 * 面板本体是登录墙后的 SPA，以前访客和用户看到的是同一张登录卡；现在 /
 * 对着两种人给两种东西 —— 已登录的直接给 SPA 壳（seo.renderIndex），陌生
 * 访客给这里的 landing。登录页从此有了自己的地址 /login，landing 上的
 * 「进入面板 / 注册」都指向它。
 *
 * 和首页壳一样按请求渲染：面板名 / 主题色 / 描述存在 settings 表里，模板
 * 数量从 templates.js 现数 —— landing 上写着的「N 个模板、几大类」跟着
 * 模板库走，不会过期。样式搭 style.css 的设计变量（见 public/landing.css）。
 */

/** 文本安全嵌入 HTML（属性值同样适用）。 */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── 品牌点阵标记 ──
   几何、常量与两段动画的节奏同 public/app.js 的 dotMark() 一致（原理的
   完整说明在那边）；这里的差别只有两点：跑在 Node 里，以及一页可能同时
   出现两个标记（导航栏一个、hero 一个），linearGradient 的 id 因此要
   各自带后缀 —— 同文档里两个 #dotmark-ink 会互相抢引用。 */
const MARK_STEP = 22 / 15;
const MARK_WAVE = 3600;
const MARK_ASSEMBLE = 700;

function dotMark(label, { assemble = false, id = '' } = {}) {
  const CENTER = 16;
  const RADIUS = 5;
  const FLAT = 11 - RADIUS;
  const BAND = MARK_STEP * 1.02;
  const DOT = MARK_STEP * 0.31;
  const dots = [];
  for (let i = -1; i <= 16; i++) {
    for (let j = -1; j <= 16; j++) {
      const x = 5 + MARK_STEP * i;
      const y = 5 + MARK_STEP * j;
      const qx = Math.abs(x - CENTER) - FLAT;
      const qy = Math.abs(y - CENTER) - FLAT;
      const d = Math.abs(
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - RADIUS
      );
      if (d > BAND) continue;
      dots.push({ x, y, phase: Math.round(((x + y - 7) / 50) * MARK_WAVE) });
    }
  }
  // 点亮的先后随机、节奏均匀 —— 次序随机才像噪声里显出图像（详见 app.js）。
  const light = dots.map((_, n) => n);
  for (let n = light.length - 1; n > 0; n--) {
    const m = Math.floor(Math.random() * (n + 1));
    [light[n], light[m]] = [light[m], light[n]];
  }
  const lightAt = [];
  light.forEach((dot, place) => {
    lightAt[dot] = Math.round((place / light.length) * MARK_ASSEMBLE);
  });
  const circles = dots
    .map((p, n) => `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${DOT.toFixed(2)}" style="animation-delay:-${p.phase}ms,${lightAt[n]}ms" />`)
    .join('');
  // 渐变停靠点的颜色由 style.css 按 .dotmark 类上色，标记跟着主题色走。
  return `<svg class="dotmark${assemble ? ' assemble' : ''}" viewBox="0 0 32 32" role="img" aria-label="${esc(label)}">
    <defs><linearGradient id="dotmark-ink${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" /><stop offset="1" /></linearGradient></defs>
    <g fill="url(#dotmark-ink${id})">${circles}</g>
  </svg>`;
}

/* 线性图标（lucide 的 24 格描边路径），只放 landing 用到的这几张。 */
const ICONS = {
  grid: '<rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/>',
  upload: '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>',
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  gamepad: '<line x1="6" x2="10" y1="12" y2="12"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="15" x2="15.01" y1="13" y2="13"/><line x1="18" x2="18.01" y1="11" y2="11"/><rect width="20" height="12" x="2" y="6" rx="2"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  layout: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  'user-plus': '<path d="M2 21a8 8 0 0 1 13.292-6"/><circle cx="10" cy="8" r="5"/><path d="M19 16v6"/><path d="M22 19h-6"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>',
  'layout-template': '<rect width="18" height="7" x="3" y="3" rx="1"/><rect width="9" height="7" x="3" y="14" rx="1"/><rect width="5" height="7" x="16" y="14" rx="1"/>',
  'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  'key-round': '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

/* 模板分类 → icon：label 与 templates.js 的 category 同名；没列到的分类退回 grid */
const CAT_ICONS = {
  Web: 'globe',
  建站: 'layout',
  开发: 'code',
  数据库: 'database',
  游戏: 'gamepad',
  工具: 'wrench',
  媒体: 'play',
  AI: 'sparkles',
};
const icon = (name) =>
  `<svg class="ld-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

/* ── 模板 logo 砖 ── */
function logoTile({ name, iconFile }) {
  return `<div class="ld-logo-tile" title="${esc(name)}"><img src="/template-icons/${esc(iconFile)}" alt="" width="36" height="36" loading="lazy" decoding="async" onerror="this.parentElement.hidden=true" /></div>`;
}

/** 把 logo 均分到 n 行，空行丢掉（模板很少时不留空白轨道）。 */
function logoRows(logos, n) {
  const rows = Array.from({ length: n }, () => []);
  logos.forEach((item, i) => rows[i % n].push(item));
  return rows.filter((row) => row.length);
}

function logoStage(logos) {
  if (!logos.length) return '';
  const rows = logoRows(logos, 3)
    .map(
      (row, i) => `<div class="ld-marquee" data-dir="${i === 1 ? '-1' : '1'}">
              <div class="ld-marquee-track">
                <div class="ld-marquee-set">${row.map(logoTile).join('')}</div>
              </div>
            </div>`
    )
    .join('\n            ');
  return `<div class="ld-split-visual">
            <div class="ld-logo-stage" aria-hidden="true">
            ${rows}
            </div>
          </div>`;
}

/* ── 特性分栏里的示意面板：纯装饰，给文案一个「长什么样」的锚点 ── */
function mockChrome(label) {
  return `<div class="ld-mock-chrome"><span class="ld-mock-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${esc(label)}</span></div>`;
}

function mockSleep() {
  return `<div class="ld-mock ld-mock-inst" aria-hidden="true">
              ${mockChrome('实例 · jellyfin')}
              <div class="ld-mock-inst-row">
                <img class="ld-mock-avatar" src="/template-icons/jellyfin.svg" alt="" width="28" height="28" />
                <div><b>jellyfin</b><small>媒体服务器</small></div>
                <span class="ld-mock-pill" data-states="休眠中,唤醒中,运行中">休眠中</span>
              </div>
              <div class="ld-mock-meters">
                <div><span>CPU</span><i class="ld-mock-bar"><b style="width:28%"></b></i></div>
                <div><span>内存</span><i class="ld-mock-bar"><b style="width:46%"></b></i></div>
              </div>
            </div>`;
}

function mockTerm() {
  return `<div class="ld-mock ld-mock-term" aria-hidden="true">
              ${mockChrome('终端 · nginx')}
              <pre class="ld-term-body"><span class="ld-term-line">$ nginx -t</span>
<span class="ld-term-out">nginx: the configuration file /etc/nginx/nginx.conf syntax is ok</span>
<span class="ld-term-line">$ ls /usr/share/nginx/html</span>
<span class="ld-term-out">index.html  assets/</span>
<span class="ld-term-line">$ <i class="ld-caret"></i></span></pre>
            </div>`;
}

function mockDrop() {
  return `<div class="ld-mock ld-mock-drop" aria-hidden="true">
              ${mockChrome('站点 · 新建')}
              <div class="ld-drop-zone">${icon('upload')}<b>放开以上线</b><small>index.html 或整个站点目录</small></div>
              <ul class="ld-drop-files">
                <li>${icon('layout')}index.html</li>
                <li>${icon('folder')}assets/</li>
              </ul>
            </div>`;
}

function mockFiles() {
  return `<div class="ld-mock ld-mock-files" aria-hidden="true">
              ${mockChrome('文件 · nginx')}
              <ul class="ld-file-tree">
                <li>${icon('folder')}<span>html</span></li>
                <li class="on">${icon('code')}<span>nginx.conf</span></li>
                <li>${icon('folder')}<span>logs</span></li>
                <li>${icon('layout')}<span>mime.types</span></li>
              </ul>
            </div>`;
}

function splitArticle({ kicker, icon: ic, title, body, visual, flip }) {
  return `<article class="ld-split${flip ? ' flip' : ''}">
            <div class="ld-split-visual">${visual}</div>
            <div class="ld-split-copy">
              <p class="ld-kicker">${icon(ic)}${esc(kicker)}</p>
              <h3>${esc(title)}</h3>
              <p class="ld-lead">${esc(body)}</p>
            </div>
          </article>`;
}

/**
 * 特性区：三列图文分栏讲清楚「用起来长什么样」，剩下的收成小卡。
 * sitesEnabled 决定第三栏是拖放网页还是文件管理，对应小卡也跟着换。
 */
function featureBlock({ sitesEnabled }) {
  const sleep = splitArticle({
    kicker: '资源调度',
    icon: 'moon',
    title: '闲时休眠，访问即醒',
    body: '无访问时容器自动停止，请求到来后数秒内自动恢复，冷启动几乎无感知 —— 闲置的资源由此归还给全体用户。',
    visual: mockSleep(),
    flip: false,
  });
  const term = splitArticle({
    kicker: '在线运维',
    icon: 'terminal',
    title: '浏览器里的容器终端',
    body: '网页版 docker exec -it：支持彩色输出、vim / htop 等全屏程序、Tab 补全与断线自动重连，移动端另提供 Esc / Ctrl 快捷键栏。',
    visual: mockTerm(),
    flip: true,
  });
  const third = sitesEnabled
    ? splitArticle({
        kicker: '静态站点',
        icon: 'upload',
        title: '拖放上线静态网页',
        body: '将 index.html 或整站目录拖入面板即可发布：无需创建容器、不占用端口、无需等待审批，单个站点仅按 0.1 核 · 32 MB 计入用量。',
        visual: mockDrop(),
        flip: false,
      })
    : splitArticle({
        kicker: '文件',
        icon: 'folder',
        title: '容器文件管理',
        body: '在线浏览目录、编辑配置文件、上传文件，或将整个目录打包下载 —— 无需 docker cp，镜像内也无需预装 tar / vim。',
        visual: mockFiles(),
        flip: false,
      });

  const cards = [
    sitesEnabled
      ? {
          icon: 'folder',
          title: '容器文件管理',
          body: '浏览目录、编辑配置、上传或打包下载，镜像内无需预装 tar / vim。',
        }
      : {
          icon: 'activity',
          title: '实时日志与资源监控',
          body: '日志流与 CPU / 内存曲线直接在网页中查看，不必再 SSH 上去跑 docker logs。',
        },
    {
      icon: 'ticket',
      title: '资源额度，凭券管理',
      body: '资源券签发时即锁定内存 / CPU / 端口；开放注册配有自研验证码，可拦截自动化注册。',
    },
    sitesEnabled
      ? {
          icon: 'activity',
          title: '实时日志与资源监控',
          body: '日志流与 CPU / 内存曲线直接在网页中查看，不必再 SSH 上去跑 docker logs。',
        }
      : {
          icon: 'wrench',
          title: '自定义镜像',
          body: '模板之外的镜像可凭资源券或账号权限启用，规格由管理员在签发时锁定。',
        },
  ];
  const grid = cards
    .map((c) => `<div class="ld-card">${icon(c.icon)}<h3>${esc(c.title)}</h3><p>${esc(c.body)}</p></div>`)
    .join('\n          ');

  return `${sleep}
          ${term}
          ${third}
          <div class="ld-grid">
          ${grid}
          </div>`;
}

/**
 * 渲染 landing 页。
 * - categories：[{ label, count }]，由调用方从模板库现数；
 * - stars：模板库里挑几个叫得上名字的展示（调用方按固定 id 列表取 name）；
 * - logos：[{ name, iconFile }]，模板区左侧轮播用，招牌排在最前；
 * - 其余字段与 seo.renderIndex 同源（settings 表 + config）。
 */
export function renderLanding({
  name,
  color,
  description,
  baseUrl,
  hasPublicUrl,
  openRegistration,
  welcomePoints,
  sitesEnabled,
  templateTotal,
  categories,
  stars,
  logos = [],
}) {
  const title = `${name} · 容器面板`;
  const desc = description || `${name} —— 云容器托管面板。`;
  const ogUrl = hasPublicUrl ? `${baseUrl}/` : null;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name,
    description: desc,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any',
    inLanguage: 'zh-CN',
    ...(ogUrl ? { url: ogUrl } : {}),
  };
  const favicon = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='5' y='5' width='22' height='22' rx='7' fill='none' stroke='%23${color.replace('#', '')}' stroke-width='3'/></svg>`;

  // 注册通道的实况一行：开放注册写明注册方式与注册权益，邀请制则写明索取方式。
  const regBits = [];
  if (openRegistration) {
    if (sitesEnabled) regBits.push('注册赠静态网页券');
    if (welcomePoints) regBits.push(`另赠 ${welcomePoints} 积分`);
  }
  const regLine = openRegistration
    ? `<b>开放注册</b> · 无需邀请码${regBits.length ? ` · ${esc(regBits.join(' · '))}` : ''}`
    : '<b>邀请制注册</b> · 请向管理员索取邀请码';

  const cats = categories
    .map((c) => `<span class="ld-chip">${icon(CAT_ICONS[c.label] || 'grid')}${esc(c.label)}<b>${c.count}</b></span>`)
    .join('\n              ');
  const starLead = stars.length
    ? `${esc(stars.slice(0, 8).join('、'))} 等常用服务开箱即用，填写参数即可完成部署。`
    : '常用服务开箱即用，填写参数即可完成部署。';
  const tplVisual = logoStage(logos);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}" />
    <meta name="robots" content="index, follow" />
    ${ogUrl ? `    <link rel="canonical" href="${esc(ogUrl)}" />\n` : ''}
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
    <meta property="og:site_name" content="${esc(name)}" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(desc)}" />
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="zh_CN" />
    ${ogUrl ? `    <meta property="og:url" content="${esc(ogUrl)}" />\n` : ''}
    <meta name="twitter:card" content="summary" />
    <link rel="stylesheet" href="/style.css" />
    <link rel="stylesheet" href="/landing.css" />
    <link rel="icon" href="${esc(favicon)}" />
    <!-- 管理后台可改的主题色：晚于两个样式表注入，:root 级直接生效 -->
    <style>:root{--primary:${esc(color)}}</style>
    <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
  </head>
  <body class="ld">
    <header class="ld-nav">
      <div class="ld-wrap ld-nav-in">
        <a class="ld-brand" href="/">${dotMark(name, { id: '-nav' })}<b>${esc(name)}</b></a>
        <nav id="ld-nav-links" aria-label="页面导航">
          <a href="#templates">模板</a>
          <a href="#features">特性</a>
          <a href="#flow">流程</a>
          <a href="#faq">常见问题</a>
        </nav>
        <a class="ld-btn ghost ld-nav-cta" href="/login">进入面板</a>
        <button type="button" class="ld-nav-toggle" id="ld-nav-toggle" aria-label="打开菜单" aria-expanded="false" aria-controls="ld-nav-links">
          <span class="ld-nav-bars">${icon('menu')}</span>
          <span class="ld-nav-close">${icon('x')}</span>
        </button>
      </div>
      <div class="ld-nav-scrim" id="ld-nav-scrim"></div>
    </header>

    <main>
      <section class="ld-hero">
        <div class="ld-wrap ld-hero-in">
          <div class="ld-hero-text">
            <p class="ld-eyebrow">自托管 · 多用户容器面板</p>
            <h1>选择模板，一键部署，<br />服务即刻上线。</h1>
            <p class="ld-sub">${esc(desc)}</p>
            <div class="ld-cta">
              <a class="ld-btn primary" href="${openRegistration ? '/login#/register' : '/login'}">${icon(openRegistration ? 'user-plus' : 'arrow-right')}${openRegistration ? '免费注册' : '进入面板'}</a>
              <a class="ld-btn ghost" href="#templates">${icon('compass')}浏览模板</a>
            </div>
            <p class="ld-meta">${icon('gift')}<span>${regLine}</span></p>
          </div>
          <div class="ld-hero-visual">
            <canvas class="ld-logo" role="img" aria-label="${esc(name)}" data-ink="${esc(color)}"></canvas>
          </div>
        </div>
      </section>

      <section id="templates" class="ld-section alt">
        <div class="ld-wrap">
          <article class="ld-split${logos.length ? '' : ' copy-only'}">
          ${tplVisual}
            <div class="ld-split-copy">
              <p class="ld-kicker">${icon('layout-template')}模板库</p>
              <h2><span class="ld-num" data-count="${templateTotal}">${templateTotal}</span> 个模板开箱即用</h2>
              <span class="ld-h2-bar" aria-hidden="true"></span>
              <p class="ld-lead">${starLead}</p>
              <div class="ld-cats">
              ${cats}
              </div>
              <p class="ld-note">需要运行模板之外的镜像？自定义镜像可凭资源券或账号权限启用，请联系管理员开通。</p>
            </div>
          </article>
        </div>
      </section>

      <section id="features" class="ld-section">
        <div class="ld-wrap">
          <header class="ld-section-head">
            <h2>面板功能一览</h2>
            <span class="ld-h2-bar" aria-hidden="true"></span>
          </header>
          ${featureBlock({ sitesEnabled })}
        </div>
      </section>

      <section id="flow" class="ld-section alt">
        <div class="ld-wrap">
          <h2>从注册到上线</h2>
          <span class="ld-h2-bar" aria-hidden="true"></span>
          <ol class="ld-steps">
            <li><i class="ld-step-link" aria-hidden="true"></i><span class="ld-step-n">1</span><h3>${icon('user-plus')}注册账号</h3><p>${
              openRegistration
                ? '开放注册并通过自研验证码，无需邀请码；注册即获起步资源。'
                : '凭邀请码完成注册；注册即获起步资源。'
            }</p></li>
            <li><i class="ld-step-link" aria-hidden="true"></i><span class="ld-step-n">2</span><h3>${icon('layout-template')}选择模板或上传网页</h3><p>${
              sitesEnabled ? '静态网页拖入面板即自动上线；' : ''
            }容器规格从模板库中选定，按资源券或积分配置后提交申请。</p></li>
            <li><i class="ld-step-link" aria-hidden="true"></i><span class="ld-step-n">3</span><h3>${icon('shield-check')}管理员审批</h3><p>面板先行完成端口预留，管理员配置穿透并批准后，容器才会正式创建并启动${
              sitesEnabled ? '（静态站点无需排队）' : ''
            }。</p></li>
            <li><span class="ld-step-n">4</span><h3>${icon('monitor')}浏览器中管理一切</h3><p>终端、日志、文件与监控全部在网页中完成；实例无访问时自动休眠，请求到来时秒级唤醒。</p></li>
          </ol>
        </div>
      </section>

      <section id="faq" class="ld-section">
        <div class="ld-wrap">
          <h2>常见问题</h2>
          <span class="ld-h2-bar" aria-hidden="true"></span>
          <div class="ld-faq">
            <details>
              <summary><span class="ld-q">${icon('coins')}<span>创建实例需要消耗什么？</span></span></summary>
              <div class="ld-faq-body"><p>一张实例资源券，或一定数额的积分。资源券在签发时即确定内存 / CPU / 端口额度；积分方案从基础规格起步，可为内存、CPU 与端口逐项加配。超出上限的规格需由管理员单独签发资源券。</p></div>
            </details>
            <details>
              <summary><span class="ld-q">${icon('package')}<span>可以运行任意镜像吗？</span></span></summary>
              <div class="ld-faq-body"><p>模板库内的镜像可自由选用；模板之外的自定义镜像需凭资源券或账号权限启用，请向管理员申请。</p></div>
            </details>
            <details>
              <summary><span class="ld-q">${icon('lock')}<span>我的数据由谁保管？</span></span></summary>
              <div class="ld-faq-body"><p>面板与容器均运行在管理员自有的服务器上（自托管）。管理员可以查看实例的终端、文件与资源用量，请勿存放敏感或私密数据，详见<a href="/terms">《用户协议》</a>。</p></div>
            </details>
            <details>
              <summary><span class="ld-q">${icon('key-round')}<span>注册需要邀请码吗？</span></span></summary>
              <div class="ld-faq-body"><p>${
                openRegistration
                  ? '当前不需要：开放注册已启用，通过自研验证码（行为分析 / 图片回正 / 工作量证明）即可完成注册。'
                  : '当前需要：面板现为邀请制，请向管理员索取邀请码后完成注册。'
              }</p></div>
            </details>
          </div>
        </div>
      </section>
    </main>

    <section class="ld-band">
      <div class="ld-wrap ld-band-in">
        <h2>准备就绪，即刻开始</h2>
        <p>模板部署、站点发布、容器运维，全部在浏览器中完成。</p>
        <a class="ld-btn primary ld-band-btn" href="${openRegistration ? '/login#/register' : '/login'}">${icon(openRegistration ? 'user-plus' : 'arrow-right')}${openRegistration ? '免费注册' : '进入面板'}</a>
      </div>
    </section>

    <footer class="ld-foot">
      <div class="ld-wrap ld-foot-in">
        <span><b>${esc(name)}</b> · 自托管容器面板</span>
        <nav aria-label="页脚">
          <a href="/terms">用户协议</a>
          <a href="/privacy">隐私政策</a>
          <a href="/login">登录 / 注册</a>
        </nav>
        <span class="ld-power">Powered by localhosting</span>
      </div>
    </footer>
    <!-- 首屏动效与滚动入场：gsap 全局库 + 两个插件/脚本（顺序敏感，非 defer）。
         品牌色经 data-ink 传给粒子脚本，与管理后台设置的主题色同源。 -->
    <script src="/vendor/gsap.min.js"></script>
    <script src="/vendor/ScrollTrigger.min.js"></script>
    <script src="/landing-hero.js"></script>
    <script src="/landing-scroll.js"></script>
    <script>
      (function () {
        var header = document.querySelector('.ld-nav');
        var btn = document.getElementById('ld-nav-toggle');
        if (!header || !btn) return;
        function setOpen(open) {
          header.classList.toggle('is-open', open);
          btn.setAttribute('aria-expanded', String(open));
          btn.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
          document.body.classList.toggle('ld-nav-lock', open);
        }
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          setOpen(!header.classList.contains('is-open'));
        });
        header.querySelectorAll('#ld-nav-links a').forEach(function (a) {
          a.addEventListener('click', function () { setOpen(false); });
        });
        var scrim = document.getElementById('ld-nav-scrim');
        if (scrim) scrim.addEventListener('click', function () { setOpen(false); });
        document.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') setOpen(false);
        });
        if (window.matchMedia) {
          window.matchMedia('(max-width: 900px)').addEventListener('change', function (e) {
            if (!e.matches) setOpen(false);
          });
        }
      })();
    </script>
  </body>
</html>
`;
}
