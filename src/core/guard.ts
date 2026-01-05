/**
 * 初始化状态检查
 * 未初始化时阻止其他命令执行
 */
import fs from 'fs/promises';
import { getConfigPath, getConfigDir } from './platform.js';
import { error, hint } from '../utils/logger.js';
import type { DockConfig, InitStatus } from '../types/index.js';

/**
 * 检查是否已初始化
 */
export async function isInitialized(): Promise<boolean> {
  try {
    const configPath = getConfigPath();
    const content = await fs.readFile(configPath, 'utf-8');
    const config: DockConfig = JSON.parse(content);
    return config.initialized === true;
  } catch {
    return false;
  }
}

/**
 * 确保已初始化，否则输出错误并退出
 */
export async function ensureInitialized(): Promise<void> {
  const initialized = await isInitialized();
  if (!initialized) {
    error('TanmiDock 尚未初始化');
    hint('请先运行: tanmi-dock init');
    process.exit(1);
  }
}

/**
 * 获取详细的初始化状态
 */
export async function getInitStatus(): Promise<InitStatus> {
  const configPath = getConfigPath();

  let configExists = false;
  let initialized = false;
  let storePathExists = false;
  let storePath: string | undefined;

  try {
    await fs.access(configPath);
    configExists = true;

    const content = await fs.readFile(configPath, 'utf-8');
    const config: DockConfig = JSON.parse(content);
    initialized = config.initialized === true;
    storePath = config.storePath;

    if (storePath) {
      try {
        await fs.access(storePath);
        storePathExists = true;
      } catch {
        storePathExists = false;
      }
    }
  } catch {
    // config file doesn't exist
  }

  return {
    initialized,
    configExists,
    storePathExists,
    storePath,
  };
}

/**
 * 检查配置目录是否存在
 */
export async function configDirExists(): Promise<boolean> {
  try {
    await fs.access(getConfigDir());
    return true;
  } catch {
    return false;
  }
}
