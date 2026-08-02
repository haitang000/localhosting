import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

// Minimal .env loader (no dependency). Existing process env always wins.
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v, fallback) => (v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v));

const portRange = (process.env.PORT_POOL || '20000-20200').split('-');
const dataDir = process.env.DATA_DIR || path.join(ROOT, 'data');

export const config = {
  // --- Panel ---
  port: num(process.env.PANEL_PORT, 8099),
  host: process.env.PANEL_HOST || '0.0.0.0',
  dataDir,
  sessionTtlDays: num(process.env.SESSION_TTL_DAYS, 14),
  trustProxy: bool(process.env.TRUST_PROXY, false),

  // --- Bootstrap admin (created on first run if no users exist) ---
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',

  // --- Registration ---
  // Open registration: anyone can sign up with a captcha, no invite code.
  // Set false to go back to invite-code-only registration (no captcha there —
  // the code itself is the gate). Resource vouchers are unaffected either way.
  openRegistration: bool(process.env.OPEN_REGISTRATION, true),
  // Successful sign-ups allowed per IP per hour (failed attempts are handled
  // separately by the exponential backoff in the auth routes).
  registerPerIpPerHour: num(process.env.REGISTER_IP_PER_HOUR, 3),
  // Require ticking "I agree to the user agreement" on both sign-up and sign-in.
  // The text itself lives in src/terms.js; bump TERMS_VERSION there after
  // editing it and everyone re-consents on their next login.
  termsRequired: bool(process.env.TERMS_REQUIRED, true),

  // --- 验证码（注册/登录/签到共用，全部自研，零外部依赖） ---
  // 四层防线：行为分析（轨迹/打字节奏，通过线随机浮动）→ 工作量证明
  //（sha256 前导零，CAPTCHA_POW_BITS 位，防规模注册的算力闸）→ 图片回正
  // 挑战（旋转角度烘焙进几何坐标，标记里没有答案）→ 一次性 token（绑 IP、
  // 签发/求解/使用各有最低间隔）。失败多的 IP 的 PoW 难度自动上调。
  captchaEnabled: bool(process.env.CAPTCHA_ENABLED, true),
  captchaPowBits: num(process.env.CAPTCHA_POW_BITS, 18),
  captchaTolerance: num(process.env.CAPTCHA_TOLERANCE, 10),
  captchaMinSolveMs: num(process.env.CAPTCHA_MIN_SOLVE_MS, 1000),
  captchaMinTokenAgeMs: num(process.env.CAPTCHA_MIN_TOKEN_AGE_MS, 300),
  captchaMaxChallengesPerIp: num(process.env.CAPTCHA_MAX_CHALLENGES_PER_IP, 3),

  // --- Docker ---
  dockerHost: process.env.DOCKER_HOST || '',
  containerPrefix: process.env.CONTAINER_PREFIX || 'lh',
  networkName: process.env.DOCKER_NETWORK || 'bridge',

  // --- Port pool exposed to the outside world ---
  // Containers get a host port from this pool. `bindAddress` is what Docker
  // binds on the host; keep 127.0.0.1 when a tunnel (frp / cloudflared / ngrok)
  // runs on the same machine and you do not want the ports on the LAN.
  portPoolStart: num(portRange[0], 20000),
  portPoolEnd: num(portRange[1] ?? portRange[0], 20200),
  bindAddress: process.env.BIND_ADDRESS || '0.0.0.0',

  // --- Public address shown to users (your tunnel endpoint) ---
  // PUBLIC_HOST: hostname users connect to, e.g. "frp.example.com".
  // PUBLIC_PORT_OFFSET: added to the host port when the tunnel remaps ports
  // (frp `remote_port = local_port + offset`). Usually 0.
  publicHost: process.env.PUBLIC_HOST || '',
  publicPortOffset: num(process.env.PUBLIC_PORT_OFFSET, 0),
  publicScheme: process.env.PUBLIC_SCHEME || 'http',
  // PANEL_PUBLIC_URL: 面板自己在公网上的入口，例 "http://1.2.3.4:8099" 或
  // "https://panel.example.com"。静态站点是面板亲自发的，所以它们的地址跟着
  // 这个走，而不是跟着端口池的 PUBLIC_HOST。留空时按 PUBLIC_HOST + 面板端口猜。
  panelPublicUrl: (process.env.PANEL_PUBLIC_URL || '').replace(/\/+$/, ''),

  // --- Per-account cap. Memory / CPU / ports come from the resource voucher
  //     spent at creation time, so only the instance count is capped here. ---
  defaultMaxInstances: num(process.env.DEFAULT_MAX_INSTANCES, 5),
  defaultMaxMemoryMb: num(process.env.DEFAULT_MAX_MEMORY_MB, 2048),
  defaultMaxCpus: Number(process.env.DEFAULT_MAX_CPUS ?? 1),
  defaultMaxPorts: num(process.env.DEFAULT_MAX_PORTS, 3),
  defaultAllowCustomImage: bool(process.env.DEFAULT_ALLOW_CUSTOM_IMAGE, false),

  // --- 区域总算力上限（所有用户、所有实例的内存 / CPU 合计）。这是整台宿主机
  //     的“可售算力”，跟 per-account 的额度不同：到顶后无论谁来建新实例都会被
  //     拒（提示“当前区域已无剩余算力，请稍后再试”）。已封存 / 已驳回的实例不占
  //     用配额。0 表示不限制。 ---
  regionMaxMemoryMb: num(process.env.REGION_MAX_MEMORY_MB, 16384),
  regionMaxCpus: Number(process.env.REGION_MAX_CPUS ?? 10),

  // --- Resource voucher behaviour ---
  // Give the use back when the instance is deleted, so people are not afraid
  // to tear down and rebuild. Set false to make every voucher strictly one-shot.
  refundInviteOnDelete: bool(process.env.REFUND_INVITE_ON_DELETE, true),
  refundInviteOnFailure: bool(process.env.REFUND_INVITE_ON_FAILURE, true),
  // Defaults pre-filled in the admin's "new voucher" form.
  voucherDefaultMemoryMb: num(process.env.VOUCHER_DEFAULT_MEMORY_MB, 1024),
  voucherDefaultCpus: Number(process.env.VOUCHER_DEFAULT_CPUS ?? 1),
  voucherDefaultPorts: num(process.env.VOUCHER_DEFAULT_PORTS, 2),
  // 用这张券建出来的实例能活多少天，0 = 永久。到期后实例被封存（见下）。
  voucherDefaultDays: num(process.env.VOUCHER_DEFAULT_DAYS, 0),

  // --- 实例有效期 / 到期封存 ---
  // 实例的寿命写在它花掉的那张资源券上；到期后面板停掉容器、收回它占着的
  // 端口，状态转为 archived。容器和数据卷都原样留着，删实例才会清掉。
  expiryCheckSeconds: num(process.env.EXPIRY_CHECK_SECONDS, 60),
  // 封存后宽限期天数：到期后数据原样保留 N 天，期间可以下载数据或积分续期；
  // 超过 N 天后自动彻底删除（容器、数据卷、端口、数据库记录一并清掉）。
  // 设为 0 则跳过自动删除，保持旧行为（只封存，不删除）。
  archiveRetentionDays: num(process.env.ARCHIVE_RETENTION_DAYS, 7),
  // 积分续期定价：一次续 7 天收多少积分。
  renewalPointsCost: num(process.env.RENEWAL_POINTS_COST, 100),
  // 续期一次延长的天数（默认 7 天）。
  renewalDays: num(process.env.RENEWAL_DAYS, 7),
  // 待审批申请超过这么多天没人处理就自动驳回（归还端口、券和积分）。
  // 0 关闭。防的是申请堆着不动、端口池被一点点吃光。
  pendingRejectDays: num(process.env.PENDING_AUTO_REJECT_DAYS, 7),

  // --- Welcome gift: 新用户注册送一笔积分（以前是送一张静态网页券） ---
  // 100 分的默认盘子：可以开一台基础实例（0.1 核/128MB/7 天），
  // 或者发两个静态站点（50 分一个）。设 0 关掉见面礼。
  welcomePoints: num(process.env.WELCOME_POINTS, 100),

  // --- 积分定价 ---
  // 没有老资源券时，发站点/建实例按这里的价格扣积分。实例是「基础价 +
  // 加配」：基础价包含 128MB / 0.1 核 / 1 个端口，往上每加一档另收钱，
  // 加到封顶为止 —— 还想要更大的机器，仍然找管理员要券。
  sitePointsCost: num(process.env.SITE_POINTS_COST, 50),
  instancePointsCost: num(process.env.INSTANCE_POINTS_COST, 100),
  pointsInstanceMemoryMb: num(process.env.POINTS_INSTANCE_MEMORY_MB, 128), // 基础价含的内存
  pointsInstanceCpus: Number(process.env.POINTS_INSTANCE_CPUS ?? 0.1), // 基础价含的 CPU
  pointsInstancePorts: num(process.env.POINTS_INSTANCE_PORTS, 1), // 基础价含的端口数
  pointsInstanceDays: num(process.env.POINTS_INSTANCE_DAYS, 7), // 0 = 永久
  // 加配价目：内存每 +128MB 收 40 分；CPU 每 +0.1 核收 10 分；端口从第 2 个起每个 10 分
  pointsMemStepMb: num(process.env.POINTS_MEM_STEP_MB, 128),
  pointsMemStepCost: num(process.env.POINTS_MEM_STEP_COST, 40),
  pointsCpuStepCost: num(process.env.POINTS_CPU_STEP_COST, 10), // 每 0.1 核的加价
  pointsPortCost: num(process.env.POINTS_PORT_COST, 10),
  // 加配封顶：积分路径最多能配到多大
  pointsMaxMemoryMb: num(process.env.POINTS_MAX_MEMORY_MB, 16384),
  pointsMaxCpus: Number(process.env.POINTS_MAX_CPUS ?? 8),
  pointsMaxPorts: num(process.env.POINTS_MAX_PORTS, 4),
  // 套餐直减：这几个内存 + CPU 组合按打包价卖，比逐档加配明显便宜
  //（2c2g 原价 890 → 650 约七三折，4c4g 原价 1730 → 1200 约七折）；端口费照收。
  pointsBundles: JSON.parse(
    process.env.POINTS_BUNDLES ??
      '[{"memoryMb":2048,"cpus":2,"cost":650},{"memoryMb":4096,"cpus":4,"cost":1200},{"memoryMb":8192,"cpus":4,"cost":2100},{"memoryMb":16384,"cpus":8,"cost":4200}]'
  ),

  // --- Container hardening ---
  pidsLimit: num(process.env.PIDS_LIMIT, 512),
  diskQuota: process.env.DISK_QUOTA || '', // e.g. "10G", only works on some storage drivers

  // --- Disk guard (app-level, works everywhere incl. Docker Desktop) ---
  // DISK_QUOTA/StorageOpt above is a real kernel-enforced quota but only takes
  // effect on overlay2+xfs prjquota hosts. This is the fallback: poll every
  // running instance's volume usage and stop it if it goes over budget.
  diskGuardEnabled: bool(process.env.DISK_GUARD_ENABLED, true),
  diskQuotaMb: num(process.env.DISK_QUOTA_MB, 2048),
  diskGuardCheckSeconds: num(process.env.DISK_GUARD_CHECK_SECONDS, 60),
  // Registries a custom image may come from. Empty entry "" allows bare
  // Docker Hub names (nginx, user/app). Comma separated.
  allowedRegistries: (process.env.ALLOWED_REGISTRIES ?? ',docker.io,ghcr.io,registry.hub.docker.com,quay.io')
    .split(',')
    .map((s) => s.trim()),
  maxLogLines: num(process.env.MAX_LOG_LINES, 500),

  // --- Live console (docker exec with a TTY, streamed to the browser) ---
  // How much output a session keeps for reattaching tabs, and how long a
  // session with nobody attached is kept before the shell is killed.
  consoleScrollback: num(process.env.CONSOLE_SCROLLBACK, 200_000),
  consoleIdleMinutes: num(process.env.CONSOLE_IDLE_MINUTES, 30),

  // --- File manager (browse the container's filesystem from the panel) ---
  // Listing and mkdir/rm/mv go through `docker exec`, so the container has to be
  // running and have a shell — the same deal as the live console. Reading and
  // writing file *content* goes through the archive endpoints instead, which is
  // what makes an upload work without tar or unzip existing in the image.
  filesEnabled: bool(process.env.FILES_ENABLED, true),
  // One directory page. A folder with more entries than this is listed up to the
  // cap and the panel says so rather than trying to render all of it.
  fileMaxEntries: num(process.env.FILE_MAX_ENTRIES, 1000),
  // Anything bigger opens as a download instead of in the editor.
  fileEditMaxBytes: num(process.env.FILE_EDIT_MAX_BYTES, 512 * 1024),
  // Per upload, across all files in it. Uploads are held in memory (base64 in a
  // JSON body, like the static-site drop), so this is a memory figure too.
  fileUploadMaxBytes: num(process.env.FILE_UPLOAD_MAX_BYTES, 32 * 1024 * 1024),
  fileUploadMaxFiles: num(process.env.FILE_UPLOAD_MAX_FILES, 200),

  // --- Static sites (drag a folder / an .html file onto the panel) ---
  // These are served by the panel itself, so they need no container, no port
  // and no tunnel of their own — only the panel port has to be reachable.
  sitesEnabled: bool(process.env.SITES_ENABLED, true),
  sitesDir: process.env.SITES_DIR || path.join(dataDir, 'sites'),
  siteMaxBytes: num(process.env.SITE_MAX_BYTES, 20 * 1024 * 1024),
  siteMaxFiles: num(process.env.SITE_MAX_FILES, 300),
  // What a published page is booked as. There is no container behind it, so
  // this is a nominal figure — a page gets a sliver of the box, never the whole
  // allowance of the voucher it was published with.
  siteMemoryMb: num(process.env.SITE_MEMORY_MB, 32),
  siteCpus: Number(process.env.SITE_CPUS ?? 0.1),
  // A site costs one use of a resource voucher, or SITE_POINTS_COST points
  // when no voucher is supplied; set false to let any logged-in user publish
  // for free.
  siteRequireInvite: bool(process.env.SITE_REQUIRE_INVITE, true),
  defaultMaxSites: num(process.env.DEFAULT_MAX_SITES, 5),
  // User pages live on the panel's own origin, so without the sandbox header a
  // published page could script the panel API with the visitor's session.
  // Only turn this off when sites are served from a separate hostname.
  siteSandbox: bool(process.env.SITE_SANDBOX, true),
  // Shown to users instead of "<panel>/s/<slug>" when you point a domain at the
  // panel, e.g. https://pages.example.com  → address becomes <base>/<slug>/
  sitePublicBase: (process.env.SITE_PUBLIC_BASE || '').replace(/\/+$/, ''),

  // --- Idle sleep (stop when nobody uses it, start again on first connect) ---
  // While an instance sleeps the panel holds its host ports open; the first TCP
  // connection is parked, the container is started, then the connection is
  // relayed through. Enabled per instance, TCP ports only.
  idleSleepEnabled: bool(process.env.IDLE_SLEEP, true),
  idleSleepDefault: bool(process.env.IDLE_SLEEP_DEFAULT, false),
  idleMinutes: num(process.env.IDLE_MINUTES, 15),
  // How long to keep accepting connections before closing the listeners and
  // handing the ports back to Docker — catches a browser's parallel requests.
  wakeGraceMs: num(process.env.WAKE_GRACE_MS, 200),
  wakeTimeoutMs: num(process.env.WAKE_TIMEOUT_MS, 90_000),
  sleepCheckSeconds: num(process.env.SLEEP_CHECK_SECONDS, 30),
};

fs.mkdirSync(config.dataDir, { recursive: true });
if (config.sitesEnabled) fs.mkdirSync(config.sitesDir, { recursive: true });

export function publicAddress(hostPort) {
  const host = config.publicHost || 'localhost';
  return `${host}:${hostPort + config.publicPortOffset}`;
}

/**
 * Where the panel itself answers from the outside. Static sites ride on the
 * panel's own port, so they need this — not the port-pool host.
 *
 * PANEL_PUBLIC_URL wins. Otherwise guess from PUBLIC_HOST, keeping the panel's
 * port: a tunnel that forwards 8099 → 8099 (the documented frp setup) is far
 * more common than a panel sitting on bare :80, and a URL missing its port is
 * silently broken. Add the port to PUBLIC_HOST itself, or set PANEL_PUBLIC_URL,
 * when that guess is wrong.
 */
export function panelBaseUrl() {
  if (config.panelPublicUrl) return config.panelPublicUrl;
  const host = config.publicHost
    ? config.publicHost.includes(':')
      ? config.publicHost
      : `${config.publicHost}:${config.port}`
    : `localhost:${config.port}`;
  return `${config.publicScheme}://${host}`;
}

/** True while nobody has told the panel its public address — the shown address
 *  is then a localhost placeholder that only works on this machine. */
export const panelAddressUnset = () => !config.panelPublicUrl && !config.publicHost && !config.sitePublicBase;

/** Where a published static site can be reached from the outside. */
export function siteAddress(slug) {
  if (config.sitePublicBase) return `${config.sitePublicBase}/${slug}/`;
  return `${panelBaseUrl()}/s/${slug}/`;
}

/** The address the panel dials when it relays a parked connection back in. */
export const loopbackAddress = () =>
  config.bindAddress === '0.0.0.0' || config.bindAddress === '::' ? '127.0.0.1' : config.bindAddress;
