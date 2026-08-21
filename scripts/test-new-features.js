/**
 * 测试新功能的脚本
 * 运行：node scripts/test-new-features.js
 */

import { db } from '../src/db.js';
import * as statsCollector from '../src/stats-collector.js';
import * as scheduler from '../src/scheduler.js';

console.log('🧪 测试新功能...\n');

// 1. 测试数据库表是否创建成功
console.log('1️⃣ 检查数据库表...');
try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const tableNames = tables.map(t => t.name);

  const requiredTables = ['resource_stats', 'scheduled_tasks', 'backups'];
  const missing = requiredTables.filter(t => !tableNames.includes(t));

  if (missing.length === 0) {
    console.log('   ✅ 所有必需的表都已创建');
    console.log('   📋 表列表:', requiredTables.join(', '));
  } else {
    console.log('   ❌ 缺少表:', missing.join(', '));
  }
} catch (err) {
  console.log('   ❌ 错误:', err.message);
}

console.log('');

// 2. 测试 cron 表达式验证
console.log('2️⃣ 测试 cron 表达式验证...');
const testCrons = [
  { cron: '0 9 * * *', expected: true, desc: '每天上午9点' },
  { cron: '*/30 * * * *', expected: true, desc: '每30分钟' },
  { cron: '0 9 * * 1-5', expected: true, desc: '工作日上午9点' },
  { cron: 'invalid', expected: false, desc: '无效格式' },
  { cron: '0 25 * * *', expected: false, desc: '无效小时（25）' },
];

for (const test of testCrons) {
  const result = scheduler.validateCron(test.cron);
  const status = result.valid === test.expected ? '✅' : '❌';
  console.log(`   ${status} "${test.cron}" (${test.desc})`);
  if (!result.valid) {
    console.log(`      错误: ${result.error}`);
  }
}

console.log('');

// 3. 测试资源统计功能
console.log('3️⃣ 测试资源统计功能...');
try {
  // 查询全局统计（应该返回空数据，因为还没有采集）
  const globalStats = statsCollector.getGlobalStats('24h');
  console.log('   ✅ 全局统计查询成功');
  console.log('   📊 活跃实例数:', globalStats.instanceCount);
  console.log('   📊 活跃用户数:', globalStats.userCount);
  console.log('   📊 平均 CPU:', globalStats.avgCpu.toFixed(2), '%');
  console.log('   📊 平均内存:', globalStats.avgMemory.toFixed(2), 'MB');
} catch (err) {
  console.log('   ❌ 错误:', err.message);
}

console.log('');

// 4. 检查索引
console.log('4️⃣ 检查数据库索引...');
try {
  const indexes = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all();
  const newIndexes = indexes.filter(idx =>
    idx.name.includes('resource_stats') ||
    idx.name.includes('scheduled_tasks') ||
    idx.name.includes('backups')
  );

  if (newIndexes.length > 0) {
    console.log('   ✅ 找到', newIndexes.length, '个新索引');
    for (const idx of newIndexes) {
      console.log(`      - ${idx.name} (表: ${idx.tbl_name})`);
    }
  } else {
    console.log('   ⚠️  未找到新索引（可能需要重启服务器）');
  }
} catch (err) {
  console.log('   ❌ 错误:', err.message);
}

console.log('');

// 5. 检查配置
console.log('5️⃣ 检查配置项...');
try {
  const { config } = await import('../src/config.js');
  console.log('   ✅ 统计采集间隔:', config.statsCollectSeconds, '秒');
} catch (err) {
  console.log('   ❌ 错误:', err.message);
}

console.log('');
console.log('🎉 测试完成！');
console.log('');
console.log('📝 下一步：');
console.log('   1. 启动面板：npm run dev');
console.log('   2. 登录管理后台');
console.log('   3. 测试 API 端点：');
console.log('      - GET /api/stats/global');
console.log('      - GET /api/stats/user');
console.log('      - POST /api/stats/tasks');
console.log('      - POST /api/stats/export/:instanceId');
