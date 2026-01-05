/**
 * clean 命令 - 清理无引用库
 */
import { Command } from 'commander';
import { ensureInitialized } from '../core/guard.js';
import { getRegistry } from '../core/registry.js';
import * as store from '../core/store.js';
import { formatSize } from '../utils/disk.js';
import { info, warn, success, hint, blank, separator, title } from '../utils/logger.js';

/**
 * 创建 clean 命令
 */
export function createCleanCommand(): Command {
  return new Command('clean')
    .description('清理无引用的库')
    .option('--dry-run', '只显示将要清理的内容')
    .option('--force', '跳过确认')
    .action(async (options) => {
      await ensureInitialized();
      await cleanLibraries(options);
    });
}

interface CleanOptions {
  dryRun: boolean;
  force: boolean;
}

/**
 * 清理库
 */
async function cleanLibraries(options: CleanOptions): Promise<void> {
  const registry = getRegistry();
  await registry.load();

  // 先清理无效项目
  info('扫描 Store...');
  const staleHashes = await registry.cleanStaleProjects();

  if (staleHashes.length > 0) {
    info(`清理了 ${staleHashes.length} 个无效项目引用`);
  }

  // 获取无引用的库
  const unreferenced = registry.getUnreferencedLibraries();

  if (unreferenced.length === 0) {
    success('没有需要清理的库');
    return;
  }

  // 计算总大小
  let totalSize = 0;
  for (const lib of unreferenced) {
    totalSize += lib.size;
  }

  blank();
  title(`将清理 (unreferenced 策略):`);

  for (const lib of unreferenced) {
    info(`  - ${lib.libName}/${lib.commit.slice(0, 7)} (${formatSize(lib.size)}) - 无项目引用`);
  }

  blank();
  info(`总计释放: ${formatSize(totalSize)}`);

  if (options.dryRun) {
    blank();
    hint('运行 tanmi-dock clean 执行清理');
    return;
  }

  if (!options.force) {
    // TODO: 交互式确认
    blank();
    warn('使用 --force 选项跳过确认');
    return;
  }

  // 执行清理
  blank();
  separator();
  info('正在清理...');

  let cleaned = 0;
  let freedSize = 0;

  for (const lib of unreferenced) {
    try {
      await store.remove(lib.libName, lib.commit);
      const libKey = registry.getLibraryKey(lib.libName, lib.commit);
      registry.removeLibrary(libKey);
      freedSize += lib.size;
      cleaned++;
    } catch (err) {
      warn(`清理 ${lib.libName} 失败: ${(err as Error).message}`);
    }
  }

  await registry.save();

  blank();
  success(`清理完成: 删除 ${cleaned} 个库，释放 ${formatSize(freedSize)}`);
}

export default createCleanCommand;
