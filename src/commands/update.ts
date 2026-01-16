/**
 * update 命令 - 更新 tanmi-dock 版本
 */
import { Command } from 'commander';
import { spawn } from 'child_process';
import { info, success, error, blank } from '../utils/logger.js';

/**
 * 创建 update 命令
 */
export function createUpdateCommand(): Command {
  return new Command('update')
    .description('更新 tanmi-dock 到最新版本')
    .option('--beta', '更新到最新测试版本')
    .action(async (options) => {
      await updateSelf(options.beta);
    });
}

/**
 * 执行自更新
 */
async function updateSelf(beta: boolean): Promise<void> {
  const pkg = beta ? 'tanmi-dock@beta' : 'tanmi-dock@latest';
  const tag = beta ? 'beta' : 'latest';

  info(`正在更新到 ${tag} 版本...`);
  blank();

  return new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', pkg], {
      stdio: 'inherit',
      shell: true,
    });

    child.on('close', (code) => {
      blank();
      if (code === 0) {
        success(`更新完成！运行 td --version 查看当前版本`);
      } else {
        error(`更新失败 (exit code: ${code})`);
        process.exit(1);
      }
      resolve();
    });

    child.on('error', (err) => {
      blank();
      error(`更新失败: ${err.message}`);
      process.exit(1);
    });
  });
}
