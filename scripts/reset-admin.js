/**
 * 忘记管理员密码时用：node scripts/reset-admin.js <用户名> <新密码>
 * 不带参数则列出所有用户。
 */
import { db } from '../src/db.js';
import { hashPassword, passwordProblem } from '../src/auth.js';

const [username, password] = process.argv.slice(2);

if (!username) {
  const rows = db.prepare('SELECT id, username, role, disabled FROM users ORDER BY id').all();
  console.table(rows);
  console.log('\n用法: node scripts/reset-admin.js <用户名> <新密码>');
  process.exit(0);
}

const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`用户 ${username} 不存在`);
  process.exit(1);
}

const problem = passwordProblem(password, user.username);
if (problem) {
  console.error(problem);
  process.exit(1);
}

db.prepare("UPDATE users SET password_hash = ?, role = 'admin', disabled = 0 WHERE id = ?").run(
  hashPassword(password),
  user.id
);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
console.log(`已重置 ${username} 的密码，并确保其为启用状态的管理员。`);
