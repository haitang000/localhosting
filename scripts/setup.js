import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const q = (query) => new Promise((r) => rl.question(query, r));

function parseEnv(text) {
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    map[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return map;
}

function writeKey(text, key, value) {
  const lines = text.split('\n');
  let found = false;
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      found = true;
      const indent = line.match(/^\s*/)[0];
      return `${indent}${key}=${value}`;
    }
    return line;
  });
  if (!found) out.push(`${key}=${value}`);
  return out.join('\n');
}

async function main() {
  const welcome = `
  ╔═══════════════════════════════════════════╗
  ║     localhosting 面板  ——  首次设置向导   ║
  ╚═══════════════════════════════════════════╝

  这个向导会帮你配置最核心的几个参数。
  其他配置（Docker、注册规则、积分定价等）可随时在 .env 中修改。

  `;
  console.log(welcome);

  let src = '';
  if (fs.existsSync(ENV_FILE)) {
    src = fs.readFileSync(ENV_FILE, 'utf8');
    console.log('  ℹ 检测到已有 .env，将更新其中的关键项，其余保持不变。\n');
  } else if (fs.existsSync(ENV_EXAMPLE)) {
    src = fs.readFileSync(ENV_EXAMPLE, 'utf8');
    console.log('  ℹ 未找到 .env，已从 .env.example 创建初始配置。\n');
  } else {
    console.error('  ✗ 找不到 .env.example，请确保在项目根目录运行。');
    process.exit(1);
  }

  const cur = parseEnv(src);

  const defPort = cur.PANEL_PORT || '8099';
  const defRam = cur.REGION_MAX_MEMORY_MB || '32768';
  const defCpu = cur.REGION_MAX_CPUS || '20';
  const defHost = cur.PUBLIC_HOST || '';
  const defPanelUrl = cur.PANEL_PUBLIC_URL || '';

  // ── 1. Panel port ──
  const port = await q(`  ▶ 面板监听端口 [${defPort}]: `) || defPort;

  // ── 2. Region max memory ──
  const ram = await q(`  ▶ 区域最大内存 (MB) [${defRam}]: `) || defRam;

  // ── 3. Region max CPU ──
  const cpu = await q(`  ▶ 区域最大 CPU (核数) [${defCpu}]: `) || defCpu;

  // ── 4. Public host ──
  console.log(`
  ── 公网访问 ──
  填写你用于内网穿透的域名或公网 IP（例如 frp.example.com）。
  用户实例的访问地址会基于这个域名生成。
  留空也可以，之后在 .env 中设置 PUBLIC_HOST。
  `);
  const host = await q(`  ▶ 公网域名 / IP [${defHost || '（留空）'}]: `) || defHost;

  // ── 5. Panel public URL ──
  let panelUrl = defPanelUrl;
  if (host && !defPanelUrl) {
    const guess = `https://${host}:${port}`;
    panelUrl = await q(`  ▶ 面板公网地址（面板自己的入口，例如 ${guess}）\n    [${guess}]: `) || guess;
  } else if (!panelUrl) {
    const ans = await q(`  ▶ 面板公网地址（留空则稍后在 .env 中手动设置） [${defPanelUrl || '（留空）'}]: `);
    if (ans) panelUrl = ans;
  }

  // ── Write ──
  let out = src;
  out = writeKey(out, 'PANEL_PORT', port);
  out = writeKey(out, 'PANEL_HOST', '0.0.0.0');
  out = writeKey(out, 'REGION_MAX_MEMORY_MB', ram);
  out = writeKey(out, 'REGION_MAX_CPUS', cpu);
  out = writeKey(out, 'PUBLIC_HOST', host);
  out = writeKey(out, 'PANEL_PUBLIC_URL', panelUrl);

  fs.writeFileSync(ENV_FILE, out, 'utf8');

  const summary = `
  ──────────────────────────────────────────────
  ✅  配置已写入 .env

  面板端口:     ${port}
  最大内存:     ${ram} MB
  最大 CPU:     ${cpu} 核
  公网域名:     ${host || '(未设置)'}
  面板公网 URL: ${panelUrl || '(未设置)'}
  ──────────────────────────────────────────────

  现在可以启动面板了：
    npm start

  或开发模式（文件修改后自动重启）：
    npm run dev

  `;
  console.log(summary);

  rl.close();
}

main().catch((err) => {
  console.error('\n  ✗ 设置失败:', err.message);
  process.exit(1);
});
