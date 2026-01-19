#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'module';
import { createInitCommand } from './commands/init.js';
import { createLinkCommand } from './commands/link.js';
import { createStatusCommand } from './commands/status.js';
import { createCleanCommand } from './commands/clean.js';
import { createUnlinkCommand } from './commands/unlink.js';
import { createConfigCommand } from './commands/config.js';
import { createMigrateCommand } from './commands/migrate.js';
import { createCheckCommand } from './commands/check.js';
import { createUpdateCommand } from './commands/update.js';
import { showDashboard } from './commands/dashboard.js';
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
  console.error('[hint] 如问题持续，请运行 tanmi-dock check 诊断');
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
  .version(pkg.version, '-V, --version', '显示版本号')
  .option('-v, --verbose', '输出详细信息')
  .helpOption('-h, --help', '显示帮助信息')
  .addHelpCommand('help [command]', '显示命令帮助')
  .addHelpText(
    'after',
    `
快速上手:
  td init                 首次使用，初始化配置
  td link                 链接当前项目的依赖
  td link -p mac android  只链接指定平台
  td status               查看链接状态
  td config               交互式修改配置

别名: td = tanmi-dock`
  )
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
program.addCommand(createCleanCommand());
program.addCommand(createUnlinkCommand());
program.addCommand(createConfigCommand());
program.addCommand(createMigrateCommand());
program.addCommand(createCheckCommand());
program.addCommand(createUpdateCommand());

// 无参数时显示工作台
if (process.argv.length === 2) {
  showDashboard().catch((err) => {
    console.error('[err]', err.message);
    process.exit(1);
  });
} else {
  program.parse();
}
