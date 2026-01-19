/**
 * init 命令 - 首次初始化配置
 */
import fs from 'fs/promises';
import { Command } from 'commander';
import { isInitialized, getInitStatus } from '../core/guard.js';
import * as config from '../core/config.js';
import { ensureConfigDir } from '../core/config.js';
import { getDiskInfo, formatSize, getDefaultStorePaths } from '../utils/disk.js';
import { expandHome, getConfigPath, shrinkHome, isPathSafe } from '../core/platform.js';
import { info, success, warn, error, hint, title, blank, separator } from '../utils/logger.js';
import { EMPTY_REGISTRY } from '../types/index.js';
import { getRegistryPath } from '../core/platform.js';
import { selectOption, inputText, confirmAction, PROMPT_CANCELLED } from '../utils/prompt.js';

/**
 * 创建 init 命令
 */
export function createInitCommand(): Command {
  return new Command('init')
    .description('初始化 TanmiDock')
    .option('--store-path <path>', '直接指定存储路径（跳过交互）')
    .option('-y, --yes', '使用默认设置')
    .action(async (options) => {
      await initializeDock(options);
    });
}

interface InitOptions {
  storePath?: string;
  yes: boolean;
}

/**
 * 初始化
 */
export async function initializeDock(options: InitOptions): Promise<void> {
  // 检查是否已初始化
  if (await isInitialized()) {
    const status = await getInitStatus();
    warn('TanmiDock 已初始化');
    info(`Store 路径: ${shrinkHome(status.storePath || '')}`);
    hint('使用 tanmi-dock config 查看或修改配置');
    return;
  }

  title('TanmiDock 初始化');
  blank();

  let storePath: string;

  if (options.storePath) {
    // 直接使用指定路径
    storePath = expandHome(options.storePath);
  } else if (options.yes) {
    // 使用默认路径
    const suggestions = await getDefaultStorePaths();
    storePath = suggestions[0].path;
    info(`使用默认路径: ${shrinkHome(storePath)}`);
  } else {
    // 交互式选择
    const selected = await selectStorePath();
    // ESC 取消
    if (selected === PROMPT_CANCELLED) {
      info('已取消');
      return;
    }
    storePath = selected;
  }

  // 验证路径
  await validateStorePath(storePath);

  // 创建目录
  try {
    await fs.mkdir(storePath, { recursive: true });
    success(`目录已创建: ${shrinkHome(storePath)}`);
  } catch (err) {
    error(`无法创建目录: ${(err as Error).message}`);
    process.exit(1);
  }

  // 创建配置
  await ensureConfigDir();

  const cfg = config.getDefaultConfig(storePath);
  await config.save(cfg);
  success(`配置已保存: ${shrinkHome(getConfigPath())}`);

  // 创建空注册表
  const registryPath = getRegistryPath();
  await fs.writeFile(registryPath, JSON.stringify(EMPTY_REGISTRY, null, 2), 'utf-8');

  blank();
  separator();
  success('初始化完成');
  hint('运行 tanmi-dock link . 开始使用');
}

/**
 * 交互式选择存储路径
 */
async function selectStorePath(): Promise<string | typeof PROMPT_CANCELLED> {
  // 显示磁盘信息
  info('磁盘空间:');
  const disks = await getDiskInfo();

  for (const disk of disks) {
    const freeStr = formatSize(disk.free);
    const label = disk.label || disk.path;
    const sysNote = disk.isSystem ? ' (系统盘)' : '';
    const warnNote = disk.free < 10 * 1024 * 1024 * 1024 ? ' * 空间较小' : '';
    info(`  ${label}${sysNote}: ${freeStr} 可用${warnNote}`);
  }

  blank();

  // 构建选项
  const suggestions = await getDefaultStorePaths();
  const choices = suggestions.map((s) => ({
    name: `${shrinkHome(s.path)} (${formatSize(s.free)} 可用)${s.recommended ? ' (推荐)' : ''}`,
    value: s.path,
    description: s.free < 10 * 1024 * 1024 * 1024 ? '⚠️ 空间较小' : undefined,
  }));
  choices.push({ name: '自定义路径...', value: '__custom__', description: undefined });

  // 使用循环代替递归，避免栈增长
  while (true) {
    const selected = await selectOption('选择存储位置:', choices);

    // ESC 取消
    if (selected === PROMPT_CANCELLED) {
      return PROMPT_CANCELLED;
    }

    if (selected === '__custom__') {
      const customPath = await inputText('输入存储路径:', '~/.tanmi-dock/store', (v) => {
        const expanded = expandHome(v);
        const check = isPathSafe(expanded);
        return check.safe || check.reason || '路径无效';
      });
      // ESC 取消 - 返回重新选择
      if (customPath === PROMPT_CANCELLED) {
        info('已取消，重新选择...');
        continue;
      }
      return customPath;
    }

    // 确认选择
    const confirmed = await confirmAction(`确认使用路径 '${shrinkHome(selected)}'?`, true);
    // ESC 取消或确认 No - 继续循环重新选择
    if (confirmed === PROMPT_CANCELLED || !confirmed) {
      info('已取消，重新选择...');
      continue;
    }

    return selected;
  }
}

/**
 * 验证存储路径
 */
async function validateStorePath(storePath: string): Promise<void> {
  // 安全检查
  const safetyResult = isPathSafe(storePath);
  if (!safetyResult.safe) {
    error(`路径不安全: ${safetyResult.reason}`);
    process.exit(1);
  }

  try {
    const stat = await fs.stat(storePath);

    if (!stat.isDirectory()) {
      error(`路径不是目录: ${storePath}`);
      process.exit(1);
    }

    // 检查是否为空或已有 TanmiDock 数据
    const entries = await fs.readdir(storePath);

    if (entries.length > 0) {
      // 检查是否是已有的 TanmiDock store
      // 如果包含库目录结构则允许
      warn(`目录非空: ${shrinkHome(storePath)}`);
      hint('将使用此目录作为 Store');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // 目录不存在，将创建
      return;
    }
    throw err;
  }
}

export default createInitCommand;
