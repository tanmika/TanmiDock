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
import { resolvePath } from '../core/platform.js';
import { Transaction } from '../core/transaction.js';
import { formatSize, checkDiskSpace } from '../utils/disk.js';
import { getDirSize } from '../utils/fs-utils.js';
import { success, warn, error, info, hint, blank, separator } from '../utils/logger.js';
import { DependencyStatus } from '../types/index.js';
import type { ParsedDependency, ClassifiedDependency } from '../types/index.js';
import { withGlobalLock } from '../utils/global-lock.js';
import { confirmAction, selectPlatforms, parsePlatformArgs } from '../utils/prompt.js';
import pLimit from 'p-limit';
import { EXIT_CODES } from '../utils/exit-codes.js';

/**
 * 创建 link 命令
 */
export function createLinkCommand(): Command {
  return new Command('link')
    .description('链接项目依赖到中央存储')
    .argument('[path]', '项目路径', '.')
    .option('-p, --platform <platforms...>', '指定平台 (mac/ios/android/win/linux/wasm/ohos，可多选)')
    .option('-y, --yes', '跳过确认提示')
    .option('--no-download', '不自动下载缺失库')
    .option('--dry-run', '只显示将要执行的操作')
    .action(async (projectPath: string, options) => {
      await ensureInitialized();
      try {
        await withGlobalLock(() => linkProject(projectPath, options));
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}

/**
 * 命令选项
 */
interface LinkOptions {
  platform?: string[];
  yes: boolean;
  download: boolean;
  dryRun: boolean;
}

/**
 * 执行链接操作
 */
async function linkProject(projectPath: string, options: LinkOptions): Promise<void> {
  const absolutePath = resolvePath(projectPath);

  // 确定平台列表
  let platforms: string[];
  if (options.platform && options.platform.length > 0) {
    // CLI 指定了平台，解析为 values
    platforms = parsePlatformArgs(options.platform);
  } else if (!options.yes && process.stdout.isTTY) {
    // 交互模式：显示平台选择
    platforms = await selectPlatforms();
    if (platforms.length === 0) {
      error('至少需要选择一个平台');
      process.exit(EXIT_CODES.MISUSE);
    }
  } else {
    // 非交互模式且未指定平台，报错
    error('非交互模式下必须使用 -p 指定平台');
    hint('示例: tanmi-dock link -p mac ios');
    process.exit(EXIT_CODES.MISUSE);
  }

  // 检查项目路径
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isDirectory()) {
      error(`路径不是目录: ${absolutePath}`);
      process.exit(EXIT_CODES.NOINPUT);
    }
  } catch {
    error(`路径不存在: ${absolutePath}`);
    process.exit(EXIT_CODES.NOINPUT);
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
    process.exit(EXIT_CODES.DATAERR);
  }

  info(`找到 ${dependencies.length} 个依赖，平台: ${platforms.join(', ')}`);
  blank();

  // 分类依赖（使用第一个平台作为主平台进行分类）
  const classified = await classifyDependencies(dependencies, absolutePath, configPath, platforms[0]);

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

  // 磁盘空间预检（针对需要下载的库）
  if (stats.missing > 0 && options.download) {
    // 估算下载所需空间（每个库估算 500MB）
    const estimatedSize = stats.missing * 500 * 1024 * 1024;
    const storePath = await store.getStorePath();
    const spaceCheck = await checkDiskSpace(storePath, estimatedSize);

    if (!spaceCheck.sufficient) {
      error(
        `磁盘空间不足: 预计需要 ${formatSize(spaceCheck.required)}，可用 ${formatSize(spaceCheck.available)}（含 1GB 安全余量）`
      );
      process.exit(EXIT_CODES.IOERR);
    }

    if (spaceCheck.available === 0) {
      warn('无法获取磁盘空间信息，继续执行');
    }
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
      // 主平台用于 absorb 等单平台操作
      const primaryPlatform = platforms[0];
      const primaryStorePath = store.getLibraryPath(storePath, dependency.libName, dependency.commit, primaryPlatform);

      switch (status) {
        case DependencyStatus.LINKED:
          // 已链接，跳过
          break;

        case DependencyStatus.RELINK:
          // 重建链接（使用 linkLibrary 支持多平台）
          tx.recordOp('unlink', localPath);
          await linker.unlink(localPath);
          tx.recordOp('link', localPath, primaryStorePath);
          await linker.linkLibrary(localPath, storePath, dependency.libName, dependency.commit, platforms);
          success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 重建链接 [${platforms.join(', ')}]`);
          break;

        case DependencyStatus.REPLACE: {
          // 删除目录，创建链接
          const replaceSize = await getDirSize(localPath);
          tx.recordOp('replace', localPath, primaryStorePath);
          await linker.linkLibrary(localPath, storePath, dependency.libName, dependency.commit, platforms);
          savedBytes += replaceSize;
          success(
            `${dependency.libName} (${dependency.commit.slice(0, 7)}) - Store 已有，创建链接 [${platforms.join(', ')}]`
          );
          break;
        }

        case DependencyStatus.ABSORB: {
          // 移入 Store（吸收到主平台）
          const absorbSize = await getDirSize(localPath);
          tx.recordOp('absorb', localPath, primaryStorePath);
          await store.absorb(localPath, dependency.libName, dependency.commit, primaryPlatform);
          tx.recordOp('link', localPath, primaryStorePath);
          await linker.linkLibrary(localPath, storePath, dependency.libName, dependency.commit, [primaryPlatform]);
          // 添加库到注册表
          registry.addLibrary({
            libName: dependency.libName,
            commit: dependency.commit,
            branch: dependency.branch,
            url: dependency.url,
            platforms: [primaryPlatform],
            size: absorbSize,
            referencedBy: [],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          });
          hint(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 本地已有，移入 Store [${primaryPlatform}]`);
          break;
        }

        case DependencyStatus.MISSING:
          // 跳过，后续并行处理
          break;

        case DependencyStatus.LINK_NEW:
          // Store 有，项目没有，创建链接
          tx.recordOp('link', localPath, primaryStorePath);
          await linker.linkLibrary(localPath, storePath, dependency.libName, dependency.commit, platforms);
          success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 创建链接 [${platforms.join(', ')}]`);
          break;
      }
      // 保存事务进度
      await tx.save();

      // 添加引用关系（非 MISSING 状态）
      if (status !== DependencyStatus.MISSING) {
        registry.addReference(libKey, projectHash);
      }
    }

    // 并行处理 MISSING 依赖
    const missingItems = classified.filter((c) => c.status === DependencyStatus.MISSING);
    const downloadedLibs: string[] = [];

    if (missingItems.length > 0 && options.download) {
      // 确认下载
      let toDownload = missingItems;

      if (!options.yes) {
        info(`发现 ${missingItems.length} 个缺失库需要下载:`);
        for (const item of missingItems) {
          info(`  - ${item.dependency.libName} (${item.dependency.commit.slice(0, 7)})`);
        }
        blank();

        const confirmed = await confirmAction(
          `是否下载以上 ${missingItems.length} 个库?`,
          true
        );
        if (!confirmed) {
          warn('跳过下载缺失库');
          toDownload = [];
        }
      }

      if (toDownload.length > 0) {
        const totalDownloads = toDownload.length * platforms.length;
        info(`开始并行下载 ${toDownload.length} 个库 × ${platforms.length} 个平台 (最多 3 个并发)...`);
        blank();

        // 并行控制器，最多同时 3 个下载
        const downloadLimit = pLimit(3);

        // 为每个库下载所有选中的平台
        const downloadTasks = toDownload.map((item) =>
          downloadLimit(async () => {
            const { dependency, localPath } = item;
            const downloadedPlatforms: string[] = [];
            const skippedPlatforms: string[] = [];

            try {
              info(`下载 ${dependency.libName} [${platforms.join(', ')}]...`);

              // 依次下载每个平台
              for (const platform of platforms) {
                const storeLibPath = store.getLibraryPath(storePath, dependency.libName, dependency.commit, platform);
                tx.recordOp('download', storeLibPath);

                await codepac.installSingle({
                  url: dependency.url,
                  commit: dependency.commit,
                  branch: dependency.branch,
                  targetDir: storeLibPath,
                  platform: platform,
                  sparse: dependency.sparse,
                });

                // 验证平台目录是否有有效内容
                const isValid = await store.validatePlatform(dependency.libName, dependency.commit, platform);
                if (!isValid) {
                  await store.remove(dependency.libName, dependency.commit, platform);
                  skippedPlatforms.push(platform);
                } else {
                  downloadedPlatforms.push(platform);
                }
              }

              // 如果没有任何平台下载成功，视为失败
              if (downloadedPlatforms.length === 0) {
                return {
                  success: false,
                  name: dependency.libName,
                  skipped: true,
                  skippedPlatforms,
                };
              }

              // 使用 linkLibrary 创建链接（支持多平台）
              const primaryStorePath = store.getLibraryPath(storePath, dependency.libName, dependency.commit, downloadedPlatforms[0]);
              tx.recordOp('link', localPath, primaryStorePath);
              await linker.linkLibrary(localPath, storePath, dependency.libName, dependency.commit, downloadedPlatforms);

              // 计算总大小
              let totalSize = 0;
              for (const platform of downloadedPlatforms) {
                totalSize += await store.getSize(dependency.libName, dependency.commit, platform);
              }

              registry.addLibrary({
                libName: dependency.libName,
                commit: dependency.commit,
                branch: dependency.branch,
                url: dependency.url,
                platforms: downloadedPlatforms,
                size: totalSize,
                referencedBy: [],
                createdAt: new Date().toISOString(),
                lastAccess: new Date().toISOString(),
              });
              const libKey = registry.getLibraryKey(dependency.libName, dependency.commit);
              registry.addReference(libKey, projectHash);
              success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 下载完成 [${downloadedPlatforms.join(', ')}]`);

              return {
                success: true,
                name: dependency.libName,
                downloadedPlatforms,
                skippedPlatforms,
              };
            } catch (err) {
              error(`${dependency.libName} 下载失败: ${(err as Error).message}`);
              return { success: false, name: dependency.libName, error: (err as Error).message };
            }
          })
        );

        const results = await Promise.all(downloadTasks);
        const succeeded = results.filter((r) => r.success);
        const failed = results.filter((r) => !r.success && !('skipped' in r && r.skipped));

        blank();
        info(`下载完成: ${succeeded.length}/${toDownload.length} 个库`);
        if (failed.length > 0) {
          warn(`${failed.length} 个库下载失败`);
        }

        // 汇总提示跳过的平台
        const allSkipped: { name: string; platforms: string[] }[] = [];
        for (const r of results) {
          if ('skippedPlatforms' in r && r.skippedPlatforms && r.skippedPlatforms.length > 0) {
            allSkipped.push({ name: r.name, platforms: r.skippedPlatforms });
          }
        }
        if (allSkipped.length > 0) {
          blank();
          warn('以下库/平台组合不可用（已跳过）:');
          for (const item of allSkipped) {
            warn(`  - ${item.name} / ${item.platforms.join(', ')}`);
          }
        }

        // 记录成功下载的库
        for (const r of succeeded) {
          downloadedLibs.push(r.name);
        }
      }
    } else if (missingItems.length > 0 && !options.download) {
      for (const item of missingItems) {
        warn(`${item.dependency.libName} (${item.dependency.commit.slice(0, 7)}) - 缺失 (跳过下载)`);
      }
    }

    // 获取旧引用（用于后续引用关系更新）
    const oldStoreKeys = registry.getProjectStoreKeys(projectHash);

    // 更新项目信息
    const relConfigPath = getRelativeConfigPath(absolutePath, configPath);
    // 使用主平台作为依赖的 platform 字段（兼容旧结构）
    const primaryPlatform = platforms[0];
    const newDependencies = classified
      .filter((c) => {
        if (c.status === DependencyStatus.MISSING) {
          // 只包含成功下载的库
          return downloadedLibs.includes(c.dependency.libName);
        }
        return true;
      })
      .map((c) => ({
        libName: c.dependency.libName,
        commit: c.dependency.commit,
        platform: primaryPlatform,
        linkedPath: path.relative(absolutePath, c.localPath),
      }));

    registry.addProject({
      path: absolutePath,
      configPath: relConfigPath,
      lastLinked: new Date().toISOString(),
      platforms: platforms,
      dependencies: newDependencies,
    });

    // 更新 Store 引用关系
    const newStoreKeys = newDependencies.map((d) =>
      registry.getStoreKey(d.libName, d.commit, d.platform)
    );

    // 移除不再使用的引用（设置 unlinkedAt）
    for (const key of oldStoreKeys) {
      if (!newStoreKeys.includes(key)) {
        registry.removeStoreReference(key, projectHash);
      }
    }

    // 添加新引用（清除 unlinkedAt）
    for (const key of newStoreKeys) {
      registry.addStoreReference(key, projectHash);
    }

    await registry.save();

    // 事务提交成功
    await tx.commit();

    // 显示统计
    blank();
    separator();
    const totalLinked =
      stats.relink +
      stats.replace +
      stats.absorb +
      stats.linkNew +
      downloadedLibs.length;
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
 * @param dependencies 依赖列表
 * @param projectPath 项目路径
 * @param configPath 配置文件路径
 * @param platform 用于分类的主平台
 */
async function classifyDependencies(
  dependencies: ParsedDependency[],
  projectPath: string,
  configPath: string,
  platform: string
): Promise<ClassifiedDependency[]> {
  const result: ClassifiedDependency[] = [];
  const thirdPartyDir = path.dirname(configPath);
  const storePath = await store.getStorePath();

  for (const dep of dependencies) {
    const localPath = path.join(thirdPartyDir, dep.libName);
    const storeLibPath = store.getLibraryPath(storePath, dep.libName, dep.commit, platform);

    const inStore = await store.exists(dep.libName, dep.commit, platform);
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
function showDryRunInfo(classified: ClassifiedDependency[], stats: Record<string, number>): void {
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
  info(
    `统计: 跳过 ${stats.linked}, 重建 ${stats.relink}, 替换 ${stats.replace}, 吸收 ${stats.absorb}, 缺失 ${stats.missing}, 新建 ${stats.linkNew}`
  );
  hint('移除 --dry-run 选项以执行实际操作');
}

/**
 * 获取状态键
 */
type StatsKey = 'linked' | 'relink' | 'replace' | 'absorb' | 'missing' | 'linkNew';

function getStatusKey(status: DependencyStatus): StatsKey {
  const map: Record<DependencyStatus, StatsKey> = {
    [DependencyStatus.LINKED]: 'linked',
    [DependencyStatus.RELINK]: 'relink',
    [DependencyStatus.REPLACE]: 'replace',
    [DependencyStatus.ABSORB]: 'absorb',
    [DependencyStatus.MISSING]: 'missing',
    [DependencyStatus.LINK_NEW]: 'linkNew',
  };
  return map[status];
}

export default createLinkCommand;
