/**
 * link 命令 - 链接项目依赖
 */
import path from 'path';
import fs from 'fs/promises';
import { Command } from 'commander';
import { ensureInitialized } from '../core/guard.js';
import * as config from '../core/config.js';
import { setLogLevel } from '../utils/logger.js';
import {
  parseProjectDependencies,
  getRelativeConfigPath,
  parseCodepacDep,
  extractActions,
  parseActionCommand,
  extractNestedDependencies,
} from '../core/parser.js';
import { getRegistry } from '../core/registry.js';
import * as store from '../core/store.js';
import * as linker from '../core/linker.js';
import * as codepac from '../core/codepac.js';
import { setProxyConfig } from '../core/codepac.js';
import { resolvePath, getPlatformHelpText, GENERAL_PLATFORM } from '../core/platform.js';
import { Transaction } from '../core/transaction.js';
import { formatSize, checkDiskSpace } from '../utils/disk.js';
import { getDirSize } from '../utils/fs-utils.js';
import { ProgressTracker, DownloadMonitor } from '../utils/progress.js';
import { success, warn, error, info, hint, blank, separator } from '../utils/logger.js';
import { verifyLocalCommit } from '../utils/git.js';
import { DependencyStatus } from '../types/index.js';
import type { ParsedDependency, ClassifiedDependency, ActionConfig, NestedContext } from '../types/index.js';
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
    .addHelpText(
      'after',
      `${getPlatformHelpText()}

示例:
  td link                       链接当前目录项目
  td link ~/MyProject           链接指定路径项目
  td link -p mac                只链接 macOS 平台
  td link -p mac android        链接多个平台
  td link --dry-run             预览操作，不实际执行
  td link -y                    跳过确认，自动执行`
    )
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
export async function linkProject(projectPath: string, options: LinkOptions): Promise<void> {
  const absolutePath = resolvePath(projectPath);

  // 读取配置并应用
  const cfg = await config.load();
  if (cfg?.logLevel) {
    setLogLevel(cfg.logLevel);
  }
  if (cfg?.proxy) {
    setProxyConfig(cfg.proxy);
  }
  const concurrency = cfg?.concurrency ?? 5;

  // 获取项目之前的平台选择（用于记忆）
  const registry = getRegistry();
  await registry.load();
  const existingProject = registry.getProjectByPath(absolutePath);
  const rememberedPlatforms = existingProject?.platforms;

  // 确定平台列表
  let platforms: string[];
  if (options.platform && options.platform.length > 0) {
    // CLI 指定了平台，解析为 values
    platforms = parsePlatformArgs(options.platform);
  } else if (!options.yes && process.stdout.isTTY) {
    // 交互模式：显示平台选择，使用记忆的平台作为默认勾选
    platforms = await selectPlatforms(rememberedPlatforms);
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
  let configVars: Record<string, string> | undefined;

  try {
    const result = await parseProjectDependencies(absolutePath);
    dependencies = result.dependencies;
    configPath = result.configPath;
    configVars = result.vars;
  } catch (err) {
    error((err as Error).message);
    process.exit(EXIT_CODES.DATAERR);
  }

  info(`找到 ${dependencies.length} 个依赖，平台: ${platforms.join(', ')}`);
  blank();

  // 分类依赖（检查所有请求的平台）
  const classified = await classifyDependencies(dependencies, absolutePath, configPath, platforms);

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

  // 执行链接（registry 已在前面加载）

  let savedBytes = 0;
  const storePath = await store.getStorePath();
  const projectHash = registry.hashPath(absolutePath);

  // 创建事务
  const tx = new Transaction(`link:${absolutePath}`);
  await tx.begin();

  // 记录 General 类型库（用于最后生成 dependencies 时使用正确的 platform）
  const generalLibs = new Set<string>();

  // 预扫描所有本地存在的依赖的额外平台，让用户选择要链接的平台
  let finalLinkPlatforms: string[] = platforms; // 默认为用户请求的平台
  if (!options.yes && process.stdout.isTTY) {
    const { KNOWN_PLATFORM_VALUES } = await import('../core/platform.js');

    // 收集所有本地存在的平台（去重）- 扫描所有有本地目录的依赖
    const allLocalPlatforms = new Set<string>();
    for (const item of classified) {
      try {
        const stat = await fs.stat(item.localPath);
        if (!stat.isDirectory()) continue;

        const entries = await fs.readdir(item.localPath, { withFileTypes: true });
        entries
          .filter(e => e.isDirectory() && KNOWN_PLATFORM_VALUES.includes(e.name))
          .forEach(e => allLocalPlatforms.add(e.name));
      } catch {
        // 读取失败，跳过（目录不存在等情况）
      }
    }

    // 检测额外平台
    const extraPlatforms = [...allLocalPlatforms].filter(p => !platforms.includes(p));

    if (extraPlatforms.length > 0) {
      info(`本地检测到额外平台: ${extraPlatforms.join(', ')}`);
      blank();

      const { checkbox } = await import('@inquirer/prompts');
      const allAvailable = [...platforms, ...extraPlatforms];

      finalLinkPlatforms = await checkbox({
        message: '选择要链接的平台 (未选择的将被删除):',
        choices: allAvailable.map(p => ({
          name: p,
          value: p,
          checked: platforms.includes(p), // 用户请求的默认勾选
        })),
      });

      if (finalLinkPlatforms.length === 0) {
        warn('至少需要选择一个平台');
        process.exit(1);
      }

      blank();
    }
  }

  try {
    for (const item of classified) {
      const { dependency, status, localPath } = item;
      const libKey = registry.getLibraryKey(dependency.libName, dependency.commit);
      // 主平台用于 absorb 等单平台操作
      const _primaryPlatform = platforms[0];

      // 检查 Store 版本兼容性（v0.5 旧结构会报错）
      await store.ensureCompatibleStore(storePath, dependency.libName, dependency.commit);

      switch (status) {
        case DependencyStatus.LINKED: {
          // 已链接，检查是否需要补充缺失平台
          const isLinkedGeneral = await store.isGeneralLib(dependency.libName, dependency.commit);
          if (!isLinkedGeneral) {
            // 平台库：检查并补充缺失平台
            const supplementResult = await supplementMissingPlatforms(
              dependency,
              platforms,
              registry,
              tx,
              { vars: configVars }
            );

            if (supplementResult.downloaded.length > 0) {
              // 有新平台下载，需要重新链接所有平台
              const linkedCommitPath = path.join(storePath, dependency.libName, dependency.commit);
              const { existing: allExisting } = await store.checkPlatformCompleteness(
                dependency.libName,
                dependency.commit,
                platforms
              );

              tx.recordOp('link', localPath, linkedCommitPath);
              await linker.linkLib(localPath, linkedCommitPath, allExisting);

              // 更新 StoreEntry 引用
              for (const platform of allExisting) {
                const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, platform);
                registry.addStoreReference(storeKey, projectHash);
              }

              success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 已补充平台 [${supplementResult.downloaded.join(', ')}]`);
            }
          }
          break;
        }

        case DependencyStatus.RELINK: {
          // 重建链接（Store 已有）
          const relinkCommitPath = path.join(storePath, dependency.libName, dependency.commit);

          // 检查是否为 General 库
          const isRelinkGeneral = await store.isGeneralLib(dependency.libName, dependency.commit);

          tx.recordOp('unlink', localPath);
          await linker.unlink(localPath);

          if (isRelinkGeneral) {
            // General 库：整目录链接到 _shared
            const sharedPath = path.join(relinkCommitPath, '_shared');
            tx.recordOp('link', localPath, sharedPath);
            await linker.linkGeneral(localPath, sharedPath);

            // 记录为 General 库
            generalLibs.add(dependency.libName);

            success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - General 库，重建链接`);
          } else {
            // 平台库：先补充缺失平台
            const relinkSupplementResult = await supplementMissingPlatforms(
              dependency,
              platforms,
              registry,
              tx,
              { vars: configVars }
            );

            // 获取所有可用平台（原有 + 新下载）
            const { existing: relinkExisting } = await store.checkPlatformCompleteness(
              dependency.libName,
              dependency.commit,
              platforms
            );

            tx.recordOp('link', localPath, relinkCommitPath);
            await linker.linkLib(localPath, relinkCommitPath, relinkExisting);

            // 更新 StoreEntry 引用
            for (const platform of relinkExisting) {
              const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, platform);
              registry.addStoreReference(storeKey, projectHash);
            }

            if (relinkSupplementResult.downloaded.length > 0) {
              success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 重建链接并补充平台 [${relinkExisting.join(', ')}]`);
            } else {
              success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 重建链接 [${relinkExisting.join(', ')}]`);
            }
          }
          break;
        }

        case DependencyStatus.REPLACE: {
          // Store 已有，删除本地目录，直接链接
          const replaceSize = await getDirSize(localPath);
          const replaceCommitPath = path.join(storePath, dependency.libName, dependency.commit);

          // 检查是否为 General 库
          const isReplaceGeneral = await store.isGeneralLib(dependency.libName, dependency.commit);

          if (isReplaceGeneral) {
            // General 库：整目录链接到 _shared
            const sharedPath = path.join(replaceCommitPath, '_shared');
            tx.recordOp('replace', localPath, sharedPath);
            await linker.linkGeneral(localPath, sharedPath);
            savedBytes += replaceSize;

            // 记录为 General 库
            generalLibs.add(dependency.libName);

            success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - General 库，创建链接`);
          } else {
            // 平台库：先补充缺失平台
            const replaceSupplementResult = await supplementMissingPlatforms(
              dependency,
              platforms,
              registry,
              tx,
              { vars: configVars }
            );

            // 获取所有可用平台（原有 + 新下载）
            const { existing: replaceExisting } = await store.checkPlatformCompleteness(
              dependency.libName,
              dependency.commit,
              platforms
            );

            tx.recordOp('replace', localPath, replaceCommitPath);
            await linker.linkLib(localPath, replaceCommitPath, replaceExisting);
            savedBytes += replaceSize;

            // 更新 StoreEntry 引用
            for (const platform of replaceExisting) {
              const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, platform);
              registry.addStoreReference(storeKey, projectHash);
            }

            if (replaceSupplementResult.downloaded.length > 0) {
              success(
                `${dependency.libName} (${dependency.commit.slice(0, 7)}) - Store 已有，创建链接并补充平台 [${replaceExisting.join(', ')}]`
              );
            } else {
              success(
                `${dependency.libName} (${dependency.commit.slice(0, 7)}) - Store 已有，创建链接 [${replaceExisting.join(', ')}]`
              );
            }
          }
          break;
        }

        case DependencyStatus.ABSORB: {
          // 移入 Store（吸收本地目录所有平台内容）
          const storeCommitPath = path.join(storePath, dependency.libName, dependency.commit);

          // 1. 扫描本地平台目录
          const { KNOWN_PLATFORM_VALUES } = await import('../core/platform.js');
          const localDirEntries = await fs.readdir(localPath, { withFileTypes: true });
          const localPlatforms = localDirEntries
            .filter(entry => entry.isDirectory() && KNOWN_PLATFORM_VALUES.includes(entry.name))
            .map(entry => entry.name);

          // 2. 确定最终要吸收的平台（取本地存在的 ∩ 用户选择的）
          const finalPlatforms = localPlatforms.filter(p => finalLinkPlatforms.includes(p));

          // 3. 计算大小并显示进度（只计算一次，用于进度条和 registry）
          info(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 正在分析...`);
          const absorbSize = await getDirSize(localPath);

          // 4. 创建进度追踪器（用于跨文件系统复制时显示进度）
          const progressTracker = new ProgressTracker({
            name: `  移入 Store`,
            total: absorbSize,
            showSpeed: true,
          });

          tx.recordOp('absorb', storeCommitPath, localPath);

          // 进度回调 - 只在跨文件系统时触发
          let progressStarted = false;
          const absorbResult = await store.absorbLib(
            localPath,
            finalPlatforms,
            dependency.libName,
            dependency.commit,
            {
              totalSize: absorbSize,
              onProgress: (copied, _total) => {
                if (!progressStarted) {
                  progressStarted = true;
                  progressTracker.start();
                }
                progressTracker.update(copied);
              },
            }
          );

          // 如果进度条启动了，停止它
          if (progressStarted) {
            progressTracker.stop();
          }

          // 获取所有可链接的平台（新吸收 + 已存在跳过的）
          let absorbLinkPlatforms = [...Object.keys(absorbResult.platformPaths), ...absorbResult.skippedPlatforms];

          // 兼容旧结构：先添加 LibraryInfo（供 supplementMissingPlatforms 记录 unavailablePlatforms）
          const absorbLibKey = registry.getLibraryKey(dependency.libName, dependency.commit);
          if (!registry.getLibrary(absorbLibKey)) {
            registry.addLibrary({
              libName: dependency.libName,
              commit: dependency.commit,
              branch: dependency.branch,
              url: dependency.url,
              platforms: absorbLinkPlatforms,
              size: absorbSize,
              referencedBy: [],
              createdAt: new Date().toISOString(),
              lastAccess: new Date().toISOString(),
            });
          }

          if (absorbLinkPlatforms.length > 0) {
            // 为每个平台创建 StoreEntry
            for (const platform of absorbLinkPlatforms) {
              const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, platform);
              if (!registry.getStore(storeKey)) {
                const platformSize = await store.getSize(dependency.libName, dependency.commit, platform);
                registry.addStore({
                  libName: dependency.libName,
                  commit: dependency.commit,
                  platform,
                  branch: dependency.branch,
                  url: dependency.url,
                  size: platformSize,
                  usedBy: [],
                  createdAt: new Date().toISOString(),
                  lastAccess: new Date().toISOString(),
                });
              }
            }

            // 补充缺失平台（本地没有但用户需要的）
            const absorbSupplementResult = await supplementMissingPlatforms(
              dependency,
              platforms,
              registry,
              tx,
              { vars: configVars }
            );

            // 合并所有可链接的平台
            if (absorbSupplementResult.downloaded.length > 0) {
              absorbLinkPlatforms = [...absorbLinkPlatforms, ...absorbSupplementResult.downloaded];
            }

            // 创建链接
            tx.recordOp('link', localPath, storeCommitPath);
            await linker.linkLib(localPath, storeCommitPath, absorbLinkPlatforms);

            // 添加 StoreEntry 引用
            for (const platform of absorbLinkPlatforms) {
              const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, platform);
              registry.addStoreReference(storeKey, projectHash);
            }

            if (absorbSupplementResult.downloaded.length > 0) {
              hint(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 本地已有，移入 Store 并补充平台 [${absorbLinkPlatforms.join(', ')}]`);
            } else {
              hint(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 本地已有，移入 Store [${absorbLinkPlatforms.join(', ')}]`);
            }
          } else {
            // 检测是否为 General 类型
            const sharedPath = path.join(storeCommitPath, '_shared');
            try {
              await fs.access(sharedPath);

              // 检查 _shared 目录是否有内容（防止空目录静默成功）
              const sharedEntries = await fs.readdir(sharedPath);
              if (sharedEntries.length === 0) {
                warn(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - _shared 目录为空，请重新下载源文件后再 link`);
                break;
              }

              // General 类型：整目录链接
              const { GENERAL_PLATFORM } = await import('../core/platform.js');

              tx.recordOp('link', localPath, sharedPath);
              await linker.linkGeneral(localPath, sharedPath);

              // Registry: StoreEntry 记录
              const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, GENERAL_PLATFORM);
              if (!registry.getStore(storeKey)) {
                const sharedSize = await getDirSize(sharedPath);
                registry.addStore({
                  libName: dependency.libName,
                  commit: dependency.commit,
                  platform: GENERAL_PLATFORM,
                  branch: dependency.branch,
                  url: dependency.url,
                  size: sharedSize,
                  usedBy: [],
                  createdAt: new Date().toISOString(),
                  lastAccess: new Date().toISOString(),
                });
              }
              registry.addStoreReference(storeKey, projectHash);

              // Registry: LibraryInfo 兼容记录
              const libKey = registry.getLibraryKey(dependency.libName, dependency.commit);
              if (!registry.getLibrary(libKey)) {
                const sharedSize = await getDirSize(sharedPath);
                registry.addLibrary({
                  libName: dependency.libName,
                  commit: dependency.commit,
                  branch: dependency.branch,
                  url: dependency.url,
                  platforms: [GENERAL_PLATFORM],
                  size: sharedSize,
                  referencedBy: [],
                  createdAt: new Date().toISOString(),
                  lastAccess: new Date().toISOString(),
                });
              }
              registry.addReference(libKey, projectHash);

              // 记录为 General 库
              generalLibs.add(dependency.libName);

              hint(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - General 库，整目录链接`);
            } catch {
              // _shared 也不存在
              warn(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 本地目录不含任何内容，跳过`);
            }
          }
          break;
        }

        case DependencyStatus.MISSING:
          // 跳过，后续并行处理
          break;

        case DependencyStatus.LINK_NEW: {
          // Store 已有（至少一个平台），本地无，检查平台完整性并补充缺失平台
          const linkNewCommitPath = path.join(storePath, dependency.libName, dependency.commit);

          // 1. 检查平台完整性
          const { missing } = await store.checkPlatformCompleteness(
            dependency.libName,
            dependency.commit,
            platforms
          );

          // 2. 如果有缺失平台，下载并吸收
          if (missing.length > 0) {
            info(`${dependency.libName} 缺少平台 [${missing.join(', ')}]，开始下载...`);

            // 查找历史记录中的大小估算
            const linkNewLibKey = registry.getLibraryKey(dependency.libName, dependency.commit);
            const linkNewHistoryLib = registry.getLibrary(linkNewLibKey);

            // 创建下载进度监控器
            const linkNewMonitor = new DownloadMonitor({
              name: `  ${dependency.libName}`,
              estimatedSize: linkNewHistoryLib?.size,
              getDirSize,
            });

            const downloadResult = await codepac.downloadToTemp({
              url: dependency.url,
              commit: dependency.commit,
              branch: dependency.branch,
              libName: dependency.libName,
              platforms: missing,
              sparse: dependency.sparse,
              vars: configVars,
              onTempDirCreated: (_tempDir, libDir) => {
                linkNewMonitor.start(libDir);
              },
            });

            // 停止进度监控
            await linkNewMonitor.stop();

            try {
              // 过滤：只保留实际下载的且在 missing 列表中的平台
              const filteredDownloaded = downloadResult.platformDirs.filter(p => missing.includes(p));
              if (filteredDownloaded.length > 0) {
                tx.recordOp('absorb', linkNewCommitPath, downloadResult.libDir);
                await store.absorbLib(
                  downloadResult.libDir,
                  filteredDownloaded,
                  dependency.libName,
                  dependency.commit
                );
              }
            } finally {
              // 清理临时目录
              await fs.rm(downloadResult.tempDir, { recursive: true, force: true }).catch(() => {});
            }
          }

          // 3. 获取 Store 中实际存在的平台（下载后可能仍有缺失）
          const { existing: linkNewExisting } = await store.checkPlatformCompleteness(
            dependency.libName,
            dependency.commit,
            platforms
          );

          // 4. 检测是否为 General 库
          const isLinkNewGeneral = await store.isGeneralLib(dependency.libName, dependency.commit);

          if (isLinkNewGeneral) {
            // General 库：整目录链接
            const sharedPath = path.join(linkNewCommitPath, '_shared');
            tx.recordOp('link', localPath, sharedPath);
            await linker.linkGeneral(localPath, sharedPath);

            // StoreEntry 记录
            const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, GENERAL_PLATFORM);
            if (!registry.getStore(storeKey)) {
              const sharedSize = await getDirSize(sharedPath);
              registry.addStore({
                libName: dependency.libName,
                commit: dependency.commit,
                platform: GENERAL_PLATFORM,
                branch: dependency.branch,
                url: dependency.url,
                size: sharedSize,
                usedBy: [],
                createdAt: new Date().toISOString(),
                lastAccess: new Date().toISOString(),
              });
            }
            registry.addStoreReference(storeKey, projectHash);

            // 记录为 General 库
            generalLibs.add(dependency.libName);

            success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - General 库，创建链接`);
          } else {
            // 普通库：linkLib 实际存在的平台
            tx.recordOp('link', localPath, linkNewCommitPath);
            await linker.linkLib(localPath, linkNewCommitPath, linkNewExisting);

            // 5. 为每个实际存在的平台添加 StoreReference
            for (const platform of linkNewExisting) {
              const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, platform);
              // 如果 StoreEntry 不存在，创建它
              if (!registry.getStore(storeKey)) {
                const platformSize = await store.getSize(dependency.libName, dependency.commit, platform);
                registry.addStore({
                  libName: dependency.libName,
                  commit: dependency.commit,
                  platform,
                  branch: dependency.branch,
                  url: dependency.url,
                  size: platformSize,
                  usedBy: [],
                  createdAt: new Date().toISOString(),
                  lastAccess: new Date().toISOString(),
                });
              }
              registry.addStoreReference(storeKey, projectHash);
            }

            success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 创建链接 [${linkNewExisting.join(', ')}]`);
          }
          break;
        }
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
        info(`开始并行下载 ${toDownload.length} 个库 (最多 ${concurrency} 个并发)...`);
        blank();

        // 并行控制器
        const downloadLimit = pLimit(concurrency);

        // 为每个库下载所有选中的平台（使用 downloadToTemp + absorbLib + linkLib 新流程）
        const downloadTasks = toDownload.map((item) =>
          downloadLimit(async () => {
            const { dependency, localPath } = item;

            try {
              const storeCommitPath = path.join(storePath, dependency.libName, dependency.commit);

              // 0. 检查平台完整性：避免重复下载已存在的平台
              const { existing, missing } = await store.checkPlatformCompleteness(
                dependency.libName,
                dependency.commit,
                platforms
              );

              // 如果全部平台已存在，直接 linkLib，无需下载
              if (missing.length === 0) {
                info(`${dependency.libName} 所有平台已存在，直接链接...`);
                tx.recordOp('link', localPath, storeCommitPath);
                await linker.linkLib(localPath, storeCommitPath, platforms);

                // 为每个平台创建 StoreEntry 并添加引用
                for (const platform of platforms) {
                  const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, platform);
                  if (!registry.getStore(storeKey)) {
                    const platformSize = await store.getSize(dependency.libName, dependency.commit, platform);
                    registry.addStore({
                      libName: dependency.libName,
                      commit: dependency.commit,
                      platform,
                      branch: dependency.branch,
                      url: dependency.url,
                      size: platformSize,
                      usedBy: [],
                      createdAt: new Date().toISOString(),
                      lastAccess: new Date().toISOString(),
                    });
                  }
                  registry.addStoreReference(storeKey, projectHash);
                }

                // 兼容旧结构：也添加 LibraryInfo
                const libKey = registry.getLibraryKey(dependency.libName, dependency.commit);
                if (!registry.getLibrary(libKey)) {
                  let totalSize = 0;
                  for (const platform of platforms) {
                    totalSize += await store.getSize(dependency.libName, dependency.commit, platform);
                  }
                  registry.addLibrary({
                    libName: dependency.libName,
                    commit: dependency.commit,
                    branch: dependency.branch,
                    url: dependency.url,
                    platforms,
                    size: totalSize,
                    referencedBy: [],
                    createdAt: new Date().toISOString(),
                    lastAccess: new Date().toISOString(),
                  });
                }
                registry.addReference(libKey, projectHash);

                success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 链接完成 [${platforms.join(', ')}]`);
                return {
                  success: true,
                  name: dependency.libName,
                  downloadedPlatforms: platforms,
                  skippedPlatforms: [],
                };
              }

              // 查找历史记录，检查已知不可用的平台
              const libKey = registry.getLibraryKey(dependency.libName, dependency.commit);
              const historyLib = registry.getLibrary(libKey);
              const unavailablePlatforms = historyLib?.unavailablePlatforms || [];

              // 过滤掉已知不可用的平台
              const toDownload = missing.filter(p => !unavailablePlatforms.includes(p));
              const knownUnavailable = missing.filter(p => unavailablePlatforms.includes(p));

              // 如果所有缺失平台都已知不可用，跳过下载
              if (toDownload.length === 0) {
                if (knownUnavailable.length > 0) {
                  warn(`${dependency.libName} 平台 [${knownUnavailable.join(', ')}] 不支持（远程不存在）`);
                }
                return {
                  success: false,
                  name: dependency.libName,
                  skipped: true,
                  skippedPlatforms: missing,
                  unsupported: true,
                };
              }

              // 只下载未知状态的平台
              info(`下载 ${dependency.libName} [${toDownload.join(', ')}]...`);

              const estimatedSize = historyLib?.size;

              // 创建下载进度监控器
              const downloadMonitor = new DownloadMonitor({
                name: `  ${dependency.libName}`,
                estimatedSize,
                getDirSize,
              });

              // 1. 调用 downloadToTemp 只下载需要的平台（排除已知不可用的）
              const downloadResult = await codepac.downloadToTemp({
                url: dependency.url,
                commit: dependency.commit,
                branch: dependency.branch,
                libName: dependency.libName,
                platforms: toDownload,
                sparse: dependency.sparse,
                vars: configVars,
                onTempDirCreated: (_tempDir, libDir) => {
                  // 临时目录创建后启动进度监控
                  downloadMonitor.start(libDir);
                },
              });

              // 停止进度监控
              await downloadMonitor.stop();

              try {
                // 2. 检测是否为 General 库（没有 sparse 配置且没有平台目录）
                const isNewGeneral = !dependency.sparse && downloadResult.platformDirs.length === 0;

                if (isNewGeneral) {
                  // General 库：把整个下载内容移到 _shared
                  tx.recordOp('absorb', storeCommitPath, downloadResult.libDir);
                  await store.absorbGeneral(downloadResult.libDir, dependency.libName, dependency.commit);

                  // 创建链接
                  const sharedPath = path.join(storeCommitPath, '_shared');
                  tx.recordOp('link', localPath, sharedPath);
                  await linker.linkGeneral(localPath, sharedPath);

                  // StoreEntry 记录
                  const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, GENERAL_PLATFORM);
                  if (!registry.getStore(storeKey)) {
                    const sharedSize = await getDirSize(sharedPath);
                    registry.addStore({
                      libName: dependency.libName,
                      commit: dependency.commit,
                      platform: GENERAL_PLATFORM,
                      branch: dependency.branch,
                      url: dependency.url,
                      size: sharedSize,
                      usedBy: [],
                      createdAt: new Date().toISOString(),
                      lastAccess: new Date().toISOString(),
                    });
                  }
                  registry.addStoreReference(storeKey, projectHash);

                  // LibraryInfo 兼容记录
                  const libKey = registry.getLibraryKey(dependency.libName, dependency.commit);
                  if (!registry.getLibrary(libKey)) {
                    const sharedSize = await getDirSize(sharedPath);
                    registry.addLibrary({
                      libName: dependency.libName,
                      commit: dependency.commit,
                      branch: dependency.branch,
                      url: dependency.url,
                      platforms: [GENERAL_PLATFORM],
                      size: sharedSize,
                      referencedBy: [],
                      createdAt: new Date().toISOString(),
                      lastAccess: new Date().toISOString(),
                    });
                  }
                  registry.addReference(libKey, projectHash);

                  // 记录为 General 库
                  generalLibs.add(dependency.libName);

                  success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - General 库，下载完成`);

                  return {
                    success: true,
                    name: dependency.libName,
                    downloadedPlatforms: [GENERAL_PLATFORM],
                    skippedPlatforms: [],
                    isGeneral: true,
                  };
                }

                // 3. 过滤平台：只保留实际下载的且在 toDownload 列表中的平台
                const filteredDownloaded = downloadResult.platformDirs.filter(p => toDownload.includes(p));

                // 4. 检查并记录新发现的不可用平台
                const newUnavailable = toDownload.filter(p => !filteredDownloaded.includes(p));
                if (newUnavailable.length > 0) {
                  // 更新 LibraryInfo 中的 unavailablePlatforms
                  const updateLibKey = registry.getLibraryKey(dependency.libName, dependency.commit);
                  if (historyLib) {
                    const updatedUnavailable = [...new Set([...unavailablePlatforms, ...newUnavailable])];
                    registry.updateLibrary(updateLibKey, { unavailablePlatforms: updatedUnavailable });
                  } else {
                    // 如果 LibraryInfo 不存在，先创建
                    registry.addLibrary({
                      libName: dependency.libName,
                      commit: dependency.commit,
                      branch: dependency.branch,
                      url: dependency.url,
                      platforms: [],
                      size: 0,
                      referencedBy: [],
                      unavailablePlatforms: newUnavailable,
                      createdAt: new Date().toISOString(),
                      lastAccess: new Date().toISOString(),
                    });
                  }
                  warn(`${dependency.libName} 平台 [${newUnavailable.join(', ')}] 远程不存在，已记录`);
                }

                // 5. 调用 absorbLib 将临时目录内容移入 Store（如果有下载成功的平台）
                if (filteredDownloaded.length > 0) {
                  tx.recordOp('absorb', storeCommitPath, downloadResult.libDir);
                  await store.absorbLib(
                    downloadResult.libDir,
                    filteredDownloaded,
                    dependency.libName,
                    dependency.commit
                  );
                }

                // 5. 获取所有可链接的平台（已存在 + 新下载成功的）
                const linkPlatforms = [...existing, ...filteredDownloaded];

                // 6. 检测是否为 General 库（Store 中已有 _shared）
                const isDownloadGeneral = await store.isGeneralLib(dependency.libName, dependency.commit);

                if (isDownloadGeneral) {
                  // General 库：整目录链接
                  const sharedPath = path.join(storeCommitPath, '_shared');
                  tx.recordOp('link', localPath, sharedPath);
                  await linker.linkGeneral(localPath, sharedPath);

                  // StoreEntry 记录
                  const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, GENERAL_PLATFORM);
                  if (!registry.getStore(storeKey)) {
                    const sharedSize = await getDirSize(sharedPath);
                    registry.addStore({
                      libName: dependency.libName,
                      commit: dependency.commit,
                      platform: GENERAL_PLATFORM,
                      branch: dependency.branch,
                      url: dependency.url,
                      size: sharedSize,
                      usedBy: [],
                      createdAt: new Date().toISOString(),
                      lastAccess: new Date().toISOString(),
                    });
                  }
                  registry.addStoreReference(storeKey, projectHash);

                  // LibraryInfo 兼容记录
                  const libKey = registry.getLibraryKey(dependency.libName, dependency.commit);
                  if (!registry.getLibrary(libKey)) {
                    const sharedSize = await getDirSize(sharedPath);
                    registry.addLibrary({
                      libName: dependency.libName,
                      commit: dependency.commit,
                      branch: dependency.branch,
                      url: dependency.url,
                      platforms: [GENERAL_PLATFORM],
                      size: sharedSize,
                      referencedBy: [],
                      createdAt: new Date().toISOString(),
                      lastAccess: new Date().toISOString(),
                    });
                  }
                  registry.addReference(libKey, projectHash);

                  // 记录为 General 库
                  generalLibs.add(dependency.libName);

                  success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - General 库，下载完成`);

                  return {
                    success: true,
                    name: dependency.libName,
                    downloadedPlatforms: [GENERAL_PLATFORM],
                    skippedPlatforms: [],
                    isGeneral: true,
                  };
                }

                // 普通库：无平台可链接则跳过
                if (linkPlatforms.length === 0) {
                  return {
                    success: false,
                    name: dependency.libName,
                    skipped: true,
                    skippedPlatforms: platforms,
                  };
                }

                // 6. 调用 linkLib 创建符号链接并复制共享文件
                tx.recordOp('link', localPath, storeCommitPath);
                await linker.linkLib(localPath, storeCommitPath, linkPlatforms);

                // 7. 为每个平台创建 StoreEntry 并添加引用
                for (const platform of linkPlatforms) {
                  const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, platform);
                  if (!registry.getStore(storeKey)) {
                    const platformSize = await store.getSize(dependency.libName, dependency.commit, platform);
                    registry.addStore({
                      libName: dependency.libName,
                      commit: dependency.commit,
                      platform,
                      branch: dependency.branch,
                      url: dependency.url,
                      size: platformSize,
                      usedBy: [],
                      createdAt: new Date().toISOString(),
                      lastAccess: new Date().toISOString(),
                    });
                  }
                  registry.addStoreReference(storeKey, projectHash);
                }

                // 兼容旧结构：也添加 LibraryInfo
                const libKey = registry.getLibraryKey(dependency.libName, dependency.commit);
                if (!registry.getLibrary(libKey)) {
                  let totalSize = 0;
                  for (const platform of linkPlatforms) {
                    totalSize += await store.getSize(dependency.libName, dependency.commit, platform);
                  }
                  registry.addLibrary({
                    libName: dependency.libName,
                    commit: dependency.commit,
                    branch: dependency.branch,
                    url: dependency.url,
                    platforms: linkPlatforms,
                    size: totalSize,
                    referencedBy: [],
                    createdAt: new Date().toISOString(),
                    lastAccess: new Date().toISOString(),
                  });
                }
                registry.addReference(libKey, projectHash);

                // 计算未能链接的平台（用户请求但未下载也未在 Store 中的）
                const notLinkedPlatforms = platforms.filter((p) => !linkPlatforms.includes(p));
                success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 下载完成 [${linkPlatforms.join(', ')}]`);

                return {
                  success: true,
                  name: dependency.libName,
                  downloadedPlatforms: linkPlatforms,
                  skippedPlatforms: notLinkedPlatforms,
                };
              } finally {
                // 清理临时目录（无论成功还是失败）
                await fs.rm(downloadResult.tempDir, { recursive: true, force: true }).catch(() => {});
              }
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

    // ============ 处理嵌套依赖 (actions) ============
    const topLevelConfig = await parseCodepacDep(configPath);
    const actions = extractActions(topLevelConfig);

    // 嵌套依赖记录（用于 registry）
    const nestedLinkedDeps: Array<{
      libName: string;
      commit: string;
      platform: string;
      linkedPath: string;
    }> = [];

    if (actions.length > 0) {
      blank();
      separator();
      info(`发现 ${actions.length} 个嵌套依赖配置`);

      const nestedContext: NestedContext = {
        depth: 0,
        processedConfigs: new Set([configPath]),
        platforms,
        vars: configVars,
      };

      const thirdPartyDir = path.dirname(configPath);

      // 依次处理每个 action
      for (const action of actions) {
        await processAction(action, nestedContext, thirdPartyDir, {
          tx,
          registry,
          projectHash,
          dryRun: options.dryRun,
          download: options.download,
          yes: options.yes,
          generalLibs,
          downloadedLibs,
          nestedLinkedDeps,
        });
      }
    }

    // 获取旧引用（用于后续引用关系更新）
    const oldStoreKeys = registry.getProjectStoreKeys(projectHash);

    // 更新项目信息
    const relConfigPath = getRelativeConfigPath(absolutePath, configPath);
    // 使用主平台作为依赖的 platform 字段（兼容旧结构）
    const primaryPlatform = platforms[0];
    const topLevelDeps = classified
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
        // General 库使用 'general' 平台，普通库使用主平台
        platform: generalLibs.has(c.dependency.libName) ? GENERAL_PLATFORM : primaryPlatform,
        linkedPath: path.relative(absolutePath, c.localPath),
      }));

    // 合并顶层依赖和嵌套依赖
    const newDependencies = [...topLevelDeps, ...nestedLinkedDeps];

    registry.addProject({
      path: absolutePath,
      configPath: relConfigPath,
      lastLinked: new Date().toISOString(),
      platforms: finalLinkPlatforms, // 记录实际链接的平台（包括用户选择的额外平台）
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

    // 同步 cache 文件（兼容 codepac 的 checkValid.js 检测）
    await syncCacheFile(configPath);

    // 显示统计
    blank();
    separator();
    const topLevelLinked =
      stats.linked +
      stats.relink +
      stats.replace +
      stats.absorb +
      stats.linkNew +
      downloadedLibs.length;
    const nestedLinked = nestedLinkedDeps.length;
    const totalLinked = topLevelLinked + nestedLinked;
    if (nestedLinked > 0) {
      info(`完成: 链接 ${totalLinked} 个库 (顶层 ${topLevelLinked}, 嵌套 ${nestedLinked})`);
    } else {
      info(`完成: 链接 ${totalLinked} 个库`);
    }
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
 * @param platforms 请求的平台列表
 */
async function classifyDependencies(
  dependencies: ParsedDependency[],
  projectPath: string,
  configPath: string,
  platforms: string[]
): Promise<ClassifiedDependency[]> {
  const result: ClassifiedDependency[] = [];
  const thirdPartyDir = path.dirname(configPath);
  const storePath = await store.getStorePath();
  const primaryPlatform = platforms[0];

  for (const dep of dependencies) {
    const localPath = path.join(thirdPartyDir, dep.libName);
    const storeLibPath = store.getLibraryPath(storePath, dep.libName, dep.commit, primaryPlatform);

    // 检查 Store 中是否有任意请求的平台（而非只检查主平台）
    const { existing } = await store.checkPlatformCompleteness(dep.libName, dep.commit, platforms);
    // 也检查是否为 General 库（有 _shared 且有内容）
    const isGeneral = await store.isGeneralLib(dep.libName, dep.commit);
    const inStore = existing.length > 0 || isGeneral;

    // General 库的目标路径是 _shared，而不是平台目录
    const expectedTarget = isGeneral
      ? path.join(storePath, dep.libName, dep.commit, '_shared')
      : storeLibPath;
    const pathStatus = await linker.getPathStatus(localPath, expectedTarget);

    let status: DependencyStatus;

    if (inStore) {
      if (isGeneral) {
        // General 库：检查根目录符号链接状态
        switch (pathStatus) {
          case 'linked':
            status = DependencyStatus.LINKED;
            break;
          case 'wrong_link':
            status = DependencyStatus.RELINK;
            break;
          case 'broken_link':
            // 断链：Store 目标被删除，需要重新链接
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
        // 平台库：检查各平台子目录的链接状态
        const storeCommitPath = path.join(storePath, dep.libName, dep.commit);
        let allLinked = true;
        let hasWrongLink = false;
        let hasBrokenLink = false;
        let checkedCount = 0;

        for (const platform of existing) {
          const platformLocalPath = path.join(localPath, platform);
          const platformStorePath = path.join(storeCommitPath, platform);
          const platformStatus = await linker.getPathStatus(platformLocalPath, platformStorePath);

          checkedCount++;
          if (platformStatus !== 'linked') {
            allLinked = false;
            if (platformStatus === 'wrong_link') {
              hasWrongLink = true;
            } else if (platformStatus === 'broken_link') {
              hasBrokenLink = true;
            }
          }
        }

        if (checkedCount > 0 && allLinked) {
          status = DependencyStatus.LINKED;
        } else if (hasWrongLink || hasBrokenLink) {
          // 有错误链接或断链，需要重新链接
          status = DependencyStatus.RELINK;
        } else if (pathStatus === 'missing') {
          status = DependencyStatus.LINK_NEW;
        } else {
          status = DependencyStatus.REPLACE;
        }
      }
    } else {
      switch (pathStatus) {
        case 'directory': {
          // 检查本地目录是否是"之前链接的残留"（平台子目录是符号链接指向旧 commit）
          // 如果是，应该走 MISSING 而不是 ABSORB，因为本地没有新 commit 的实际内容
          const { KNOWN_PLATFORM_VALUES } = await import('../core/platform.js');
          const localEntries = await fs.readdir(localPath, { withFileTypes: true });
          const platformSymlinks = localEntries.filter(
            (entry) => entry.isSymbolicLink() && KNOWN_PLATFORM_VALUES.includes(entry.name)
          );

          if (platformSymlinks.length > 0) {
            // 本地平台目录是符号链接，说明是之前链接过的，新 commit 需要下载
            status = DependencyStatus.MISSING;
          } else {
            // 验证本地库的 commit 是否与预期一致
            const verifyResult = await verifyLocalCommit(localPath, dep.commit);

            switch (verifyResult.reason) {
              case 'match':
                // commit 匹配，正常吸收
                status = DependencyStatus.ABSORB;
                break;
              case 'mismatch':
                // commit 不匹配，输出警告并走下载流程
                warn(
                  `${dep.libName}: 本地 commit (${verifyResult.actualCommit?.slice(0, 7)}) 与预期 (${dep.commit.slice(0, 7)}) 不匹配，将重新下载`
                );
                status = DependencyStatus.MISSING;
                break;
              case 'no_git':
                // 无 .git 目录，根据配置决定策略
                const cfg = await config.load();
                const strategy = cfg?.unverifiedLocalStrategy ?? 'download';

                if (strategy === 'absorb') {
                  // 配置为 absorb，继续吸收
                  info(`${dep.libName}: 本地无 .git 目录，按配置直接吸收`);
                  status = DependencyStatus.ABSORB;
                } else {
                  // 配置为 download（默认），走下载流程
                  warn(`${dep.libName}: 本地无 .git 目录，无法验证 commit，将重新下载`);
                  status = DependencyStatus.MISSING;
                }
                break;
            }
          }
          break;
        }
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
 * 补充缺失平台
 * 检查 Store 是否缺少用户需要的平台，如果缺少则尝试下载
 */
interface SupplementOptions {
  forceDownload?: boolean;
  /** codepac 变量定义（用于解析 sparse 中的变量引用） */
  vars?: Record<string, string>;
}

interface SupplementResult {
  downloaded: string[];
  unavailable: string[];
}

async function supplementMissingPlatforms(
  dependency: ParsedDependency,
  platforms: string[],
  registry: ReturnType<typeof getRegistry>,
  tx: Transaction,
  options: SupplementOptions = {}
): Promise<SupplementResult> {
  const result: SupplementResult = { downloaded: [], unavailable: [] };

  // 1. 检查平台完整性
  const { missing } = await store.checkPlatformCompleteness(
    dependency.libName,
    dependency.commit,
    platforms
  );

  if (missing.length === 0) {
    return result;
  }

  // 2. 获取已知不可用平台
  const libKey = registry.getLibraryKey(dependency.libName, dependency.commit);
  const libInfo = registry.getLibrary(libKey);
  const unavailablePlatforms = libInfo?.unavailablePlatforms || [];

  // 3. 计算需要下载的平台（排除已知不可用的，除非强制下载）
  const toDownload = options.forceDownload
    ? missing
    : missing.filter((p) => !unavailablePlatforms.includes(p));

  if (toDownload.length === 0) {
    // 所有缺失平台都是已知不可用的
    if (missing.length > 0) {
      hint(`${dependency.libName} 平台 [${missing.join(', ')}] 远程不存在（已记录）`);
    }
    result.unavailable = missing.filter((p) => unavailablePlatforms.includes(p));
    return result;
  }

  // 4. 尝试下载
  info(`${dependency.libName} 缺少平台 [${toDownload.join(', ')}]，尝试下载...`);

  try {
    const downloadResult = await codepac.downloadToTemp({
      url: dependency.url,
      commit: dependency.commit,
      branch: dependency.branch,
      libName: dependency.libName,
      platforms: toDownload,
      sparse: dependency.sparse,
      vars: options.vars,
    });

    try {
      // 5. 检查实际下载了什么
      const downloaded = downloadResult.platformDirs.filter((p) => toDownload.includes(p));
      result.downloaded = downloaded;

      // 6. 记录新发现的不可用平台
      const notFound = toDownload.filter((p) => !downloaded.includes(p));
      if (notFound.length > 0) {
        result.unavailable = notFound;
        // 更新 LibraryInfo（如果存在）
        if (libInfo) {
          const newUnavailable = [...new Set([...unavailablePlatforms, ...notFound])];
          registry.updateLibrary(libKey, { unavailablePlatforms: newUnavailable });
        }
        warn(`${dependency.libName} 平台 [${notFound.join(', ')}] 远程不存在，已记录`);
      }

      // 7. 吸收下载的内容到 Store（不做链接，由调用者负责）
      if (downloaded.length > 0) {
        const storePath = await store.getStorePath();
        const storeCommitPath = path.join(storePath, dependency.libName, dependency.commit);

        tx.recordOp('absorb', storeCommitPath, downloadResult.libDir);
        await store.absorbLib(
          downloadResult.libDir,
          downloaded,
          dependency.libName,
          dependency.commit
        );

        // 8. 更新 Registry StoreEntry
        for (const platform of downloaded) {
          const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, platform);
          if (!registry.getStore(storeKey)) {
            const platformSize = await store.getSize(dependency.libName, dependency.commit, platform);
            registry.addStore({
              libName: dependency.libName,
              commit: dependency.commit,
              platform,
              branch: dependency.branch,
              url: dependency.url,
              size: platformSize,
              usedBy: [],
              createdAt: new Date().toISOString(),
              lastAccess: new Date().toISOString(),
            });
          }
        }

        success(`${dependency.libName} 已补充平台 [${downloaded.join(', ')}]`);
      }
    } finally {
      // 清理临时目录
      await fs.rm(downloadResult.tempDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    warn(`${dependency.libName} 下载失败: ${(err as Error).message}`);
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

/**
 * 同步配置文件到 cache 目录
 * 使 cmake 的 checkValid.js 检测能够通过
 */
async function syncCacheFile(configPath: string): Promise<void> {
  const configDir = path.dirname(configPath);
  const cacheDir = path.join(configDir, '.cache');
  const cachePath = path.join(cacheDir, 'codepac-dep.json');

  try {
    // 确保 .cache 目录存在
    await fs.mkdir(cacheDir, { recursive: true });

    // 复制配置文件到 cache
    await fs.copyFile(configPath, cachePath);

    if (process.env.VERBOSE) {
      info(`已同步 cache: ${path.basename(configPath)}`);
    }
  } catch (err) {
    // cache 同步失败不应阻塞主流程，仅警告
    warn(`cache 同步失败: ${(err as Error).message}`);
  }
}

// ============ 嵌套依赖处理 ============

/**
 * processAction 的选项
 */
/**
 * 嵌套依赖记录
 */
interface NestedLinkedDep {
  libName: string;
  commit: string;
  platform: string;
  linkedPath: string;
}

interface ProcessActionOptions {
  tx: Transaction;
  registry: ReturnType<typeof getRegistry>;
  projectHash: string;
  dryRun: boolean;
  download: boolean;
  yes: boolean;
  generalLibs: Set<string>;
  downloadedLibs: string[];
  nestedLinkedDeps: NestedLinkedDep[];
}

/**
 * 处理单个 action（嵌套依赖）
 * @param action action 配置
 * @param context 嵌套上下文
 * @param thirdPartyDir 3rdparty 目录路径
 * @param options 处理选项
 */
async function processAction(
  action: ActionConfig,
  context: NestedContext,
  thirdPartyDir: string,
  options: ProcessActionOptions
): Promise<void> {
  const indent = '  '.repeat(context.depth);

  // 1. 解析 action 命令
  let parsed;
  try {
    parsed = parseActionCommand(action.command);
  } catch (err) {
    warn(`${indent}无法解析 action: ${(err as Error).message}`);
    return;
  }

  const libsDisplay = parsed.libraries.length > 0 ? parsed.libraries.join(', ') : '全部依赖';
  info(`${indent}处理嵌套依赖: ${parsed.configDir} → [${libsDisplay}]`);

  // 2. 构建嵌套配置路径
  const nestedConfigPath = path.join(thirdPartyDir, parsed.configDir, 'codepac-dep.json');

  // 3. 循环检测
  if (context.processedConfigs.has(nestedConfigPath)) {
    warn(`${indent}  检测到循环依赖，跳过: ${parsed.configDir}`);
    return;
  }
  context.processedConfigs.add(nestedConfigPath);

  // 4. 检查配置文件是否存在
  try {
    await fs.access(nestedConfigPath);
  } catch {
    warn(`${indent}  嵌套配置文件不存在: ${nestedConfigPath}`);
    hint(`${indent}  请确保 ${parsed.configDir} 库已被下载`);
    return;
  }

  // 5. 提取指定库的依赖
  let nestedResult;
  try {
    nestedResult = await extractNestedDependencies(nestedConfigPath, parsed.libraries);
  } catch (err) {
    warn(`${indent}  解析嵌套配置失败: ${(err as Error).message}`);
    return;
  }

  const { dependencies, vars, nestedActions } = nestedResult;

  if (dependencies.length === 0) {
    warn(`${indent}  在 ${parsed.configDir} 中未找到指定的库`);
    return;
  }

  info(`${indent}  找到 ${dependencies.length} 个嵌套依赖`);

  // 6. 合并变量
  const mergedVars = { ...context.vars, ...vars };

  // 7. 处理这些依赖（targetDir 指定嵌套依赖的目标目录）
  await linkNestedDependencies(dependencies, {
    thirdPartyDir,
    targetDir: parsed.targetDir,
    nestedConfigPath,
    context: { ...context, vars: mergedVars },
    options,
    indent,
  });

  // 8. 递归处理嵌套 actions（如果没有 disable_action）
  // 注意：递归时 thirdPartyDir 应该更新为当前嵌套依赖的目标目录
  if (!parsed.disableAction && nestedActions.length > 0) {
    const nestedContext: NestedContext = {
      depth: context.depth + 1,
      processedConfigs: context.processedConfigs,
      platforms: context.platforms,
      vars: mergedVars,
    };
    const nestedThirdPartyDir = path.join(thirdPartyDir, parsed.targetDir);

    for (const nestedAction of nestedActions) {
      await processAction(nestedAction, nestedContext, nestedThirdPartyDir, options);
    }
  }
}

/**
 * 链接嵌套依赖
 */
async function linkNestedDependencies(
  dependencies: ParsedDependency[],
  params: {
    thirdPartyDir: string;
    targetDir: string;
    nestedConfigPath: string;
    context: NestedContext;
    options: ProcessActionOptions;
    indent: string;
  }
): Promise<void> {
  const { thirdPartyDir, targetDir, nestedConfigPath, context, options, indent } = params;
  // 计算嵌套依赖的实际目标目录
  const nestedTargetDir = path.join(thirdPartyDir, targetDir);
  const { tx, registry, projectHash, dryRun, download, generalLibs, downloadedLibs, nestedLinkedDeps } = options;
  const { platforms, vars } = context;
  const primaryPlatform = platforms[0];

  for (const dep of dependencies) {
    const localPath = path.join(nestedTargetDir, dep.libName);
    const storePath = await store.getStorePath();
    const storeCommitPath = path.join(storePath, dep.libName, dep.commit);

    // 检查本地状态
    let localExists = false;
    let localIsSymlink = false;
    try {
      const stat = await fs.lstat(localPath);
      localExists = true;
      localIsSymlink = stat.isSymbolicLink();
    } catch {
      // 不存在
    }

    // 检查 Store 状态
    let storeHas = false;
    for (const p of platforms) {
      if (await store.exists(dep.libName, dep.commit, p)) {
        storeHas = true;
        break;
      }
    }
    const isGeneral = await store.isGeneralLib(dep.libName, dep.commit);

    if (localExists && localIsSymlink) {
      // 已经是符号链接，检查是否正确
      const target = await linker.readLink(localPath);
      if (target && target.startsWith(storePath)) {
        // 记录到 nestedLinkedDeps
        nestedLinkedDeps.push({
          libName: dep.libName,
          commit: dep.commit,
          platform: isGeneral ? GENERAL_PLATFORM : primaryPlatform,
          linkedPath: path.relative(thirdPartyDir.replace(/\/3rdparty$/, ''), localPath),
        });
        success(`${indent}  ${dep.libName} - 已链接`);
        continue;
      }
    }

    if (storeHas || isGeneral) {
      // Store 有，创建链接
      if (dryRun) {
        info(`${indent}  ${dep.libName} - 将链接到 Store`);
        continue;
      }

      if (localExists && !localIsSymlink) {
        // 本地是目录，先删除
        await fs.rm(localPath, { recursive: true, force: true });
      }

      if (isGeneral) {
        const sharedPath = path.join(storeCommitPath, '_shared');
        tx.recordOp('link', localPath, sharedPath);
        await linker.linkGeneral(localPath, sharedPath);
        generalLibs.add(dep.libName);
        // 记录到 nestedLinkedDeps
        nestedLinkedDeps.push({
          libName: dep.libName,
          commit: dep.commit,
          platform: GENERAL_PLATFORM,
          linkedPath: path.relative(thirdPartyDir.replace(/\/3rdparty$/, ''), localPath),
        });
        success(`${indent}  ${dep.libName} - 链接完成 (General)`);
      } else {
        tx.recordOp('link', localPath, storeCommitPath);
        await linker.linkLib(localPath, storeCommitPath, platforms);
        // 记录到 nestedLinkedDeps
        nestedLinkedDeps.push({
          libName: dep.libName,
          commit: dep.commit,
          platform: primaryPlatform,
          linkedPath: path.relative(thirdPartyDir.replace(/\/3rdparty$/, ''), localPath),
        });
        success(`${indent}  ${dep.libName} - 链接完成 [${platforms.join(', ')}]`);
      }
    } else if (download) {
      // Store 没有，需要下载
      info(`${indent}  ${dep.libName} - 下载中...`);

      if (dryRun) {
        info(`${indent}  ${dep.libName} - 将下载`);
        continue;
      }

      try {
        const downloadResult = await codepac.downloadToTemp({
          url: dep.url,
          commit: dep.commit,
          branch: dep.branch,
          libName: dep.libName,
          platforms,
          sparse: dep.sparse,
          vars,
        });

        // 检测是否为 General 库
        const isNewGeneral = !dep.sparse && downloadResult.platformDirs.length === 0;

        if (isNewGeneral) {
          // General 库处理
          tx.recordOp('absorb', storeCommitPath, downloadResult.libDir);
          await store.absorbGeneral(downloadResult.libDir, dep.libName, dep.commit);

          const sharedPath = path.join(storeCommitPath, '_shared');
          tx.recordOp('link', localPath, sharedPath);
          await linker.linkGeneral(localPath, sharedPath);
          generalLibs.add(dep.libName);
          downloadedLibs.push(dep.libName);
          // 记录到 nestedLinkedDeps
          nestedLinkedDeps.push({
            libName: dep.libName,
            commit: dep.commit,
            platform: GENERAL_PLATFORM,
            linkedPath: path.relative(thirdPartyDir.replace(/\/3rdparty$/, ''), localPath),
          });
          success(`${indent}  ${dep.libName} - 下载完成 (General)`);
        } else if (downloadResult.platformDirs.length > 0) {
          // 平台库处理
          tx.recordOp('absorb', storeCommitPath, downloadResult.libDir);
          await store.absorbLib(
            downloadResult.libDir,
            downloadResult.platformDirs,
            dep.libName,
            dep.commit
          );

          tx.recordOp('link', localPath, storeCommitPath);
          await linker.linkLib(localPath, storeCommitPath, downloadResult.platformDirs);
          downloadedLibs.push(dep.libName);
          // 记录到 nestedLinkedDeps
          nestedLinkedDeps.push({
            libName: dep.libName,
            commit: dep.commit,
            platform: primaryPlatform,
            linkedPath: path.relative(thirdPartyDir.replace(/\/3rdparty$/, ''), localPath),
          });
          success(`${indent}  ${dep.libName} - 下载完成 [${downloadResult.platformDirs.join(', ')}]`);
        } else {
          warn(`${indent}  ${dep.libName} - 下载成功但无可用平台`);
        }

        // 清理临时目录
        try {
          await fs.rm(downloadResult.tempDir, { recursive: true, force: true });
        } catch {
          // 忽略清理错误
        }
      } catch (err) {
        warn(`${indent}  ${dep.libName} - 下载失败: ${(err as Error).message}`);
      }
    } else {
      warn(`${indent}  ${dep.libName} - 缺失 (跳过下载)`);
    }
  }
}

export default createLinkCommand;
