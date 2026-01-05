/**
 * 全局配置管理
 * 配置文件位置: ~/.tanmi-dock/config.json
 */
import fs from 'fs/promises';
import semver from 'semver';
import { getConfigPath, getConfigDir, expandHome } from './platform.js';
import { withFileLock } from '../utils/lock.js';
import type { DockConfig, CleanStrategy } from '../types/index.js';
import { DEFAULT_CONFIG, CURRENT_CONFIG_VERSION, MIN_SUPPORTED_VERSION } from '../types/index.js';

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
 * 配置版本状态
 */
export type ConfigVersionStatus = 'current' | 'migrate' | 'unsupported';

/**
 * 检查配置版本
 */
export function checkConfigVersion(config: DockConfig): ConfigVersionStatus {
  const version = config.version || '1.0.0';

  if (semver.eq(version, CURRENT_CONFIG_VERSION)) {
    return 'current'; // 版本一致
  }
  if (semver.lt(version, CURRENT_CONFIG_VERSION) && semver.gte(version, MIN_SUPPORTED_VERSION)) {
    return 'migrate'; // 需要迁移
  }
  if (semver.gt(version, CURRENT_CONFIG_VERSION)) {
    return 'unsupported'; // 配置版本高于程序，需升级程序
  }
  return 'unsupported';
}

/**
 * 加载配置
 * 文件不存在时返回 null
 * 版本不兼容时抛出错误
 */
export async function load(): Promise<DockConfig | null> {
  try {
    const configPath = getConfigPath();
    const content = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(content) as DockConfig;

    const versionStatus = checkConfigVersion(config);
    if (versionStatus === 'unsupported') {
      throw new Error(
        `配置版本 ${config.version} 高于程序支持版本 ${CURRENT_CONFIG_VERSION}，请升级 tanmi-dock`
      );
    }
    if (versionStatus === 'migrate') {
      return await migrateConfig(config);
    }
    return config;
  } catch (err) {
    if (err instanceof Error && err.message.includes('配置版本')) {
      throw err; // 重新抛出版本错误
    }
    return null;
  }
}

/**
 * 迁移函数类型
 */
type MigrationFn = (config: Record<string, unknown>) => Record<string, unknown>;

/**
 * 迁移函数映射: 从哪个版本迁移
 */
const migrations: Record<string, MigrationFn> = {
  '1.0.0': (config) => {
    // v1.0.0 → v1.1.0 的迁移逻辑
    return {
      ...config,
      version: '1.1.0',
      // 未来可在此添加新字段的默认值
    };
  },
};

/**
 * 迁移配置到最新版本
 * 逐版本迁移，出错时保留原配置
 */
async function migrateConfig(config: DockConfig): Promise<DockConfig> {
  const originalVersion = config.version || '1.0.0';
  let current = { ...config } as Record<string, unknown>;
  let version = originalVersion;

  try {
    // 逐版本迁移
    while (version !== CURRENT_CONFIG_VERSION) {
      const migrateFn = migrations[version];
      if (!migrateFn) {
        throw new Error(`无法从版本 ${version} 迁移，缺少迁移函数`);
      }

      console.log(`[info] 迁移配置: ${version} → ...`);
      current = migrateFn(current);
      version = current.version as string;
    }

    // 保存迁移后的配置
    const migrated = current as unknown as DockConfig;
    await save(migrated);
    console.log(`[ok] 配置已从 ${originalVersion} 迁移到 ${CURRENT_CONFIG_VERSION}`);

    return migrated;
  } catch (err) {
    console.error(`[err] 配置迁移失败: ${(err as Error).message}`);
    console.log('[info] 保留原配置不覆盖');
    return config;
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
