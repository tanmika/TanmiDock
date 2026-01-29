/**
 * unlink 命令 - 取消链接
 */
import path from 'path';
import fs from 'fs/promises';
import { Command } from 'commander';
import { ensureInitialized } from '../core/guard.js';
import { getRegistry } from '../core/registry.js';
import * as linker from '../core/linker.js';
import { resolvePath, shrinkHome, SHARED_PLATFORM } from '../core/platform.js';
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

  // ========== 阶段 1: 收集依赖信息 ==========
  // 在修改 Registry 之前，先收集所有需要处理的依赖信息
  interface DepInfo {
    libName: string;
    commit: string;
    libKey: string;
    localPath: string;
    storeKeys: string[];
  }
  const depsToProcess: DepInfo[] = [];

  for (const dep of projectInfo.dependencies) {
    depsToProcess.push({
      libName: dep.libName,
      commit: dep.commit,
      libKey: registry.getLibraryKey(dep.libName, dep.commit),
      localPath: path.join(absolutePath, dep.linkedPath),
      storeKeys: registry.getLibraryStoreKeys(dep.libName, dep.commit),
    });
  }

  // ========== 阶段 2: 还原符号链接 ==========
  let restored = 0;

  for (const dep of depsToProcess) {
    // 检查是否为符号链接（支持单平台和多平台模式）
    const isTopLevelLink = await linker.isSymlink(dep.localPath);
    let hasInternalLinks = false;

    if (!isTopLevelLink) {
      // 检查内部是否有符号链接（多平台模式）
      try {
        const entries = await fs.readdir(dep.localPath, { withFileTypes: true });
        for (const entry of entries) {
          if (await linker.isSymlink(path.join(dep.localPath, entry.name))) {
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
        await linker.restoreFromLink(dep.localPath);
        success(`${dep.libName} (${dep.commit.slice(0, 7)}) - 已还原`);
        restored++;
      } catch (err) {
        warn(`${dep.libName} 还原失败: ${(err as Error).message}`);
      }
    } else if (hasInternalLinks) {
      try {
        await linker.restoreMultiPlatform(dep.localPath);
        success(`${dep.libName} (${dep.commit.slice(0, 7)}) - 已还原`);
        restored++;
      } catch (err) {
        warn(`${dep.libName} 还原失败: ${(err as Error).message}`);
      }
    }
  }

  // ========== 阶段 3: 移除项目记录和引用 ==========
  // removeProject 会自动移除该项目对所有 StoreEntry 的引用
  registry.removeProject(projectHash);

  // ========== 阶段 4: 清理无引用的 Store（可选）==========
  let removed = 0;

  if (options.remove) {
    const storeModule = await import('../core/store.js');
    const storePath = await storeModule.getStorePath();

    for (const dep of depsToProcess) {
      // 检查该库是否还有其他项目引用
      const hasReferences = dep.storeKeys.some((key) => {
        const storeEntry = registry.getStore(key);
        return storeEntry && storeEntry.usedBy.length > 0;
      });

      if (!hasReferences) {
        try {
          // 删除所有平台的 Store 文件和记录
          const platforms = registry.getLibraryPlatforms(dep.libName, dep.commit);
          for (const platform of platforms) {
            await storeModule.remove(dep.libName, dep.commit, platform);
            const storeKey = registry.getStoreKey(dep.libName, dep.commit, platform);
            registry.removeStore(storeKey);
          }

          // 删除 _shared 的 StoreEntry（如果存在）
          const sharedKey = registry.getStoreKey(dep.libName, dep.commit, SHARED_PLATFORM);
          if (registry.getStore(sharedKey)) {
            registry.removeStore(sharedKey);
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

          registry.removeLibrary(dep.libKey);
          removed++;
          hint(`${dep.libName} (${dep.commit.slice(0, 7)}) - 已从 Store 删除`);
        } catch (err) {
          warn(`删除 ${dep.libName} 失败: ${(err as Error).message}`);
        }
      }
    }
  }

  // ========== 阶段 5: 保存并输出结果 ==========
  await registry.save();

  blank();
  separator();
  success(`完成: 还原 ${restored} 个链接`);

  if (options.remove && removed > 0) {
    info(`从 Store 删除 ${removed} 个库`);
  }
}

export default createUnlinkCommand;
