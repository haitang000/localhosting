import { config } from './config.js';
import { db, now } from './db.js';
import * as dk from './docker.js';

/**
 * 危险操作预警：用户在实例里挖矿（或干其它明显坏事的迹象）时记一条预警，
 * 管理员在后台「预警」页看到，可以选择封禁实例 / 封禁用户 / 忽略。
 *
 * 四个检测入口，全部只记录、不拦截 —— 拦截会让攻击者立刻知道特征库的存在，
 * 换个二进制名就绕过去了；安静的预警把发现权留给管理员：
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
  return Number(r.lastInsertRowid);
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
