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
    .addHelpText(
      'after',
      `
将项目的符号链接还原为普通目录，取消与中央存储的关联。
库文件会保留在 Store 中供其他项目使用。

示例:
  td unlink                取消当前项目的链接
  td unlink ~/MyProject    取消指定项目的链接
  td unlink --remove       取消链接并删除无引用的库`
    )
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

    // 移除 StoreEntry 引用（该库的所有平台）
    // 注意：需要在 --remove 检查之前移除引用，以便正确判断是否还有其他项目引用
    const depStoreKeys = registry.getLibraryStoreKeys(dep.libName, dep.commit);
    for (const storeKey of depStoreKeys) {
      registry.removeStoreReference(storeKey, projectHash);
    }

    // 如果需要删除无引用的库
    if (options.remove) {
      // 复用 depStoreKeys，检查是否还有其他项目引用
      const hasReferences = depStoreKeys.some((key) => {
        const storeEntry = registry.getStore(key);
        return storeEntry && storeEntry.usedBy.length > 0;
      });

      if (!hasReferences) {
        try {
          const storeModule = await import('../core/store.js');
          const storePath = await storeModule.getStorePath();

          // 从 StoreEntry 动态获取平台列表
          const platforms = registry.getLibraryPlatforms(dep.libName, dep.commit);
          for (const platform of platforms) {
            await storeModule.remove(dep.libName, dep.commit, platform);
            const storeKey = registry.getStoreKey(dep.libName, dep.commit, platform);
            registry.removeStore(storeKey);
          }

          // 清理整个 commit 目录（包括 _shared）
          const commitPath = path.join(storePath, dep.libName, dep.commit);
          await fs.rm(commitPath, { recursive: true, force: true }).catch(() => {});

          // 检查 library 目录是否为空，如果是则删除
          const libPath = path.join(storePath, dep.libName);
          const entries = await fs.readdir(libPath).catch(() => []);
          if (entries.length === 0) {
            await fs.rm(libPath, { recursive: true, force: true }).catch(() => {});
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

  // 直接删除项目记录（不调用 removeProject 以避免重复移除引用）
  registry.getRaw().projects[projectHash] && delete registry.getRaw().projects[projectHash];
  await registry.save();

  blank();
  separator();
  success(`完成: 还原 ${restored} 个链接`);

  if (options.remove && removed > 0) {
    info(`从 Store 删除 ${removed} 个库`);
  }
}

export default createUnlinkCommand;
