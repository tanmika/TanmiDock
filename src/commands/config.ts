/**
 * config 命令 - 查看/修改配置
 */
import { Command } from 'commander';
import { ensureInitialized } from '../core/guard.js';
import * as config from '../core/config.js';
import { shrinkHome } from '../core/platform.js';
import { info, error, success, title, blank } from '../utils/logger.js';

/**
 * 创建 config 命令
 */
export function createConfigCommand(): Command {
  const cmd = new Command('config')
    .description('查看或修改配置');

  // 默认显示所有配置
  cmd.action(async () => {
    await ensureInitialized();
    await showConfig();
  });

  // get 子命令
  cmd
    .command('get <key>')
    .description('获取配置项的值')
    .action(async (key: string) => {
      await ensureInitialized();
      await getConfigValue(key);
    });

  // set 子命令
  cmd
    .command('set <key> <value>')
    .description('设置配置项的值')
    .action(async (key: string, value: string) => {
      await ensureInitialized();
      await setConfigValue(key, value);
    });

  return cmd;
}

/**
 * 显示所有配置
 */
async function showConfig(): Promise<void> {
  const cfg = await config.load();

  if (!cfg) {
    error('配置文件不存在');
    process.exit(1);
  }

  title('TanmiDock 配置:');
  blank();
  info(`  version: ${cfg.version}`);
  info(`  storePath: ${shrinkHome(cfg.storePath)}`);
  info(`  cleanStrategy: ${cfg.cleanStrategy}`);
  info(`  autoDownload: ${cfg.autoDownload}`);

  if (cfg.maxStoreSize) {
    info(`  maxStoreSize: ${cfg.maxStoreSize}`);
  }

  blank();
  const { getConfigPath } = await import('../core/platform.js');
  info(`配置文件: ${shrinkHome(getConfigPath())}`);
}

/**
 * 获取配置项
 */
async function getConfigValue(key: string): Promise<void> {
  if (!config.isValidConfigKey(key)) {
    error(`无效的配置项: ${key}`);
    info('有效的配置项: version, storePath, cleanStrategy, maxStoreSize, autoDownload');
    process.exit(1);
  }

  const value = await config.get(key as keyof import('../types/index.js').DockConfig);

  if (value === undefined) {
    error(`配置项 ${key} 未设置`);
    process.exit(1);
  }

  if (key === 'storePath' && typeof value === 'string') {
    info(shrinkHome(value));
  } else {
    info(String(value));
  }
}

/**
 * 设置配置项
 */
async function setConfigValue(key: string, value: string): Promise<void> {
  if (!config.isValidConfigKey(key)) {
    error(`无效的配置项: ${key}`);
    info('有效的配置项: version, storePath, cleanStrategy, maxStoreSize, autoDownload');
    process.exit(1);
  }

  // 只读配置项
  if (key === 'version' || key === 'initialized') {
    error(`配置项 ${key} 为只读`);
    process.exit(1);
  }

  try {
    const parsedValue = config.parseConfigValue(
      key as keyof import('../types/index.js').DockConfig,
      value
    );
    await config.set(
      key as keyof import('../types/index.js').DockConfig,
      parsedValue as never
    );
    success(`配置已更新: ${key} = ${value}`);
  } catch (err) {
    error((err as Error).message);
    process.exit(1);
  }
}

export default createConfigCommand;
