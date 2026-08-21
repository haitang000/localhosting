import { config } from './config.js';
import { db, now } from './db.js';
import * as dk from './docker.js';
import { guardAutoBan } from './settings.js';
import * as svc from './instances.js';

/**
 * 危险操作预警：用户在实例里挖矿（或干其它明显坏事的迹象）时记一条预警，
 * 管理员在后台「预警」页看到，可以选择封禁实例 / 封禁用户 / 忽略。
 *
 * 四个检测入口都会留下预警记录；默认会自动封禁已运行的涉事实例，也可在
 * 管理后台关闭后改为人工裁决：
 *   - process  定期 docker top 扫运行中容器的进程命令行（最可靠的一条路）
 *   - console  控制台敲进容器的命令
 *   - create   创建实例时的镜像名 / 启动命令 / 环境变量 / 备注
 *   - upload   文件管理器上传的文件名（矿机二进制往往是原名上传）
 *
 * 去重口径是「同一实例 + 同一规则只留一条未处理预警」：矿机会每个扫描周期
 * 都在进程表里，重复命中只累计 seen_count / last_seen_at，不会刷屏。
 * 实例被删、用户被删后预警仍留着（user_id / instance_id 不设外键，名字是快照），
 * 否则封禁证据会跟着实例一起消失。
 */

/* 特征规则：尽量带词界或协议前缀，宁可漏报不可误报 —— 每条预警都要求
 * 管理员人工裁决，误报多了管理员就再也不看这个页面了。 */
const RULES = [
  { id: 'xmrig', label: 'XMRig 门罗币矿机', re: /\bxmrig(-[a-z]+)?\b/i },
  { id: 'xmr-stak', label: 'XMR-Stak 矿机', re: /\bxmr-stak\b/i },
  { id: 'cpuminer', label: 'CPUMiner 矿机', re: /\b(cpuminer|minerd|minerdaemon)\b/i },
  { id: 'ethminer', label: 'Ethminer 显卡矿机', re: /\bethminer\b/i },
  { id: 'cgminer', label: 'CGMiner 系矿机', re: /\b(cgminer|bfgminer|sgminer)\b/i },
  { id: 'nbminer', label: 'NBMiner 显卡矿机', re: /\bnbminer\b/i },
  { id: 'phoenixminer', label: 'PhoenixMiner 显卡矿机', re: /\bphoenixminer\b/i },
  { id: 'teamredminer', label: 'TeamRedMiner 显卡矿机', re: /\bteamredminer\b/i },
  { id: 'lolminer', label: 'GMiner / LolMiner 矿机', re: /\b(lolminer|gminer)\b/i },
  { id: 'trex-miner', label: 'T-Rex 显卡矿机', re: /\bt-rex(\.exe)?\s/i },
  { id: 'stratum', label: '挖矿协议 stratum', re: /stratum\+(tcp|ssl|http)/i },
  { id: 'minergate', label: 'Minergate 矿池客户端', re: /\bminergate\b/i },
  { id: 'nicehash', label: 'NiceHash 挖矿', re: /\bnicehash\b/i },
  {
    id: 'pool',
    label: '已知矿池域名',
    re: /\b(supportxmr|c3pool|hashvault|nanopool|f2pool|antpool|moneroocean|monerohash|pool\.minexmr|miningpoolhub|2miners|woolypooly|flexpool|ethermine|hiveon(?:\.pool)?)\b/i,
  },
  { id: 'hiveos', label: 'HiveOS 矿机系统客户端', re: /\bhive-os\b|\bhiveos\b/i },
  { id: 'cryptojacking-malware', label: '已知挖矿恶意程序', re: /\b(?:kinsing|kdevtmpfsi|watchbog|perfctl|sysupdate|xmrig-proxy)\b/i },

  // 远程控制 / 下载执行：这些模式比单独出现 curl、python 等命令更可靠，
  // 能减少用户正常安装依赖时的误报。
  {
    id: 'reverse-shell',
    label: '反向 Shell / 远程命令通道',
    re: /(?:\/dev\/tcp\/[\w.:-]+\/\d{1,5}|\b(?:nc|ncat|netcat)\b[^\n;&|]*\s-(?:e|[^\s-]*e)(?:\s|$)|\bsocat\b[^\n;&|]*(?:exec|system|shell))/i,
  },
  {
    id: 'download-exec',
    label: '下载后直接执行脚本',
    re: /\b(?:curl|wget)\b[^\n]{0,400}\|\s*(?:ba)?sh(?:\s|$)|\b(?:curl|wget)\b[^\n]{0,400}(?:;|&&)\s*(?:chmod\s+\+x[^;&|]*[;&|]\s*)?(?:\.\/|bash?\s|python(?:3)?\s)/i,
  },
  {
    id: 'encoded-exec',
    label: '解码后执行隐藏脚本',
    re: /\b(?:base64\s+(?:-d|--decode)|openssl\s+enc\s+-d)\b[^\n]{0,300}(?:\||;|&&)\s*(?:ba)?sh\b|\beval\s*\(?\s*["'`]?(?:\$\(|\b(?:curl|wget)\b)/i,
  },

  // 破坏宿主/容器数据或令系统失去服务能力的命令。
  {
    id: 'destructive-filesystem',
    label: '破坏性文件系统操作',
    re: /(?:^|[\s;&|])rm\s+(?:--no-preserve-root\s+)?-[rRfFiI]{1,4}\s+(?:--no-preserve-root\s+)?\/(?:\s|$)|\b(?:mkfs(?:\.[a-z0-9]+)?|fdisk|parted)\b[^\n]*(?:\/dev\/|--force)|\bdd\b[^\n]*\bif=\/dev\/(?:zero|urandom)\b[^\n]*\bof=\/dev\//i,
  },
  {
    id: 'service-disruption',
    label: '系统关机或服务中断',
    re: /(?:^|[\s;&|])(?:shutdown|reboot|poweroff|halt|init\s+[06])(?:\s|$)|\b(?:systemctl|service)\s+(?:stop|disable|mask)\b/i,
  },
  {
    id: 'fork-bomb',
    label: '进程 Fork Bomb',
    re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/i,
  },
  {
    id: 'resource-exhaustion',
    label: '资源耗尽攻击',
    re: /\b(?:stress(?:-ng)?|memtester)\b[^\n]*(?:--cpu|--vm|--io|--hdd|--vm-bytes|--size)|\b(?:yes|openssl\s+speed)\b[^\n]*(?:\||>)[^\n]*(?:\/dev\/null|\/tmp)/i,
  },

  // 凭据及敏感资料读取/外传。单独读取普通配置不命中，要求出现高价值路径。
  {
    id: 'credential-access',
    label: '读取凭据或敏感系统文件',
    re: /\b(?:cat|less|more|head|tail|grep|sed|awk|strings|find)\b[^\n]*(?:\/etc\/(?:shadow|gshadow)|\/root\/\.ssh|(?:^|[\s/])id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?\b|\/proc\/(?:\d+\/)?environ|\.env(?:\b|\.))/i,
  },
  {
    id: 'credential-exfiltration',
    label: '外传凭据或敏感资料',
    re: /\b(?:curl|wget|nc|ncat|netcat|socat|scp|ftp)\b[^\n]*(?:\/etc\/(?:shadow|gshadow)|\/root\/\.ssh|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\/proc\/(?:\d+\/)?environ|\.env\b)/i,
  },

  // 写入启动脚本、计划任务或 SSH 公钥，常用于持久化控制。
  {
    id: 'persistence',
    label: '写入计划任务或持久化配置',
    re: /\b(?:crontab\s+(?:-[^\n]*e|\/)|at\s+(?:now|-[^\n]*f)|systemctl\s+enable)\b|\b(?:echo|printf|cat|tee)\b[^\n]*(?:>>?|\|\s*tee)\s*[^\n]*(?:authorized_keys|\/etc\/(?:cron|systemd)|\.ssh\/rc)\b/i,
  },
  {
    id: 'network-scan',
    label: '网络扫描或探测工具',
    re: /(?:^|[\s;&|])(?:nmap|masscan|zmap|unicornscan|hping3|nping)(?:\s|$)/i,
  },
  {
    id: 'credential-cracking',
    label: '凭据破解或口令爆破工具',
    re: /(?:^|[\s;&|])(?:hydra|medusa|patator|hashcat|john)(?:\s|$)/i,
  },
  {
    id: 'web-attack-tools',
    label: '网站漏洞探测工具',
    re: /(?:^|[\s;&|])(?:sqlmap|nikto|dirb|dirbuster|gobuster|ffuf|wpscan)(?:\s|$)/i,
  },
  {
    id: 'defense-evasion',
    label: '禁用防护或清理日志',
    re: /\b(?:ufw|firewall-cmd)\s+disable\b|\biptables\b[^\n]*(?:-F\b|--flush)|\b(?:systemctl|service)\s+(?:stop|disable)\s+(?:auditd|apparmor|firewalld|ufw)\b|\b(?:history\s+-c|shred\s+[^\n]*(?:\.log|\/var\/log)|rm\s+[^\n]*\/var\/log)\b/i,
  },
  {
    id: 'cloud-metadata',
    label: '访问云平台元数据或服务凭据',
    re: /\b(?:169\.254\.169\.254|metadata\.google\.internal|\.aws\/credentials|\/var\/run\/secrets\/kubernetes\.io|serviceaccount\/token)\b/i,
  },
  {
    id: 'container-escape',
    label: '容器逃逸或 Docker Socket 访问',
    re: /\/var\/run\/docker\.sock\b|\bnsenter\b[^\n]*(?:\/proc\/1\/ns|-t\s*1)|\bunshare\b[^\n]*(?:-m|-p|-n|-U)/i,
  },
];

/** 命中列表（给后台展示 / 单元测试用），顺序即优先级。 */
export const ruleList = () => RULES.map(({ id, label }) => ({ id, label }));

const SNIPPET_MAX = 500;
const snippet = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX);

function matchOne(text) {
  for (const rule of RULES) {
    if (rule.re.test(text)) return rule;
  }
  return null;
}

/**
 * 记一条预警（或给已有未处理预警 +1）。row 只需要 { id, user_id, name }，
 * 所以创建实例的路径可以拿现拼的对象来调用，不必等数据库回读。
 */
export function record(row, source, rule, detail) {
  const username = db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id)?.username ?? '?';
  const at = now();
  const existing = db
    .prepare("SELECT id FROM alerts WHERE instance_id = ? AND rule = ? AND status = 'open'")
    .get(row.id, rule.id);
  if (existing) {
    db.prepare('UPDATE alerts SET seen_count = seen_count + 1, last_seen_at = ?, detail = ? WHERE id = ?').run(
      at,
      snippet(detail),
      existing.id
    );
    if (guardAutoBan()) {
      queueMicrotask(() => autoBanAlert(existing.id, row.id, rule.label));
    }
    return existing.id;
  }
  const r = db
    .prepare(
      `INSERT INTO alerts (user_id, username, instance_id, instance_name, source, rule, label, detail,
         status, seen_count, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?)`
    )
    .run(row.user_id, username, row.id, row.name, source, rule.id, rule.label, snippet(detail), at, at);
  console.warn(`[guard] 预警：${username} 的实例 ${row.name} 命中 ${rule.label}（${source}）`);
  // 自动封禁放到当前调用栈之后执行，避免影响控制台输入、文件上传或创建申请；
  // 待审批/已封存实例没有可封禁的运行目标，仍留给管理员人工处理。
  if (guardAutoBan()) {
    queueMicrotask(() => autoBanAlert(Number(r.lastInsertRowid), row.id, rule.label));
  }
  return Number(r.lastInsertRowid);
}

async function autoBanAlert(alertId, instanceId, label) {
  try {
    if (!guardAutoBan()) return;
    const alert = db.prepare("SELECT * FROM alerts WHERE id = ? AND status = 'open'").get(alertId);
    if (!alert) return;
    const row = instanceId ? db.prepare('SELECT * FROM instances WHERE id = ?').get(instanceId) : null;
    if (!row || !row.container_id || ['pending', 'rejected', 'archived', 'banned'].includes(row.status)) return;
    await svc.banInstance(row, { id: null, username: '自动预警' }, label);
    db.prepare(
      "UPDATE alerts SET status = 'resolved', action = 'auto_ban_instance', resolved_by = '自动预警', resolved_at = ? WHERE id = ? AND status = 'open'"
    ).run(now(), alertId);
    console.warn(`[guard] 自动封禁：实例 ${row.name}（${label}）`);
  } catch (err) {
    // 自动处置失败不吞掉证据：预警保持 open，管理员仍可人工处理。
    console.error(`[guard] 自动封禁失败：${err.message}`);
  }
}

/** 对一段文本跑一遍特征库，命中就记预警（每次最多记一条）。返回命中的规则或 null。 */
export function scanText(row, text, source) {
  if (!config.guardEnabled || text === undefined || text === null) return null;
  const t = String(text).slice(0, 4000);
  const rule = matchOne(t);
  if (!rule) return null;
  record(row, source, rule, t);
  return rule;
}

/** 创建实例时的参数扫描：镜像 / 启动命令 / 环境变量 / 挂载路径 / 备注 逐项过一遍，
 *  记第一条命中并标明是哪个字段。 */
export function scanCreate(instanceRef, { image, cmd, env, volumePath, note }) {
  if (!config.guardEnabled) return null;
  const fields = [
    ['镜像', image],
    ['启动命令', Array.isArray(cmd) ? cmd.join(' ') : cmd],
    ['环境变量', env ? Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ') : ''],
    ['数据卷路径', volumePath],
    ['备注', note],
  ];
  for (const [name, value] of fields) {
    if (!value) continue;
    const rule = matchOne(String(value).slice(0, 4000));
    if (rule) {
      record(instanceRef, 'create', rule, `${name}：${snippet(value)}`);
      return rule;
    }
  }
  return null;
}

/* ------------------------------------------------- 周期进程扫描 ------ */

async function tick() {
  const rows = db
    .prepare("SELECT * FROM instances WHERE container_id IS NOT NULL AND status = 'running'")
    .all();
  for (const row of rows) {
    let lines;
    try {
      lines = await dk.containerTop(row.container_id);
    } catch {
      continue; // docker 忙 / 容器刚好在停：下个周期再看
    }
    for (const line of lines) {
      const rule = matchOne(line);
      if (rule) {
        record(row, 'process', rule, line);
        break; // 一个容器每轮只记一条，剩下的是同一件事
      }
    }
  }
}

let timer = null;

export async function start() {
  if (!config.guardEnabled) return;
  timer = setInterval(() => tick().catch(() => {}), Math.max(15, config.guardCheckSeconds) * 1000);
  timer.unref();
  await tick().catch(() => {});
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}
