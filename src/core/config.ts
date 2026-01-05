/**
 * 全局配置管理
 * 配置文件位置: ~/.tanmi-dock/config.json
 */
import fs from 'fs/promises';
import { getConfigPath, getConfigDir, expandHome } from './platform.js';
import { withFileLock } from '../utils/lock.js';
import type { DockConfig, CleanStrategy } from '../types/index.js';
import { DEFAULT_CONFIG } from '../types/index.js';

/**
 * 获取默认配置
 */
export function getDefaultConfig(storePath: string): DockConfig {
  return {
    ...DEFAULT_CONFIG,
    initialized: true,
    storePath: expandHome(storePath),
  };
}

/**
 * 确保配置目录存在
 */
export async function ensureConfigDir(): Promise<void> {
  const dir = getConfigDir();
  await fs.mkdir(dir, { recursive: true });
}

/**
 * 加载配置
 * 文件不存在时返回 null
 */
export async function load(): Promise<DockConfig | null> {
  try {
    const configPath = getConfigPath();
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content) as DockConfig;
  } catch {
    return null;
  }
}

/**
 * 保存配置（带文件锁保护）
 */
export async function save(config: DockConfig): Promise<void> {
  await ensureConfigDir();
  const configPath = getConfigPath();
  await withFileLock(configPath, async () => {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  });
}

/**
 * 获取单个配置项
 */
export async function get<K extends keyof DockConfig>(key: K): Promise<DockConfig[K] | undefined> {
  const config = await load();
  return config?.[key];
}

/**
 * 设置单个配置项并保存（带文件锁保护读-改-写操作）
 */
export async function set<K extends keyof DockConfig>(key: K, value: DockConfig[K]): Promise<void> {
  await ensureConfigDir();
  const configPath = getConfigPath();
  await withFileLock(configPath, async () => {
    const content = await fs.readFile(configPath, 'utf-8').catch(() => null);
    if (!content) {
      throw new Error('配置文件不存在，请先运行 tanmi-dock init');
    }
    const config = JSON.parse(content) as DockConfig;
    config[key] = value;
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  });
}

/**
 * 获取 Store 路径
 */
export async function getStorePath(): Promise<string | undefined> {
  return get('storePath');
}

/**
 * 设置 Store 路径
 */
export async function setStorePath(path: string): Promise<void> {
  await set('storePath', expandHome(path));
}

/**
 * 验证配置项名称是否有效
 */
export function isValidConfigKey(key: string): key is keyof DockConfig {
  const validKeys: (keyof DockConfig)[] = [
    'version',
    'initialized',
    'storePath',
    'cleanStrategy',
    'maxStoreSize',
    'autoDownload',
  ];
  return validKeys.includes(key as keyof DockConfig);
}

/**
 * 验证 cleanStrategy 值是否有效
 */
export function isValidCleanStrategy(value: string): value is CleanStrategy {
  return ['unreferenced', 'lru', 'manual'].includes(value);
}

/**
 * 解析配置值
 */
export function parseConfigValue(
  key: keyof DockConfig,
  value: string
): DockConfig[keyof DockConfig] {
  switch (key) {
    case 'autoDownload':
    case 'initialized':
      return value === 'true';
    case 'maxStoreSize':
      return parseInt(value, 10);
    case 'cleanStrategy':
      if (!isValidCleanStrategy(value)) {
        throw new Error(`无效的 cleanStrategy 值: ${value}，有效值: unreferenced, lru, manual`);
      }
      return value;
    default:
      return value;
  }
}

export default {
  load,
  save,
  get,
  set,
  getDefaultConfig,
  ensureConfigDir,
  getStorePath,
  setStorePath,
  isValidConfigKey,
  isValidCleanStrategy,
  parseConfigValue,
};
