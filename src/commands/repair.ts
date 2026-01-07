/**
 * repair 命令 - 修复 Store 和 Registry 问题
 */
import fs from 'fs/promises';
import path from 'path';
import { Command } from 'commander';
import { ensureInitialized } from '../core/guard.js';
import { getRegistry } from '../core/registry.js';
import * as store from '../core/store.js';
import { formatSize } from '../utils/disk.js';
import { info, success, error, hint, blank, title, separator } from '../utils/logger.js';
import { confirmAction } from '../utils/prompt.js';

interface RepairResult {
  danglingLinksRemoved: number;
  orphanLibrariesFixed: number;
  staleProjectsCleaned: number;
}

/**
 * 创建 repair 命令
 */
export function createRepairCommand(): Command {
  return new Command('repair')
    .description('修复 Store 和 Registry 问题')
    .option('--dry-run', '只显示将执行的操作')
    .option('--prune', '删除孤立库而非登记')
    .option('--force', '跳过确认')
    .action(async (options) => {
      await ensureInitialized();
      await repairIssues(options);
    });
}

interface RepairOptions {
  dryRun: boolean;
  prune: boolean;
  force: boolean;
}

/**
 * 修复问题
 */
async function repairIssues(options: RepairOptions): Promise<void> {
  title('修复 Store 问题');
  blank();

  const registry = getRegistry();
  await registry.load();

  const storePath = await store.getStorePath();
  const result: RepairResult = {
    danglingLinksRemoved: 0,
    orphanLibrariesFixed: 0,
    staleProjectsCleaned: 0,
  };

  // 收集问题
  const issues: {
    danglingLinks: { path: string; projectHash: string; dep: { libName: string; commit: string } }[];
    orphanLibraries: { libName: string; commit: string; size: number; path: string }[];
    staleProjects: { hash: string; path: string }[];
  } = {
    danglingLinks: [],
    orphanLibraries: [],
    staleProjects: [],
  };

  // 1. 检查过期项目和悬挂链接
  info('扫描问题...');
  const projects = registry.listProjects();

  for (const project of projects) {
    const projectHash = registry.hashPath(project.path);

    // 检查项目路径是否存在
    try {
      await fs.access(project.path);
    } catch {
      issues.staleProjects.push({ hash: projectHash, path: project.path });
      continue;
    }

    // 检查依赖的符号链接
    for (const dep of project.dependencies) {
      const linkPath = path.join(project.path, dep.linkedPath);

      try {
        const stat = await fs.lstat(linkPath);
        if (stat.isSymbolicLink()) {
          const actualTarget = await fs.readlink(linkPath);
          const resolvedTarget = path.resolve(path.dirname(linkPath), actualTarget);

          try {
            await fs.access(resolvedTarget);
          } catch {
            issues.danglingLinks.push({
              path: linkPath,
              projectHash,
              dep: { libName: dep.libName, commit: dep.commit },
            });
          }
        }
      } catch {
        // 链接不存在，跳过
      }
    }
  }

  // 2. 检查孤立库
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
          const size = await getDirSizeRecursive(commitPath);
          issues.orphanLibraries.push({ libName, commit, size, path: commitPath });
        }
      }
    }
  } catch {
    // Store 目录不存在或无法读取
  }

  // 显示问题汇总
  const totalIssues =
    issues.danglingLinks.length + issues.orphanLibraries.length + issues.staleProjects.length;

  if (totalIssues === 0) {
    success('没有发现需要修复的问题');
    return;
  }

  blank();
  info(`发现 ${totalIssues} 个问题:`);

  if (issues.staleProjects.length > 0) {
    info(`  - ${issues.staleProjects.length} 个过期项目`);
  }
  if (issues.danglingLinks.length > 0) {
    info(`  - ${issues.danglingLinks.length} 个悬挂链接`);
  }
  if (issues.orphanLibraries.length > 0) {
    const totalSize = issues.orphanLibraries.reduce((sum, lib) => sum + lib.size, 0);
    info(`  - ${issues.orphanLibraries.length} 个孤立库 (${formatSize(totalSize)})`);
  }

  // dry-run 模式
  if (options.dryRun) {
    blank();
    separator();
    info('[dry-run] 将执行以下操作:');
    blank();

    for (const p of issues.staleProjects) {
      info(`  清理过期项目: ${p.path}`);
    }
    for (const link of issues.danglingLinks) {
      info(`  移除悬挂链接: ${link.path}`);
    }
    for (const lib of issues.orphanLibraries) {
      if (options.prune) {
        info(`  删除孤立库: ${lib.libName}/${lib.commit.slice(0, 7)} (${formatSize(lib.size)})`);
      } else {
        info(`  登记孤立库: ${lib.libName}/${lib.commit.slice(0, 7)}`);
      }
    }

    blank();
    hint('移除 --dry-run 选项以执行修复');
    return;
  }

  // 确认执行
  if (!options.force) {
    blank();
    const confirmed = await confirmAction(`确认修复以上 ${totalIssues} 个问题?`, false);
    if (!confirmed) {
      info('已取消修复');
      return;
    }
  }

  // 执行修复
  blank();
  separator();
  info('正在修复...');
  blank();

  // 3.1 清理过期项目
  for (const p of issues.staleProjects) {
    try {
      registry.removeProject(p.hash);
      success(`[ok] 清理过期项目: ${p.path}`);
      result.staleProjectsCleaned++;
    } catch (err) {
      error(`[err] 清理项目失败: ${p.path} - ${(err as Error).message}`);
    }
  }

  // 3.2 移除悬挂链接
  for (const link of issues.danglingLinks) {
    try {
      await fs.unlink(link.path);
      // 更新项目依赖
      const project = registry.getProject(link.projectHash);
      if (project) {
        project.dependencies = project.dependencies.filter(
          (d) => !(d.libName === link.dep.libName && d.commit === link.dep.commit)
        );
        registry.updateProject(link.projectHash, { dependencies: project.dependencies });
      }
      success(`[ok] 移除悬挂链接: ${link.path}`);
      result.danglingLinksRemoved++;
    } catch (err) {
      error(`[err] 移除链接失败: ${link.path} - ${(err as Error).message}`);
    }
  }

  // 3.3 处理孤立库
  for (const lib of issues.orphanLibraries) {
    try {
      if (options.prune) {
        // 删除孤立库
        await fs.rm(lib.path, { recursive: true, force: true });
        success(`[ok] 删除孤立库: ${lib.libName}/${lib.commit.slice(0, 7)}`);
      } else {
        // 登记到 Registry
        registry.addLibrary({
          libName: lib.libName,
          commit: lib.commit,
          branch: 'unknown',
          url: 'unknown',
          platforms: [],
          size: lib.size,
          referencedBy: [],
          createdAt: new Date().toISOString(),
          lastAccess: new Date().toISOString(),
        });
        success(`[ok] 登记孤立库: ${lib.libName}/${lib.commit.slice(0, 7)}`);
      }
      result.orphanLibrariesFixed++;
    } catch (err) {
      error(`[err] 处理孤立库失败: ${lib.libName}/${lib.commit.slice(0, 7)} - ${(err as Error).message}`);
    }
  }

  // 保存 Registry
  await registry.save();

  // 结果汇总
  blank();
  separator();
  const totalFixed =
    result.danglingLinksRemoved + result.orphanLibrariesFixed + result.staleProjectsCleaned;
  success(`修复完成: ${totalFixed} 个问题已解决`);
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

export default createRepairCommand;
