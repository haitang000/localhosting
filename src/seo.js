/**
 * SEO 出口：首页壳、robots.txt、sitemap.xml。
 *
 * 面板是登录墙后的 SPA，真正能被搜索引擎索引的只有三样：首页壳（登录页）、
 * /terms 协议页、以及 /s/ 下公开发布的静态站点。所以这里只服务这三样能见光
 * 的东西 —— 其余所有路径本来就该 404。
 *
 * 首页壳按请求渲染而不是用静态文件：面板名和站点描述存在 settings 表里、
 * 管理员改了立即生效，标题 / description / canonical 都跟着走。
 */

/** 文本安全嵌入 HTML（属性值同样适用）。 */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FAVICON =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='5' y='5' width='22' height='22' rx='7' fill='none' stroke='%23COLOR' stroke-width='3'/></svg>";

/**
 * The SPA shell. `hasPublicUrl` = 面板已知自己在公网上的地址；不知道时不给
 * canonical / og:url / JSON-LD url —— 写 localhost 进去等于教搜索引擎收录
 * 一台内网机器。
 */
export function renderIndex({ name, color, description, baseUrl, hasPublicUrl }) {
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
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <!-- interactive-widget: 默认软键盘会平移整个视口，吸底的控制台命令行因此被顶出
         屏幕。resizes-content 让键盘弹起时视口真的变短，dvh 和 sticky 才按预期工作。 -->
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"
    />
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
    <link rel="icon" href="${esc(FAVICON.replace('COLOR', color.replace('#', '')))}" />
    <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
  </head>
  <body>
    <div id="app" class="boot">
      <div class="loading" role="status" aria-label="正在加载">
        <svg class="loader" viewBox="0 0 32 32" aria-hidden="true">
          <rect class="track" x="5" y="5" width="22" height="22" rx="7" />
          <rect class="trace" x="5" y="5" width="22" height="22" rx="7" />
        </svg>
      </div>
    </div>
    <noscript>
      <div style="padding:48px 20px;text-align:center;font-family:system-ui,-apple-system,sans-serif">
        面板需要启用 JavaScript 才能使用。<br />
        <a href="/terms">查看用户协议</a>
      </div>
    </noscript>
    <div id="toasts"></div>
    <script type="module" src="/app.js"></script>
  </body>
</html>
`;
}

/**
 * `/s/` 下是用户公开发布的静态站点，放行抓取；面板自身是登录墙后的 SPA，
 * 只让首页壳和协议页可索引，其余全部挡掉。`baseUrl` 未知（面板没告诉过自己
 * 的公网地址）时不写 Sitemap 行。
 */
export function robotsTxt(baseUrl) {
  return `User-agent: *
Allow: /$
Allow: /terms$
Allow: /s/
Disallow: /api/
Disallow: /404
Disallow: /index.html
Disallow: /app.js
Disallow: /editor.js
Disallow: /icons.js
Disallow: /style.css
Disallow: /vendor/
Disallow: /announcement-images/
${baseUrl ? `Sitemap: ${baseUrl}/sitemap.xml` : ''}
`;
}

/** urls 是完整地址（含 /s/<slug>/ 站点页，由调用方按 sitePublicBase 拼好）。 */
export function sitemapXml(urls) {
  const entries = urls
    .map((u) => `  <url><loc>${esc(u)}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}
