import path from 'node:path';
import { PassThrough } from 'node:stream';
import { config } from './config.js';
import { audit } from './db.js';
import * as dk from './docker.js';
import * as tar from './tar.js';
import * as sleeper from './sleeper.js';
import { HttpError } from './instances.js';

/**
 * The file manager: browse and edit the filesystem inside someone's container
 * from the panel, instead of telling them to learn `docker cp`.
 *
 * Two different Docker facilities are used, on purpose:
 *
 *   · *Listing and moving things around* (ls / mkdir / rm / mv) go through
 *     `docker exec`, because there is no API for "what is in this directory".
 *     That means the container must be running and must have /bin/sh — the same
 *     requirement the live console already has, so it is a limit users have met
 *     before rather than a new surprise.
 *   · *File content* (download, open in the editor, upload, save) goes through
 *     the archive endpoints `docker cp` uses. Those need no shell, no tar and no
 *     unzip inside the image, and they transfer bytes without a base64 round
 *     trip through a terminal.
 *
 * Everything is scoped by getInstance() at the route layer, so a request can
 * only ever reach a container the caller owns (or any container, if admin).
 */

const bad = (msg) => new HttpError(400, msg);

/* ----------------------------------------------------------------- paths --- */

/**
 * Absolute container path, normalised. `..` is resolved here rather than
 * rejected, so a breadcrumb that walks up cannot be talked into escaping — and
 * since every segment is passed to the shell as a positional argument, a name
 * full of quotes and semicolons is just a name.
 */
export function cleanPath(raw) {
  const input = String(raw ?? '').trim() || '/';
  if (!input.startsWith('/')) throw bad('路径必须以 / 开头');
  if (input.length > 1024) throw bad('路径过长');
  if (/[\u0000-\u001f]/.test(input)) throw bad('路径含控制字符');

  const segs = [];
  for (const seg of input.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  if (segs.length > 64) throw bad('目录层级太深');
  return `/${segs.join('/')}`;
}

/** A single new name (upload target, mkdir, rename): no slashes, no dot-dot. */
export function cleanName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw bad('名称不能为空');
  if (name === '.' || name === '..') throw bad('这个名称不合法');
  if (name.includes('/')) throw bad('名称里不能有 /');
  if (/[\u0000-\u001f]/.test(name)) throw bad('名称含控制字符');
  if (Buffer.byteLength(name) > 200) throw bad('名称过长');
  return name;
}

/** Relative path inside an upload ("assets/app.css" when a folder is dropped). */
function cleanRelPath(raw) {
  const p = String(raw ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .trim();
  if (!p) throw bad('文件路径为空');
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (!segs.length) throw bad('文件路径为空');
  if (segs.some((s) => s === '..')) throw bad(`文件路径 "${p}" 不合法`);
  if (segs.length > 24) throw bad('上传的目录层级太深');
  segs.forEach(cleanName);
  if (Buffer.byteLength(segs.join('/')) > 800) throw bad('文件路径过长');
  return segs.join('/');
}

const parentOf = (p) => path.posix.dirname(p);
const baseOf = (p) => path.posix.basename(p);
const join = (dir, name) => cleanPath(path.posix.join(dir, name));

/* ------------------------------------------------------------ readiness --- */

/**
 * Anything shell-backed needs the container up. A sleeping instance is woken
 * first — opening the file tab is exactly the kind of "I want to use this now"
 * signal that should end a nap, and the console does the same.
 */
async function ready(row, why = '文件管理') {
  if (!config.filesEnabled) throw new HttpError(403, '管理员关闭了文件管理功能');
  if (row.status === 'pending') throw bad('这个实例还在等管理员审批');
  if (row.status === 'rejected') throw bad('这个申请已被驳回');
  // 封存的实例不能像休眠那样被「用一下」唤醒 —— 它的有效期已经过去了。
  if (row.status === 'archived') {
    throw bad('实例已封存，容器不会再启动，面板里也就没法再浏览它的文件了');
  }
  if (!row.container_id) throw bad('容器还未创建完成');

  let state = await dk.containerState(row.container_id);
  if (!state.running && row.status === 'sleeping') {
    await sleeper.wake(row.id, why);
    state = await dk.containerState(row.container_id);
  }
  return state;
}

async function requireRunning(row, why) {
  const state = await ready(row, why);
  if (!state.running) throw bad('容器未在运行，先启动它再管理文件');
}

/** Content moves through the archive API, which a stopped container supports. */
async function requireExists(row) {
  const state = await ready(row);
  if (state.status === 'missing') throw bad('容器不存在');
}

/* --------------------------------------------------------------- listing --- */

/**
 * One directory, in one exec. Written against POSIX sh with no assumptions:
 * the type comes from shell tests (so no `ls` output parsing, which is where
 * every home-grown file manager goes wrong on names with spaces), and size and
 * mtime come from a single `stat` call that is allowed to fail — busybox and
 * coreutils both understand this format, and an image with neither still gets a
 * usable listing, just without the numbers.
 *
 * Names are the rest of the line, so anything except a newline inside a
 * filename survives the round trip.
 */
const LIST_SCRIPT = `
cd -- "$1" 2>/dev/null || { echo "E nodir"; exit 0; }
for f in * .*; do
  case $f in .|..) continue;; esac
  if [ -L "$f" ]; then
    if [ -d "$f" ]; then t=ld; else t=lf; fi
  elif [ -d "$f" ]; then t=d
  elif [ -f "$f" ]; then t=f
  elif [ -e "$f" ]; then t=o
  else continue
  fi
  echo "T $t $f"
done
stat -c 'S %s %Y %n' -- * .* 2>/dev/null
exit 0
`;

export async function list(row, dirRaw) {
  const dir = cleanPath(dirRaw);
  await requireRunning(row, '浏览文件');

  const res = await dk.execCollect(row.container_id, ['/bin/sh', '-c', LIST_SCRIPT, 'sh', dir], {
    limitBytes: 4 << 20,
  });
  if (res.exitCode === 126 || res.exitCode === 127 || /no such file|not found/i.test(res.stderr)) {
    throw bad('这个镜像里没有 /bin/sh，没法浏览它的文件');
  }

  const meta = new Map(); // name -> { size, mtime }
  const entries = [];
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('E ')) throw new HttpError(404, `目录不存在：${dir}`);
    if (line.startsWith('T ')) {
      const sp = line.indexOf(' ', 2);
      if (sp === -1) continue;
      const type = line.slice(2, sp);
      const name = line.slice(sp + 1);
      if (name) entries.push({ name, type });
      continue;
    }
    if (line.startsWith('S ')) {
      const m = /^S (\d+) (\d+) (.*)$/.exec(line);
      if (!m) continue;
      const name = baseOf(m[3]);
      meta.set(name, { size: Number(m[1]), mtime: Number(m[2]) * 1000 });
    }
  }

  const truncated = entries.length > config.fileMaxEntries || res.truncated;
  const kept = entries.slice(0, config.fileMaxEntries).map((e) => {
    const m = meta.get(e.name);
    return {
      name: e.name,
      path: join(dir, e.name),
      // 'd' 目录 | 'f' 文件 | 'ld'/'lf' 软链接 | 'o' 其它（设备、套接字…）
      type: e.type,
      dir: e.type === 'd' || e.type === 'ld',
      link: e.type.startsWith('l'),
      size: e.type === 'd' || e.type === 'ld' ? null : (m?.size ?? null),
      mtime: m?.mtime ? new Date(m.mtime).toISOString() : null,
    };
  });
  // Directories first, then by name — the order every file manager has.
  kept.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh-CN') : a.dir ? -1 : 1));

  return { path: dir, parent: dir === '/' ? null : parentOf(dir), entries: kept, truncated };
}

/* ------------------------------------------------------ owner / mode --- */

/** Mode, uid and gid of one path, or null when it does not exist. */
async function statOne(row, target) {
  const res = await dk.execCollect(
    row.container_id,
    ['/bin/sh', '-c', 'stat -c "%a %u %g %F" -- "$1" 2>/dev/null || exit 9', 'sh', target],
    { limitBytes: 4096 }
  );
  const m = /^(\d+) (\d+) (\d+) (.*)$/m.exec(res.stdout.trim());
  if (!m) return null;
  return {
    mode: parseInt(m[1], 8) || 0o644,
    uid: Number(m[2]),
    gid: Number(m[3]),
    kind: m[4].trim(),
  };
}

/* ------------------------------------------------------------ download --- */

/** The archive stream Docker is handing over, or a 404 in the caller's language. */
async function archiveOf(row, target) {
  try {
    return await dk.getArchive(row.container_id, target);
  } catch (err) {
    if (err.statusCode === 404) throw new HttpError(404, `文件不存在：${target}`);
    throw err;
  }
}

/**
 * Reads the first tar block off a stream and hands back both the block and a
 * stream that still starts with it. Deciding file-vs-directory means looking at
 * that header, and a directory download has to be forwarded byte for byte — so
 * whatever the probe consumed has to be put back, or the .tar the browser saves
 * is missing its first entry and will not open.
 */
function peekBlock(src, size = 512) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    const cleanup = () => {
      src.off('data', onData);
      src.off('end', onEnd);
      src.off('error', onError);
    };
    const handOver = () => {
      const head = Buffer.concat(chunks);
      const rest = new PassThrough();
      if (head.length) rest.write(head);
      src.pipe(rest);
      resolve({ head, stream: rest });
    };
    const onData = (c) => {
      chunks.push(c);
      len += c.length;
      if (len < size) return;
      cleanup();
      src.pause();
      handOver();
    };
    const onEnd = () => {
      cleanup();
      handOver(); // shorter than one block: let the caller call it empty
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    src.on('data', onData);
    src.on('end', onEnd);
    src.on('error', onError);
  });
}

/**
 * A file streams out as itself; a directory streams out as a .tar, since that
 * is what Docker hands over and repacking it as a zip would mean pulling in a
 * compression library for one button.
 */
export async function download(row, targetRaw) {
  const target = cleanPath(targetRaw);
  if (target === '/') throw bad('不能整个根目录打包下载');
  await requireExists(row);

  const src = await archiveOf(row, target);
  const { head, stream } = await peekBlock(src);
  const header = head.length >= 512 ? tar.parseHeader(head.subarray(0, 512)) : null;
  if (!header) {
    stream.destroy();
    throw bad('没读到内容，文件可能刚被删掉了');
  }

  const name = baseOf(target);
  if (header.type === '5') {
    return { stream, filename: `${name}.tar`, contentType: 'application/x-tar' };
  }
  if (header.type === '2') {
    stream.destroy();
    throw bad(`${name} 是软链接 → ${header.linkname}，请打开它指向的路径`);
  }

  const un = tar.extractFirstFile();
  stream.pipe(un);
  return {
    stream: un,
    filename: name,
    // Only a plain file entry states its own length; behind a pax/long-name
    // record the size in this header belongs to the record, not to the file, so
    // the response is left unsized rather than wrongly sized.
    size: header.type === '0' || header.type === '\0' ? header.size : null,
    contentType: 'application/octet-stream',
  };
}

/* -------------------------------------------------------------- reading --- */

const isBinary = (buf) => buf.subarray(0, 8192).includes(0);

/** File content for the editor. Refuses what the editor would only mangle. */
export async function read(row, targetRaw) {
  const target = cleanPath(targetRaw);
  await requireExists(row);
  const limit = config.fileEditMaxBytes;

  const stream = await archiveOf(row, target);
  const un = tar.extractFirstFile();
  const chunks = [];
  let size = 0;
  let header = null;
  un.on('entry', (h) => (header = h));

  await new Promise((resolve, reject) => {
    un.on('data', (c) => {
      size += c.length;
      if (size <= limit + 1) chunks.push(c);
    });
    un.on('end', resolve);
    un.on('error', reject);
    stream.on('error', reject);
    stream.pipe(un);
  });

  if (header?.type === '5') throw bad('这是一个目录，不是文件');
  if (header?.type === '2') throw bad(`这是软链接 → ${header.linkname}，请打开它指向的路径`);
  const buf = Buffer.concat(chunks);
  const total = header?.size ?? size;
  if (isBinary(buf)) {
    return { path: target, size: total, binary: true, truncated: false, text: '', mode: header?.mode ?? null };
  }
  if (total > limit) {
    return {
      path: target,
      size: total,
      binary: false,
      truncated: true,
      text: buf.subarray(0, limit).toString('utf8'),
      mode: header?.mode ?? null,
    };
  }
  return { path: target, size: total, binary: false, truncated: false, text: buf.toString('utf8'), mode: header?.mode ?? null };
}

/* -------------------------------------------------------------- writing --- */

/** Push one tar into the container, mapping Docker's errors to plain sentences. */
async function extractInto(row, dir, entries) {
  try {
    await dk.putArchive(row.container_id, dir, tar.build(entries));
  } catch (err) {
    if (err.statusCode === 404) throw new HttpError(404, `目录不存在：${dir}`);
    if (err.statusCode === 403) throw new HttpError(403, '容器拒绝了写入（目录只读？）');
    if (err.statusCode === 400) throw bad(`写入失败：${err.message}`);
    throw err;
  }
}

/** Save the editor's contents back. Keeps the file's mode and owner. */
export async function write(row, user, targetRaw, text) {
  const target = cleanPath(targetRaw);
  if (target === '/') throw bad('这不是一个文件');
  const body = String(text ?? '');
  const data = Buffer.from(body, 'utf8');
  if (data.length > config.fileEditMaxBytes) {
    throw bad(`内容超过上限（${Math.round(config.fileEditMaxBytes / 1024)} KB）`);
  }
  await requireExists(row);

  const dir = parentOf(target);
  const existing = await statOne(row, target).catch(() => null);
  if (existing && existing.kind.includes('directory')) throw bad('这是一个目录');
  const own = existing ?? (await statOne(row, dir).catch(() => null));

  await extractInto(row, dir, [
    {
      path: baseOf(target),
      data,
      mode: existing?.mode ?? 0o644,
      uid: own?.uid ?? 0,
      gid: own?.gid ?? 0,
    },
  ]);
  audit(user, 'instance.file.write', row.name, `${target} (${data.length} 字节)`);
  return { path: target, size: data.length };
}

/**
 * files = [{ path, base64 }] — the browser reads what was dropped and base64s
 * it, exactly like the static-site drop, so there is still no multipart parser
 * anywhere in this project.
 *
 * New files are given the target directory's owner: dropping a config into a
 * postgres data directory should not hand it to root.
 */
export async function upload(row, user, dirRaw, rawFiles) {
  const dir = cleanPath(dirRaw);
  if (!Array.isArray(rawFiles) || !rawFiles.length) throw bad('没有收到任何文件');
  if (rawFiles.length > config.fileUploadMaxFiles) {
    throw bad(`一次最多上传 ${config.fileUploadMaxFiles} 个文件`);
  }
  await requireExists(row);

  let total = 0;
  const files = rawFiles.map((f) => {
    const rel = cleanRelPath(f?.path);
    const data = Buffer.from(String(f?.base64 || ''), 'base64');
    total += data.length;
    if (total > config.fileUploadMaxBytes) {
      throw bad(`本次上传超过上限（${Math.round(config.fileUploadMaxBytes / 1048576)} MB）`);
    }
    return { path: rel, data };
  });

  const own = await statOne(row, dir).catch(() => null);
  if (own && !own.kind.includes('directory')) throw bad(`${dir} 不是目录`);

  // Docker will not create missing parents on extraction, so every folder a
  // dropped tree implies is written as its own entry first.
  const dirs = new Set();
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const entries = [
    ...[...dirs].sort().map((d) => ({ path: d, dir: true, mode: 0o755, uid: own?.uid ?? 0, gid: own?.gid ?? 0 })),
    ...files.map((f) => ({ path: f.path, data: f.data, mode: 0o644, uid: own?.uid ?? 0, gid: own?.gid ?? 0 })),
  ];

  await extractInto(row, dir, entries);
  audit(user, 'instance.file.upload', row.name, `${dir} ← ${files.length} 个文件 / ${total} 字节`);
  return { path: dir, count: files.length, bytes: total };
}

/* ------------------------------------------------------------ mutations --- */

/** Runs one shell command with the path as $1, turning a non-zero exit into a
 *  4xx the browser can show. */
async function run(row, script, args, what) {
  const res = await dk.execCollect(row.container_id, ['/bin/sh', '-c', script, 'sh', ...args], {
    limitBytes: 8192,
  });
  if (res.exitCode !== 0) {
    const detail = res.stderr.split('\n')[0]?.replace(/^[^:]*: /, '') || `退出码 ${res.exitCode}`;
    throw bad(`${what}失败：${detail}`);
  }
  return res;
}

export async function mkdir(row, user, dirRaw, nameRaw) {
  const dir = cleanPath(dirRaw);
  const name = cleanName(nameRaw);
  const target = join(dir, name);
  await requireRunning(row, '新建文件夹');
  await run(row, 'mkdir -- "$1"', [target], '新建文件夹');
  audit(user, 'instance.file.mkdir', row.name, target);
  return { path: target };
}

/** An empty file, so "new file" then "edit" works in images without an editor. */
export async function touch(row, user, dirRaw, nameRaw) {
  const dir = cleanPath(dirRaw);
  const name = cleanName(nameRaw);
  const target = join(dir, name);
  await requireExists(row);
  const existing = await statOne(row, target).catch(() => null);
  if (existing) throw bad('这个名字已经被占用了');
  const own = await statOne(row, dir).catch(() => null);
  await extractInto(row, dir, [{ path: name, data: Buffer.alloc(0), mode: 0o644, uid: own?.uid ?? 0, gid: own?.gid ?? 0 }]);
  audit(user, 'instance.file.touch', row.name, target);
  return { path: target };
}

export async function rename(row, user, targetRaw, nameRaw) {
  const target = cleanPath(targetRaw);
  if (target === '/') throw bad('根目录不能改名');
  const name = cleanName(nameRaw);
  const next = join(parentOf(target), name);
  if (next === target) return { path: target };
  await requireRunning(row, '重命名');
  // -n is not in POSIX mv, so the overwrite check is explicit.
  await run(row, '[ ! -e "$2" ] || { echo "exists" >&2; exit 1; }; mv -- "$1" "$2"', [target, next], '重命名');
  audit(user, 'instance.file.rename', row.name, `${target} → ${next}`);
  return { path: next };
}

export async function remove(row, user, targetRaw) {
  const target = cleanPath(targetRaw);
  if (target === '/') throw bad('不能删除根目录');
  await requireRunning(row, '删除文件');
  await run(row, 'rm -rf -- "$1"', [target], '删除');
  audit(user, 'instance.file.delete', row.name, target);
  return { path: target };
}
