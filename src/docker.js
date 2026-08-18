import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import { config } from './config.js';

function buildDocker() {
  const h = config.dockerHost;
  if (h && /^tcp:\/\//.test(h)) {
    const u = new URL(h.replace(/^tcp:/, 'http:'));
    return new Docker({ host: u.hostname, port: Number(u.port || 2375) });
  }
  if (h && /^npipe:/.test(h)) return new Docker({ socketPath: h.replace(/^npipe:\/\//, '') });
  if (h && /^unix:/.test(h)) return new Docker({ socketPath: h.replace(/^unix:\/\//, '') });
  if (process.platform === 'win32') return new Docker({ socketPath: '//./pipe/docker_engine' });
  return new Docker();
}

export const docker = buildDocker();

/**
 * 上游（Docker daemon / 镜像仓库）偶尔会返回一整张 HTML 错误页而不是 JSON
 * 错误（拉取不存在的镜像、被镜像源网关拦截、网络被墙时常见），dockerode 会把
 * 响应体原样塞进 err.message —— 直接丢给界面就是一墙标签。识别这种响应，
 * 换成一句能看懂的话；原始内容打到控制台供排查，绝不往用户界面漏。
 */
export function friendlyError(err, fallback = '操作失败') {
  const msg = err?.message || String(err || '');
  if (!msg.trim()) return fallback;
  if (/^\s*<!DOCTYPE|<html[\s>]/i.test(msg.trim())) {
    console.error(`  ⚠ Docker 上游返回了 HTML 错误页（已转友好提示），原始内容：\n${msg.slice(0, 2000)}`);
    return `${fallback}：上游返回了非 JSON 的错误页面（常见于网络被拦或镜像源异常），请稍后重试或换个镜像源`;
  }
  return msg;
}

export const LABEL_MANAGED = 'lh.managed';
export const LABEL_INSTANCE = 'lh.instance';
export const LABEL_USER = 'lh.user';

export async function ping() {
  await docker.ping();
  return docker.version();
}

/** Pull an image, reporting coarse progress lines through onLog. */
export function pullImage(image, onLog = () => {}) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(friendlyError(err, '镜像拉取失败'));
      let lastStatus = '';
      docker.modem.followProgress(
        stream,
        (doneErr) => (doneErr ? reject(friendlyError(doneErr, '镜像拉取失败')) : resolve()),
        (event) => {
          const line = event.status ? `${event.status}${event.id ? ` ${event.id}` : ''}` : '';
          if (line && line !== lastStatus) {
            lastStatus = line;
            onLog(line);
          }
        }
      );
    });
  });
}

export async function imageExists(image) {
  try {
    await docker.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

/** Same naming scheme used at creation time and at every later lookup. */
export function volumeNamesFor(volumeName, volumePaths) {
  return (volumePaths || []).map((_, i) => (i === 0 ? volumeName : `${volumeName}-${i}`));
}

/**
 * spec = {
 *   name, image, instanceId, userId, username, env {}, cmd []|null,
 *   memoryMb, cpus, portBindings [{ containerPort, protocol, hostPort }],
 *   volumeName, volumePaths []
 * }
 */
export async function createContainer(spec) {
  const exposed = {};
  const bindings = {};
  for (const p of spec.portBindings) {
    const key = `${p.containerPort}/${p.protocol}`;
    exposed[key] = {};
    bindings[key] = [{ HostIp: config.bindAddress, HostPort: String(p.hostPort) }];
  }

  const binds = volumeNamesFor(spec.volumeName, spec.volumePaths).map((v, i) => `${v}:${spec.volumePaths[i]}`);

  const container = await docker.createContainer({
    name: spec.name,
    Image: spec.image,
    Cmd: spec.cmd && spec.cmd.length ? spec.cmd : undefined,
    Env: Object.entries(spec.env || {}).map(([k, v]) => `${k}=${v}`),
    Labels: {
      [LABEL_MANAGED]: 'true',
      [LABEL_INSTANCE]: spec.instanceId,
      [LABEL_USER]: String(spec.userId),
      'lh.username': spec.username,
    },
    ExposedPorts: exposed,
    HostConfig: {
      PortBindings: bindings,
      Binds: binds,
      NetworkMode: config.networkName,
      Memory: spec.memoryMb * 1024 * 1024,
      MemorySwap: spec.memoryMb * 1024 * 1024,
      NanoCpus: Math.round(spec.cpus * 1e9),
      PidsLimit: config.pidsLimit,
      RestartPolicy: { Name: 'unless-stopped' },
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      // 优先用实例自己的磁盘配额（积分套餐/自定义带 diskMb）；券和老实例回退全局 DISK_QUOTA
      StorageOpt: spec.diskMb
        ? { size: `${spec.diskMb}m` }
        : config.diskQuota
          ? { size: config.diskQuota }
          : undefined,
    },
  });
  return container;
}

/* container inspect 是轮询热路径（概览每 6 秒、每个实例一次），多个标签页同时开着
   时会对 Docker daemon 重复轰炸。加一层 1.5 秒的 TTL 缓存 + 并发去重：
   ——同一实例在同一窗口内的并发请求共享同一个 in-flight promise；
   ——重复请求直接命中缓存。轮询周期本身就 >1.5s，展示数据的陈旧程度不受影响。 */
const stateCache = new Map(); // containerId -> { promise, at }
const STATE_CACHE_TTL = 1500;

export function containerState(containerId) {
  if (!containerId) return Promise.resolve({ status: 'missing' });
  const hit = stateCache.get(containerId);
  if (hit && Date.now() - hit.at < STATE_CACHE_TTL) return hit.promise;
  const promise = (async () => {
    try {
      const info = await docker.getContainer(containerId).inspect();
      return {
        status: info.State.Status, // created | running | paused | restarting | removing | exited | dead
        running: info.State.Running,
        startedAt: info.State.StartedAt,
        finishedAt: info.State.FinishedAt,
        exitCode: info.State.ExitCode,
        health: info.State.Health?.Status || null,
        restartCount: info.RestartCount,
      };
    } catch (err) {
      // 失败不缓存：下一次调用重试，别让一次抖动把状态钉住 1.5 秒。
      stateCache.delete(containerId);
      if (err.statusCode === 404) return { status: 'missing' };
      throw err;
    }
  })();
  stateCache.set(containerId, { promise, at: Date.now() });
  return promise;
}

const act = (fn) => async (containerId, opts) => {
  const c = docker.getContainer(containerId);
  try {
    return await fn(c, opts);
  } catch (err) {
    if (err.statusCode === 304) return null; // already in requested state
    throw err;
  } finally {
    // 操作会立刻改变容器状态，把旧缓存清掉，下一个请求拿到的就是新状态。
    stateCache.delete(containerId);
  }
};

export const startContainer = act((c) => c.start());
export const stopContainer = act((c) => c.stop({ t: 10 }));
export const restartContainer = act((c) => c.restart({ t: 10 }));
export const killContainer = act((c) => c.kill());
export const removeContainer = act((c) => c.remove({ force: true, v: false }));

/* 一次性读日志必须走流：follow:false 时 docker-modem 会把 daemon 的整个
   响应聚成一个 Buffer 才交出来，一条几百 MB 的无换行日志能把面板直接
   拖进 OOM。这里直接向 modem 要流、边收边数，累计到上限就掐断连接 ——
   内存占用封顶在 LOGS_CAP_BYTES，而不是容器日志文件的大小。 */
const LOGS_CAP_BYTES = 2 * 1024 * 1024;
const LOGS_TIMEOUT_MS = 15_000;

export function getLogs(containerId, tail = 200) {
  return new Promise((resolve, reject) => {
    docker.modem.dial(
      {
        path: `/containers/${containerId}/logs?`,
        method: 'GET',
        options: { stdout: true, stderr: true, tail, timestamps: false, follow: false },
        isStream: true,
        statusCodes: { 200: true, 404: 'no such container', 500: 'server error' },
      },
      (err, stream) => {
        if (err) return reject(err);
        const out = new PassThrough();
        const errOut = new PassThrough();
        docker.modem.demuxStream(stream, out, errOut);

        const chunks = [];
        let len = 0;
        let truncated = false;
        let settled = false;
        const take = (src) =>
          src.on('data', (c) => {
            if (len >= LOGS_CAP_BYTES) {
              truncated = true;
              stream.destroy();
              return;
            }
            if (len + c.length > LOGS_CAP_BYTES) {
              c = c.subarray(0, LOGS_CAP_BYTES - len);
              truncated = true;
            }
            chunks.push(c);
            len += c.length;
          });
        take(out);
        take(errOut);

        const timer = setTimeout(() => {
          truncated = true;
          stream.destroy();
          finish();
        }, LOGS_TIMEOUT_MS);
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          let text = Buffer.concat(chunks).toString('utf8');
          if (truncated) text += '\n（日志过长，已截断）';
          resolve(text);
        };
        stream.on('end', finish);
        stream.on('close', finish);
        stream.on('error', (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        });
      }
    );
  });
}

/** Docker multiplexes stdout/stderr with an 8-byte header per frame. */
export function demux(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let out = '';
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const len = buf.readUInt32BE(i + 4);
    if (type > 2 || len > buf.length - i - 8) {
      // Not a framed stream (TTY mode) — return raw.
      return buf.toString('utf8');
    }
    out += buf.subarray(i + 8, i + 8 + len).toString('utf8');
    i += 8 + len;
  }
  return out || buf.toString('utf8');
}

export function followLogs(containerId, onChunk, tail = 100) {
  return docker
    .getContainer(containerId)
    .logs({ stdout: true, stderr: true, follow: true, tail })
    .then((stream) => {
      stream.on('data', (chunk) => onChunk(demux(chunk)));
      return stream;
    });
}

/** Process list of a running container (`docker top`), one cmdline string per
 *  process — feeds the security guard's periodic mining scan. */
export async function containerTop(containerId) {
  const t = await docker.getContainer(containerId).top({ psargs: ['-ef'] });
  return (t.Processes || []).map((cols) => cols.join(' '));
}

export async function getStats(containerId) {
  const s = await docker.getContainer(containerId).stats({ stream: false });
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage?.total_usage ?? 0);
  const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage ?? 0);
  const cores = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  const cpuPercent = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cores * 100 : 0;
  const memUsage = (s.memory_stats.usage ?? 0) - (s.memory_stats.stats?.cache ?? 0);
  const memLimit = s.memory_stats.limit ?? 0;
  const net = Object.values(s.networks || {}).reduce(
    (a, n) => ({ rx: a.rx + n.rx_bytes, tx: a.tx + n.tx_bytes }),
    { rx: 0, tx: 0 }
  );
  return {
    cpuPercent: Number(cpuPercent.toFixed(1)),
    memUsage,
    memLimit,
    memPercent: memLimit ? Number(((memUsage / memLimit) * 100).toFixed(1)) : 0,
    netRx: net.rx,
    netTx: net.tx,
  };
}

export async function removeVolume(name) {
  try {
    await docker.getVolume(name).remove({ force: true });
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
}

export async function listManaged() {
  return docker.listContainers({ all: true, filters: { label: [`${LABEL_MANAGED}=true`] } });
}

export async function execStream(containerId, cmd, { tty = true, cols = 80, rows = 24, env } = {}) {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: cmd,
    Env: env && env.length ? env : undefined,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: tty,
  });
  const stream = await exec.start({ hijack: true, stdin: true, Tty: tty });
  if (tty) await exec.resize({ h: rows, w: cols }).catch(() => {});
  return { exec, stream };
}

/**
 * Run a command to completion and collect what it printed. Unlike execStream
 * this is for one-shot commands the panel itself issues (listing a directory,
 * making one) rather than an interactive shell, so stdout and stderr are kept
 * apart and the exit code comes back with them.
 *
 * stdout is capped: a command that decides to print a gigabyte should not take
 * the panel down with it. Everything past the cap is dropped and flagged.
 *
 * timeoutMs 是软超时：到期直接把流掐掉、照常返回已收的输出（rcon-cli 偶尔会
 * 因为服务器没响应而挂住，不能让它把面板的请求一起拖死）。
 */
export async function execCollect(containerId, cmd, { limitBytes = 1 << 20, env, timeoutMs = 0 } = {}) {
  const exec = await docker.getContainer(containerId).exec({
    Cmd: cmd,
    Env: env && env.length ? env : undefined,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true });
  const out = [];
  const err = [];
  let outLen = 0;
  let errLen = 0;
  let timedOut = false;

  await new Promise((resolve, reject) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    docker.modem.demuxStream(stream, stdout, stderr);
    stdout.on('data', (c) => {
      outLen += c.length;
      if (outLen <= limitBytes) out.push(c);
    });
    stderr.on('data', (c) => {
      errLen += c.length;
      if (errLen <= 8192) err.push(c);
    });
    stream.on('end', resolve);
    stream.on('close', resolve);
    stream.on('error', reject);
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            stream.destroy();
          } catch {
            /* ignore */
          }
          resolve();
        }, timeoutMs)
      : null;
    if (timer) stream.on('close', () => clearTimeout(timer));
  });

  const info = await exec.inspect().catch(() => ({ ExitCode: null }));
  return {
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8').trim(),
    exitCode: info.ExitCode,
    truncated: outLen > limitBytes,
    timedOut,
  };
}

/* --- container filesystem (the same endpoints `docker cp` uses) ---
   These work on a stopped container too, which is why file *content* moves
   through them instead of through a shell. */

export const getArchive = (containerId, path) => docker.getContainer(containerId).getArchive({ path });

/** `tar` is a Buffer; `path` must be an existing directory inside the container. */
export const putArchive = (containerId, path, tar) =>
  docker.getContainer(containerId).putArchive(tar, { path });

export async function diskUsage() {
  const df = await docker.df();
  return {
    images: df.LayersSize,
    containers: (df.Containers || []).reduce((a, c) => a + (c.SizeRw || 0), 0),
    volumes: (df.Volumes || []).reduce((a, v) => a + (v.UsageData?.Size > 0 ? v.UsageData.Size : 0), 0),
  };
}

/** name -> bytes used, for every volume Docker knows about. */
export async function volumeSizes() {
  const df = await docker.df();
  const map = {};
  for (const v of df.Volumes || []) {
    if (v.UsageData?.Size >= 0) map[v.Name] = v.UsageData.Size;
  }
  return map;
}
