import { Transform } from 'node:stream';

/**
 * Just enough tar to talk to Docker's archive endpoints.
 *
 * `GET /containers/x/archive` hands back a tar stream and `PUT` expects one, so
 * copying a single file in or out of a container means writing and reading the
 * format by hand — there is no tar dependency here, same as everywhere else in
 * this project. Only the ustar subset Docker actually produces is covered:
 * regular files, directories, symlinks, and the pax/GNU extension records that
 * carry long names (skipped rather than interpreted, since the names we care
 * about come from the request, not from the archive).
 */

const BLOCK = 512;
const ZERO = Buffer.alloc(BLOCK);

/** ustar numeric field: octal, NUL-terminated, zero-padded. */
function octal(value, len) {
  const digits = Math.max(0, Math.floor(value)).toString(8);
  if (digits.length > len - 1) throw new Error('tar 数值字段溢出');
  return `${digits.padStart(len - 1, '0')}\0`;
}

/**
 * Long paths go in the `prefix` field, split at a slash — that is the portable
 * ustar answer, and it keeps us from having to emit GNU long-name records.
 */
function splitName(path) {
  const p = path.replace(/^\/+/, '');
  if (Buffer.byteLength(p) <= 100) return { name: p, prefix: '' };
  // Try every slash from the right: the tail must fit name[100], the head prefix[155].
  for (let i = p.length - 1; i > 0; i--) {
    if (p[i] !== '/') continue;
    const name = p.slice(i + 1);
    const prefix = p.slice(0, i);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  }
  throw new Error(`路径过长，tar 放不下：${p}`);
}

function header({ path, size = 0, mode = 0o644, mtime = Date.now(), type = '0', linkname = '', uid = 0, gid = 0 }) {
  const buf = Buffer.alloc(BLOCK);
  const { name, prefix } = splitName(path);
  buf.write(name, 0, 100, 'utf8');
  buf.write(octal(mode & 0o7777, 8), 100, 8, 'ascii');
  // Docker extracts as root and honours these, so an overwrite can hand the file
  // back to whoever owned it — a config file that turns up root-owned is how you
  // break an image that runs as postgres or www-data.
  buf.write(octal(uid, 8), 108, 8, 'ascii');
  buf.write(octal(gid, 8), 116, 8, 'ascii');
  buf.write(octal(size, 12), 124, 12, 'ascii');
  buf.write(octal(Math.floor(mtime / 1000), 12), 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii'); // checksum field counts as spaces while summing
  buf.write(type, 156, 1, 'ascii');
  buf.write(linkname, 157, 100, 'utf8');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  buf.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${octal(sum, 7).slice(0, 6)}\0 `, 148, 8, 'ascii');
  return buf;
}

const padding = (size) => {
  const rem = size % BLOCK;
  return rem ? Buffer.alloc(BLOCK - rem) : Buffer.alloc(0);
};

/**
 * entries = [{ path, data }] for files, [{ path, dir: true }] for directories.
 * Returns the whole archive as one buffer: uploads are capped well below any
 * size where streaming would matter.
 */
export function build(entries) {
  const parts = [];
  for (const e of entries) {
    const own = { uid: e.uid ?? 0, gid: e.gid ?? 0 };
    if (e.dir) {
      parts.push(
        header({ path: `${e.path.replace(/\/+$/, '')}/`, size: 0, mode: e.mode ?? 0o755, type: '5', ...own })
      );
      continue;
    }
    const data = e.data ?? Buffer.alloc(0);
    parts.push(
      header({ path: e.path, size: data.length, mode: e.mode ?? 0o644, type: '0', ...own }),
      data,
      padding(data.length)
    );
  }
  parts.push(ZERO, ZERO); // end-of-archive marker
  return Buffer.concat(parts);
}

/**
 * The first 512 bytes of an archive, decoded — enough to tell a file from a
 * directory before deciding what to do with the rest of the stream. Returns
 * null for the end-of-archive block.
 */
export function parseHeader(block) {
  // Two zero blocks end the archive; one is enough to stop caring.
  if (block.every((b) => b === 0)) return null;
  const str = (off, len) => {
    const raw = block.subarray(off, off + len);
    const end = raw.indexOf(0);
    return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
  };
  const oct = (off, len) => {
    const t = str(off, len).trim();
    // GNU base-256 encoding for sizes that do not fit in octal (>8GB files).
    if (block[off] & 0x80) {
      let n = block[off] & 0x7f;
      for (let i = off + 1; i < off + len; i++) n = n * 256 + block[i];
      return n;
    }
    return t ? parseInt(t, 8) || 0 : 0;
  };
  const name = str(0, 100);
  const prefix = str(345, 155);
  return {
    path: prefix ? `${prefix}/${name}` : name,
    size: oct(124, 12),
    mode: oct(100, 8),
    mtime: oct(136, 12) * 1000,
    type: str(156, 1) || '0',
    linkname: str(157, 100),
  };
}

/** Extension records: their payload describes the *next* entry, so skip both. */
const META_TYPES = new Set(['x', 'g', 'L', 'K', 'V']);

/**
 * Unwraps the first regular file in a tar stream, passing its bytes through
 * untouched. Docker's `getArchive` on a file yields exactly one entry, so this
 * is what turns "tar of one file" back into "the file".
 *
 * The returned stream emits `entry` with the header before any data, and errors
 * if the archive holds no file at all (a directory, for instance).
 */
export function extractFirstFile() {
  let buf = Buffer.alloc(0);
  let remaining = 0; // payload bytes of the entry being emitted
  let skip = 0; // payload bytes to drop (padding, or a metadata record)
  let entry = null;
  let seen = false; // any entry at all, including a directory or a symlink
  let finished = false;

  return new Transform({
    transform(chunk, _enc, cb) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (finished) {
          buf = Buffer.alloc(0);
          return cb();
        }
        if (skip) {
          const n = Math.min(skip, buf.length);
          skip -= n;
          buf = buf.subarray(n);
          if (skip) return cb();
          continue;
        }
        if (remaining) {
          const n = Math.min(remaining, buf.length);
          this.push(buf.subarray(0, n));
          remaining -= n;
          buf = buf.subarray(n);
          if (!remaining) {
            skip = padding(entry.size).length;
            finished = true; // one file is all any caller here wants
          }
          if (buf.length === 0) return cb();
          continue;
        }
        if (buf.length < BLOCK) return cb();
        const h = parseHeader(buf.subarray(0, BLOCK));
        buf = buf.subarray(BLOCK);
        if (!h) {
          finished = true;
          continue;
        }
        if (META_TYPES.has(h.type)) {
          skip = h.size + padding(h.size).length;
          continue;
        }
        if (h.type !== '0' && h.type !== '\0' && h.type !== '7') {
          // A directory or a symlink: there are no file bytes to hand back, but
          // the caller still needs to hear what it was, so this is reported as
          // an entry rather than treated as an empty archive.
          if (h.type === '5' || h.type === '2') {
            seen = true;
            this.emit('entry', h);
            finished = true;
            continue;
          }
          skip = h.size + padding(h.size).length;
          continue;
        }
        entry = h;
        seen = true;
        remaining = h.size;
        this.emit('entry', h);
        if (!remaining) {
          finished = true;
          continue;
        }
      }
    },
    flush(cb) {
      if (!seen) return cb(new Error('归档是空的'));
      cb();
    },
  });
}
