#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'module';
import { createInitCommand } from './commands/init.js';
import { createLinkCommand } from './commands/link.js';
import { createStatusCommand } from './commands/status.js';
import { createProjectsCommand } from './commands/projects.js';
import { createCleanCommand } from './commands/clean.js';
import { createUnlinkCommand } from './commands/unlink.js';
import { createConfigCommand } from './commands/config.js';
import { createMigrateCommand } from './commands/migrate.js';
import { createDoctorCommand } from './commands/doctor.js';
import { createVerifyCommand } from './commands/verify.js';
import { createRepairCommand } from './commands/repair.js';
import { Transaction } from './core/transaction.js';

// 读取 package.json 版本
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

// 信号处理：优雅退出
let isShuttingDown = false;

async function gracefulShutdown(signal: string, exitCode: number): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[info] 收到 ${signal} 信号，正在清理...`);

  try {
    const pending = await Transaction.findPending();
    if (pending) {
      console.log('[info] 正在回滚未完成事务...');
      const errors = await pending.rollback();
      if (errors.length > 0) {
        console.error('[warn] 部分回滚失败:');
        errors.forEach((e) => console.error(`  - ${e}`));
      } else {
        console.log('[ok] 事务已回滚');
      }
    }
  } catch (err) {
    console.error('[err] 清理失败:', (err as Error).message);
  }

  process.exit(exitCode);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT', 130));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 143));

// 全局异常捕获
process.on('uncaughtException', (err) => {
  console.error('[err] 发生未预期错误:', err.message);
  if (process.env.DEBUG) {
    console.error(err.stack);
  }
  console.error('[hint] 如问题持续，请运行 tanmi-dock doctor 诊断');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[err] 未处理的 Promise 拒绝:', reason);
  if (process.env.DEBUG) {
    console.error(reason);
  }
  process.exit(1);
});

const program = new Command();

program
  .name('tanmi-dock')
  .description('集中型第三方库链接管理工具')
  .version(pkg.version)
  .option('-v, --verbose', '输出详细信息')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.optsWithGlobals();
    if (opts.verbose) {
      process.env.VERBOSE = '1';
    }
  });

// 注册命令
program.addCommand(createInitCommand());
program.addCommand(createLinkCommand());
program.addCommand(createStatusCommand());
program.addCommand(createProjectsCommand());
program.addCommand(createCleanCommand());
program.addCommand(createUnlinkCommand());
program.addCommand(createConfigCommand());
program.addCommand(createMigrateCommand());
program.addCommand(createDoctorCommand());
program.addCommand(createVerifyCommand());
program.addCommand(createRepairCommand());

program.parse();
