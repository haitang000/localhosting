/**
 * 给已经存在的账号补发注册见面礼（一笔积分，默认 WELCOME_POINTS=100）。
 *
 *   node scripts/grant-welcome-points.js              # 先看看会发给谁，不写库
 *   node scripts/grant-welcome-points.js --yes        # 真的发
 *   node scripts/grant-welcome-points.js --yes --include-admins
 *
 * 反复跑没关系：积分流水里已经有 welcome 那笔的人会被跳过。
 * 当年领过欢迎券的老用户不算数 —— 券归券，积分这份见面礼照发。
 */
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { grantWelcomePoints } from '../src/points.js';

const args = process.argv.slice(2);
const write = args.includes('--yes');
const includeAdmins = args.includes('--include-admins');

if (!config.welcomePoints) {
  console.error('WELCOME_POINTS=0，见面礼被关掉了，没有可补发的东西。');
  process.exit(1);
}

// 管理员的积分自己就能调，引导也不给他们看，默认不掺和。
// 只认积分流水里的 welcome 痕迹：老用户当年拿的是欢迎券，不影响这次补发积分。
const users = db
  .prepare(
    `SELECT u.id, u.username, u.role, u.points FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM point_txns t WHERE t.user_id = u.id AND t.reason = 'welcome')
       ${includeAdmins ? '' : "AND u.role != 'admin'"}
     ORDER BY u.id`
  )
  .all();

if (!users.length) {
  console.log('没有需要补发的账号 —— 每个人的积分流水里都有 welcome 那笔了。');
  process.exit(0);
}

console.log(`准备给 ${users.length} 个账号各补发 ${config.welcomePoints} 积分：`);

const done = [];
for (const u of users) {
  if (!write) {
    console.log(`  ${u.username}${u.role === 'admin' ? ' (管理员)' : ''}（当前 ${u.points ?? 0} 分）`);
    continue;
  }
  if (grantWelcomePoints(u)) done.push({ 用户: u.username, 补发: config.welcomePoints, 现余额: u.points });
  else console.error(`  ✗ ${u.username} 补发失败`);
}

if (!write) {
  console.log('\n以上都还没写库。确认无误后加 --yes 再跑一次。');
} else {
  console.table(done);
  console.log(`已补发 ${done.length} 笔。用户在「账号 → 我的积分」里就能看到余额。`);
}
