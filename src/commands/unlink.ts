/**
 * unlink 命令 - 取消链接
 */
import path from 'path';
import fs from 'fs/promises';
import { Command } from 'commander';
import { ensureInitialized } from '../core/guard.js';
import { getRegistry } from '../core/registry.js';
import * as linker from '../core/linker.js';
import { resolvePath, shrinkHome } from '../core/platform.js';
import { info, warn, success, error, hint, blank, separator } from '../utils/logger.js';

/**
 * 创建 unlink 命令
 */
export function createUnlinkCommand(): Command {
  return new Command('unlink')
    .description('取消项目的链接')
    .argument('[path]', '项目路径', '.')
    .option('--remove', '同时从 Store 删除无其他引用的库')
    .action(async (projectPath: string, options) => {
      await ensureInitialized();
      await unlinkProject(projectPath, options);
    });
}

interface UnlinkOptions {
  remove: boolean;
}

/**
 * 取消链接
 */
export async function unlinkProject(projectPath: string, options: UnlinkOptions): Promise<void> {
  const absolutePath = resolvePath(projectPath);

  // 检查项目路径
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isDirectory()) {
      error(`路径不是目录: ${absolutePath}`);
      process.exit(1);
    }
  } catch {
    error(`路径不存在: ${absolutePath}`);
    process.exit(1);
  }

  // 加载注册表
  const registry = getRegistry();
  await registry.load();

  const projectHash = registry.hashPath(absolutePath);
  const projectInfo = registry.getProject(projectHash);

  if (!projectInfo) {
    warn('此项目未被跟踪');
    process.exit(1);
  }

  info(`取消链接: ${shrinkHome(absolutePath)}`);
  blank();

  let restored = 0;
  let removed = 0;

  // 遍历项目的依赖
  for (const dep of projectInfo.dependencies) {
    const localPath = path.join(absolutePath, dep.linkedPath);
    const libKey = registry.getLibraryKey(dep.libName, dep.commit);

    // 检查是否为符号链接（支持单平台和多平台模式）
    const isTopLevelLink = await linker.isSymlink(localPath);
    let hasInternalLinks = false;

    if (!isTopLevelLink) {
      // 检查内部是否有符号链接（多平台模式）
      try {
        const entries = await fs.readdir(localPath, { withFileTypes: true });
        for (const entry of entries) {
          if (await linker.isSymlink(path.join(localPath, entry.name))) {
            hasInternalLinks = true;
            break;
          }
        }
      } catch {
        // 目录不存在或无法读取
      }
    }

    if (isTopLevelLink) {
      try {
        // 单平台模式：顶层是符号链接，直接还原
        await linker.restoreFromLink(localPath);
        success(`${dep.libName} (${dep.commit.slice(0, 7)}) - 已还原`);
        restored++;
      } catch (err) {
        warn(`${dep.libName} 还原失败: ${(err as Error).message}`);
      }
    } else if (hasInternalLinks) {
      try {
        // 多平台模式：顶层是普通目录，内部有符号链接
        await linker.restoreMultiPlatform(localPath);
        success(`${dep.libName} (${dep.commit.slice(0, 7)}) - 已还原`);
        restored++;
      } catch (err) {
        warn(`${dep.libName} 还原失败: ${(err as Error).message}`);
      }
    }

    // 移除引用关系
    registry.removeReference(libKey, projectHash);

    // 移除 StoreEntry 引用（所有平台 + general）
    const { GENERAL_PLATFORM } = await import('../core/platform.js');
    const platformsToRemove = [...new Set([...projectInfo.platforms, GENERAL_PLATFORM])];
    for (const platform of platformsToRemove) {
      const storeKey = registry.getStoreKey(dep.libName, dep.commit, platform);
      registry.removeStoreReference(storeKey, projectHash);
    }

    // 如果需要删除无引用的库
    if (options.remove) {
      const lib = registry.getLibrary(libKey);
      if (lib && lib.referencedBy.length === 0) {
        try {
          const store = await import('../core/store.js');
          // 从 StoreEntry 动态获取平台列表（比 LibraryInfo.platforms 更准确）
          const platforms = registry.getLibraryPlatforms(dep.libName, dep.commit);
          for (const platform of platforms) {
            await store.remove(dep.libName, dep.commit, platform);
          }
          registry.removeLibrary(libKey);
          removed++;
          hint(`${dep.libName} (${dep.commit.slice(0, 7)}) - 已从 Store 删除`);
        } catch (err) {
          warn(`删除 ${dep.libName} 失败: ${(err as Error).message}`);
        }
      }
    }
  }

  // 移除项目记录
  registry.removeProject(projectHash);
  await registry.save();

  blank();
  separator();
  success(`完成: 还原 ${restored} 个链接`);

  if (options.remove && removed > 0) {
    info(`从 Store 删除 ${removed} 个库`);
  }
}

export default createUnlinkCommand;
