/**
 * migrate 命令 - 迁移 Store 位置
 */
import fs from 'fs/promises';
import path from 'path';
import { Command } from 'commander';
import { ensureInitialized } from '../core/guard.js';
import * as config from '../core/config.js';
import { getRegistry } from '../core/registry.js';
import * as linker from '../core/linker.js';
import { expandHome, shrinkHome, isPathSafe } from '../core/platform.js';
import { formatSize, getFreeSpace } from '../utils/disk.js';
import { copyDirWithProgress } from '../utils/fs-utils.js';
import * as store from '../core/store.js';
import {
  info,
  success,
  warn,
  error,
  title,
  blank,
  separator,
  progressBar,
} from '../utils/logger.js';
import { withGlobalLock } from '../utils/global-lock.js';

/**
 * 创建 migrate 命令
 */
export function createMigrateCommand(): Command {
  return new Command('migrate')
    .description('迁移 Store 到新位置')
    .argument('<new-path>', '新的存储路径')
    .option('--force', '跳过确认')
    .option('--keep-old', '保留旧目录（默认删除）')
    .action(async (newPath: string, options) => {
      await ensureInitialized();
      try {
        await withGlobalLock(() => migrateStore(newPath, options));
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}

interface MigrateOptions {
  force: boolean;
  keepOld: boolean;
}

/**
 * 迁移 Store
 */
async function migrateStore(newPath: string, options: MigrateOptions): Promise<void> {
  const absoluteNewPath = expandHome(newPath);

  // 安全检查
  const safetyResult = isPathSafe(absoluteNewPath);
  if (!safetyResult.safe) {
    error(`目标路径不安全: ${safetyResult.reason}`);
    process.exit(1);
  }

  const oldPath = await store.getStorePath();

  if (absoluteNewPath === oldPath) {
    warn('新路径与当前路径相同');
    return;
  }

  title('迁移 Store');
  blank();

  // 获取当前 Store 信息
  const libraries = await store.listLibraries();
  const totalSize = await store.getTotalSize();

  info(`当前位置: ${shrinkHome(oldPath)} (${formatSize(totalSize)}, ${libraries.length} 个库)`);
  info(`目标位置: ${shrinkHome(absoluteNewPath)}`);
  blank();

  // 检查目标路径
  info('检查:');

  // 检查可写性
  try {
    await fs.mkdir(absoluteNewPath, { recursive: true });
    success('  [ok] 目标路径可写');
  } catch (err) {
    error(`  [err] 无法创建目标目录: ${(err as Error).message}`);
    process.exit(1);
  }

  // 检查空间
  const freeSpace = await getFreeSpace(absoluteNewPath);
  if (freeSpace < totalSize) {
    error(`  [err] 目标空间不足 (需要 ${formatSize(totalSize)}, 可用 ${formatSize(freeSpace)})`);
    process.exit(1);
  }
  success(`  [ok] 目标空间充足 (${formatSize(freeSpace)} 可用)`);

  // 获取需要更新的项目
  const registry = getRegistry();
  await registry.load();
  const projects = registry.listProjects();

  info(`  [info] ${projects.length} 个项目的符号链接需要更新`);
  blank();

  if (!options.force) {
    warn('使用 --force 选项确认迁移');
    return;
  }

  // 执行迁移
  separator();

  // 1. 复制文件
  info('[1/3] 复制文件...');
  await copyDirWithProgress(oldPath, absoluteNewPath, totalSize, (copied, total) => {
    progressBar(copied, total);
  });
  // 确保进度条完成
  if (totalSize > 0) {
    progressBar(totalSize, totalSize);
  }

  // 2. 更新符号链接
  info('[2/3] 更新符号链接...');
  for (const project of projects) {
    let updatedCount = 0;

    for (const dep of project.dependencies) {
      const localPath = path.join(project.path, dep.linkedPath);
      const newStorePath = store.getLibraryPath(absoluteNewPath, dep.libName, dep.commit);

      if (await linker.isSymlink(localPath)) {
        await linker.unlink(localPath);
        await linker.link(newStorePath, localPath);
        updatedCount++;
      }
    }

    success(`  [ok] ${shrinkHome(project.path)} (${updatedCount} 个链接)`);
  }

  // 3. 更新配置
  await config.setStorePath(absoluteNewPath);

  // 4. 清理旧目录
  if (!options.keepOld) {
    info('[3/3] 清理旧目录...');
    try {
      await fs.rm(oldPath, { recursive: true, force: true });
      success(`  [ok] 已删除 ${shrinkHome(oldPath)}`);
    } catch (err) {
      warn(`  [warn] 删除旧目录失败: ${(err as Error).message}`);
    }
  } else {
    info('[3/3] 保留旧目录');
  }

  blank();
  success('迁移完成');
}

export default createMigrateCommand;
