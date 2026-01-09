/**
 * verify 命令 - 验证 Store 和 Registry 完整性
 */
import fs from 'fs/promises';
import path from 'path';
import { Command } from 'commander';
import { ensureInitialized } from '../core/guard.js';
import { getRegistry } from '../core/registry.js';
import * as store from '../core/store.js';
import { formatSize } from '../utils/disk.js';
import { info, warn, success, error, hint, blank, title, separator } from '../utils/logger.js';

interface VerifyResult {
  danglingLinks: { path: string; target: string }[];
  orphanLibraries: { libName: string; commit: string; size: number }[];
  missingLibraries: { libName: string; commit: string; project: string }[];
  invalidProjects: string[];
}

/**
 * 创建 verify 命令
 */
export function createVerifyCommand(): Command {
  return new Command('verify')
    .description('验证 Store 和 Registry 完整性')
    .action(async () => {
      await ensureInitialized();
      await verifyIntegrity();
    });
}

/**
 * 验证完整性
 */
export async function verifyIntegrity(): Promise<void> {
  title('验证 Store 完整性');
  blank();

  const registry = getRegistry();
  await registry.load();

  const result: VerifyResult = {
    danglingLinks: [],
    orphanLibraries: [],
    missingLibraries: [],
    invalidProjects: [],
  };

  const storePath = await store.getStorePath();

  // 1. 检查项目引用一致性
  info('检查项目引用...');
  const projects = registry.listProjects();

  for (const project of projects) {
    // 检查项目路径是否存在
    try {
      await fs.access(project.path);
    } catch {
      result.invalidProjects.push(project.path);
      continue;
    }

    // 检查依赖的符号链接
    for (const dep of project.dependencies) {
      const linkPath = path.join(project.path, dep.linkedPath);
      // 使用依赖记录的平台，或项目的第一个平台
      const verifyPlatform = dep.platform ?? project.platforms?.[0] ?? 'macOS';

      try {
        const stat = await fs.lstat(linkPath);
        if (stat.isSymbolicLink()) {
          const actualTarget = await fs.readlink(linkPath);
          const resolvedTarget = path.resolve(path.dirname(linkPath), actualTarget);

          // 检查链接目标是否存在
          try {
            await fs.access(resolvedTarget);
          } catch {
            result.danglingLinks.push({ path: linkPath, target: resolvedTarget });
          }
        }
      } catch {
        // 符号链接不存在，检查库是否在 Store
        const exists = await store.exists(dep.libName, dep.commit, verifyPlatform);
        if (!exists) {
          result.missingLibraries.push({
            libName: dep.libName,
            commit: dep.commit,
            project: project.path,
          });
        }
      }
    }
  }

  // 2. 检查孤立库（Store 中有但 Registry 没有）
  info('检查孤立库...');
  try {
    const storeEntries = await fs.readdir(storePath);

    for (const libName of storeEntries) {
      const libPath = path.join(storePath, libName);
      const stat = await fs.stat(libPath);

      if (!stat.isDirectory()) continue;

      const commits = await fs.readdir(libPath);
      for (const commit of commits) {
        const commitPath = path.join(libPath, commit);
        const commitStat = await fs.stat(commitPath);

        if (!commitStat.isDirectory()) continue;

        const libKey = registry.getLibraryKey(libName, commit);
        const libInfo = registry.getLibrary(libKey);

        if (!libInfo) {
          // 计算大小
          const size = await getDirSizeRecursive(commitPath);
          result.orphanLibraries.push({ libName, commit, size });
        }
      }
    }
  } catch {
    // Store 目录不存在或无法读取
  }

  // 输出结果
  blank();
  separator();

  // Registry 引用一致性
  if (result.invalidProjects.length === 0 && result.missingLibraries.length === 0) {
    success('[ok] Registry 引用一致');
  } else {
    if (result.invalidProjects.length > 0) {
      warn(`[warn] 发现 ${result.invalidProjects.length} 个无效项目`);
      for (const p of result.invalidProjects) {
        info(`  - ${p} -> 路径不存在`);
      }
    }
    if (result.missingLibraries.length > 0) {
      error(`[err] 发现 ${result.missingLibraries.length} 个缺失库`);
      for (const lib of result.missingLibraries) {
        info(`  - ${lib.libName}/${lib.commit.slice(0, 7)} (引用自 ${lib.project})`);
      }
    }
  }

  // 悬挂链接
  if (result.danglingLinks.length === 0) {
    success('[ok] 符号链接完整');
  } else {
    warn(`[warn] 发现 ${result.danglingLinks.length} 个悬挂链接`);
    for (const link of result.danglingLinks) {
      info(`  - ${link.path} -> 目标不存在`);
    }
  }

  // 孤立库
  if (result.orphanLibraries.length === 0) {
    success('[ok] 无孤立库');
  } else {
    const totalSize = result.orphanLibraries.reduce((sum, lib) => sum + lib.size, 0);
    warn(`[warn] 发现 ${result.orphanLibraries.length} 个孤立库 (${formatSize(totalSize)})`);
    for (const lib of result.orphanLibraries) {
      info(`  - ${lib.libName}/${lib.commit.slice(0, 7)} (${formatSize(lib.size)})`);
    }
  }

  // 总结和建议
  blank();
  const hasIssues =
    result.danglingLinks.length > 0 ||
    result.orphanLibraries.length > 0 ||
    result.missingLibraries.length > 0 ||
    result.invalidProjects.length > 0;

  if (hasIssues) {
    hint('建议: 运行 tanmi-dock repair 修复问题');
  } else {
    success('Store 完整性验证通过');
  }
}

/**
 * 递归计算目录大小
 */
async function getDirSizeRecursive(dirPath: string): Promise<number> {
  let size = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += await getDirSizeRecursive(fullPath);
      } else {
        const stat = await fs.stat(fullPath);
        size += stat.size;
      }
    }
  } catch {
    // 忽略错误
  }
  return size;
}

export default createVerifyCommand;
