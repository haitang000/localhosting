import express from 'express';
import { db } from '../db.js';
import * as statsCollector from '../stats-collector.js';
import * as scheduler from '../scheduler.js';
import * as backup from '../backup.js';
import { logger } from '../logger.js';

export const router = express.Router();

// ==================== 资源统计 ====================

/**
 * GET /api/stats/instance/:id
 * 查询实例的资源使用历史
 */
router.get('/instance/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { range = '24h' } = req.query;

    // 验证权限
    const instance = db.prepare('SELECT user_id FROM instances WHERE id = ?').get(id);
    if (!instance) {
      return res.status(404).json({ error: '实例不存在' });
    }

    if (req.user.role !== 'admin' && instance.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权访问此实例的统计数据' });
    }

    const stats = statsCollector.getInstanceStats(id, range);
    res.json({ stats, range });
  } catch (err) {
    logger.error('stats.instance.error', { error: err });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/stats/user
 * 查询当前用户的资源使用汇总
 */
router.get('/user', (req, res) => {
  try {
    const { range = '24h' } = req.query;
    const stats = statsCollector.getUserStats(req.user.id, range);
    res.json({ stats, range });
  } catch (err) {
    logger.error('stats.user.error', { error: err });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/stats/global
 * 查询全局资源使用统计（管理员）
 */
router.get('/global', (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可访问' });
  }

  try {
    const { range = '24h' } = req.query;
    const stats = statsCollector.getGlobalStats(range);
    res.json({ stats, range });
  } catch (err) {
    logger.error('stats.global.error', { error: err });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/stats/ranking
 * 查询用户排行（管理员）
 */
router.get('/ranking', (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可访问' });
  }

  try {
    const { metric = 'cpu', range = '24h', limit = 10 } = req.query;
    const ranking = statsCollector.getUserRanking(metric, range, Number(limit));
    res.json({ ranking, metric, range });
  } catch (err) {
    logger.error('stats.ranking.error', { error: err });
    res.status(500).json({ error: err.message });
  }
});

// ==================== 定时任务 ====================

/**
 * GET /api/tasks
 * 获取当前用户的所有定时任务
 */
router.get('/tasks', (req, res) => {
  try {
    const tasks = scheduler.getUserTasks(req.user.id);
    res.json({ tasks });
  } catch (err) {
    logger.error('tasks.list.error', { error: err });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tasks/instance/:id
 * 获取实例的所有定时任务
 */
router.get('/tasks/instance/:id', (req, res) => {
  try {
    const { id } = req.params;

    // 验证权限
    const instance = db.prepare('SELECT user_id FROM instances WHERE id = ?').get(id);
    if (!instance) {
      return res.status(404).json({ error: '实例不存在' });
    }

    if (req.user.role !== 'admin' && instance.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权访问此实例的定时任务' });
    }

    const tasks = scheduler.getInstanceTasks(id);
    res.json({ tasks });
  } catch (err) {
    logger.error('tasks.instance.error', { error: err });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/tasks
 * 创建定时任务
 */
router.post('/tasks', (req, res) => {
  try {
    const { instanceId, action, cron } = req.body;

    if (!instanceId || !action || !cron) {
      return res.status(400).json({ error: '缺少必填字段' });
    }

    // 验证权限
    const instance = db.prepare('SELECT user_id FROM instances WHERE id = ?').get(instanceId);
    if (!instance) {
      return res.status(404).json({ error: '实例不存在' });
    }

    if (req.user.role !== 'admin' && instance.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权为此实例创建定时任务' });
    }

    // 验证动作类型
    if (!['start', 'stop', 'restart', 'backup'].includes(action)) {
      return res.status(400).json({ error: '无效的任务类型' });
    }

    // 验证 cron 表达式
    const validation = scheduler.validateCron(cron);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const taskId = scheduler.createTask(instanceId, req.user.id, action, cron);
    res.json({ success: true, taskId });
  } catch (err) {
    logger.error('tasks.create.error', { error: err });
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/tasks/:id
 * 更新定时任务
 */
router.put('/tasks/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { action, cron, status } = req.body;

    // 验证权限
    const task = db.prepare('SELECT user_id FROM scheduled_tasks WHERE id = ?').get(id);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }

    if (req.user.role !== 'admin' && task.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权修改此任务' });
    }

    const updates = {};
    if (action) updates.action = action;
    if (cron) {
      const validation = scheduler.validateCron(cron);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
      updates.cron = cron;
    }
    if (status) updates.status = status;

    scheduler.updateTask(id, updates);
    res.json({ success: true });
  } catch (err) {
    logger.error('tasks.update.error', { error: err });
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/tasks/:id
 * 删除定时任务
 */
router.delete('/tasks/:id', (req, res) => {
  try {
    const { id } = req.params;

    // 验证权限
    const task = db.prepare('SELECT user_id FROM scheduled_tasks WHERE id = ?').get(id);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }

    if (req.user.role !== 'admin' && task.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权删除此任务' });
    }

    scheduler.deleteTask(id);
    res.json({ success: true });
  } catch (err) {
    logger.error('tasks.delete.error', { error: err });
    res.status(500).json({ error: err.message });
  }
});

// ==================== 备份和导出 ====================

/**
 * POST /api/backups/export/:instanceId
 * 导出实例
 */
router.post('/export/:instanceId', async (req, res) => {
  try {
    const { instanceId } = req.params;

    // 验证权限
    const instance = db.prepare('SELECT user_id FROM instances WHERE id = ?').get(instanceId);
    if (!instance) {
      return res.status(404).json({ error: '实例不存在' });
    }

    if (req.user.role !== 'admin' && instance.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权导出此实例' });
    }

    const result = await backup.exportInstance(instanceId, req.user.id, 'manual');
    res.json({ success: true, backup: result });
  } catch (err) {
    logger.error('backup.export.error', { error: err });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/backups/import
 * 从 docker-compose.yml 导入配置
 */
router.post('/import', async (req, res) => {
  try {
    const { composeYaml, name } = req.body;

    if (!composeYaml) {
      return res.status(400).json({ error: '缺少 docker-compose.yml 内容' });
    }

    const result = await backup.importInstance(req.user.id, composeYaml, { name });
    res.json({ success: true, instance: result });
  } catch (err) {
    logger.error('backup.import.error', { error: err });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/backups
 * 获取当前用户的备份列表
 */
router.get('/backups', (req, res) => {
  try {
    const backups = backup.getUserBackups(req.user.id);
    res.json({ backups });
  } catch (err) {
    logger.error('backup.list.error', { error: err });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/backups/instance/:id
 * 获取实例的备份列表
 */
router.get('/backups/instance/:id', (req, res) => {
  try {
    const { id } = req.params;

    // 验证权限
    const instance = db.prepare('SELECT user_id FROM instances WHERE id = ?').get(id);
    if (!instance) {
      return res.status(404).json({ error: '实例不存在' });
    }

    if (req.user.role !== 'admin' && instance.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权访问此实例的备份' });
    }

    const backups = backup.getInstanceBackups(id);
    res.json({ backups });
  } catch (err) {
    logger.error('backup.instance.error', { error: err });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/backups/download/:id
 * 下载备份文件
 */
router.get('/download/:id', (req, res) => {
  try {
    const { id } = req.params;
    const fileInfo = backup.downloadBackup(id, req.user.id);

    res.download(fileInfo.path, fileInfo.name, (err) => {
      if (err) {
        logger.error('backup.download.error', { backupId: id, error: err });
        if (!res.headersSent) {
          res.status(500).json({ error: '下载失败' });
        }
      }
    });
  } catch (err) {
    logger.error('backup.download.error', { error: err });
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/backups/:id
 * 删除备份
 */
router.delete('/backups/:id', (req, res) => {
  try {
    const { id } = req.params;
    backup.deleteBackup(id, req.user.id);
    res.json({ success: true });
  } catch (err) {
    logger.error('backup.delete.error', { error: err });
    res.status(500).json({ error: err.message });
  }
});
