import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/**
 * Claude Stop hook:
 * - stages tracked changes plus non-ignored new project files, while excluding
 *   local agent settings and temporary inspection files;
 * - leaves an already-staged index alone, as that is likely a manual commit
 *   being prepared by the developer;
 * - a small cross-process lock avoids two overlapping Stop hooks creating
 *   duplicate commits.
 */
const runGit = (args, options = {}) =>
  execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });

const clean = (args) => {
  try {
    runGit(args);
    return true;
  } catch (err) {
    if (err.status === 1) return false; // git diff --quiet: changes found
    throw err;
  }
};

const lockName =
  'localhosting-auto-commit-' + createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16) + '.lock';
const lockPath = path.join(os.tmpdir(), lockName);

let lock;
try {
  lock = fs.openSync(lockPath, 'wx');
} catch (err) {
  if (err.code === 'EEXIST') process.exit(0);
  throw err;
}

try {
  // Do not fold a developer's hand-picked staged files into an automatic commit.
  if (!clean(['diff', '--cached', '--quiet', '--ignore-submodules', '--'])) process.exit(0);
  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter((file) => !file.startsWith('.claude/') && !file.startsWith('.codex/') && !path.basename(file).startsWith('.tmp-'));
  const hasTrackedChanges = !clean(['diff', '--quiet', '--ignore-submodules', '--']);
  if (!hasTrackedChanges && !untracked.length) process.exit(0);

  runGit(['add', '-u', '--']);
  if (untracked.length) runGit(['add', '--', ...untracked]);
  if (clean(['diff', '--cached', '--quiet', '--ignore-submodules', '--'])) process.exit(0);
  runGit(['commit', '-m', 'chore: save completed changes']);
  process.stdout.write('[auto-commit] 已提交本次已追踪文件改动。\n');
} catch (err) {
  const detail = err.stderr?.trim() || err.message;
  process.stderr.write('[auto-commit] 提交失败：' + detail + '\n');
  process.exitCode = 1;
} finally {
  if (lock !== undefined) fs.closeSync(lock);
  fs.rmSync(lockPath, { force: true });
}
