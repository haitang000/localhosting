import crypto from 'node:crypto';
import { config, publicAddress } from './config.js';
import { db, now, audit } from './db.js';
import { templateById } from './templates.js';
import { allocatePorts, releasePorts } from './ports.js';
import * as dk from './docker.js';
import { emit, reset as resetEvents } from './events.js';
import { getInvite, inviteProblem, consume, refund } from './invites.js';
import { spendPoints, refundPoints, balanceOf, priceInstanceSpec } from './points.js';
import { consumeBundleStock, refundBundleStock } from './bundles.js';
import * as sleeper from './sleeper.js';
import * as lifespan from './lifespan.js';
import * as diskguard from './diskguard.js';
import * as guard from './guard.js';
import * as term from './console.js';
import * as cftunnel from './cftunnel.js';

export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);

export function usage(userId) {
  // 端口数用 SQLite 的 json_array_length 直接算，省掉每行一次 JSON.parse。
  const rows = db
    .prepare(
      'SELECT memory_mb, cpus, disk_mb, json_array_length(ports_json) AS port_count FROM instances WHERE user_id = ?'
    )
    .all(userId);
  return {
    instances: rows.length,
    memoryMb: rows.reduce((a, r) => a + r.memory_mb, 0),
    cpus: Number(rows.reduce((a, r) => a + r.cpus, 0).toFixed(2)),
    diskMb: rows.reduce((a, r) => a + (r.disk_mb ?? 0), 0),
    ports: rows.reduce((a, r) => a + (r.port_count ?? 0), 0),
  };
}

// 区域级用量：所有用户、所有实例合计占用的内存 / CPU。已封存（到期停机、端口
// 已归还）和已驳回的实例不再占用算力，所以排除掉；pending / creating 会预留
// 资源，照常计入。用来跟 config.regionMaxMemoryMb / regionMaxCpus 比较。
export function globalUsage() {
  const rows = db
    .prepare("SELECT memory_mb, cpus FROM instances WHERE status NOT IN ('archived', 'rejected')")
    .all();
  return {
    memoryMb: rows.reduce((a, r) => a + r.memory_mb, 0),
    cpus: Number(rows.reduce((a, r) => a + r.cpus, 0).toFixed(2)),
  };
}

function assertImageAllowed(image, user, invite) {
  if (!/^[\w.\-/:@]+$/.test(image)) throw bad('镜像名含非法字符');
  if (image.length > 200) throw bad('镜像名过长');
  const allowed = user.role === 'admin' || user.allow_custom_image || invite?.allow_custom_image;
  if (!allowed) {
    throw new HttpError(403, invite ? '这张资源券不允许自定义镜像，请从模板里选一个' : '积分开的基础实例不支持自定义镜像，请从模板里选一个');
  }
  // Docker only treats the first path component as a registry when there is
  // more than one component and it looks like a host (contains "." / ":" /
  // is "localhost"). "alpine:3.20" and "user/app" are Docker Hub names.
  const parts = image.split('/');
  const looksLikeHost = parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost';
  const registry = parts.length > 1 && looksLikeHost ? parts[0].split(':')[0] : '';
  if (!config.allowedRegistries.includes(registry)) {
    throw bad(`镜像仓库 ${registry || 'docker.io'} 不在白名单内`);
  }
}

function buildEnv(template, provided) {
  const env = {};
  const generated = {};
  for (const field of template?.env ?? []) {
    let v = provided?.[field.key];
    if (v === undefined || v === '') v = field.default ?? '';
    if (v === '' && field.generate === 'password') {
      v = crypto.randomBytes(12).toString('base64url');
      generated[field.key] = v;
    }
    if (v === '' && field.required) throw bad(`环境变量 ${field.label || field.key} 必填`);
    if (field.type === 'select' && field.options && v && !field.options.includes(v)) {
      throw bad(`${field.label || field.key} 的取值不合法`);
    }
    if (v !== '') env[field.key] = String(v);
  }
  return { env, generated };
}

function buildCustomEnv(provided) {
  const env = {};
  for (const [k, v] of Object.entries(provided || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw bad(`环境变量名 ${k} 不合法`);
    if (String(v).length > 4096) throw bad(`环境变量 ${k} 过长`);
    env[k] = String(v);
  }
  return { env, generated: {} };
}

export async function createInstance(user, body) {
  const name = String(body.name || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) throw bad('实例名需为 3-30 位小写字母、数字或连字符，且不能以连字符开头/结尾');

  const exists = db.prepare('SELECT 1 FROM instances WHERE user_id = ? AND name = ?').get(user.id, name);
  if (exists) throw bad('你已经有同名实例了');

  // 两种付法：填了老资源券就走券（额度写在券上）；没填券就扣积分，
  // 规格是用户在支付页自己配的（body.spec），价钱由 priceInstanceSpec 说了算。
  const inviteCode = String(body.inviteCode || '').trim();
  let invite = null;
  if (inviteCode) {
    invite = getInvite(inviteCode);
    const problem = inviteProblem(invite, 'instance', 'instance');
    if (problem) throw new HttpError(403, problem);
  }

  const template = body.templateId ? templateById(body.templateId) : null;
  if (body.templateId && !template) throw bad('模板不存在');

  let image;
  let cmd = null;
  let volumePaths = [];
  let portSpecs = [];

  if (template) {
    image = template.image;
    cmd = template.cmd ?? null;
    volumePaths = template.volumes ?? [];
    portSpecs = template.ports ?? [];
  } else {
    image = String(body.image || '').trim();
    if (!image) throw bad('请填写镜像名');
    if (!image.includes(':') && !image.includes('@')) image += ':latest';
    assertImageAllowed(image, user, invite);
    cmd = Array.isArray(body.cmd) && body.cmd.length ? body.cmd.map(String) : null;
    const ports = Array.isArray(body.ports) ? body.ports : [];
    portSpecs = ports.map((p) => {
      const cp = Number(p.container ?? p);
      if (!Number.isInteger(cp) || cp < 1 || cp > 65535) throw bad(`容器端口 ${p.container ?? p} 不合法`);
      return { container: cp, protocol: p.protocol === 'udp' ? 'udp' : 'tcp', label: p.label || `端口 ${cp}` };
    });
    if (body.volumePath) {
      const vp = String(body.volumePath).trim();
      // 白名单而不是黑名单：这个值后面会被拼进 sh 命令（RCON 参数读取、
      // latest.log tail），引号 / $ / 分号一类字符在这里就没有存在的理由。
      if (!vp.startsWith('/') || vp === '/') throw bad('数据卷挂载路径必须是绝对路径，且不能是根目录');
      if (vp.length > 100) throw bad('数据卷挂载路径过长');
      if (!/^[\w./-]+$/.test(vp)) throw bad('数据卷挂载路径只能包含字母、数字、下划线、点、连字符和 /');
      volumePaths = [vp];
    }
  }

  // Resources come from the voucher — or from the spec the user configured on
  // the pay step, which is validated and priced server-side before any spend.
  let plan = null;
  if (!invite) {
    try {
      plan = priceInstanceSpec(body.spec);
    } catch (err) {
      throw bad(err.message);
    }
  }
  const memoryMb = invite ? invite.memory_mb : plan.memoryMb;
  const cpus = invite ? invite.cpus : plan.cpus;
  const maxPorts = invite ? invite.ports : plan.ports;
  // 硬盘配额：积分路径跟着规格走（套餐/自定义都带 diskMb）；
  // 资源券现在可以自带 disk_mb（发券时填），老券没有这列回退全局 DISK_QUOTA_MB。
  const diskMb = invite ? (invite.disk_mb ?? config.diskQuotaMb) : plan.diskMb;
  if (!Number.isFinite(memoryMb) || memoryMb < 64) throw bad('这张资源券的内存额度无效，请联系管理员');
  if (!Number.isFinite(cpus) || cpus < 0.1) throw bad('这张资源券的 CPU 额度无效，请联系管理员');
  if (!Number.isInteger(diskMb) || diskMb < 128) throw bad('磁盘配额无效，请联系管理员');
  if (portSpecs.length > maxPorts) {
    throw new HttpError(
      403,
      invite
        ? `这张资源券只允许 ${maxPorts} 个对外端口，所选配置需要 ${portSpecs.length} 个`
        : `你配的规格只有 ${maxPorts} 个对外端口，所选配置需要 ${portSpecs.length} 个 —— 回第一步加端口`
    );
  }

  // The voucher governs resources; the account-level cap only limits how many
  // instances one person may run at once.
  const u = usage(user.id);
  if (u.instances + 1 > user.max_instances) throw new HttpError(403, `实例数已达上限（${user.max_instances}）`);

  // 区域总算力封顶：整台宿主机的内存 / CPU 就那么多，不管用券还是积分，
  // 加上这台新实例后超过上限就拒。0 = 不限制。
  const region = globalUsage();
  const overMem = config.regionMaxMemoryMb > 0 && region.memoryMb + memoryMb > config.regionMaxMemoryMb;
  const overCpu = config.regionMaxCpus > 0 && region.cpus + cpus > config.regionMaxCpus;
  if (overMem || overCpu) throw new HttpError(503, '当前区域已无剩余算力，请稍后再试');

  const { env, generated } = template ? buildEnv(template, body.env) : buildCustomEnv(body.env);

  // Idle sleep needs a TCP port to listen on while the container is down, so a
  // UDP-only or port-less instance simply cannot take part. Asking for it
  // explicitly is an error; inheriting it from the default just turns it off.
  const askedSleep = body.sleep?.enabled !== undefined;
  let sleepEnabled = config.idleSleepEnabled && (askedSleep ? Boolean(body.sleep.enabled) : config.idleSleepDefault);
  if (sleepEnabled && portSpecs.some((p) => p.protocol === 'udp')) {
    if (askedSleep) throw bad('UDP 服务无法通过连接唤醒，不能开启闲时休眠');
    sleepEnabled = false;
  }
  if (sleepEnabled && !portSpecs.length) {
    if (askedSleep) throw bad('没有对外端口的实例休眠后无法被唤醒');
    sleepEnabled = false;
  }
  let idleMinutes = null;
  if (sleepEnabled && body.sleep?.idleMinutes !== undefined) {
    idleMinutes = Math.round(Number(body.sleep.idleMinutes));
    if (!Number.isFinite(idleMinutes) || idleMinutes < 1 || idleMinutes > 1440) {
      throw bad('空闲分钟数需在 1 - 1440 之间');
    }
  }

  let paidPoints = 0;
  let bundleId = null;
  if (invite) {
    if (!consume(invite.code)) throw new HttpError(403, '这张资源券刚刚被用完了');
  } else {
    paidPoints = plan.cost;
    if (!spendPoints(user, paidPoints, 'instance.create', name)) {
      throw new HttpError(
        403,
        `积分不够：这个配置要 ${paidPoints} 积分，你当前有 ${balanceOf(user.id)} 积分`
      );
    }
    // 命中打包套餐的实例扣一份库存；没抢到（并发下刚卖完）就把积分退回。
    if (plan.bundleId && !consumeBundleStock(plan.bundleId)) {
      refundPoints(user.id, paidPoints, 'instance.create_failed', name);
      throw new HttpError(409, '该套餐刚刚售罄，积分已退回，请选择其他套餐');
    }
    bundleId = plan.bundleId;
  }

  const id = crypto.randomUUID();
  const volumeName = volumePaths.length ? `${config.containerPrefix}-vol-${id.slice(0, 8)}` : null;
  // How long this instance gets to live is a property of the voucher — or of
  // the points tier — copied down now: editing the voucher later must not
  // retroactively move the deadline of something already built with it.
  // 套餐自带时长时优先用套餐的（plan.days），否则跟随全局 POINTS_INSTANCE_DAYS。
  const lifeDays = invite
    ? lifespan.lifeDaysOf(invite)
    : (plan.days !== null && plan.days !== undefined ? plan.days : config.pointsInstanceDays) || null;

  // Nothing is handed to Docker yet: the row goes in as a pending request and
  // waits for an admin, who sets up the tunnel by hand and then approves it.
  // The row has to exist before ports can be allocated — port_allocations has a
  // foreign key onto instances(id).
  db.prepare(
    `INSERT INTO instances
      (id, user_id, name, image, template_id, memory_mb, cpus, disk_mb, env_json, ports_json, volume_name,
       invite_code, paid_points, bundle_id, cmd_json, volume_paths_json, note, sleep_enabled, idle_minutes, life_days, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    id,
    user.id,
    name,
    image,
    template?.id ?? null,
    memoryMb,
    cpus,
    diskMb,
    JSON.stringify(env),
    volumeName,
    invite?.code ?? null,
    paidPoints || null,
    bundleId,
    cmd ? JSON.stringify(cmd) : null,
    JSON.stringify(volumePaths),
    String(body.note || '').slice(0, 500),
    sleepEnabled ? 1 : 0,
    idleMinutes,
    lifeDays,
    now()
  );

  // Ports are reserved up front so the admin knows exactly what to forward.
  try {
    const hostPorts = portSpecs.length ? await allocatePorts(id, portSpecs.length) : [];
    const ports = portSpecs.map((p, i) => ({
      container: p.container,
      protocol: p.protocol,
      label: p.label,
      host: hostPorts[i],
      public: null, // filled in by the admin at approval time
    }));
    db.prepare('UPDATE instances SET ports_json = ? WHERE id = ?').run(JSON.stringify(ports), id);
  } catch (err) {
    db.prepare('DELETE FROM instances WHERE id = ?').run(id);
    if (invite) refund(invite.code);
    if (paidPoints) refundPoints(user.id, paidPoints, 'instance.create_failed', name);
    refundBundleStock(bundleId);
    throw new HttpError(503, err.message);
  }

  // 危险操作预警：创建参数（镜像 / 命令 / 环境变量 / 备注）过一遍特征库。
  // 只记录不拦截 —— 待审批的申请本来就要管理员过目，预警页多一条线索而已；
  // 管理员自己开的实例跳过了队列，这条预警就是唯一会留下痕迹的地方。
  guard.scanCreate({ id, user_id: user.id, name }, { image, cmd, env, volumePath: body.volumePath, note: body.note });

  audit(
    user,
    'instance.request',
    name,
    `${image} (${invite ? `券 ${invite.code}` : `${paidPoints} 积分`}${lifeDays ? `，有效 ${lifeDays} 天` : ''})`
  );

  // 管理员自己开的实例不排队：审批队列的意义是「先把穿透配好，再建容器」，
  // 而配穿透的就是他本人 —— 让他给自己点一次放行没有增加任何把关。
  // 对外地址先空着（显示成 PUBLIC_HOST:主机端口），穿透配好后在实例页改；
  // 没勾也没取消「自动穿透」的话 approveInstance 会默认建隧道
  // （<实例名>.域名 → 对外端口）并自动填好地址。
  if (user.role === 'admin') {
    emit(id, '管理员本人提交，跳过审批直接创建', 'log');
    await approveInstance(db.prepare('SELECT * FROM instances WHERE id = ?').get(id), user, {
      // 三态透传：true 明确要 / false 明确不要 / undefined 没说（走默认）
      autoTunnel: body.autoTunnel === true ? true : body.autoTunnel === false ? false : undefined,
    });
    return { id, generated, status: 'creating' };
  }

  emit(id, '申请已提交，等待管理员配置内网穿透并放行', 'log');
  if (lifeDays) {
    emit(
      id,
      invite
        ? `这张券的实例有效期是 ${lifeDays} 天，从放行创建那一刻开始算`
        : `积分开的基础实例有效期是 ${lifeDays} 天，从放行创建那一刻开始算`,
      'log'
    );
  }

  return { id, generated, status: 'pending' };
}

/**
 * Validates a { 主机端口: 对外地址 } map against a row's reserved ports and
 * folds it in. Blank means "no override" — serialize() then falls back to
 * PUBLIC_HOST:主机端口.
 */
function withAddresses(row, addresses) {
  return JSON.parse(row.ports_json).map((p) => {
    const given = String(addresses[String(p.host)] ?? '').trim();
    if (given && !/^[\w.-]+(:\d{1,5})?$/.test(given)) {
      throw bad(`对外地址 "${given}" 格式不对，应形如 example.com:20001 或 app.example.com`);
    }
    return { ...p, public: given || null };
  });
}

/**
 * Repoint an already-built instance's public addresses. Approval is where these
 * are normally set once and for all, but an admin's own instances never pass
 * through it, and a tunnel can be moved later — so this stays editable.
 */
export function setAddresses(row, admin, addresses = {}) {
  if (row.status === 'pending' || row.status === 'rejected') {
    throw bad('这个实例还没有创建容器，请到待审批队列里处理');
  }
  const ports = withAddresses(row, addresses);
  db.prepare('UPDATE instances SET ports_json = ? WHERE id = ?').run(JSON.stringify(ports), row.id);
  audit(admin, 'instance.addresses', row.name, ports.map((p) => `${p.host}→${p.public || '默认'}`).join(' '));
  return ports;
}

/** 管理员直接修改实例的过期时间。expiresAt 为 null / 空串 = 设为永久有效。 */
export function setExpiry(row, admin, expiresAt) {
  if (admin.role !== 'admin') throw new HttpError(403, '只有管理员可以修改过期时间');
  if (row.status === 'pending' || row.status === 'rejected') {
    throw bad('这个实例还没有创建容器');
  }

  let value = null;
  if (expiresAt !== null && expiresAt !== undefined && String(expiresAt).trim() !== '') {
    const d = new Date(expiresAt);
    if (isNaN(d.getTime())) throw bad('过期时间格式无效');
    value = d.toISOString();
  }

  // life_days is informational — keep it if we still have a deadline, clear if permanent
  db.prepare('UPDATE instances SET expires_at = ?, life_days = CASE WHEN ? IS NULL THEN NULL ELSE life_days END WHERE id = ?').run(
    value, value, row.id
  );

  const desc = value ? `过期时间设为 ${value.slice(0, 10)}` : '设为永久有效';
  audit(admin, 'instance.setExpiry', row.name, desc);
}

/** Admin approved: record the public addresses they set up, then build it. */
export async function approveInstance(row, admin, { addresses = {}, note, autoTunnel } = {}) {
  if (row.status !== 'pending') throw bad('这个实例不在待审批状态');

  let ports = withAddresses(row, addresses);

  // 自动穿透默认开启：调用方没明确取消（autoTunnel === undefined）而 CF 隧道
  // 可用、实例有 TCP 端口、管理员也没手填 TCP 端口的对外地址时，放行即自动
  // 把 <实例名>.<CF_TUNNEL_DOMAIN> 解析到对外端口。明确 true / false 的按
  // 传进来的走（true 遇配置问题照旧报错，实例留在待审批队列）。
  if (autoTunnel === undefined) {
    const tcpManual = ports.some((p) => p.protocol === 'tcp' && p.public);
    autoTunnel = cftunnel.enabled() && ports.some((p) => p.protocol === 'tcp') && !tcpManual;
  }

  // 自动穿透：面板自己建 Cloudflare 隧道、绑域名、拉起进程，地址自动填好，
  // 管理员不用再手动配。失败会回滚已创建的隧道再抛错，实例留在待审批队列。
  let tunnel = null;
  if (autoTunnel) {
    // 上次放行时面板在隧道建好之后、容器建好之前崩溃，实例退回待审批、
    // 但隧道还残留 —— 先清掉再建，免得域名和 DNS 记录越积越多
    if (row.tunnel_json) await cftunnel.destroy(row).catch(() => {});
    const problem = cftunnel.configProblem();
    if (problem) {
      console.warn(`  ⚠ 实例 ${row.name} 请求自动穿透但配置不可用：${problem}`);
      throw bad(`自动穿透暂不可用：${problem}`);
    }
    const tcp = ports.filter((p) => p.protocol === 'tcp');
    const udp = ports.filter((p) => p.protocol === 'udp');
    if (!tcp.length) throw bad('这个实例没有可自动穿透的 TCP 端口');
    emit(row.id, '正在创建 Cloudflare 隧道并分配域名…', 'log');
    console.log(`  🌐 开始为实例 ${row.name} 自动创建 Cloudflare 隧道（${tcp.length} 个 TCP 端口）`);
    try {
      tunnel = await cftunnel.createTunnel(row, tcp);
    } catch (err) {
      console.error(`  ⚠ 实例 ${row.name} 自动创建 Cloudflare 隧道失败：${err.message}`);
      emit(row.id, `创建隧道失败：${err.message}`, 'error');
      throw new HttpError(502, `自动创建 Cloudflare Tunnel 失败：${err.message}`);
    }
    // tunnel.hostnames 按下标对应 tcp 端口列表，UDP 端口穿插时不能拿
    // 全数组的下标去取
    const tcpIdx = new Map(tcp.map((p, i) => [p, i]));
    ports = ports.map((p) => {
      const i = tcpIdx.get(p);
      return i === undefined ? p : { ...p, public: tunnel.hostnames[i] };
    });
    tunnel.hostnames.forEach((h) => emit(row.id, `已分配域名 https://${h}`, 'log'));
    if (udp.length) emit(row.id, `${udp.length} 个 UDP 端口无法走 Cloudflare 隧道，未穿透（可稍后手动改地址）`, 'warn');
  }

  // The lifespan clock starts here, not when the request was filed: whatever the
  // queue cost this instance, it still gets the full number of days it paid for.
  const expiresAt = lifespan.deadlineIn(row.life_days);

  db.prepare(
    `UPDATE instances SET ports_json = ?, tunnel_json = ?, status = 'creating', error = NULL, reject_reason = NULL,
       reviewed_by = ?, reviewed_at = ?, expires_at = ?, archived_at = NULL,
       sleep_enabled = CASE WHEN ? IS NOT NULL THEN 0 ELSE sleep_enabled END,
       note = COALESCE(?, note) WHERE id = ?`
  ).run(
    JSON.stringify(ports),
    tunnel ? JSON.stringify(tunnel) : null,
    admin.username,
    now(),
    expiresAt,
    tunnel ? 1 : null,
    note ?? null,
    row.id
  );

  audit(
    admin,
    'instance.approve',
    row.name,
    `属主 ${ownerName(row.user_id)}${tunnel ? `，自动 Cloudflare 隧道 ${tunnel.hostnames.join('、')}` : ''}`
  );
  emit(row.id, `管理员 ${admin.username} 已放行，开始创建容器`, 'log');
  if (expiresAt) {
    emit(row.id, `有效期 ${row.life_days} 天，到期（${expiresAt.slice(0, 10)}）后会自动封存`, 'log');
  }

  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  provision({
    id: row.id,
    user: owner,
    name: row.name,
    image: row.image,
    cmd: row.cmd_json ? JSON.parse(row.cmd_json) : null,
    env: JSON.parse(row.env_json),
    ports,
    memoryMb: row.memory_mb,
    cpus: row.cpus,
    diskMb: row.disk_mb ?? config.diskQuotaMb,
    volumeName: row.volume_name,
    volumePaths: row.volume_paths_json ? JSON.parse(row.volume_paths_json) : [],
  }).catch((err) => {
    setStatus(row.id, 'error', err.message);
    emit(row.id, `创建失败：${err.message}`, 'error');
    if (config.refundInviteOnFailure && row.invite_code) {
      refund(row.invite_code);
      // Clear the link so deleting the failed instance cannot refund it twice.
      db.prepare('UPDATE instances SET invite_code = NULL WHERE id = ?').run(row.id);
      emit(row.id, `资源券 ${row.invite_code} 的次数已退回，删掉这个实例后可以重新申请`, 'log');
    }
    if (config.refundInviteOnFailure && row.paid_points) {
      refundPoints(row.user_id, row.paid_points, 'instance.create_failed', row.name);
      db.prepare('UPDATE instances SET paid_points = NULL WHERE id = ?').run(row.id);
      emit(row.id, `${row.paid_points} 积分已退回，删掉这个实例后可以重新申请`, 'log');
    }
    if (row.bundle_id) {
      refundBundleStock(row.bundle_id);
      db.prepare('UPDATE instances SET bundle_id = NULL WHERE id = ?').run(row.id);
      emit(row.id, '套餐余量已退回', 'log');
    }
  });
}

/** Admin turned it down: release the reservation and hand the payment back. */
export function rejectInstance(row, admin, reason) {
  if (row.status !== 'pending') throw bad('这个实例不在待审批状态');
  releasePorts(row.id);
  if (row.invite_code) refund(row.invite_code);
  if (row.paid_points) refundPoints(row.user_id, row.paid_points, 'instance.reject', row.name);
  refundBundleStock(row.bundle_id);
  db.prepare(
    `UPDATE instances SET status = 'rejected', reject_reason = ?, invite_code = NULL, paid_points = NULL,
       bundle_id = NULL, ports_json = '[]', reviewed_by = ?, reviewed_at = ? WHERE id = ?`
  ).run(String(reason || '未说明原因').slice(0, 500), admin.username, now(), row.id);
  audit(admin, 'instance.reject', row.name, reason);
  emit(row.id, `申请被驳回：${reason || '未说明原因'}`, 'error');
}

const ownerName = (userId) =>
  db.prepare('SELECT username FROM users WHERE id = ?').get(userId)?.username ?? '?';

function setStatus(id, status, error = null) {
  db.prepare('UPDATE instances SET status = ?, error = ? WHERE id = ?').run(status, error, id);
}

async function provision(spec) {
  const containerName = `${config.containerPrefix}-${spec.user.username}-${spec.name}`.toLowerCase();

  emit(spec.id, `准备镜像 ${spec.image} ...`);
  if (!(await dk.imageExists(spec.image))) {
    emit(spec.id, '本地没有该镜像，开始拉取（大镜像可能需要几分钟）');
    await dk.pullImage(spec.image, (line) => emit(spec.id, line, 'pull'));
  }
  emit(spec.id, '镜像就绪');

  emit(spec.id, `创建容器 ${containerName}`);
  const container = await dk.createContainer({
    name: containerName,
    image: spec.image,
    instanceId: spec.id,
    userId: spec.user.id,
    username: spec.user.username,
    env: spec.env,
    cmd: spec.cmd,
    memoryMb: spec.memoryMb,
    cpus: spec.cpus,
    diskMb: spec.diskMb,
    portBindings: spec.ports.map((p) => ({
      containerPort: p.container,
      protocol: p.protocol,
      hostPort: p.host,
    })),
    volumeName: spec.volumeName,
    volumePaths: spec.volumePaths,
  });

  db.prepare('UPDATE instances SET container_id = ? WHERE id = ?').run(container.id, spec.id);

  emit(spec.id, '启动中');
  await container.start();
  setStatus(spec.id, 'running');
  const fresh = db.prepare('SELECT sleep_enabled, idle_minutes FROM instances WHERE id = ?').get(spec.id);
  if (fresh?.sleep_enabled) {
    emit(spec.id, `闲时休眠已开启：${fresh.idle_minutes || config.idleMinutes} 分钟无流量就停止，有访问再自动启动`);
  }
  emit(spec.id, '实例已启动 ✅', 'done');
}

export function getInstance(id, user) {
  const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, '实例不存在');
  if (row.user_id !== user.id && user.role !== 'admin') throw new HttpError(404, '实例不存在');
  return row;
}

/** 一批 user_id 一次性查出 username 映射 —— 列表接口不再每个实例多跑一条查询。 */
export function ownersMap(userIds) {
  const ids = [...new Set(userIds.filter((x) => Number.isInteger(x)))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  return new Map(
    db
      .prepare(`SELECT id, username FROM users WHERE id IN (${placeholders})`)
      .all(...ids)
      .map((u) => [u.id, u.username])
  );
}

export async function serialize(row, { withState = true, owner } = {}) {
  const ports = JSON.parse(row.ports_json);
  let state = null;
  if (withState && row.container_id) {
    try {
      state = await dk.containerState(row.container_id);
    } catch {
      state = { status: 'unknown' };
    }
  }
  // owner 由调用方批量查好传进来；单条路径没传就自己查。
  const ownerName = owner ?? db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id)?.username ?? '?';

  // A sleeping or archived container looks "exited" to Docker — say what it
  // really is. Archived wins over everything: it is a terminal state. Banned
  // likewise: the container is parked by the admin, not merely stopped.
  let status = state ? state.status : row.status;
  if (row.status === 'archived') status = 'archived';
  else if (row.status === 'banned') status = 'banned';
  else if (sleeper.isWaking(row.id)) status = 'waking';
  else if (row.status === 'sleeping' && !state?.running) status = 'sleeping';
  return {
    id: row.id,
    name: row.name,
    owner: ownerName,
    userId: row.user_id,
    image: row.image,
    templateId: row.template_id,
    memoryMb: row.memory_mb,
    cpus: row.cpus,
    env: JSON.parse(row.env_json),
    // `public` is what the admin actually set up in their tunnel; the computed
    // PUBLIC_HOST:port is only a fallback for when they left it blank.
    ports: ports.map((p) => ({ ...p, address: p.public || publicAddress(p.host) })),
    volumeName: row.volume_name,
    // Where that volume is mounted inside the container. The file manager turns
    // these into shortcuts: it is where a user's own data lives, as opposed to
    // the image's own files.
    volumePaths: JSON.parse(row.volume_paths_json || '[]'),
    inviteCode: row.invite_code,
    paidPoints: row.paid_points ?? null,
    disk: row.volume_name
      ? {
          quotaMb: diskguard.quotaMbFor(row),
          usedBytes: diskguard.usageFor(row)?.bytes ?? null,
          checkedAt: diskguard.usageFor(row)?.checkedAt ?? null,
        }
      : null,
    sleep: {
      enabled: !!row.sleep_enabled,
      idleMinutes: row.idle_minutes || config.idleMinutes,
      available: config.idleSleepEnabled,
      problem: sleeper.sleepProblem(row),
      sleptAt: row.slept_at,
      wokeAt: row.woke_at,
    },
    // 有效期。lifeDays 有值但 expiresAt 还没有 = 还在排队，放行那一刻才起算。
    life: {
      days: row.life_days || null,
      expiresAt: row.expires_at,
      archivedAt: row.archived_at,
      remainingMs: lifespan.remainingMs(row),
      graceRemainingMs: lifespan.graceRemainingMs(row),
      retentionDays: config.archiveRetentionDays || null,
    },
    // 自动 Cloudflare 隧道：hostnames / 进程是否在跑 / 最近输出，无凭据
    tunnel: row.tunnel_json ? cftunnel.info(row) : null,
    status,
    dbStatus: row.status,
    error: row.error,
    note: row.note,
    rejectReason: row.reject_reason,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    state,
    createdAt: row.created_at,
  };
}

export async function listForUser(user, { all = false } = {}) {
  const rows = all
    ? db.prepare('SELECT * FROM instances ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM instances WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
  // 属主名一次查齐，不再每实例一条 SELECT。
  const owners = ownersMap(rows.map((r) => r.user_id));
  return Promise.all(rows.map((r) => serialize(r, { owner: owners.get(r.user_id) })));
}

export async function action(row, what, user) {
  if (row.status === 'pending') throw bad('这个实例还在等管理员审批');
  if (row.status === 'rejected') throw bad('这个申请已被驳回');
  if (row.status === 'archived') {
    throw bad('这个实例的有效期已过，已被封存，不能再启动；数据卷还留着，删除实例才会清掉');
  }
  if (row.status === 'banned') {
    throw new HttpError(
      403,
      user.role === 'admin'
        ? '这个实例因违规被封禁，先在管理后台解封才能操作'
        : '这个实例因违规操作被封禁，无法启动或停止；如有疑问请联系管理员'
    );
  }
  if (!row.container_id) throw bad('容器还未创建完成');
  const parked = row.status === 'sleeping';
  switch (what) {
    case 'start':
      // While it sleeps the panel is holding the host ports; Docker cannot bind
      // them again until the wake path has handed them back.
      if (parked) await sleeper.wake(row.id, `${user.username} 手动启动`);
      else {
        await dk.startContainer(row.container_id);
        setStatus(row.id, 'running');
        await sleeper.onRunning(row.id);
      }
      break;
    case 'stop':
      term.closeForInstance(row.id);
      await sleeper.onStopped(row.id);
      await dk.stopContainer(row.container_id);
      setStatus(row.id, 'stopped');
      break;
    case 'restart':
      if (parked) {
        await sleeper.wake(row.id, `${user.username} 手动重启`);
      } else {
        await dk.restartContainer(row.container_id);
        setStatus(row.id, 'running');
        await sleeper.onRunning(row.id);
      }
      break;
    case 'kill':
      term.closeForInstance(row.id);
      await sleeper.onStopped(row.id);
      await dk.killContainer(row.container_id);
      setStatus(row.id, 'stopped');
      break;
    default:
      throw bad('未知操作');
  }
  audit(user, `instance.${what}`, row.name, null);
}

/** Turns idle sleep on or off for an existing instance. */
export async function setSleep(row, user, { enabled, idleMinutes } = {}) {
  if (row.status === 'pending' || row.status === 'rejected') throw bad('这个实例还没有创建容器');
  if (row.status === 'archived') throw bad('这个实例已封存，休眠设置没有意义了');
  if (row.status === 'banned') throw new HttpError(403, '这个实例因违规被封禁，休眠设置不可用');
  if (!config.idleSleepEnabled) throw bad('管理员没有开启闲时休眠功能');

  const on = Boolean(enabled);
  let mins = row.idle_minutes;
  if (idleMinutes !== undefined && idleMinutes !== null && idleMinutes !== '') {
    mins = Math.round(Number(idleMinutes));
    if (!Number.isFinite(mins) || mins < 1 || mins > 1440) throw bad('空闲分钟数需在 1 - 1440 之间');
  }
  if (on) {
    const problem = sleeper.sleepProblem(row);
    if (problem) throw new HttpError(400, problem);
  }

  db.prepare('UPDATE instances SET sleep_enabled = ?, idle_minutes = ? WHERE id = ?').run(on ? 1 : 0, mins ?? null, row.id);
  const fresh = db.prepare('SELECT * FROM instances WHERE id = ?').get(row.id);

  if (!on && row.status === 'sleeping') {
    await sleeper.wake(row.id, '关闭闲时休眠');
  } else if (on && (row.status === 'stopped' || row.status === 'error' || row.status === 'exited')) {
    // Already down: park the ports now so the next visitor brings it back up.
    await sleeper.parkStopped(fresh).catch((err) => {
      emit(row.id, `接管端口失败：${err.message}`, 'error');
    });
  }
  audit(user, 'instance.sleep', row.name, on ? `开启（${mins ?? config.idleMinutes} 分钟）` : '关闭');
  return db.prepare('SELECT * FROM instances WHERE id = ?').get(row.id);
}

export async function destroy(row, user, { keepVolume = false } = {}) {
  term.closeForInstance(row.id, '实例已删除');
  await sleeper.release(row.id);
  // 自动穿透的实例：隧道 + DNS 记录 + 凭据一起清掉，域名腾出来
  if (row.tunnel_json) {
    try {
      console.log(`  🌐 删除实例 ${row.name}：清理 Cloudflare 隧道`);
      await cftunnel.destroy(row);
    } catch (err) {
      console.error(`  ⚠ 删除实例 ${row.name} 时清理 Cloudflare 隧道失败：${err.message}`);
      emit(row.id, `清理 Cloudflare 隧道失败：${err.message}`, 'error');
    }
  }
  if (row.container_id) {
    try {
      await dk.removeContainer(row.container_id);
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
  }
  if (row.volume_name && !keepVolume) await dk.removeVolume(row.volume_name);
  releasePorts(row.id);
  db.prepare('DELETE FROM instances WHERE id = ?').run(row.id);
  resetEvents(row.id);
  let refunded = false;
  let refundedPoints = 0;
  if (config.refundInviteOnDelete && row.invite_code) {
    refund(row.invite_code);
    refunded = true;
  }
  // 花积分开的实例同样删除退分 —— 但已封存（到期）的不退：七天用满再退钱
  // 等于永动机，券没这个问题是因为券本来就是管理员一张张数着发的。
  // 套餐余量跟积分一个口径：删了就退一份库存（到期封存不退）。
  if (config.refundInviteOnDelete && row.paid_points && row.status !== 'archived') {
    refundPoints(row.user_id, row.paid_points, 'instance.delete', row.name);
    refundedPoints = row.paid_points;
  }
  if (row.bundle_id && row.status !== 'archived') refundBundleStock(row.bundle_id);
  audit(
    user,
    'instance.delete',
    row.name,
    `${keepVolume ? '保留数据卷' : '数据卷已删除'}${refunded ? `，退回资源券 ${row.invite_code}` : ''}${
      refundedPoints ? `，退回 ${refundedPoints} 积分` : ''
    }`
  );
  return { refundedInvite: refunded ? row.invite_code : null, refundedPoints: refundedPoints || null };
}

/** 积分续期：给实例续 N 天，付积分。管理员免费。已封存（宽限期内）或
 *  活跃中的实例都能续，只要它有有效期。返回更新后的行。 */
export async function renewInstance(row, user, days) {
  if (!row.life_days) throw bad('这个实例没有有效期，不需要续期');
  if (row.status === 'pending' || row.status === 'rejected') throw bad('这个实例还没有创建容器');
  if (row.status === 'banned') throw new HttpError(403, '这个实例因违规被封禁，不能续期；如有疑问请联系管理员');
  if (row.status === 'archived' && !lifespan.isInGrace(row)) {
    const ret = config.archiveRetentionDays
      ? `封存已超过 ${config.archiveRetentionDays} 天宽限期，数据已无法恢复`
      : '该实例已封存且不可续期';
    throw bad(ret);
  }

  const n = Math.round(Number(days));
  if (!Number.isInteger(n) || n <= 0) throw bad('续期天数需为正整数');
  if (!Number.isFinite(config.renewalDays) || config.renewalDays <= 0) {
    throw bad('续期天数配置有误，请联系管理员');
  }

  // 按续期套餐算价：每 renewalDays 天收 renewalPointsCost 分，不足按一个套餐算
  const blocks = Math.ceil(n / config.renewalDays);
  const cost = blocks * config.renewalPointsCost;

  const isAdmin = user.role === 'admin';
  if (!isAdmin) {
    if (!spendPoints(user, cost, 'instance.renew', row.name)) {
      throw new HttpError(
        403,
        `积分不够：续期 ${n} 天需要 ${cost} 积分，你当前有 ${balanceOf(user.id)} 积分`
      );
    }
  }

  const wasArchived = row.status === 'archived';
  // 已封存的：从现在起算 n 天。活跃中的：从旧到期日往后加 n 天。
  // 如果旧到期日已经过了（正好在扫到期的时候），当从现在起算。
  const base =
    wasArchived || !row.expires_at || new Date(row.expires_at).getTime() < Date.now()
      ? Date.now()
      : new Date(row.expires_at).getTime();
  const expiresAt = new Date(base + n * 86400_000).toISOString();

  db.prepare(
    `UPDATE instances SET expires_at = ?, archived_at = NULL,
       status = CASE WHEN ? THEN 'stopped' ELSE status END,
       error = NULL WHERE id = ?`
  ).run(expiresAt, wasArchived ? 1 : 0, row.id);

  const reason = isAdmin ? `管理员续期 ${n} 天（免费）` : `续期 ${n} 天（${cost} 积分）`;
  audit(user, 'instance.renew', row.name, reason);
  emit(row.id, `${reason}，新到期 ${expiresAt.slice(0, 10)}${wasArchived ? '，容器可重新启动' : ''}`, 'log');

  const fresh = db.prepare('SELECT * FROM instances WHERE id = ?').get(row.id);
  // 封存时隧道进程被停掉了；续期激活后把域名恢复指向（隧道和 DNS 还在）
  if (wasArchived && fresh.tunnel_json) {
    try {
      cftunnel.ensureRunning(fresh);
      console.log(`  🌐 实例 ${row.name} 续期激活，Cloudflare 隧道已重新拉起`);
      emit(row.id, 'Cloudflare 隧道已重新拉起，域名恢复访问', 'log');
    } catch (err) {
      console.error(`  ⚠ 实例 ${row.name} 续期后重启 Cloudflare 隧道失败：${err.message}`);
      emit(row.id, `重启 Cloudflare 隧道失败：${err.message}`, 'error');
    }
  }
  return fresh;
}

/** 下载封存实例的数据卷内容（仅宽限期内可用）。返回 { stream, filename }。 */
export async function downloadArchive(row, user) {
  if (row.status !== 'archived') throw bad('只能下载已封存实例的数据');
  if (!lifespan.isInGrace(row)) {
    const ret = config.archiveRetentionDays
      ? `封存宽限期（${config.archiveRetentionDays} 天）已过，数据已自动删除`
      : '该实例不支持下���数据';
    throw bad(ret);
  }

  const volumePaths = JSON.parse(row.volume_paths_json || '[]');
  if (!volumePaths.length) throw bad('这个实例没有挂载数据卷，没有可下载的持久数据');

  let stream;
  try {
    stream = await dk.getArchive(row.container_id, volumePaths[0]);
  } catch (err) {
    if (err.statusCode === 404) throw new HttpError(404, '容器已不存在，数据可能已被清理');
    throw err;
  }

  const name = `${row.name}-${row.archived_at?.slice(0, 10) || 'archive'}`;
  audit(user, 'instance.download', row.name, '下载封存数据');
  return { stream, filename: `${name}.tar`, contentType: 'application/x-tar' };
}

/**
 * 封禁实例（预警处置 / 管理员手动）：停掉容器、关掉控制台会话，状态转为
 * banned —— 一个不随重启漂移的管理员裁决，此后启动/重启/续期/休眠全部被拒，
 * 直到你 unbanInstance。容器和数据卷原样留着（证据 + 可解封），端口也继续
 * 占着（释放了别人就能复用，而这条记录还指向它）；真要清理走正常的删除流程。
 */
export async function banInstance(row, admin, reason) {
  if (row.status === 'pending' || row.status === 'rejected') {
    throw bad('这个实例还没有创建容器，没有可封禁的东西；直接驳回申请即可');
  }
  if (row.status === 'archived') throw bad('这个实例已封存，无需再封禁');
  if (row.status === 'banned') return; // 幂等：重复点封禁不报错也不重复审计

  term.closeForInstance(row.id, '实例已被封禁');
  await sleeper.release(row.id);
  if (row.container_id) {
    try {
      await dk.stopContainer(row.container_id);
    } catch (err) {
      if (err.statusCode !== 404 && err.statusCode !== 304) throw err;
    }
  }
  const note = `因检测到违规操作（${reason || '危险行为'}），已被管理员封禁`;
  db.prepare("UPDATE instances SET status = 'banned', error = ? WHERE id = ?").run(note, row.id);
  emit(row.id, note, 'error');
  audit(admin, 'instance.ban', row.name, reason || null);
}

/** 解封：容器回到普通的「已停止」，想跑再自己启动。 */
export function unbanInstance(row, admin) {
  if (row.status !== 'banned') throw bad('这个实例没有被封禁');
  db.prepare("UPDATE instances SET status = 'stopped', error = NULL WHERE id = ?").run(row.id);
  emit(row.id, '管理员已解封这个实例，容器可以重新启动', 'log');
  audit(admin, 'instance.unban', row.name, null);
}

/**
 * 停掉某个用户名下所有在跑的实例（封禁用户时调用）。只停不删：删实例会
 * 退积分 / 券，被处罚的人不应该拿回任何东西，那由管理员之后逐个决定。
 * 返回停掉的实例数。
 */
export async function stopAllInstancesOf(userId) {
  const rows = db
    .prepare(
      "SELECT * FROM instances WHERE user_id = ? AND container_id IS NOT NULL AND status IN ('running', 'sleeping')"
    )
    .all(userId);
  for (const row of rows) {
    try {
      term.closeForInstance(row.id, '账号已被封禁');
      await sleeper.release(row.id);
      await dk.stopContainer(row.container_id);
      db.prepare("UPDATE instances SET status = 'stopped', error = NULL WHERE id = ?").run(row.id);
    } catch (err) {
      emit(row.id, `封禁用户时停止容器失败：${err.message}`, 'error');
    }
  }
  return rows.length;
}

/** Reconciles DB rows with what Docker actually reports (called on boot). */
export async function reconcile() {
  const rows = db.prepare('SELECT * FROM instances').all();
  for (const row of rows) {
    // Archived is terminal: it says "this instance's time is up", which is a
    // fact about the voucher, not about what Docker currently reports. Banned
    // is the same kind of administrative verdict — Docker says "exited", but
    // that must not quietly un-ban it on the next reboot.
    if (row.status === 'archived' || row.status === 'banned') continue;
    if (!row.container_id) {
      // Approved but the panel died mid-build: put it back in the queue so an
      // admin can simply approve it again.
      if (row.status === 'creating') {
        db.prepare("UPDATE instances SET status = 'pending', error = NULL WHERE id = ?").run(row.id);
      }
      continue;
    }
    try {
      const st = await dk.containerState(row.container_id);
      if (st.status === 'missing') {
        setStatus(row.id, 'missing', '容器已不存在（可能被手动删除）');
      } else if (row.status === 'sleeping' && !st.running && sleeper.sleepable(row)) {
        // Still asleep from before the restart; sleeper.start() re-takes the ports.
        setStatus(row.id, 'sleeping', null);
      } else {
        setStatus(row.id, st.running ? 'running' : 'stopped', null);
      }
    } catch {
      /* docker unreachable; leave as-is */
    }
  }
}

/* ----------------------------------------------------------- 维护任务 ------ */

/**
 * 待审批的申请没人处理会永远占着端口池（每个申请都从池子里领了端口），
 * 攒多了管理员要一个个手动驳回。超过 PENDING_AUTO_REJECT_DAYS 天还没处理的
 * 自动驳回：端口、资源券、积分全部归还，和手动驳回走同一条路径。
 */
function sweepStalePending() {
  if (!(config.pendingRejectDays > 0)) return;
  const cutoff = new Date(Date.now() - config.pendingRejectDays * 86400_000).toISOString();
  const stale = db.prepare('SELECT * FROM instances WHERE status = ? AND created_at <= ?').all('pending', cutoff);
  for (const row of stale) {
    try {
      rejectInstance(row, { username: '系统' }, `申请超过 ${config.pendingRejectDays} 天未处理，已自动关闭；需要的话重新提交即可`);
    } catch {
      /* 状态竞争失败就算了，下一个周期再试 */
    }
  }
}
setInterval(sweepStalePending, 3600_000).unref();
sweepStalePending();
