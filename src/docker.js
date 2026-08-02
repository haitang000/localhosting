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
      if (err) return reject(err);
      let lastStatus = '';
      docker.modem.followProgress(
        stream,
        (doneErr) => (doneErr ? reject(doneErr) : resolve()),
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

export async function containerState(containerId) {
  if (!containerId) return { status: 'missing' };
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
    if (err.statusCode === 404) return { status: 'missing' };
    throw err;
  }
}

const act = (fn) => async (containerId, opts) => {
  const c = docker.getContainer(containerId);
  try {
    return await fn(c, opts);
  } catch (err) {
    if (err.statusCode === 304) return null; // already in requested state
    throw err;
  }
};

export const startContainer = act((c) => c.start());
export const stopContainer = act((c) => c.stop({ t: 10 }));
export const restartContainer = act((c) => c.restart({ t: 10 }));
export const killContainer = act((c) => c.kill());
export const removeContainer = act((c) => c.remove({ force: true, v: false }));

export async function getLogs(containerId, tail = 200) {
  const buf = await docker
    .getContainer(containerId)
    .logs({ stdout: true, stderr: true, tail, timestamps: false });
  return demux(buf);
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
 */
export async function execCollect(containerId, cmd, { limitBytes = 1 << 20, env } = {}) {
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
  });

  const info = await exec.inspect().catch(() => ({ ExitCode: null }));
  return {
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8').trim(),
    exitCode: info.ExitCode,
    truncated: outLen > limitBytes,
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
