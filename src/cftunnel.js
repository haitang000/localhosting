import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { db, now } from './db.js';
import { emit } from './events.js';

/**
 * Cloudflare Tunnel 自动穿透。
 *
 * 管理员在审批 / 新建实例时勾选「自动穿透」后，面板自己走 Cloudflare API：
 *   1. 建一个命名隧道（POST /accounts/<id>/cfd_tunnel），密钥是本模块自己
 *      生成的（tunnel_secret），凭据写进 data/cloudflared/<tunnelId>.json
 *   2. 给实例的每个 TCP 端口在 CF_TUNNEL_DOMAIN 下分配一个子域名
 *      （CNAME → <tunnelId>.cfargotunnel.com，proxied 必须为 true）。DNS 记录
 *      写进哪个 Zone 由 zoneId() 自动解析：CF_TUNNEL_DOMAIN 填二级域名
 *      （example.com）或三级/更深的子域（apps.example.com）都行
 *   3. 写一份 ingress 配置文件，spawn 一个 `cloudflared tunnel run` 进程
 * 对外地址（hostname）自动填进实例的 ports_json —— 管理员不用再手动配穿透。
 *
 * 生命周期跟实例走：
 *   - 删除实例 / 宽限期届满清理：停进程 + 删 DNS 记录 + 删隧道 + 删凭据文件
 *   - 到期封存：只停进程，隧道和域名保留，续期后立刻恢复
 *   - 面板重启：按数据库里的 tunnel_json 恢复进程；另有 60 秒看护循环，
 *     进程意外退出会自动拉起
 *
 * 凭据只在 .env（CF_API_TOKEN）和 data/cloudflared/ 里，API 不吐 token。
 */

const CF_BASE = 'https://api.cloudflare.com/client/v4';

/* ---------------------------------------------------------------- HTTP --- */

async function api(method, url, body) {
  const res = await fetch(`${CF_BASE}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.cfApiToken}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应（网关 502 之类），下面按状态码报错 */
  }
  if (!res.ok || (data && data.success === false)) {
    const detail = (data?.errors || []).map((e) => e.message).join('；') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API ${method} ${url} 失败：${detail}`);
  }
  return data.result;
}

/** 配置齐不齐。返回错误描述，null = 可用。CF_ZONE_ID 可选 —— 没填时
 *  建/删 DNS 记录前会用 CF_TUNNEL_DOMAIN 逐级向上解析（见 zoneId）。 */
export function configProblem() {
  if (!config.cfTunnelEnabled) return 'CF_TUNNEL_ENABLED 未开启';
  const need = [
    ['CF_API_TOKEN', config.cfApiToken],
    ['CF_ACCOUNT_ID', config.cfAccountId],
    ['CF_TUNNEL_DOMAIN', config.cfTunnelDomain],
  ];
  const missing = need.filter(([, v]) => !v).map(([k]) => k);
  return missing.length ? `缺少配置：${missing.join('、')}` : null;
}

export const enabled = () => !configProblem();

/* ---------------------------------------------------------------- Zone --- */

let zoneIdCache = null;

/**
 * DNS 记录要写进去的 Zone ID。
 *
 * CF_ZONE_ID 填了直接用（快路径）；没填就拿着 CF_TUNNEL_DOMAIN 逐级向上
 * 查 /zones?name= —— 先试整个域名（它本身就是个 Zone 的情况），再逐个
 * 去掉最左边的标签试父域（apps.example.com → example.com），顶级域（cn /
 * com）不试。所以 CF_TUNNEL_DOMAIN 填二级还是三级/更深都能解析到，前提
 * 是 API Token 带 Zone:Zone:Read。结果缓存，一个面板进程最多查一次。
 */
async function zoneId() {
  if (config.cfZoneId) return config.cfZoneId;
  if (zoneIdCache) return zoneIdCache;
  const labels = config.cfTunnelDomain.split('.').filter(Boolean);
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join('.');
    const zones = await api('GET', `/zones?name=${encodeURIComponent(name)}&status=active`);
    if (zones.length) {
      zoneIdCache = zones[0].id;
      return zoneIdCache;
    }
  }
  throw new Error(
    `无法为 CF_TUNNEL_DOMAIN（${config.cfTunnelDomain}）解析出 Cloudflare Zone：` +
      '请确认域名已托管在 Cloudflare、API Token 带 Zone:Zone:Read 权限，' +
      '或在 .env 里直接填 CF_ZONE_ID'
  );
}

/* ------------------------------------------------------------ 进程管理 --- */

const children = new Map(); // tunnelId → { child, pid, ring }

const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

function killChild(tunnelId) {
  const cur = children.get(tunnelId);
  if (!cur) return;
  children.delete(tunnelId);
  try {
    if (process.platform === 'win32') {
      // cloudflared 在 Windows 上是进程树，taskkill /T 连子进程一起杀
      spawn('taskkill', ['/pid', String(cur.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(cur.pid, 'SIGTERM');
    }
  } catch {
    /* 进程已经不在了 */
  }
}

function spawnRun(tunnelId, cfgFile) {
  const child = spawn(config.cfTunnelBin, ['tunnel', '--config', cfgFile, 'run', tunnelId], {
    windowsHide: true,
    env: { ...process.env, NO_AUTOUPDATE: '1' },
  });
  const ring = [];
  const push = (l) => {
    for (const line of String(l).split(/\r?\n/)) {
      if (!line.trim()) continue;
      ring.push(line.trim());
      if (ring.length > 8) ring.shift();
    }
  };
  child.stdout?.on('data', push);
  child.stderr?.on('data', push);
  child.on('exit', (code, signal) => {
    const cur = children.get(tunnelId);
    if (cur) push(`进程退出 code=${code} signal=${signal ?? ''}`);
  });
  children.set(tunnelId, { child, pid: child.pid, ring });
  return child;
}

const parse = (json) => {
  try {
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
};

const credDir = () => config.cfTunnelCredDir;

function buildConfig(tunnelId, credFile, tcpPorts, hostnames) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const ingress = tcpPorts
    .map((p, i) => `  - hostname: ${q(hostnames[i])}\n    service: http://127.0.0.1:${p.host}`)
    .join('\n');
  return `tunnel: ${q(tunnelId)}\ncredentials-file: ${q(credFile)}\ningress:\n${ingress}\n  - service: http_status:404\n`;
}

/** 给实例的第 idx 个 TCP 端口生成候选域名（hostname 按 DNS 规则必须唯一）。 */
function hostnameFor(instanceName, instanceId, idx) {
  const label = `${instanceName}-${instanceId.slice(0, 6)}${idx > 0 ? `-p${idx + 1}` : ''}`;
  return `${label}.${config.cfTunnelDomain}`;
}

/** 挑一个没被占用的域名：先试本名，被占就依次试 -2 ~ -9。 */
async function freeHostname(zone, base) {
  const candidates = [base, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)];
  for (const name of candidates) {
    const found = await api('GET', `/zones/${zone}/dns_records?name=${encodeURIComponent(name)}`);
    if (!found.length) return name;
  }
  throw new Error(`域名 ${base} 及其 8 个备选都已被占用`);
}

/** 删掉一个隧道的全部 DNS 记录（按名字找，防手滑删掉别人的）。 */
async function deleteDnsRecords(hostnames) {
  const zone = await zoneId();
  for (const name of hostnames) {
    const found = await api('GET', `/zones/${zone}/dns_records?name=${encodeURIComponent(name)}`);
    for (const rec of found) {
      await api('DELETE', `/zones/${zone}/dns_records/${rec.id}`).catch(() => {});
    }
  }
}

/** 删隧道 + 它的 DNS 记录。best-effort，失败不抛。 */
async function cleanupRemote(tunnelId, hostnames) {
  if (hostnames?.length) await deleteDnsRecords(hostnames).catch(() => {});
  if (tunnelId) {
    await api('DELETE', `/accounts/${config.cfAccountId}/cfd_tunnel/${tunnelId}?force=true`).catch(() => {});
  }
}

/* -------------------------------------------------------------- 对外 --- */

/**
 * 为实例创建隧道：建隧道、绑域名、拉起进程、把记录写进 instances.tunnel_json。
 * tcpPorts 是 ports_json 里 protocol === 'tcp' 的端口数组（带 host）。
 * 失败时把已经建好的东西全部回滚再抛错。
 */
export async function createTunnel(row, tcpPorts) {
  fs.mkdirSync(credDir(), { recursive: true });
  const tunnelName = `${config.cfTunnelPrefix}-${row.id.slice(0, 8)}`;
  const secret = crypto.randomBytes(32).toString('base64url');

  const created = await api('POST', `/accounts/${config.cfAccountId}/cfd_tunnel`, {
    name: tunnelName,
    config_src: 'local',
    tunnel_secret: secret,
  });
  const tunnelId = created.id;
  const hostnames = [];
  const credFile = path.join(credDir(), `${tunnelId}.json`);
  const configFile = path.join(credDir(), `${tunnelId}.yaml`);

  try {
    const accountTag = created.credentials_file?.AccountTag || config.cfAccountId;
    fs.writeFileSync(
      credFile,
      JSON.stringify({ AccountTag: accountTag, TunnelSecret: secret, TunnelID: tunnelId }, null, 2)
    );

    const zone = await zoneId();
    for (let i = 0; i < tcpPorts.length; i++) {
      const base = hostnameFor(row.name, row.id, i);
      const host = await freeHostname(zone, base);
      await api('POST', `/zones/${zone}/dns_records`, {
        type: 'CNAME',
        name: host,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
      });
      hostnames.push(host);
    }

    fs.writeFileSync(configFile, buildConfig(tunnelId, credFile, tcpPorts, hostnames));
    spawnRun(tunnelId, configFile);

    const tunnel = { tunnelName, tunnelId, credFile, configFile, hostnames, pid: spawnPid(tunnelId), createdAt: now() };
    db.prepare('UPDATE instances SET tunnel_json = ? WHERE id = ?').run(JSON.stringify(tunnel), row.id);

    // 不阻塞放行：注册连接通常 1-3 秒内建立，连不上就留个警告日志
    waitForConnection(tunnelId).then((ok) => {
      if (!ok) {
        emit(
          row.id,
          `Cloudflare 隧道进程已启动但 20 秒内未注册到 Cloudflare（进程还在重试）。检查 data/cloudflared/${tunnelId}.yaml 与网络。`,
          'warn'
        );
      }
    });
    return tunnel;
  } catch (err) {
    killChild(tunnelId);
    await cleanupRemote(tunnelId, hostnames).catch(() => {});
    for (const f of [credFile, configFile]) {
      try { fs.unlinkSync(f); } catch { /* 已删 */ }
    }
    throw err;
  }
}

/** 面板重启 / 看护循环用：隧道记录还在但进程没了，就按配置重新拉起。 */
export function ensureRunning(row) {
  const t = parse(row.tunnel_json);
  if (!t) return;
  const cur = children.get(t.tunnelId);
  if (cur && cur.child.exitCode === null && alive(cur.pid)) return;
  const cfgFile = t.configFile || path.join(credDir(), `${t.tunnelId}.yaml`);
  if (!fs.existsSync(cfgFile)) {
    // 配置文件丢了（比如数据目录被清）—— 隧道名还在 Cloudflare 那边，
    // 凭据文件没了就起不来，只能等管理员重建实例
    console.error(`  ⚠ 隧道 ${t.tunnelName} 的配置文件丢失，无法恢复（${cfgFile}）`);
    return;
  }
  spawnRun(t.tunnelId, cfgFile);
}

/** 停掉隧道进程，保留隧道和域名（封存时用，续期后 ensureRunning 拉回来）。 */
export function stop(row) {
  const t = parse(row.tunnel_json);
  if (!t) return;
  killChild(t.tunnelId);
}

/** 彻底删除：停进程、删 DNS、删隧道、删凭据文件、清数据库记录。best-effort。 */
export async function destroy(row) {
  const t = parse(row.tunnel_json);
  if (!t) return;
  killChild(t.tunnelId);
  await cleanupRemote(t.tunnelId, t.hostnames).catch((err) =>
    console.error(`  ⚠ 删除隧道 ${t.tunnelName} 失败：${err.message}`)
  );
  for (const f of [t.credFile, t.configFile]) {
    try { fs.unlinkSync(f); } catch { /* 已删 */ }
  }
  db.prepare('UPDATE instances SET tunnel_json = NULL WHERE id = ?').run(row.id);
}

/** 给 serialize 用：进程状态 + 最近几行输出，不含任何凭据。 */
export function info(row) {
  const t = parse(row.tunnel_json);
  if (!t) return null;
  const cur = children.get(t.tunnelId);
  return {
    hostnames: t.hostnames,
    running: !!(cur && cur.child.exitCode === null && alive(cur.pid)),
    output: cur?.ring?.slice(-4) || [],
  };
}

/** 隧道进程注册到 Cloudflare 之前，轮询 connections 接口确认健康。 */
async function waitForConnection(tunnelId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const conns = await api('GET', `/accounts/${config.cfAccountId}/cfd_tunnel/${tunnelId}/connections`);
      if (conns.length) return true;
    } catch {
      /* 接口抖一下，重试 */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

let watchdog = null;

/** 启动时恢复所有实例的隧道进程，并挂一个 60 秒看护循环。 */
export function start() {
  const rows = db.prepare('SELECT * FROM instances WHERE tunnel_json IS NOT NULL').all();
  let up = 0;
  for (const row of rows) {
    if (['archived', 'pending', 'rejected'].includes(row.status)) {
      // 封存 / 待审批 / 已驳回的实例不该有活着的隧道进程
      stop(row);
      continue;
    }
    try {
      ensureRunning(row);
      up++;
    } catch (err) {
      console.error(`  ⚠ 恢复隧道 ${row.name} 失败：${err.message}`);
    }
  }
  if (up) console.log(`  🌐 已恢复 ${up} 个 Cloudflare 隧道进程`);
  if (watchdog) clearInterval(watchdog);
  watchdog = setInterval(() => {
    const active = db
      .prepare(
        "SELECT * FROM instances WHERE tunnel_json IS NOT NULL AND status NOT IN ('archived','pending','rejected')"
      )
      .all();
    for (const row of active) {
      try { ensureRunning(row); } catch { /* 下轮再试 */ }
    }
  }, 60_000);
  watchdog.unref();
}

export function stopAll() {
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
  for (const tunnelId of children.keys()) killChild(tunnelId);
}

/** createTunnel 里 spawn 之后的 pid 记录（spawnRun 内部存了）。 */
function spawnPid(tunnelId) {
  const cur = children.get(tunnelId);
  return cur?.pid ?? null;
}
