import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/* ================================================================
   真实图片回正验证的支撑模块：纯 Node 实现（零外部依赖）——
   解码 PNG → 双线性旋转像素 → 重新编码 PNG。
   旋转在服务端像素层完成，角度不出现在任何标记里，只能真的去看图。

   支持的输入：8-bit、非隔行，颜色类型 0（灰度）/ 2（RGB）/
   4（灰+透明）/ 6（RGBA）。其它格式直接抛错，由调用方跳过该文件。
   ================================================================ */

const BPP = { 0: 1, 2: 3, 4: 2, 6: 4 };

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG 文件');
  let off = 8;
  let w = 0, h = 0, depth = 0, colorType = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0) throw new Error('不支持的压缩/滤波方式');
      if (data[12] !== 0) throw new Error('不支持隔行扫描 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const bpp = BPP[colorType];
  if (!w || !h) throw new Error('PNG 缺少 IHDR');
  if (!bpp || depth !== 8) throw new Error(`不支持的 PNG 格式（类型 ${colorType}，位深 ${depth}）`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const rgba = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const unf = Buffer.from(row);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? unf[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          unf[x] = (unf[x] + a) & 0xff;
          break;
        case 2:
          unf[x] = (unf[x] + b) & 0xff;
          break;
        case 3:
          unf[x] = (unf[x] + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          unf[x] = (unf[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default:
          throw new Error('未知滤波类型');
      }
    }
    for (let x = 0; x < w; x++) {
      const si = x * bpp;
      const di = (y * w + x) * 4;
      rgba[di] = unf[si];
      rgba[di + 1] = unf[si + 1];
      rgba[di + 2] = unf[si + 2];
      rgba[di + 3] = bpp === 4 ? unf[si + 3] : 255;
    }
    prev = unf;
  }
  return { w, h, rgba };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** RGBA → PNG。逐行用 Paeth 滤波（类型 4），照片上压缩率比不滤波好不少。
    预测值一律取「原始」字节（本行 x-4 与上一行同位置），PNG 滤波定义如此。 */
export function encodePng({ w, h, rgba }) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const out = y * (stride + 1);
    raw[out] = 4;
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? row[x - 4] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= 4 ? prev[x - 4] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[out + 1 + x] = (row[x] - pr) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 绕中心旋转 deg 度（数学正方向 = 屏幕上的逆时针，与客户端 CSS rotate
 * 顺时针回正的约定相反相成）。结果画布取 w/h 的较大者，画不下的角落留透明。
 */
export function rotatePixels(pic, deg) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const size = Math.max(pic.w, pic.h);
  const out = Buffer.alloc(size * size * 4);
  const cx = pic.w / 2;
  const cy = pic.h / 2;
  const c2 = size / 2;
  for (let y = 0; y < size; y++) {
    const dy = y - c2;
    for (let x = 0; x < size; x++) {
      const dx = x - c2;
      const sx = cx + dx * cos + dy * sin;
      const sy = cy - dx * sin + dy * cos;
      if (sx < 0 || sy < 0 || sx > pic.w - 1 || sy > pic.h - 1) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const x1 = Math.min(x0 + 1, pic.w - 1);
      const y1 = Math.min(y0 + 1, pic.h - 1);
      const o00 = (y0 * pic.w + x0) * 4;
      const o01 = (y0 * pic.w + x1) * 4;
      const o10 = (y1 * pic.w + x0) * 4;
      const o11 = (y1 * pic.w + x1) * 4;
      const di = (y * size + x) * 4;
      for (let c = 0; c < 4; c++) {
        out[di + c] = Math.round(
          pic.rgba[o00 + c] * (1 - fx) * (1 - fy) +
            pic.rgba[o01 + c] * fx * (1 - fy) +
            pic.rgba[o10 + c] * (1 - fx) * fy +
            pic.rgba[o11 + c] * fx * fy
        );
      }
    }
  }
  return { w: size, h: size, rgba: out };
}

/** 双线性缩到 maxSize 见方（题图 340px 就够了，缩小后旋转/编码都快一倍）。 */
function resize(pic, maxSize) {
  const size = Math.min(maxSize, Math.max(pic.w, pic.h));
  if (size >= pic.w && size >= pic.h) return pic;
  const out = Buffer.alloc(size * size * 4);
  const sx = pic.w / size;
  const sy = pic.h / size;
  for (let y = 0; y < size; y++) {
    const fy = y * sy;
    const y0 = Math.min(Math.floor(fy), pic.h - 1);
    const y1 = Math.min(y0 + 1, pic.h - 1);
    const ty = fy - y0;
    for (let x = 0; x < size; x++) {
      const fx = x * sx;
      const x0 = Math.min(Math.floor(fx), pic.w - 1);
      const x1 = Math.min(x0 + 1, pic.w - 1);
      const tx = fx - x0;
      const o00 = (y0 * pic.w + x0) * 4;
      const o01 = (y0 * pic.w + x1) * 4;
      const o10 = (y1 * pic.w + x0) * 4;
      const o11 = (y1 * pic.w + x1) * 4;
      const di = (y * size + x) * 4;
      for (let c = 0; c < 4; c++) {
        out[di + c] = Math.round(
          pic.rgba[o00 + c] * (1 - tx) * (1 - ty) +
            pic.rgba[o01 + c] * tx * (1 - ty) +
            pic.rgba[o10 + c] * (1 - tx) * ty +
            pic.rgba[o11 + c] * tx * ty
        );
      }
    }
  }
  return { w: size, h: size, rgba: out };
}

/** 读目录里所有 PNG 题图，解码 + 缩到 maxSize。哪张坏了跳过哪张，不拖垮启动。 */
export function loadPuzzles(dir, maxSize = 256) {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((n) => /\.png$/i.test(n)).sort();
  } catch {
    return out;
  }
  for (const name of files) {
    try {
      out.push(resize(decodePng(fs.readFileSync(path.join(dir, name))), maxSize));
    } catch (err) {
      console.error(`[captcha] 跳过无法解码的题图 ${name}: ${err.message}`);
    }
  }
  return out;
}

export function rotateToPng(pic, deg) {
  return encodePng(rotatePixels(pic, deg));
}
