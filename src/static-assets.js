import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from './config.js';

/**
 * 面板自己的静态资源，启动时一次性压成 brotli 存内存，之后每个请求直接发
 * 字节，不在热路径上重复压缩（app.js 有 ~290KB，现压一次要几十到几百毫秒）。
 *
 * ETag 用原始文件的 stat 算、和 express/send 的强 ETag 同格式，所以浏览器
 * 之前缓存下来的 If-None-Match 依然对得上，文件没变照样 304。
 * 带 Content-Encoding: br 的响应不会被全局 compression 中间件二次压缩。
 */

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

/** public/ 下全部静态文件；新增文件只需在这补一行。
 *  index.html 不在列表里：首页壳按请求动态渲染（见 seo.js），不走预压缩缓存。 */
const FILES = [
  '404.html',
  'terms.html',
  'app.js',
  'editor.js',
  'icons.js',
  'style.css',
  'vendor/marked.esm.js',
];

/** req.path → 磁盘相对路径。 */
const ALIASES = {};

const assets = new Map(); // '/app.js' -> { br, etag, lastModified, type }

export function preloadStaticAssets() {
  const publicDir = path.join(ROOT, 'public');
  for (const rel of FILES) {
    const abs = path.join(publicDir, rel);
    let raw;
    let stat;
    try {
      stat = fs.statSync(abs);
      raw = fs.readFileSync(abs);
    } catch {
      continue; // 文件不在 —— 交给 express.static 去 404
    }
    // 与 express/send 的强 ETag 同格式："<size hex>-<mtime hex>"
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    assets.set(`/${rel}`, {
      br: zlib.brotliCompressSync(raw, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 },
      }),
      etag,
      lastModified: new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toUTCString(),
      type: MIME[path.extname(rel)],
    });
  }
}

export function servePrecompressed() {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const asset = assets.get(ALIASES[req.path] || req.path);
    if (!asset) return next();
    // 只拦下能收 brotli 的客户端；其余原样走 express.static。
    if (!(req.headers['accept-encoding'] || '').includes('br')) return next();

    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', asset.etag);
    res.setHeader('Last-Modified', asset.lastModified);
    res.setHeader('Vary', 'Accept-Encoding');

    const inm = req.headers['if-none-match'];
    if (inm === '*' || inm === asset.etag) return res.status(304).end();
    const ims = req.headers['if-modified-since'];
    if (ims && new Date(ims).getTime() >= new Date(asset.lastModified).getTime()) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', asset.type);
    res.setHeader('Content-Encoding', 'br');
    res.setHeader('Content-Length', asset.br.length);
    res.status(200);
    if (req.method === 'HEAD') return res.end();
    res.end(asset.br);
  };
}
