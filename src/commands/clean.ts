/**
 * clean 命令 - 清理无引用库
 */
import { Command } from 'commander';
import { ensureInitialized } from '../core/guard.js';
import { getRegistry } from '../core/registry.js';
import * as store from '../core/store.js';
import * as config from '../core/config.js';
import { formatSize } from '../utils/disk.js';
import { info, warn, success, hint, blank, separator, title, error } from '../utils/logger.js';
import { withGlobalLock } from '../utils/global-lock.js';
import { confirmAction, checkboxSelect } from '../utils/prompt.js';
import type { LibraryInfo, StoreEntry } from '../types/index.js';

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
      try {
        await withGlobalLock(() => cleanLibraries(options));
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
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

  // 获取清理策略配置
  const cleanStrategy = await config.get('cleanStrategy');
  const unusedDays = (await config.get('unusedDays')) ?? 30;

  // 先清理无效项目
  info('扫描 Store...');
  const staleHashes = await registry.cleanStaleProjects();

  if (staleHashes.length > 0) {
    info(`清理了 ${staleHashes.length} 个无效项目记录`);
  }

  // 清理失效的 Store 引用
  const staleRefs = await registry.cleanStaleReferences();
  if (staleRefs > 0) {
    info(`清理了 ${staleRefs} 个失效引用`);
  }

  // 根据策略获取待清理列表
  let toCleanLibs: LibraryInfo[] = [];
  let toCleanStores: StoreEntry[] = [];
  let strategyName: string;

  if (cleanStrategy === 'unused') {
    // unused 策略：基于 StoreEntry 和 unlinkedAt
    toCleanStores = registry.getUnusedStores(unusedDays);
    strategyName = `unused (超过 ${unusedDays} 天)`;

    // 显示待清理的库
    const pending = registry.getPendingUnusedStores(unusedDays);
    if (pending.length > 0) {
      blank();
      info(`无引用但尚未达到清理条件的库 (${pending.length} 个):`);
      for (const { entry, daysLeft } of pending) {
        hint(`  - ${entry.libName}/${entry.commit.slice(0, 7)}/${entry.platform} - 还剩 ${daysLeft} 天`);
      }
    }
  } else if (cleanStrategy === 'manual') {
    // manual 策略：交互式选择要清理的库
    const allStores = registry.listStores();

    if (allStores.length === 0) {
      success('Store 为空');
      return;
    }

    // 构建选项列表
    const choices = allStores.map((entry) => {
      const key = registry.getStoreKey(entry.libName, entry.commit, entry.platform);
      const status =
        entry.usedBy.length === 0
          ? '(无引用)'
          : `(被 ${entry.usedBy.length} 个项目使用)`;
      const size = formatSize(entry.size);

      return {
        name: `${entry.libName}/${entry.commit.slice(0, 7)}/${entry.platform} ${size} ${status}`,
        value: key,
        checked: entry.usedBy.length === 0, // 无引用的默认勾选
      };
    });

    blank();
    const selected = await checkboxSelect('选择要清理的库:', choices);

    if (selected.length === 0) {
      info('未选择任何库');
      return;
    }

    // 警告有引用的库
    const withRefs = selected.filter((key) => {
      const entry = registry.getStore(key);
      return entry && entry.usedBy.length > 0;
    });

    if (withRefs.length > 0) {
      blank();
      warn(`注意: ${withRefs.length} 个库仍被项目引用，删除后链接将失效`);
      const confirmed = await confirmAction('确定继续?', false);
      if (!confirmed) {
        info('已取消清理');
        return;
      }
    }

    // 将选中的转为 StoreEntry
    for (const key of selected) {
      const entry = registry.getStore(key);
      if (entry) {
        toCleanStores.push(entry);
      }
    }
    strategyName = 'manual';
  } else {
    // unreferenced 策略（默认）：基于 LibraryInfo
    toCleanLibs = registry.getUnreferencedLibraries();
    strategyName = 'unreferenced';
  }

  // 检查是否有需要清理的内容
  if (toCleanLibs.length === 0 && toCleanStores.length === 0) {
    success('没有需要清理的库');
    return;
  }

  // 计算总大小
  let totalSize = 0;
  if (toCleanStores.length > 0) {
    for (const entry of toCleanStores) {
      totalSize += entry.size;
    }
  } else {
    for (const lib of toCleanLibs) {
      totalSize += lib.size;
    }
  }

  blank();
  title(`将清理 (${strategyName} 策略):`);

  if (toCleanStores.length > 0) {
    for (const entry of toCleanStores) {
      const daysAgo = entry.unlinkedAt
        ? Math.floor((Date.now() - entry.unlinkedAt) / 86400000)
        : 0;
      info(`  - ${entry.libName}/${entry.commit.slice(0, 7)}/${entry.platform} (${formatSize(entry.size)}) - 无引用 ${daysAgo} 天`);
    }
  } else {
    for (const lib of toCleanLibs) {
      info(`  - ${lib.libName}/${lib.commit.slice(0, 7)} (${formatSize(lib.size)}) - 无项目引用`);
    }
  }

  blank();
  info(`总计释放: ${formatSize(totalSize)}`);

  if (options.dryRun) {
    blank();
    hint('运行 tanmi-dock clean 执行清理');
    return;
  }

  const cleanCount = toCleanStores.length > 0 ? toCleanStores.length : toCleanLibs.length;

  if (!options.force) {
    blank();
    const confirmed = await confirmAction(
      `确认清理以上 ${cleanCount} 个库 (${formatSize(totalSize)})?`,
      false
    );
    if (!confirmed) {
      info('已取消清理');
      return;
    }
  }

  // 执行清理
  blank();
  separator();
  info('正在清理...');

  let cleaned = 0;
  let freedSize = 0;

  if (toCleanStores.length > 0) {
    // unused 策略：清理 StoreEntry
    for (const entry of toCleanStores) {
      try {
        await store.remove(entry.libName, entry.commit, entry.platform);
        const storeKey = registry.getStoreKey(entry.libName, entry.commit, entry.platform);
        registry.removeStore(storeKey);
        freedSize += entry.size;
        cleaned++;
      } catch (err) {
        warn(`清理 ${entry.libName}/${entry.platform} 失败: ${(err as Error).message}`);
      }
    }
  } else {
    // unreferenced 策略：清理 LibraryInfo
    for (const lib of toCleanLibs) {
      try {
        for (const platform of lib.platforms) {
          await store.remove(lib.libName, lib.commit, platform);
        }
        const libKey = registry.getLibraryKey(lib.libName, lib.commit);
        registry.removeLibrary(libKey);
        freedSize += lib.size;
        cleaned++;
      } catch (err) {
        warn(`清理 ${lib.libName} 失败: ${(err as Error).message}`);
      }
    }
  }

  await registry.save();

  blank();
  success(`清理完成: 删除 ${cleaned} 个库，释放 ${formatSize(freedSize)}`);
}

export default createCleanCommand;
