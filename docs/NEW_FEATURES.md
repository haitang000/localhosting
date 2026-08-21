# 新增功能文档

本次更新为 localhosting 面板添加了三个重要功能：资源使用报表、定时任务管理、实例迁移和导出。

## 1. 资源使用报表 📊

### 功能概述
- **自动采集**：每 5 分钟（可配置）自动采集运行中实例的资源使用数据
- **数据保留**：历史数据保留 30 天
- **多维度统计**：CPU、内存、网络流量、磁盘使用

### 使用方式

#### 用户端
- **查看自己的统计**：`GET /api/stats/user?range=24h`
  - 参数：`range` = `1h` | `24h` | `7d` | `30d`
  - 返回：平均/峰值 CPU、内存、总流量

- **查看单个实例统计**：`GET /api/stats/instance/:id?range=24h`
  - 返回：时间序列数据，可用于绘制图表

#### 管理员端
- **全局统计**：`GET /api/stats/global?range=24h`
  - 返回：全局资源使用情况、活跃实例数、用户数

- **用户排行**：`GET /api/stats/ranking?metric=cpu&range=24h&limit=10`
  - 参数：`metric` = `cpu` | `memory` | `network`
  - 返回：资源消耗排行榜

### 配置项
```env
# .env 中添加
STATS_COLLECT_SECONDS=300  # 采集间隔（秒），默认 300 秒
```

### 数据库表
```sql
CREATE TABLE resource_stats (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id   TEXT NOT NULL,
  user_id       INTEGER NOT NULL,
  cpu_percent   REAL,
  memory_mb     REAL,
  memory_percent REAL,
  network_rx_mb REAL,
  network_tx_mb REAL,
  disk_mb       REAL,
  collected_at  TEXT NOT NULL
);
```

---

## 2. 定时任务管理 ⏰

### 功能概述
- **四种任务类型**：启动、停止、重启、备份
- **标准 cron 语法**：灵活的时间配置
- **自动执行**：后台调度器每分钟检查一次

### 使用方式

#### 创建任务
```http
POST /api/stats/tasks
Content-Type: application/json

{
  "instanceId": "实例ID",
  "action": "start",  // start | stop | restart | backup
  "cron": "0 9 * * 1-5"  // 工作日上午9点
}
```

#### 查看任务
- **用户的所有任务**：`GET /api/stats/tasks`
- **实例的任务**：`GET /api/stats/tasks/instance/:id`

#### 更新任务
```http
PUT /api/stats/tasks/:id
Content-Type: application/json

{
  "cron": "0 18 * * *",  // 改成每天下午6点
  "status": "active"  // active | paused
}
```

#### 删除任务
```http
DELETE /api/stats/tasks/:id
```

### Cron 语法说明
格式：`分 时 日 月 周`

示例：
- `0 9 * * *` - 每天上午 9 点
- `0 9 * * 1-5` - 工作日上午 9 点
- `*/30 * * * *` - 每 30 分钟
- `0 0 * * 0` - 每周日午夜
- `0 2 1 * *` - 每月 1 号凌晨 2 点

### 任务类型说明
- **start**：启动已停止的实例
- **stop**：停止运行中的实例
- **restart**：重启运行中的实例
- **backup**：创建实例备份（包含配置和数据卷）

### 数据库表
```sql
CREATE TABLE scheduled_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  action      TEXT NOT NULL,
  cron        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  last_run_at TEXT,
  next_run_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

---

## 3. 实例迁移和导出 📦

### 功能概述
- **完整导出**：生成 docker-compose.yml + 数据卷打包（.tar.gz）
- **灵活导入**：从 docker-compose.yml 快速创建实例
- **备份管理**：手动备份 + 定时备份，自动过期清理

### 使用方式

#### 导出实例
```http
POST /api/stats/export/:instanceId
```

返回：
```json
{
  "success": true,
  "backup": {
    "id": "backup-uuid",
    "name": "myapp_2026-08-21T10-30-00",
    "sizeBytes": 12345678,
    "path": "/path/to/backup.tar.gz"
  }
}
```

导出内容包括：
- `docker-compose.yml` - 完整的容器配置
- `metadata.json` - 导出时间、面板版本等元数据
- `volumes/` - 数据卷内容（如果有）

#### 导入配置
```http
POST /api/stats/import
Content-Type: application/json

{
  "composeYaml": "version: '3.8'\nservices:\n  ...",
  "name": "新实例名称"
}
```

返回解析后的配置，可用于创建新实例：
```json
{
  "success": true,
  "instance": {
    "name": "新实例名称",
    "image": "nginx:latest",
    "memoryMb": 512,
    "cpus": 0.5,
    "ports": 2,
    "env": { ... },
    "volumePaths": ["/data"]
  }
}
```

#### 下载备份
```http
GET /api/stats/download/:backupId
```

直接下载 `.tar.gz` 文件。

#### 查看备份列表
- **用户的所有备份**：`GET /api/stats/backups`
- **实例的备份**：`GET /api/stats/backups/instance/:id`

#### 删除备份
```http
DELETE /api/stats/backups/:id
```

### docker-compose.yml 格式示例
```yaml
version: '3.8'

services:
  myapp:
    image: nginx:latest
    container_name: myapp
    restart: unless-stopped
    environment:
      - API_KEY=secret123
      - MODE=production
    ports:
      - "20001:80/tcp"
    volumes:
      - ./volumes/volume_0:/data
    mem_limit: 512m
    cpus: 0.5
```

### 备份类型
- **manual**：用户手动创建，永久保留（除非手动删除）
- **scheduled**：定时任务创建，30 天后自动过期删除

### 数据库表
```sql
CREATE TABLE backups (
  id          TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'manual',
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  file_path   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT
);
```

---

## API 路由总览

### 资源统计
- `GET /api/stats/instance/:id` - 实例统计
- `GET /api/stats/user` - 用户统计
- `GET /api/stats/global` - 全局统计（管理员）
- `GET /api/stats/ranking` - 用户排行（管理员）

### 定时任务
- `GET /api/stats/tasks` - 用户的所有任务
- `GET /api/stats/tasks/instance/:id` - 实例的任务
- `POST /api/stats/tasks` - 创建任务
- `PUT /api/stats/tasks/:id` - 更新任务
- `DELETE /api/stats/tasks/:id` - 删除任务

### 备份和导出
- `POST /api/stats/export/:instanceId` - 导出实例
- `POST /api/stats/import` - 导入配置
- `GET /api/stats/backups` - 备份列表
- `GET /api/stats/backups/instance/:id` - 实例的备份
- `GET /api/stats/download/:id` - 下载备份
- `DELETE /api/stats/backups/:id` - 删除备份

---

## 权限说明

### 资源统计
- 用户只能查看自己的统计数据
- 管理员可以查看全局统计和用户排行

### 定时任务
- 用户只能管理自己实例的任务
- 管理员可以管理所有任务

### 备份和导出
- 用户只能导出/备份自己的实例
- 管理员可以导出/备份所有实例
- 备份文件只能由创建者或管理员下载/删除

---

## 后台进程

新增以下后台进程：

1. **资源统计采集器**（stats-collector）
   - 每 5 分钟采集一次
   - 启动时：`await startupStep('stats-collector', () => statsCollector.start())`
   - 停止时：`statsCollector.stop()`

2. **定时任务调度器**（scheduler）
   - 每分钟检查一次待执行任务
   - 启动时：`await startupStep('scheduler', () => scheduler.start())`
   - 停止时：`scheduler.stop()`

3. **备份过期清理**
   - 每小时自动清理过期备份
   - 自动运行，无需手动启动

---

## 使用场景

### 场景 1：资源成本分析
管理员可以通过资源统计功能：
- 查看哪些用户消耗最多资源
- 分析不同时段的资源使用情况
- 为定价策略提供数据支持

### 场景 2：自动化运维
用户可以设置定时任务：
- 工作日自动启动开发环境
- 深夜自动停止节省资源
- 每周自动备份重要数据

### 场景 3：实例迁移
用户可以：
- 导出生产实例配置
- 在测试环境快速部署相同配置
- 备份关键实例以防意外

### 场景 4：灾难恢复
- 定期自动备份所有实例
- 出现问题时快速恢复
- 保留 30 天历史备份

---

## 注意事项

### 资源统计
- 仅采集运行中的实例
- 数据保留 30 天，之后自动删除
- 采集频率可调整，但不建议低于 30 秒

### 定时任务
- 任务执行时会检查实例状态
- 如果实例不存在或无容器，任务跳过
- 备份任务可能消耗较多磁盘空间

### 备份和导出
- 导出过程中实例仍可正常运行
- 大容量数据卷导出可能耗时较长
- 定时备份 30 天后自动删除
- 手动备份需手动删除

---

## 未来改进

可能的后续增强：
1. 前端图表展示（Echarts/Chart.js）
2. 导出/导入时的进度提示
3. 备份压缩率优化
4. 支持增量备份
5. 支持跨面板迁移
6. 定时任务执行历史记录
7. 资源使用告警（超过阈值通知）

---

## 故障排查

### 统计数据不更新
1. 检查 stats-collector 是否正常启动
2. 查看日志：`grep "stats.collect" server.log`
3. 确认实例处于 running 状态

### 定时任务不执行
1. 检查 scheduler 是否正常启动
2. 验证 cron 表达式：`GET /api/stats/tasks`
3. 查看 `next_run_at` 字段是否正确

### 导出失败
1. 确认实例存在且有容器
2. 检查磁盘空间是否充足
3. 查看 `data/backups/` 目录权限

---

## 依赖包

新增依赖：
```json
{
  "tar": "^7.x",     // tar 打包/解包
  "yaml": "^2.x"     // docker-compose.yml 解析
}
```

安装：
```bash
npm install tar yaml
```
