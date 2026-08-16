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

/** 读目录里所有 PNG 题图，解码 + 缩到 maxSize。哪张坏了跳过哪张，不拖垮启动。
 *  顺便记下内容区（非透明像素的包围盒）：发题时的随机裁剪只在内容里进行，
 *  别把照片里指向「上」的方位线索切出画面。 */
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
      const pic = resize(decodePng(fs.readFileSync(path.join(dir, name))), maxSize);
      let minX = pic.w, minY = pic.h, maxX = -1, maxY = -1;
      for (let y = 0; y < pic.h; y++) {
        for (let x = 0; x < pic.w; x++) {
          if (pic.rgba[(y * pic.w + x) * 4 + 3] === 0) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (maxX >= minX && maxY >= minY) {
        pic.bounds = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
      }
      out.push(pic);
    } catch (err) {
      console.error(`[captcha] 跳过无法解码的题图 ${name}: ${err.message}`);
    }
  }
  return out;
}

export function rotateToPng(pic, deg) {
  return encodePng(rotatePixels(pic, deg));
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * 发题前的随机加工：把题图和公开的原图在像素层拉开距离。
 *
 * 攻击者拿到 challenge 图后，可以拿仓库里公开的题图按同一旋转算法逐角度比对
 *（缩略图级别的稳健比对就行），毫秒级算出答案 —— 不需要任何视觉 AI。光靠
 * 裁剪/缩放/噪声挡不住：同一张照片的内容在正确角度下怎么都能对齐。所以要
 * 在**低频**上动手 —— 缩略图比对看的就是低频亮度分布：
 *   1. 随机裁剪窗口（偏移在内容区内任意取）—— 可见内容每次都不一样；
 *   2. 双线性放大回原画布（1.15–2.0 倍）—— 换采样相位和尺度；
 *   3. 乘一层缓慢变化的随机亮度场（±45%，9×9 网格双线性插值）—— 这是
 *      关键的一步：整幅图的低频亮度分布被搅乱，缩略图比对的特征没了；
 *   4. 后量化为 6 级色阶 + 每像素 ±14 噪声 + 全局亮度抖动 —— 精确比对
 *      彻底失效。
 *
 * 现在要命中答案，攻击者得同时搜索 角度 × 裁剪偏移 × 缩放，而且低频比对
 * 已经失灵，只能退到特征点级别 —— 那已经不是顺手写个脚本能干的活。人眼
 * 不受影响：照片的方向线索还在，亮度场只是像一层自然光照变化。
 */
export function obscurePuzzle(pic) {
  const size = pic.w;
  const b = pic.bounds || { x: 0, y: 0, w: size, h: size };
  // 窗口在内容区任意位置、任意大小（内容区的 50%–87%）
  const zoom = 1.15 + Math.random() * 0.85;
  const cw = Math.min(b.w, Math.max(24, Math.floor(b.w / zoom)));
  const ch = Math.min(b.h, Math.max(24, Math.floor(b.h / zoom)));
  const ox = b.x + Math.floor(Math.random() * Math.max(1, b.w - cw + 1));
  const oy = b.y + Math.floor(Math.random() * Math.max(1, b.h - ch + 1));

  const cropped = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((oy + y) * size + ox + x) * 4;
      const di = (y * cw + x) * 4;
      cropped[di] = pic.rgba[si];
      cropped[di + 1] = pic.rgba[si + 1];
      cropped[di + 2] = pic.rgba[si + 2];
      cropped[di + 3] = pic.rgba[si + 3];
    }
  }
  const up = resize({ w: cw, h: ch, rgba: cropped }, size);

  // 13×13 随机亮度场，双线性插值到全分辨率：低频扰动 ±60%，人眼几乎无感
  const GRID = 13;
  const field = Array.from({ length: GRID * GRID }, () => 0.4 + Math.random() * 1.2);
  const fieldAt = (x, y) => {
    const gx = (x / size) * (GRID - 1);
    const gy = (y / size) * (GRID - 1);
    const x0 = Math.min(Math.floor(gx), GRID - 2);
    const y0 = Math.min(Math.floor(gy), GRID - 2);
    const fx = gx - x0;
    const fy = gy - y0;
    const a = field[y0 * GRID + x0];
    const b = field[y0 * GRID + x0 + 1];
    const c = field[(y0 + 1) * GRID + x0];
    const d = field[(y0 + 1) * GRID + x0 + 1];
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  };

  // 色阶后量化到 6 级（≈42 步进），再上亮度场、全局抖动和每像素噪声
  const gamma = 0.8 + Math.random() * 0.4;
  const bright = Math.round((Math.random() - 0.5) * 24);
  const quant = (v, mul) => {
    let x = Math.pow(v / 255, gamma) * 255 * mul;
    x = Math.round(x / 42) * 42;
    return clamp255(x + bright + Math.round((Math.random() - 0.5) * 36));
  };
  for (let y = 0; y < up.h; y++) {
    for (let x = 0; x < up.w; x++) {
      const i = (y * up.w + x) * 4;
      if (up.rgba[i + 3] === 0) continue; // 透明角落不掺噪
      const mul = fieldAt(x, y);
      up.rgba[i] = quant(up.rgba[i], mul);
      up.rgba[i + 1] = quant(up.rgba[i + 1], mul);
      up.rgba[i + 2] = quant(up.rgba[i + 2], mul);
    }
  }
  return up;
}
