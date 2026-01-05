/**
 * link 命令 - 链接项目依赖
 */
import path from 'path';
import fs from 'fs/promises';
import { Command } from 'commander';
import { ensureInitialized } from '../core/guard.js';
import { parseProjectDependencies, getRelativeConfigPath } from '../core/parser.js';
import { getRegistry } from '../core/registry.js';
import * as store from '../core/store.js';
import * as linker from '../core/linker.js';
import * as codepac from '../core/codepac.js';
import { getPlatform, resolvePath } from '../core/platform.js';
import { Transaction } from '../core/transaction.js';
import { formatSize } from '../utils/disk.js';
import { success, warn, error, info, hint, blank, separator } from '../utils/logger.js';
import { DependencyStatus } from '../types/index.js';
import type { ParsedDependency, ClassifiedDependency, Platform } from '../types/index.js';

/**
 * 创建 link 命令
 */
export function createLinkCommand(): Command {
  return new Command('link')
    .description('链接项目依赖到中央存储')
    .argument('[path]', '项目路径', '.')
    .option('-p, --platform <platform>', '指定平台 (mac/win)', getPlatform())
    .option('-y, --yes', '跳过确认提示')
    .option('--no-download', '不自动下载缺失库')
    .option('--dry-run', '只显示将要执行的操作')
    .action(async (projectPath: string, options) => {
      await ensureInitialized();
      await linkProject(projectPath, options);
    });
}

/**
 * 命令选项
 */
interface LinkOptions {
  platform: Platform;
  yes: boolean;
  download: boolean;
  dryRun: boolean;
}

/**
 * 执行链接操作
 */
async function linkProject(projectPath: string, options: LinkOptions): Promise<void> {
  const absolutePath = resolvePath(projectPath);
  const platform = options.platform as Platform;

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

  // 解析依赖
  info(`分析 ${absolutePath}`);
  let dependencies: ParsedDependency[];
  let configPath: string;

  try {
    const result = await parseProjectDependencies(absolutePath);
    dependencies = result.dependencies;
    configPath = result.configPath;
  } catch (err) {
    error((err as Error).message);
    process.exit(1);
  }

  info(`找到 ${dependencies.length} 个依赖，平台: ${platform === 'mac' ? 'macOS' : 'Windows'}`);
  blank();

  // 分类依赖
  const classified = await classifyDependencies(dependencies, absolutePath, configPath);

  // 显示分类结果
  const stats = {
    linked: 0,
    relink: 0,
    replace: 0,
    absorb: 0,
    missing: 0,
    linkNew: 0,
  };

  for (const item of classified) {
    stats[getStatusKey(item.status)]++;
  }

  // 如果是 dry-run，只显示信息
  if (options.dryRun) {
    showDryRunInfo(classified, stats);
    return;
  }

  // 检查是否有未完成的事务需要恢复
  const pendingTx = await Transaction.findPending();
  if (pendingTx) {
    warn(`发现未完成的事务 (${pendingTx.id.slice(0, 8)})`);
    info('正在尝试回滚...');
    try {
      await pendingTx.rollback();
      success('事务回滚完成');
    } catch (err) {
      error(`回滚失败: ${(err as Error).message}`);
      hint('请手动检查 Store 和项目目录状态');
    }
  }

  // 执行链接
  const registry = getRegistry();
  await registry.load();

  let savedBytes = 0;
  const storePath = await store.getStorePath();
  const projectHash = registry.hashPath(absolutePath);

  // 创建事务
  const tx = new Transaction(`link:${absolutePath}`);
  await tx.begin();

  try {
  for (const item of classified) {
    const { dependency, status, localPath } = item;
    const libKey = registry.getLibraryKey(dependency.libName, dependency.commit);
    const storeLibPath = store.getLibraryPath(storePath, dependency.libName, dependency.commit);

    switch (status) {
      case DependencyStatus.LINKED:
        // 已链接，跳过
        break;

      case DependencyStatus.RELINK:
        // 重建链接
        tx.recordOp('unlink', localPath);
        await linker.unlink(localPath);
        tx.recordOp('link', localPath, storeLibPath);
        await linker.link(storeLibPath, localPath);
        success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 重建链接`);
        break;

      case DependencyStatus.REPLACE:
        // 删除目录，创建链接
        const replaceSize = await getDirSize(localPath);
        tx.recordOp('replace', localPath, storeLibPath);
        await linker.replaceWithLink(localPath, storeLibPath);
        savedBytes += replaceSize;
        success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - Store 已有，创建链接`);
        break;

      case DependencyStatus.ABSORB:
        // 移入 Store
        const absorbSize = await getDirSize(localPath);
        tx.recordOp('absorb', localPath, storeLibPath);
        await store.absorb(localPath, dependency.libName, dependency.commit);
        tx.recordOp('link', localPath, storeLibPath);
        await linker.link(storeLibPath, localPath);
        // 添加库到注册表
        registry.addLibrary({
          libName: dependency.libName,
          commit: dependency.commit,
          branch: dependency.branch,
          url: dependency.url,
          platforms: await store.getPlatforms(dependency.libName, dependency.commit),
          size: absorbSize,
          referencedBy: [],
          createdAt: new Date().toISOString(),
          lastAccess: new Date().toISOString(),
        });
        hint(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 本地已有，移入 Store`);
        break;

      case DependencyStatus.MISSING:
        // 需要下载
        if (!options.download) {
          warn(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 缺失 (跳过下载)`);
          continue;
        }

        if (!options.yes) {
          // TODO: 交互式确认
          warn(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 缺失，需要下载`);
          continue;
        }

        try {
          info(`下载 ${dependency.libName}...`);
          tx.recordOp('download', storeLibPath);
          await codepac.installSingle({
            url: dependency.url,
            commit: dependency.commit,
            branch: dependency.branch,
            targetDir: storeLibPath,
            sparse: dependency.sparse,
          });
          tx.recordOp('link', localPath, storeLibPath);
          await linker.link(storeLibPath, localPath);
          const downloadSize = await store.getSize(dependency.libName, dependency.commit);
          registry.addLibrary({
            libName: dependency.libName,
            commit: dependency.commit,
            branch: dependency.branch,
            url: dependency.url,
            platforms: await store.getPlatforms(dependency.libName, dependency.commit),
            size: downloadSize,
            referencedBy: [],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          });
          success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 下载完成，创建链接`);
        } catch (err) {
          error(`${dependency.libName} 下载失败: ${(err as Error).message}`);
        }
        break;

      case DependencyStatus.LINK_NEW:
        // Store 有，项目没有，创建链接
        tx.recordOp('link', localPath, storeLibPath);
        await linker.link(storeLibPath, localPath);
        success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 创建链接`);
        break;
    }
    // 保存事务进度
    await tx.save();

    // 添加引用关系
    if (status !== DependencyStatus.MISSING || options.download) {
      registry.addReference(libKey, projectHash);
    }
  }

  // 更新项目信息
  const relConfigPath = getRelativeConfigPath(absolutePath, configPath);
  registry.addProject({
    path: absolutePath,
    configPath: relConfigPath,
    lastLinked: new Date().toISOString(),
    platform,
    dependencies: classified
      .filter((c) => c.status !== DependencyStatus.MISSING || options.download)
      .map((c) => ({
        libName: c.dependency.libName,
        commit: c.dependency.commit,
        linkedPath: path.relative(absolutePath, c.localPath),
      })),
  });

  await registry.save();

  // 事务提交成功
  await tx.commit();

  // 显示统计
  blank();
  separator();
  const totalLinked = stats.relink + stats.replace + stats.absorb + stats.linkNew + (options.download ? stats.missing : 0);
  info(`完成: 链接 ${totalLinked} 个库`);
  if (savedBytes > 0) {
    info(`本次节省: ${formatSize(savedBytes)}`);
  }
  const totalSize = await store.getTotalSize();
  info(`Store 总计: ${formatSize(totalSize)}`);
  } catch (err) {
    // 链接过程出错，回滚事务
    error(`链接失败: ${(err as Error).message}`);
    warn('正在回滚事务...');
    try {
      await tx.rollback();
      success('事务已回滚');
    } catch (rollbackErr) {
      error(`回滚失败: ${(rollbackErr as Error).message}`);
      hint('请手动检查 Store 和项目目录状态');
    }
    process.exit(1);
  }
}

/**
 * 分类依赖状态
 */
async function classifyDependencies(
  dependencies: ParsedDependency[],
  projectPath: string,
  configPath: string
): Promise<ClassifiedDependency[]> {
  const result: ClassifiedDependency[] = [];
  const thirdPartyDir = path.dirname(configPath);
  const storePath = await store.getStorePath();

  for (const dep of dependencies) {
    const localPath = path.join(thirdPartyDir, dep.libName);
    const storeLibPath = store.getLibraryPath(storePath, dep.libName, dep.commit);

    const inStore = await store.exists(dep.libName, dep.commit);
    const pathStatus = await linker.getPathStatus(localPath, storeLibPath);

    let status: DependencyStatus;

    if (inStore) {
      switch (pathStatus) {
        case 'linked':
          status = DependencyStatus.LINKED;
          break;
        case 'wrong_link':
          status = DependencyStatus.RELINK;
          break;
        case 'directory':
          status = DependencyStatus.REPLACE;
          break;
        case 'missing':
          status = DependencyStatus.LINK_NEW;
          break;
        default:
          status = DependencyStatus.LINK_NEW;
      }
    } else {
      switch (pathStatus) {
        case 'directory':
          status = DependencyStatus.ABSORB;
          break;
        default:
          status = DependencyStatus.MISSING;
      }
    }

    result.push({
      dependency: dep,
      status,
      localPath,
      storePath: storeLibPath,
    });
  }

  return result;
}

/**
 * 显示 dry-run 信息
 */
function showDryRunInfo(
  classified: ClassifiedDependency[],
  stats: Record<string, number>
): void {
  info('[dry-run] 以下操作将被执行:');
  blank();

  for (const item of classified) {
    const { dependency, status } = item;
    const shortCommit = dependency.commit.slice(0, 7);

    switch (status) {
      case DependencyStatus.LINKED:
        info(`  [跳过] ${dependency.libName} (${shortCommit}) - 已链接`);
        break;
      case DependencyStatus.RELINK:
        info(`  [重建] ${dependency.libName} (${shortCommit}) - 链接错误`);
        break;
      case DependencyStatus.REPLACE:
        info(`  [替换] ${dependency.libName} (${shortCommit}) - Store 已有`);
        break;
      case DependencyStatus.ABSORB:
        info(`  [吸收] ${dependency.libName} (${shortCommit}) - 移入 Store`);
        break;
      case DependencyStatus.MISSING:
        warn(`  [缺失] ${dependency.libName} (${shortCommit}) - 需要下载`);
        break;
      case DependencyStatus.LINK_NEW:
        info(`  [链接] ${dependency.libName} (${shortCommit}) - 新建链接`);
        break;
    }
  }

  blank();
  separator();
  info(`统计: 跳过 ${stats.linked}, 重建 ${stats.relink}, 替换 ${stats.replace}, 吸收 ${stats.absorb}, 缺失 ${stats.missing}, 新建 ${stats.linkNew}`);
  hint('移除 --dry-run 选项以执行实际操作');
}

/**
 * 获取状态键
 */
function getStatusKey(status: DependencyStatus): keyof typeof defaultStats {
  const map: Record<DependencyStatus, keyof typeof defaultStats> = {
    [DependencyStatus.LINKED]: 'linked',
    [DependencyStatus.RELINK]: 'relink',
    [DependencyStatus.REPLACE]: 'replace',
    [DependencyStatus.ABSORB]: 'absorb',
    [DependencyStatus.MISSING]: 'missing',
    [DependencyStatus.LINK_NEW]: 'linkNew',
  };
  return map[status];
}

const defaultStats = {
  linked: 0,
  relink: 0,
  replace: 0,
  absorb: 0,
  missing: 0,
  linkNew: 0,
};

/**
 * 获取目录大小
 */
async function getDirSize(dirPath: string): Promise<number> {
  let size = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += await getDirSize(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        size += stat.size;
      }
    }
  } catch {
    // 忽略错误
  }
  return size;
}

export default createLinkCommand;
