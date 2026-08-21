import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { db, now, audit } from './db.js';
import * as dk from './docker.js';
import { config } from './config.js';
import { logger } from './logger.js';

const BACKUP_DIR = path.join(config.dataDir, 'backups');

// 确保备份目录存在
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * 生成 docker-compose.yml 内容
 * @param {Object} instance 实例信息
 * @returns {string} docker-compose.yml 内容
 */
function generateDockerCompose(instance) {
  const env = JSON.parse(instance.env_json || '{}');
  const ports = JSON.parse(instance.ports_json || '[]');
  const volumePaths = JSON.parse(instance.volume_paths_json || '[]');
  const cmd = JSON.parse(instance.cmd_json || 'null');

  // 环境变量部分
  const envLines = Object.entries(env)
    .map(([key, value]) => `      - ${key}=${value}`)
    .join('\n');

  // 端口映射部分
  const portLines = ports
    .map((p) => `      - "${p.host}:${p.container}/${p.protocol}"`)
    .join('\n');

  // 数据卷部分
  const volumeLines = volumePaths
    .map((vp, idx) => `      - ./volumes/volume_${idx}:${vp}`)
    .join('\n');

  // 命令部分
  const cmdLine = cmd ? `    command: ${JSON.stringify(cmd)}` : '';

  const compose = `version: '3.8'

services:
  ${instance.name}:
    image: ${instance.image}
    container_name: ${instance.name}
    restart: unless-stopped
${envLines ? `    environment:\n${envLines}` : ''}
${portLines ? `    ports:\n${portLines}` : ''}
${volumeLines ? `    volumes:\n${volumeLines}` : ''}
    mem_limit: ${instance.memory_mb}m
    cpus: ${instance.cpus}
${cmdLine}
`;

  return compose;
}

/**
 * 导出实例配置和数据
 * @param {string} instanceId 实例 ID
 * @param {number} userId 用户 ID
 * @param {string} type 备份类型：manual | scheduled
 * @returns {Promise<Object>} 备份信息
 */
export async function exportInstance(instanceId, userId, type = 'manual') {
  logger.info('backup.export.start', { instanceId, userId, type });

  // 获取实例信息
  const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(instanceId);
  if (!instance) {
    throw new Error('实例不存在');
  }

  if (instance.user_id !== userId) {
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (!user || user.role !== 'admin') {
      throw new Error('无权导出此实例');
    }
  }

  const backupId = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const backupName = `${instance.name}_${timestamp}`;
  const backupPath = path.join(BACKUP_DIR, `${backupId}.tar.gz`);

  // 创建临时目录
  const tempDir = path.join(BACKUP_DIR, `temp_${backupId}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 1. 生成 docker-compose.yml
    const composeContent = generateDockerCompose(instance);
    fs.writeFileSync(path.join(tempDir, 'docker-compose.yml'), composeContent, 'utf8');

    // 2. 生成元数据文件
    const metadata = {
      exportedAt: now(),
      panelVersion: '1.0.0',
      instance: {
        name: instance.name,
        image: instance.image,
        templateId: instance.template_id,
        memoryMb: instance.memory_mb,
        cpus: instance.cpus,
        createdAt: instance.created_at,
      },
    };
    fs.writeFileSync(path.join(tempDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

    // 3. 导出数据卷（如果容器存在）
    let totalSize = 0;
    if (instance.container_id && instance.volume_name) {
      try {
        const container = dk.docker.getContainer(instance.container_id);
        const volumePaths = JSON.parse(instance.volume_paths_json || '[]');

        const volumesDir = path.join(tempDir, 'volumes');
        fs.mkdirSync(volumesDir, { recursive: true });

        // 对每个挂载点导出数据
        for (let i = 0; i < volumePaths.length; i++) {
          const volumePath = volumePaths[i];
          logger.debug('backup.export.volume', { instanceId, volumePath });

          // 使用 docker cp 导出数据卷内容
          const volumeTarPath = path.join(volumesDir, `volume_${i}.tar`);
          const stream = await container.getArchive({ path: volumePath });
          const writeStream = fs.createWriteStream(volumeTarPath);

          await pipeline(stream, writeStream);

          const stats = fs.statSync(volumeTarPath);
          totalSize += stats.size;
        }
      } catch (err) {
        logger.warn('backup.export.volume.failed', { instanceId, error: err.message });
        // 数据卷导出失败不影响配置导出
      }
    }

    // 4. 打包成 tar.gz
    logger.debug('backup.export.compress', { instanceId, tempDir, backupPath });

    // tar@7 exposes its API as named ESM exports (there is no default export).
    const tar = await import('tar');
    await tar.c(
      {
        gzip: true,
        file: backupPath,
        cwd: tempDir,
      },
      ['.']
    );

    const backupStats = fs.statSync(backupPath);
    totalSize = backupStats.size;

    // 5. 记录到数据库
    const expiresAt = type === 'scheduled' ? new Date(Date.now() + 30 * 86400000).toISOString() : null;

    db.prepare(
      `INSERT INTO backups (id, instance_id, user_id, name, type, size_bytes, file_path, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(backupId, instanceId, userId, backupName, type, totalSize, backupPath, now(), expiresAt);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    audit(user, 'instance.export', instanceId, `导出实例: ${backupName}`);

    logger.info('backup.export.complete', { instanceId, backupId, sizeBytes: totalSize });

    return {
      id: backupId,
      name: backupName,
      sizeBytes: totalSize,
      path: backupPath,
    };
  } finally {
    // 清理临时目录
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * 导入实例（从备份恢复或从 docker-compose.yml 导入）
 * @param {number} userId 用户 ID
 * @param {string} composeYaml docker-compose.yml 内容
 * @param {Object} options 导入选项
 * @returns {Promise<Object>} 导入结果
 */
export async function importInstance(userId, composeYaml, options = {}) {
  logger.info('backup.import.start', { userId });

  // 解析 docker-compose.yml
  const { default: yaml } = await import('yaml');
  const compose = yaml.parse(composeYaml);

  if (!compose.services) {
    throw new Error('无效的 docker-compose.yml：缺少 services 部分');
  }

  const serviceName = Object.keys(compose.services)[0];
  const service = compose.services[serviceName];

  if (!service.image) {
    throw new Error('无效的 docker-compose.yml：缺少镜像配置');
  }

  // 提取配置
  const instanceName = options.name || serviceName;
  const image = service.image;
  const memoryMb = service.mem_limit ? parseInt(service.mem_limit) : 512;
  const cpus = service.cpus || 0.5;

  // 提取环境变量
  const env = {};
  if (service.environment) {
    if (Array.isArray(service.environment)) {
      for (const item of service.environment) {
        const [key, ...valueParts] = item.split('=');
        env[key] = valueParts.join('=');
      }
    } else {
      Object.assign(env, service.environment);
    }
  }

  // 提取端口映射
  const ports = [];
  if (service.ports) {
    for (const portMapping of service.ports) {
      const match = String(portMapping).match(/^(\d+):(\d+)(?:\/(tcp|udp))?$/);
      if (match) {
        ports.push({
          host: parseInt(match[1]),
          container: parseInt(match[2]),
          protocol: match[3] || 'tcp',
        });
      }
    }
  }

  // 提取数据卷路径
  const volumePaths = [];
  if (service.volumes) {
    for (const volume of service.volumes) {
      const parts = String(volume).split(':');
      if (parts.length >= 2) {
        volumePaths.push(parts[1]);
      }
    }
  }

  const result = {
    name: instanceName,
    image,
    memoryMb,
    cpus,
    ports: ports.length,
    env,
    volumePaths,
    portsJson: JSON.stringify(ports),
    volumePathsJson: JSON.stringify(volumePaths),
  };

  logger.info('backup.import.parsed', { userId, result });

  return result;
}

/**
 * 下载备份文件
 * @param {string} backupId 备份 ID
 * @param {number} userId 用户 ID
 * @returns {Object} 文件信息
 */
export function downloadBackup(backupId, userId) {
  const backup = db.prepare('SELECT * FROM backups WHERE id = ?').get(backupId);
  if (!backup) {
    throw new Error('备份不存在');
  }

  if (backup.user_id !== userId) {
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (!user || user.role !== 'admin') {
      throw new Error('无权下载此备份');
    }
  }

  if (!fs.existsSync(backup.file_path)) {
    throw new Error('备份文件不存在');
  }

  return {
    path: backup.file_path,
    name: `${backup.name}.tar.gz`,
    size: backup.size_bytes,
  };
}

/**
 * 删除备份
 * @param {string} backupId 备份 ID
 * @param {number} userId 用户 ID
 */
export function deleteBackup(backupId, userId) {
  const backup = db.prepare('SELECT * FROM backups WHERE id = ?').get(backupId);
  if (!backup) {
    throw new Error('备份不存在');
  }

  if (backup.user_id !== userId) {
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (!user || user.role !== 'admin') {
      throw new Error('无权删除此备份');
    }
  }

  // 删除文件
  if (fs.existsSync(backup.file_path)) {
    fs.unlinkSync(backup.file_path);
  }

  // 删除数据库记录
  db.prepare('DELETE FROM backups WHERE id = ?').run(backupId);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  audit(user, 'backup.delete', backupId, `删除备份: ${backup.name}`);

  logger.info('backup.deleted', { backupId, userId });
}

/**
 * 获取用户的备份列表
 * @param {number} userId 用户 ID
 * @returns {Array} 备份列表
 */
export function getUserBackups(userId) {
  return db
    .prepare(
      `SELECT b.*, i.name as instance_name
       FROM backups b
       LEFT JOIN instances i ON b.instance_id = i.id
       WHERE b.user_id = ?
       ORDER BY b.created_at DESC`
    )
    .all(userId);
}

/**
 * 获取实例的备份列表
 * @param {string} instanceId 实例 ID
 * @returns {Array} 备份列表
 */
export function getInstanceBackups(instanceId) {
  return db.prepare('SELECT * FROM backups WHERE instance_id = ? ORDER BY created_at DESC').all(instanceId);
}

/**
 * 清理过期备份
 */
export function cleanupExpiredBackups() {
  const expired = db.prepare('SELECT * FROM backups WHERE expires_at IS NOT NULL AND expires_at < ?').all(now());

  for (const backup of expired) {
    try {
      if (fs.existsSync(backup.file_path)) {
        fs.unlinkSync(backup.file_path);
      }
      db.prepare('DELETE FROM backups WHERE id = ?').run(backup.id);
      logger.info('backup.cleanup.expired', { backupId: backup.id });
    } catch (err) {
      logger.error('backup.cleanup.failed', { backupId: backup.id, error: err });
    }
  }
}

// 定期清理过期备份（每小时）
setInterval(cleanupExpiredBackups, 3600000);
