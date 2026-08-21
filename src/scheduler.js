import { db, now, audit } from './db.js';
import * as dk from './docker.js';
import { logger } from './logger.js';
import { exportInstance } from './backup.js';

let schedulerInterval = null;

/**
 * 解析 cron 表达式，判断当前是否应该执行
 * @param {string} cron 格式：分 时 日 月 周（如 "0 9 * * 1-5"）
 * @param {Date} date 要检查的时间
 * @returns {boolean}
 */
function shouldRun(cron, date) {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.split(/\s+/);

  const matchField = (field, value) => {
    if (field === '*') return true;
    if (field.includes(',')) return field.split(',').some(v => matchField(v, value));
    if (field.includes('-')) {
      const [start, end] = field.split('-').map(Number);
      return value >= start && value <= end;
    }
    if (field.includes('/')) {
      const [range, step] = field.split('/');
      if (range === '*') return value % Number(step) === 0;
      const [start, end] = range.split('-').map(Number);
      return value >= start && value <= end && (value - start) % Number(step) === 0;
    }
    return Number(field) === value;
  };

  return (
    matchField(minute, date.getMinutes()) &&
    matchField(hour, date.getHours()) &&
    matchField(dayOfMonth, date.getDate()) &&
    matchField(month, date.getMonth() + 1) &&
    matchField(dayOfWeek, date.getDay())
  );
}

/**
 * 计算下次运行时间（简化版，返回最近的一分钟对齐时间）
 * @param {string} cron
 * @returns {string} ISO 时间字符串
 */
function calculateNextRun(cron) {
  const now = new Date();
  // 从下一分钟开始检查
  const next = new Date(now.getTime() + 60000);
  next.setSeconds(0);
  next.setMilliseconds(0);

  // 最多检查未来 7 天
  const limit = new Date(now.getTime() + 7 * 86400000);

  while (next < limit) {
    if (shouldRun(cron, next)) {
      return next.toISOString();
    }
    next.setTime(next.getTime() + 60000); // 每次加 1 分钟
  }

  // 如果 7 天内找不到，返回 7 天后
  return limit.toISOString();
}

/**
 * 执行任务
 * @param {Object} task 任务对象
 */
async function executeTask(task) {
  logger.info('scheduler.execute', { taskId: task.id, action: task.action, instanceId: task.instance_id });

  try {
    // 获取实例信息
    const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(task.instance_id);
    if (!instance) {
      logger.warn('scheduler.instance_not_found', { taskId: task.id, instanceId: task.instance_id });
      return;
    }

    if (!instance.container_id) {
      logger.warn('scheduler.no_container', { taskId: task.id, instanceId: task.instance_id });
      return;
    }

    const container = dk.docker.getContainer(instance.container_id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(task.user_id);

    switch (task.action) {
      case 'start':
        if (instance.status === 'stopped') {
          await container.start();
          db.prepare("UPDATE instances SET status = 'running' WHERE id = ?").run(instance.id);
          audit(user, 'instance.start', instance.id, `定时任务启动: ${instance.name}`);
        }
        break;

      case 'stop':
        if (instance.status === 'running') {
          await container.stop({ t: 10 });
          db.prepare("UPDATE instances SET status = 'stopped' WHERE id = ?").run(instance.id);
          audit(user, 'instance.stop', instance.id, `定时任务停止: ${instance.name}`);
        }
        break;

      case 'restart':
        if (instance.status === 'running') {
          await container.restart({ t: 10 });
          audit(user, 'instance.restart', instance.id, `定时任务重启: ${instance.name}`);
        }
        break;

      case 'backup':
        await exportInstance(instance.id, task.user_id, 'scheduled');
        audit(user, 'instance.backup', instance.id, `定时任务备份: ${instance.name}`);
        break;

      default:
        logger.warn('scheduler.unknown_action', { action: task.action });
    }

    // 更新最后运行时间和下次运行时间
    const nextRun = calculateNextRun(task.cron);
    db.prepare('UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(
      now(),
      nextRun,
      task.id
    );
  } catch (err) {
    logger.error('scheduler.execute.failed', { taskId: task.id, error: err });
  }
}

/**
 * 检查并执行到期的任务
 */
async function checkTasks() {
  const tasks = db
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active'
       AND (next_run_at IS NULL OR next_run_at <= ?)
       ORDER BY next_run_at ASC`
    )
    .all(now());

  for (const task of tasks) {
    await executeTask(task);
  }
}

/**
 * 启动定时任务调度器
 */
export function start() {
  logger.info('scheduler.started');

  // 初始化所有任务的 next_run_at
  const uninitializedTasks = db.prepare('SELECT * FROM scheduled_tasks WHERE next_run_at IS NULL').all();
  for (const task of uninitializedTasks) {
    const nextRun = calculateNextRun(task.cron);
    db.prepare('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?').run(nextRun, task.id);
  }

  // 立即检查一次
  checkTasks().catch((err) => logger.error('scheduler.check.error', { error: err }));

  // 每分钟检查一次
  schedulerInterval = setInterval(() => {
    checkTasks().catch((err) => logger.error('scheduler.check.error', { error: err }));
  }, 60000);
}

/**
 * 停止定时任务调度器
 */
export function stop() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info('scheduler.stopped');
  }
}

/**
 * 创建定时任务
 * @param {string} instanceId 实例 ID
 * @param {number} userId 用户 ID
 * @param {string} action 动作：start | stop | restart | backup
 * @param {string} cron cron 表达式
 * @returns {number} 任务 ID
 */
export function createTask(instanceId, userId, action, cron) {
  const nextRun = calculateNextRun(cron);

  const result = db
    .prepare(
      `INSERT INTO scheduled_tasks
       (instance_id, user_id, action, cron, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(instanceId, userId, action, cron, nextRun, now(), now());

  logger.info('scheduler.task.created', { taskId: result.lastInsertRowid, instanceId, action, cron });
  return result.lastInsertRowid;
}

/**
 * 更新定时任务
 * @param {number} taskId 任务 ID
 * @param {Object} updates 更新内容
 */
export function updateTask(taskId, updates) {
  const fields = [];
  const values = [];

  if (updates.action) {
    fields.push('action = ?');
    values.push(updates.action);
  }
  if (updates.cron) {
    fields.push('cron = ?');
    values.push(updates.cron);
    fields.push('next_run_at = ?');
    values.push(calculateNextRun(updates.cron));
  }
  if (updates.status) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(now());
  values.push(taskId);

  db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  logger.info('scheduler.task.updated', { taskId, updates });
}

/**
 * 删除定时任务
 * @param {number} taskId 任务 ID
 */
export function deleteTask(taskId) {
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(taskId);
  logger.info('scheduler.task.deleted', { taskId });
}

/**
 * 获取实例的所有定时任务
 * @param {string} instanceId 实例 ID
 * @returns {Array} 任务列表
 */
export function getInstanceTasks(instanceId) {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE instance_id = ? ORDER BY created_at DESC').all(instanceId);
}

/**
 * 获取用户的所有定时任务
 * @param {number} userId 用户 ID
 * @returns {Array} 任务列表
 */
export function getUserTasks(userId) {
  return db
    .prepare(
      `SELECT st.*, i.name as instance_name
       FROM scheduled_tasks st
       JOIN instances i ON st.instance_id = i.id
       WHERE st.user_id = ?
       ORDER BY st.created_at DESC`
    )
    .all(userId);
}

/**
 * 验证 cron 表达式
 * @param {string} cron
 * @returns {Object} { valid: boolean, error?: string }
 */
export function validateCron(cron) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, error: 'cron 表达式必须包含 5 个字段：分 时 日 月 周' };
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  const validateField = (field, min, max, name) => {
    if (field === '*') return true;

    // 处理逗号分隔
    if (field.includes(',')) {
      return field.split(',').every(v => validateField(v.trim(), min, max, name));
    }

    // 处理范围
    if (field.includes('-')) {
      const [start, end] = field.split('-').map(Number);
      if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) {
        return false;
      }
      return true;
    }

    // 处理步长
    if (field.includes('/')) {
      const [range, step] = field.split('/');
      if (range !== '*' && !validateField(range, min, max, name)) return false;
      const stepNum = Number(step);
      if (isNaN(stepNum) || stepNum < 1) return false;
      return true;
    }

    const num = Number(field);
    return !isNaN(num) && num >= min && num <= max;
  };

  if (!validateField(minute, 0, 59, '分钟')) {
    return { valid: false, error: '分钟字段无效（0-59）' };
  }
  if (!validateField(hour, 0, 23, '小时')) {
    return { valid: false, error: '小时字段无效（0-23）' };
  }
  if (!validateField(dayOfMonth, 1, 31, '日')) {
    return { valid: false, error: '日期字段无效（1-31）' };
  }
  if (!validateField(month, 1, 12, '月')) {
    return { valid: false, error: '月份字段无效（1-12）' };
  }
  if (!validateField(dayOfWeek, 0, 6, '星期')) {
    return { valid: false, error: '星期字段无效（0-6，0=周日）' };
  }

  return { valid: true };
}
