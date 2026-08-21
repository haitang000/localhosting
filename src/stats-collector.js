import { db, now } from './db.js';
import * as dk from './docker.js';
import { config } from './config.js';
import { logger } from './logger.js';

let collectorInterval = null;

/**
 * 采集所有运行中实例的资源使用数据
 */
async function collectStats() {
  const instances = db
    .prepare("SELECT id, user_id, container_id FROM instances WHERE status = 'running' AND container_id IS NOT NULL")
    .all();

  for (const inst of instances) {
    try {
      const container = dk.docker.getContainer(inst.container_id);
      const stats = await container.stats({ stream: false });

      // 计算 CPU 使用率
      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
      const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100 : 0;

      // 计算内存使用
      const memoryMb = stats.memory_stats.usage ? stats.memory_stats.usage / 1048576 : 0;
      const memoryLimit = stats.memory_stats.limit || 1;
      const memoryPercent = (stats.memory_stats.usage / memoryLimit) * 100;

      // 计算网络流量（所有网卡累加）
      let rxBytes = 0;
      let txBytes = 0;
      if (stats.networks) {
        for (const net of Object.values(stats.networks)) {
          rxBytes += net.rx_bytes || 0;
          txBytes += net.tx_bytes || 0;
        }
      }

      // 计算磁盘使用（如果有 blkio 数据）
      let diskMb = 0;
      if (stats.blkio_stats?.io_service_bytes_recursive) {
        for (const item of stats.blkio_stats.io_service_bytes_recursive) {
          diskMb += (item.value || 0) / 1048576;
        }
      }

      // 写入数据库
      db.prepare(
        `INSERT INTO resource_stats
         (instance_id, user_id, cpu_percent, memory_mb, memory_percent, network_rx_mb, network_tx_mb, disk_mb, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        inst.id,
        inst.user_id,
        Math.round(cpuPercent * 100) / 100,
        Math.round(memoryMb * 100) / 100,
        Math.round(memoryPercent * 100) / 100,
        Math.round((rxBytes / 1048576) * 100) / 100,
        Math.round((txBytes / 1048576) * 100) / 100,
        Math.round(diskMb * 100) / 100,
        now()
      );
    } catch (err) {
      logger.debug('stats.collect.failed', { instanceId: inst.id, error: err.message });
    }
  }

  // 清理旧数据：保留最近 30 天
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  db.prepare('DELETE FROM resource_stats WHERE collected_at < ?').run(cutoff);
}

/**
 * 启动资源统计采集
 */
export function start() {
  const intervalSeconds = Math.max(30, config.statsCollectSeconds || 300);
  logger.info('stats.collector.started', { intervalSeconds });

  // 立即执行一次
  collectStats().catch((err) => logger.error('stats.collect.error', { error: err }));

  // 定时执行
  collectorInterval = setInterval(() => {
    collectStats().catch((err) => logger.error('stats.collect.error', { error: err }));
  }, intervalSeconds * 1000);
}

/**
 * 停止资源统计采集
 */
export function stop() {
  if (collectorInterval) {
    clearInterval(collectorInterval);
    collectorInterval = null;
    logger.info('stats.collector.stopped');
  }
}

/**
 * 查询实例的资源统计数据
 * @param {string} instanceId 实例 ID
 * @param {string} range 时间范围：1h | 24h | 7d | 30d
 * @returns {Array} 统计数据数组
 */
export function getInstanceStats(instanceId, range = '24h') {
  const ranges = {
    '1h': 3600,
    '24h': 86400,
    '7d': 604800,
    '30d': 2592000,
  };
  const seconds = ranges[range] || 86400;
  const since = new Date(Date.now() - seconds * 1000).toISOString();

  return db
    .prepare(
      `SELECT cpu_percent, memory_mb, memory_percent, network_rx_mb, network_tx_mb, disk_mb, collected_at
       FROM resource_stats
       WHERE instance_id = ? AND collected_at >= ?
       ORDER BY collected_at ASC`
    )
    .all(instanceId, since);
}

/**
 * 查询用户的资源使用汇总
 * @param {number} userId 用户 ID
 * @param {string} range 时间范围
 * @returns {Object} 汇总统计
 */
export function getUserStats(userId, range = '24h') {
  const ranges = {
    '1h': 3600,
    '24h': 86400,
    '7d': 604800,
    '30d': 2592000,
  };
  const seconds = ranges[range] || 86400;
  const since = new Date(Date.now() - seconds * 1000).toISOString();

  const result = db
    .prepare(
      `SELECT
         AVG(cpu_percent) as avg_cpu,
         MAX(cpu_percent) as max_cpu,
         AVG(memory_mb) as avg_memory,
         MAX(memory_mb) as max_memory,
         SUM(network_rx_mb) as total_rx,
         SUM(network_tx_mb) as total_tx
       FROM resource_stats
       WHERE user_id = ? AND collected_at >= ?`
    )
    .get(userId, since);

  return {
    avgCpu: Math.round((result.avg_cpu || 0) * 100) / 100,
    maxCpu: Math.round((result.max_cpu || 0) * 100) / 100,
    avgMemory: Math.round((result.avg_memory || 0) * 100) / 100,
    maxMemory: Math.round((result.max_memory || 0) * 100) / 100,
    totalRx: Math.round((result.total_rx || 0) * 100) / 100,
    totalTx: Math.round((result.total_tx || 0) * 100) / 100,
  };
}

/**
 * 查询全局资源使用汇总（管理员）
 * @param {string} range 时间范围
 * @returns {Object} 全局统计
 */
export function getGlobalStats(range = '24h') {
  const ranges = {
    '1h': 3600,
    '24h': 86400,
    '7d': 604800,
    '30d': 2592000,
  };
  const seconds = ranges[range] || 86400;
  const since = new Date(Date.now() - seconds * 1000).toISOString();

  const result = db
    .prepare(
      `SELECT
         AVG(cpu_percent) as avg_cpu,
         MAX(cpu_percent) as max_cpu,
         AVG(memory_mb) as avg_memory,
         MAX(memory_mb) as max_memory,
         SUM(network_rx_mb) as total_rx,
         SUM(network_tx_mb) as total_tx,
         COUNT(DISTINCT instance_id) as instance_count,
         COUNT(DISTINCT user_id) as user_count
       FROM resource_stats
       WHERE collected_at >= ?`
    )
    .get(since);

  return {
    avgCpu: Math.round((result.avg_cpu || 0) * 100) / 100,
    maxCpu: Math.round((result.max_cpu || 0) * 100) / 100,
    avgMemory: Math.round((result.avg_memory || 0) * 100) / 100,
    maxMemory: Math.round((result.max_memory || 0) * 100) / 100,
    totalRx: Math.round((result.total_rx || 0) * 100) / 100,
    totalTx: Math.round((result.total_tx || 0) * 100) / 100,
    instanceCount: result.instance_count || 0,
    userCount: result.user_count || 0,
  };
}

/**
 * 查询用户排行（按资源消耗）
 * @param {string} metric cpu | memory | network
 * @param {string} range 时间范围
 * @param {number} limit 返回数量
 * @returns {Array} 用户排行
 */
export function getUserRanking(metric = 'cpu', range = '24h', limit = 10) {
  const ranges = {
    '1h': 3600,
    '24h': 86400,
    '7d': 604800,
    '30d': 2592000,
  };
  const seconds = ranges[range] || 86400;
  const since = new Date(Date.now() - seconds * 1000).toISOString();

  let aggregation;
  switch (metric) {
    case 'memory':
      aggregation = 'AVG(memory_mb)';
      break;
    case 'network':
      aggregation = 'SUM(network_rx_mb + network_tx_mb)';
      break;
    case 'cpu':
    default:
      aggregation = 'AVG(cpu_percent)';
  }

  return db
    .prepare(
      `SELECT
         u.username,
         rs.user_id,
         ${aggregation} as value,
         COUNT(DISTINCT rs.instance_id) as instance_count
       FROM resource_stats rs
       JOIN users u ON rs.user_id = u.id
       WHERE rs.collected_at >= ?
       GROUP BY rs.user_id
       ORDER BY value DESC
       LIMIT ?`
    )
    .all(since, limit);
}
