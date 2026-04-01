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
  findAllCodepacConfigs,
  extractDependencies,
  resolveProjectRootPath,
} from '../core/parser.js';
import type { OptionalConfigInfo } from '../core/parser.js';
import { getRegistry } from '../core/registry.js';
import * as store from '../core/store.js';
import type { NestedAbsorbInfo, AbsorbLocalResult } from '../core/store.js';
import * as linker from '../core/linker.js';
import * as codepac from '../core/codepac.js';
import { setProxyConfig } from '../core/codepac.js';
import { resolvePath, getPlatformHelpText, GENERAL_PLATFORM, SHARED_PLATFORM, pathsEqual, isSparseOnlyCommon, KNOWN_PLATFORM_VALUES } from '../core/platform.js';
import { Transaction } from '../core/transaction.js';
import { formatSize, checkDiskSpace } from '../utils/disk.js';
import { getDirSize, getDirectoryIntegrity } from '../utils/fs-utils.js';
import { ProgressTracker, DownloadMonitor, MultiBarManager } from '../utils/progress.js';
import { success, warn, error, info, hint, blank, separator, debug } from '../utils/logger.js';
import { verifyLocalCommit, findSubmoduleConfigs } from '../utils/git.js';
import type { SubmoduleConfig } from '../utils/git.js';
import { DependencyStatus } from '../types/index.js';
import type { ParsedDependency, ClassifiedDependency, ActionConfig, NestedContext, StoreEntry } from '../types/index.js';
import { withGlobalLock } from '../utils/global-lock.js';
import { confirmAction, selectPlatforms, parsePlatformArgs, selectOption, selectOptionalConfigs, PROMPT_CANCELLED } from '../utils/prompt.js';
import type { OptionalConfig, SelectOptionalConfigsOptions } from '../utils/prompt.js';
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
    .option('--config <configs...>', '指定可选配置文件 (如 codepac-dep-inner.json)')
    .option('--no-submodules', '不检测 git submodule 依赖')
    .addHelpText(
      'after',
      `${getPlatformHelpText()}

示例:
  td link                       链接当前目录项目
  td link ~/MyProject           链接指定路径项目
  td link -p mac                只链接 macOS 平台
  td link -p mac android        链接多个平台
  td link --dry-run             预览操作，不实际执行
  td link -y                    跳过确认，自动执行
  td link --config codepac-dep-inner.json   使用指定的可选配置
  td link --no-submodules       跳过 git submodule 检测`
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
  config?: string[];
  submodules: boolean; // commander --no-xxx 自动为 boolean，默认 true
}

// ============ linkScope 接口定义 ============

interface LinkScopeParams {
  scopeName: string;
  configPath: string;
  platforms: string[];
  finalLinkPlatforms: string[];
  scanExtraPlatforms: boolean;
  registry: ReturnType<typeof getRegistry>;
  tx: Transaction;
  projectHash: string;
  projectRoot: string;
  storePath: string;
  download: boolean;
  dryRun: boolean;
  yes: boolean;
  concurrency: number;
  optionalConfigs?: OptionalConfigInfo[];
  scope?: string;
}

interface LinkScopeResult {
  linkedDeps: Array<{ libName: string; commit: string; platform: string; linkedPath: string; scope?: string }>;
  nestedLinkedDeps: NestedLinkedDep[];
  generalLibs: Set<string>;
  downloadedLibs: string[];
  savedBytes: number;
  finalLinkPlatforms: string[];
  stats: {
    linked: number;
    relink: number;
    replace: number;
    absorb: number;
    missing: number;
    linkNew: number;
  };
}

interface DownloadAssessment {
  downloadedRequested: string[];
  unavailableRequested: string[];
  hasAnyPlatformArtifacts: boolean;
  isPureGeneral: boolean;
}

export function assessDownloadResult(
  requestedPlatforms: string[],
  sparse: ParsedDependency['sparse'],
  downloadResult: codepac.DownloadResult
): DownloadAssessment {
  const downloadedRequested = downloadResult.platformDirs.filter((platform) =>
    requestedPlatforms.includes(platform)
  );
  const unavailableRequested = requestedPlatforms.filter(
    (platform) => !downloadedRequested.includes(platform)
  );
  const hasAnyPlatformArtifacts = downloadResult.allPlatformDirs.length > 0;
  const isPureGeneral =
    (!sparse || isSparseOnlyCommon(sparse)) &&
    !hasAnyPlatformArtifacts;

  return {
    downloadedRequested,
    unavailableRequested,
    hasAnyPlatformArtifacts,
    isPureGeneral,
  };
}

function upsertLibraryAvailability(
  dependency: ParsedDependency,
  updates: {
    unavailablePlatforms?: string[];
    platforms?: string[];
    isGeneral?: boolean;
  }
): void {
  const registry = getRegistry();
  const libKey = registry.getLibraryKey(dependency.libName, dependency.commit);
  const existing = registry.getLibrary(libKey);

  if (existing) {
    registry.updateLibrary(libKey, {
      unavailablePlatforms: updates.unavailablePlatforms ?? existing.unavailablePlatforms,
      platforms: updates.platforms ?? existing.platforms,
      isGeneral: updates.isGeneral ?? existing.isGeneral,
      lastAccess: new Date().toISOString(),
    });
    return;
  }

  registry.addLibrary({
    libName: dependency.libName,
    commit: dependency.commit,
    branch: dependency.branch,
    url: dependency.url,
    platforms: updates.platforms ?? [],
    size: 0,
    isGeneral: updates.isGeneral,
    referencedBy: [],
    unavailablePlatforms: updates.unavailablePlatforms,
    createdAt: new Date().toISOString(),
    lastAccess: new Date().toISOString(),
  });
}

export async function resolveLibraryGeneralState(
  dependency: Pick<ParsedDependency, 'libName' | 'commit'>
): Promise<boolean> {
  const registry = getRegistry();
  const libKey = registry.getLibraryKey(dependency.libName, dependency.commit);
  const library = registry.getLibrary(libKey);

  if (typeof library?.isGeneral === 'boolean') {
    return library.isGeneral;
  }

  return store.isGeneralLib(dependency.libName, dependency.commit);
}

// ============ SubmoduleConfig 扩展（带选择的可选配置） ============

interface SubmoduleConfigWithSelection extends SubmoduleConfig {
  selectedOptionalConfigs?: OptionalConfigInfo[];
}

/**
 * 选择要链接的 submodule
 */
async function selectSubmodules(
  configs: SubmoduleConfig[],
  options: LinkOptions,
  remembered?: string[]
): Promise<SubmoduleConfigWithSelection[]> {
  if (configs.length === 0) return [];

  let selected: SubmoduleConfig[];

  if (options.yes) {
    // --yes 模式：自动包含所有
    selected = configs;
  } else if (process.stdout.isTTY) {
    // 交互模式：checkbox 选择
    info('检测到 git submodule 包含依赖配置:');
    blank();

    const { checkboxWithCancel, PROMPT_CANCELLED } = await import('../utils/prompt.js');

    const choices = configs.map(c => ({
      name: `${c.name} (${c.depCount} 个库)`,
      value: c.relativePath,
      // 首次全选，之后使用记忆的选择
      checked: remembered ? remembered.includes(c.relativePath) : true,
    }));

    const selectedPaths = await checkboxWithCancel({
      message: '选择要一并链接的子模块:',
      choices,
    });

    if (selectedPaths === PROMPT_CANCELLED) {
      return [];
    }

    selected = configs.filter(c => (selectedPaths as string[]).includes(c.relativePath));
  } else {
    // 非 TTY 且没有 --yes
    error('发现 git submodule 依赖，非交互模式下必须使用 --yes 或 --no-submodules');
    hint(`检测到子模块: ${configs.map(c => c.name).join(', ')}`);
    hint('示例: td link --yes -p mac  (包含所有子模块)');
    hint('      td link --no-submodules -p mac  (跳过子模块)');
    process.exit(EXIT_CODES.MISUSE);
  }

  return selected.map(s => ({ ...s }));
}

/**
 * 单个 scope（主项目或 submodule）的链接处理
 *
 * 包含：解析依赖、分类、预扫描平台、下载确认、逐个处理、并行下载、嵌套 actions
 */
async function linkScope(params: LinkScopeParams): Promise<LinkScopeResult> {
  const {
    scopeName, configPath, platforms,
    scanExtraPlatforms,
    registry, tx, projectHash, projectRoot, storePath,
    download, dryRun, yes, concurrency,
    optionalConfigs,
    scope,
  } = params;

  let finalLinkPlatforms = [...params.finalLinkPlatforms];

  // 记录 General 类型库
  const generalLibs = new Set<string>();
  const downloadedLibs: string[] = [];
  let savedBytes = 0;

  // 1. 解析依赖
  info(`分析 ${scopeName}: ${configPath}`);
  let dependencies: ParsedDependency[];
  let configVars: Record<string, string> | undefined;

  try {
    const result = await parseProjectDependencies(path.dirname(path.dirname(configPath)));
    dependencies = result.dependencies;
    configVars = result.vars;

    // 合并可选配置依赖
    if (optionalConfigs && optionalConfigs.length > 0) {
      for (const optionalConfig of optionalConfigs) {
        try {
          const optionalResult = await parseCodepacDep(optionalConfig.path);
          const optionalDeps = extractDependencies(optionalResult);
          dependencies = mergeDepLists(dependencies, optionalDeps);
          info(`  + ${optionalConfig.name}: ${optionalDeps.length} 个依赖`);
        } catch (optErr) {
          warn(`无法解析可选配置 ${optionalConfig.name}: ${(optErr as Error).message}`);
        }
      }
    }
  } catch (err) {
    error((err as Error).message);
    process.exit(EXIT_CODES.DATAERR);
  }

  info(`找到 ${dependencies.length} 个依赖，平台: ${platforms.join(', ')}`);
  blank();

  // 2. 分类依赖
  const scopePath = path.dirname(path.dirname(configPath));
  const classified = await classifyDependencies(dependencies, scopePath, configPath, platforms);

  const stats = {
    linked: 0, relink: 0, replace: 0, absorb: 0, missing: 0, linkNew: 0,
  };
  for (const item of classified) {
    stats[getStatusKey(item.status)]++;
  }

  // 3. dry-run
  if (dryRun) {
    showDryRunInfo(classified, stats);
    return {
      linkedDeps: [], nestedLinkedDeps: [], generalLibs, downloadedLibs,
      savedBytes: 0, finalLinkPlatforms, stats,
    };
  }

  // 4. 磁盘空间预检
  if (stats.missing > 0 && download) {
    const estimatedSize = stats.missing * 500 * 1024 * 1024;
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

  // 5. 预扫描额外平台（仅主项目 scope）
  if (scanExtraPlatforms && !yes && process.stdout.isTTY) {
    const { KNOWN_PLATFORM_VALUES } = await import('../core/platform.js');
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
        // 读取失败，跳过
      }
    }

    const extraPlatforms = [...allLocalPlatforms].filter(p => !platforms.includes(p));
    if (extraPlatforms.length > 0) {
      info(`本地检测到额外平台: ${extraPlatforms.join(', ')}`);
      blank();

      const { checkboxWithCancel, PROMPT_CANCELLED } = await import('../utils/prompt.js');
      const allAvailable = [...platforms, ...extraPlatforms];

      const selectedPlatforms = await checkboxWithCancel({
        message: '选择要链接的平台 (未选择的将被删除):',
        choices: allAvailable.map(p => ({
          name: p, value: p, checked: platforms.includes(p),
        })),
      });

      if (selectedPlatforms === PROMPT_CANCELLED) {
        info('已取消');
        return {
          linkedDeps: [], nestedLinkedDeps: [], generalLibs, downloadedLibs,
          savedBytes: 0, finalLinkPlatforms, stats,
        };
      }

      finalLinkPlatforms = selectedPlatforms as string[];
      if (finalLinkPlatforms.length === 0) {
        error('至少需要选择一个平台');
        process.exit(1);
      }
      blank();
    }
  }

  // 6. 预扫描下载确认
  const downloadConfirmedLibs = new Set<string>();
  let skipAllDownloads = false;

  if (download && !yes) {
    const needDownloadItems: Array<{ libName: string; commit: string; reason: string }> = [];
    for (const item of classified) {
      const { dependency, status } = item;
      if (status === DependencyStatus.MISSING) {
        needDownloadItems.push({
          libName: dependency.libName, commit: dependency.commit, reason: '缺失',
        });
      } else if (status === DependencyStatus.ABSORB) {
        const { missing } = await store.checkPlatformCompleteness(
          dependency.libName, dependency.commit, platforms
        );
        if (missing.length > 0) {
          needDownloadItems.push({
            libName: dependency.libName, commit: dependency.commit,
            reason: `补充平台 [${missing.join(', ')}]`,
          });
        }
      } else if (status === DependencyStatus.LINK_NEW) {
        const { missing } = await store.checkPlatformCompleteness(
          dependency.libName, dependency.commit, platforms
        );
        if (missing.length > 0) {
          needDownloadItems.push({
            libName: dependency.libName, commit: dependency.commit,
            reason: `补充平台 [${missing.join(', ')}]`,
          });
        }
      }
    }

    if (needDownloadItems.length > 0) {
      info(`发现 ${needDownloadItems.length} 个库需要下载:`);
      for (const item of needDownloadItems) {
        info(`  - ${item.libName} (${item.commit.slice(0, 7)}) - ${item.reason}`);
      }
      blank();

      const { confirmAction, PROMPT_CANCELLED } = await import('../utils/prompt.js');
      const confirmed = await confirmAction(
        `是否下载以上 ${needDownloadItems.length} 个库?`, true
      );

      if (confirmed === PROMPT_CANCELLED || !confirmed) {
        warn('跳过所有下载');
        skipAllDownloads = true;
      } else {
        for (const item of needDownloadItems) {
          downloadConfirmedLibs.add(`${item.libName}@${item.commit}`);
        }
      }
      blank();
    }
  } else if (download && yes) {
    for (const item of classified) {
      downloadConfirmedLibs.add(`${item.dependency.libName}@${item.dependency.commit}`);
    }
  }

  // 7. 逐个处理依赖（LINKED/RELINK/REPLACE/ABSORB/LINK_NEW）
  try {
    for (const item of classified) {
      const { dependency, status, localPath } = item;
      const libKey = registry.getLibraryKey(dependency.libName, dependency.commit);

      await store.ensureCompatibleStore(storePath, dependency.libName, dependency.commit);

      switch (status) {
        case DependencyStatus.LINKED: {
          const isLinkedGeneral = await resolveLibraryGeneralState(dependency);
          if (!isLinkedGeneral) {
            const supplementResult = await supplementMissingPlatforms(
              dependency, platforms, registry, tx, { vars: configVars }
            );
            await registerNestedLibraries(supplementResult.nestedLibraries, projectHash);

            if (supplementResult.downloaded.length > 0) {
              const linkedCommitPath = path.join(storePath, dependency.libName, dependency.commit);
              const { existing: allExisting } = await store.checkPlatformCompleteness(
                dependency.libName, dependency.commit, platforms
              );
              tx.recordOp('link', localPath, linkedCommitPath);
              await linker.linkLib(localPath, linkedCommitPath, allExisting);
              await ensureLinkedRegistryState(
                dependency.libName,
                dependency.commit,
                dependency.branch,
                dependency.url,
                allExisting,
                projectHash,
                false
              );
              success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 已补充平台 [${supplementResult.downloaded.join(', ')}]`);
            }
          }
          await ensureLinkedRegistryState(
            dependency.libName,
            dependency.commit,
            dependency.branch,
            dependency.url,
            isLinkedGeneral ? [GENERAL_PLATFORM] : platforms,
            projectHash,
            isLinkedGeneral
          );
          break;
        }

        case DependencyStatus.RELINK: {
          const relinkCommitPath = path.join(storePath, dependency.libName, dependency.commit);
          const isRelinkGeneral = await resolveLibraryGeneralState(dependency);

          if (isRelinkGeneral) {
            tx.recordOp('unlink', localPath);
            await linker.unlink(localPath);
            const sharedPath = path.join(relinkCommitPath, '_shared');
            tx.recordOp('link', localPath, sharedPath);
            await linker.linkGeneral(localPath, sharedPath);
            await ensureLinkedRegistryState(
              dependency.libName,
              dependency.commit,
              dependency.branch,
              dependency.url,
              [GENERAL_PLATFORM],
              projectHash,
              true
            );
            generalLibs.add(dependency.libName);
            success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - General 库，重建链接`);
          } else {
            const relinkSupplementResult = await supplementMissingPlatforms(
              dependency, platforms, registry, tx, { vars: configVars }
            );
            await registerNestedLibraries(relinkSupplementResult.nestedLibraries, projectHash);

            const { existing: relinkExisting } = await store.checkPlatformCompleteness(
              dependency.libName, dependency.commit, platforms
            );

            if (relinkExisting.length === 0) {
              const { KNOWN_PLATFORM_VALUES } = await import('../core/platform.js');
              const relinkCommitEntries = await fs.readdir(relinkCommitPath, { withFileTypes: true });
              const relinkAvailablePlatforms = relinkCommitEntries
                .filter(e => e.isDirectory() && e.name !== '_shared' && KNOWN_PLATFORM_VALUES.includes(e.name))
                .map(e => e.name);
              warn(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 不支持 ${platforms.join('/')} 平台 [可用: ${relinkAvailablePlatforms.join(', ')}]`);
              const relinkLibKey = registry.getLibraryKey(dependency.libName, dependency.commit);
              const relinkLib = registry.getLibrary(relinkLibKey);
              if (relinkLib) {
                const unavailable = relinkLib.unavailablePlatforms || [];
                for (const p of platforms) {
                  if (!unavailable.includes(p) && !relinkAvailablePlatforms.includes(p)) unavailable.push(p);
                }
                registry.updateLibrary(relinkLibKey, { unavailablePlatforms: unavailable });
              }
              break;
            }

            tx.recordOp('unlink', localPath);
            await linker.unlink(localPath);
            tx.recordOp('link', localPath, relinkCommitPath);
            await linker.linkLib(localPath, relinkCommitPath, relinkExisting);
            await ensureLinkedRegistryState(
              dependency.libName,
              dependency.commit,
              dependency.branch,
              dependency.url,
              relinkExisting,
              projectHash,
              false
            );

            if (relinkSupplementResult.downloaded.length > 0) {
              success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 重建链接并补充平台 [${relinkExisting.join(', ')}]`);
            } else {
              success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 重建链接 [${relinkExisting.join(', ')}]`);
            }
          }
          break;
        }

        case DependencyStatus.REPLACE: {
          const replaceSize = await getDirSize(localPath);
          const replaceCommitPath = path.join(storePath, dependency.libName, dependency.commit);
          const isReplaceGeneral = await resolveLibraryGeneralState(dependency);

          if (isReplaceGeneral) {
            const sharedPath = path.join(replaceCommitPath, '_shared');
            tx.recordOp('replace', localPath, sharedPath);
            await linker.linkGeneral(localPath, sharedPath);
            savedBytes += replaceSize;
            await ensureLinkedRegistryState(
              dependency.libName,
              dependency.commit,
              dependency.branch,
              dependency.url,
              [GENERAL_PLATFORM],
              projectHash,
              true
            );
            generalLibs.add(dependency.libName);
            success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - General 库，创建链接`);
          } else {
            const replaceSupplementResult = await supplementMissingPlatforms(
              dependency, platforms, registry, tx, { vars: configVars }
            );
            await registerNestedLibraries(replaceSupplementResult.nestedLibraries, projectHash);

            const { existing: replaceExisting } = await store.checkPlatformCompleteness(
              dependency.libName, dependency.commit, platforms
            );

            if (replaceExisting.length === 0) {
              const { KNOWN_PLATFORM_VALUES } = await import('../core/platform.js');
              const replaceCommitEntries = await fs.readdir(replaceCommitPath, { withFileTypes: true });
              const replaceAvailablePlatforms = replaceCommitEntries
                .filter(e => e.isDirectory() && e.name !== '_shared' && KNOWN_PLATFORM_VALUES.includes(e.name))
                .map(e => e.name);
              warn(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 不支持 ${platforms.join('/')} 平台 [可用: ${replaceAvailablePlatforms.join(', ')}]`);
              const replaceLibKey = registry.getLibraryKey(dependency.libName, dependency.commit);
              const replaceLib = registry.getLibrary(replaceLibKey);
              if (replaceLib) {
                const unavailable = replaceLib.unavailablePlatforms || [];
                for (const p of platforms) {
                  if (!unavailable.includes(p) && !replaceAvailablePlatforms.includes(p)) unavailable.push(p);
                }
                registry.updateLibrary(replaceLibKey, { unavailablePlatforms: unavailable });
              }
              break;
            }

            tx.recordOp('replace', localPath, replaceCommitPath);
            await linker.linkLib(localPath, replaceCommitPath, replaceExisting);
            savedBytes += replaceSize;
            await ensureLinkedRegistryState(
              dependency.libName,
              dependency.commit,
              dependency.branch,
              dependency.url,
              replaceExisting,
              projectHash,
              false
            );

            if (replaceSupplementResult.downloaded.length > 0) {
              success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - Store 已有，创建链接并补充平台 [${replaceExisting.join(', ')}]`);
            } else {
              success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - Store 已有，创建链接 [${replaceExisting.join(', ')}]`);
            }
          }
          break;
        }

        case DependencyStatus.ABSORB: {
          const storeCommitPath = path.join(storePath, dependency.libName, dependency.commit);
          const { KNOWN_PLATFORM_VALUES } = await import('../core/platform.js');
          const localDirEntries = await fs.readdir(localPath, { withFileTypes: true });
          const localPlatforms = localDirEntries
            .filter(entry => entry.isDirectory() && KNOWN_PLATFORM_VALUES.includes(entry.name))
            .map(entry => entry.name);

          const finalPlatforms = localPlatforms.filter(p => finalLinkPlatforms.includes(p));

          if (finalPlatforms.length === 0 && localPlatforms.length > 0) {
            warn(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 不支持 ${platforms.join('/')} 平台 [本地有: ${localPlatforms.join(', ')}]`);
            const absorbLibKey = registry.getLibraryKey(dependency.libName, dependency.commit);
            const absorbLib = registry.getLibrary(absorbLibKey);
            if (absorbLib) {
              const unavailable = absorbLib.unavailablePlatforms || [];
              for (const p of platforms) {
                if (!unavailable.includes(p) && !localPlatforms.includes(p)) unavailable.push(p);
              }
              registry.updateLibrary(absorbLibKey, { unavailablePlatforms: unavailable });
            }
            break;
          }

          info(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 正在分析...`);
          const absorbSize = await getDirSize(localPath);

          const progressTracker = new ProgressTracker({
            name: `  移入 Store`, total: absorbSize, showSpeed: true,
          });

          tx.recordOp('absorb', storeCommitPath, localPath);
          let progressStarted = false;
          const absorbResult = await store.absorbLib(
            localPath, finalPlatforms, dependency.libName, dependency.commit, {
              totalSize: absorbSize,
              onProgress: (copied, _total) => {
                if (!progressStarted) { progressStarted = true; progressTracker.start(); }
                progressTracker.update(copied);
              },
            }
          );
          if (progressStarted) progressTracker.stop();

          let absorbLinkPlatforms = [...Object.keys(absorbResult.platformPaths), ...absorbResult.skippedPlatforms];

          const absorbLibKey = registry.getLibraryKey(dependency.libName, dependency.commit);
          if (!registry.getLibrary(absorbLibKey)) {
            registry.addLibrary({
              libName: dependency.libName, commit: dependency.commit, branch: dependency.branch,
              url: dependency.url, platforms: absorbLinkPlatforms, size: absorbSize,
              isGeneral: false,
              referencedBy: [], createdAt: new Date().toISOString(), lastAccess: new Date().toISOString(),
            });
          }

          if (absorbLinkPlatforms.length > 0) {
            for (const platform of absorbLinkPlatforms) {
              const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, platform);
              if (!registry.getStore(storeKey)) {
                const integrity = await store.captureIntegrity(dependency.libName, dependency.commit, platform);
                registry.addStore({
                  libName: dependency.libName, commit: dependency.commit, platform,
                  branch: dependency.branch, url: dependency.url, ...integrity,
                  usedBy: [], createdAt: new Date().toISOString(), lastAccess: new Date().toISOString(),
                });
              }
            }
            await registerSharedStore(dependency.libName, dependency.commit, dependency.branch, dependency.url);
            await registerNestedLibraries(absorbResult.nestedLibraries, projectHash);

            const absorbSupplementResult = await supplementMissingPlatforms(
              dependency, platforms, registry, tx, { vars: configVars }
            );
            await registerNestedLibraries(absorbSupplementResult.nestedLibraries, projectHash);

            if (absorbSupplementResult.downloaded.length > 0) {
              absorbLinkPlatforms = [...absorbLinkPlatforms, ...absorbSupplementResult.downloaded];
            }

            tx.recordOp('link', localPath, storeCommitPath);
            await linker.linkLib(localPath, storeCommitPath, absorbLinkPlatforms);

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
            const sharedPath = path.join(storeCommitPath, '_shared');
            try {
              await fs.access(sharedPath);
              const sharedEntries = await fs.readdir(sharedPath);
              if (sharedEntries.length === 0) {
                warn(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - _shared 目录为空，请重新下载源文件后再 link`);
                break;
              }
              const { GENERAL_PLATFORM } = await import('../core/platform.js');
              tx.recordOp('link', localPath, sharedPath);
              await linker.linkGeneral(localPath, sharedPath);

              const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, GENERAL_PLATFORM);
              if (!registry.getStore(storeKey)) {
                const integrity = await store.captureIntegrity(dependency.libName, dependency.commit, GENERAL_PLATFORM);
                registry.addStore({
                  libName: dependency.libName, commit: dependency.commit, platform: GENERAL_PLATFORM,
                  branch: dependency.branch, url: dependency.url, ...integrity,
                  usedBy: [], createdAt: new Date().toISOString(), lastAccess: new Date().toISOString(),
                });
              }
              registry.addStoreReference(storeKey, projectHash);

              const libKeyGen = registry.getLibraryKey(dependency.libName, dependency.commit);
              if (!registry.getLibrary(libKeyGen)) {
                const sharedSize = await getDirSize(sharedPath);
                registry.addLibrary({
                  libName: dependency.libName, commit: dependency.commit, branch: dependency.branch,
                  url: dependency.url, platforms: [GENERAL_PLATFORM], size: sharedSize,
                  isGeneral: true,
                  referencedBy: [], createdAt: new Date().toISOString(), lastAccess: new Date().toISOString(),
                });
              }
              generalLibs.add(dependency.libName);
              hint(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - General 库，整目录链接`);
            } catch {
              warn(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 本地目录不含任何内容，跳过`);
            }
          }
          break;
        }

        case DependencyStatus.MISSING:
          break;

        case DependencyStatus.LINK_NEW: {
          const linkNewCommitPath = path.join(storePath, dependency.libName, dependency.commit);
          const { missing } = await store.checkPlatformCompleteness(
            dependency.libName, dependency.commit, platforms
          );

          const linkNewLibId = `${dependency.libName}@${dependency.commit}`;
          if (missing.length > 0 && !skipAllDownloads && downloadConfirmedLibs.has(linkNewLibId)) {
            info(`${dependency.libName} 缺少平台 [${missing.join(', ')}]，开始下载...`);
            const linkNewLibKey = registry.getLibraryKey(dependency.libName, dependency.commit);
            const linkNewHistoryLib = registry.getLibrary(linkNewLibKey);

            const linkNewMonitor = new DownloadMonitor({
              name: `  ${dependency.libName}`, estimatedSize: linkNewHistoryLib?.size, getDirSize,
            });

            let downloadResult: codepac.DownloadResult;
            try {
              downloadResult = await codepac.downloadToTemp({
                url: dependency.url, commit: dependency.commit, branch: dependency.branch,
                libName: dependency.libName, platforms: missing, sparse: dependency.sparse, vars: configVars,
                onTempDirCreated: (_tempDir, libDir) => { linkNewMonitor.start(libDir); },
                onHeartbeat: (message) => { linkNewMonitor.heartbeat(message); },
              });
            } finally {
              await linkNewMonitor.stop();
            }

            if (downloadResult.cleanedPlatforms.length > 0) {
              hint(`  已过滤: ${downloadResult.cleanedPlatforms.join(', ')}`);
            }

            try {
              const filteredDownloaded = downloadResult.platformDirs.filter(p => missing.includes(p));
              if (filteredDownloaded.length > 0) {
                tx.recordOp('absorb', linkNewCommitPath, downloadResult.libDir);
                const linkNewAbsorbResult = await store.absorbLib(
                  downloadResult.libDir, filteredDownloaded, dependency.libName, dependency.commit
                );
                await registerNestedLibraries(linkNewAbsorbResult.nestedLibraries, projectHash);
              }
            } finally {
              await fs.rm(downloadResult.tempDir, { recursive: true, force: true }).catch(() => {});
            }
          }

          const { existing: linkNewExisting } = await store.checkPlatformCompleteness(
            dependency.libName, dependency.commit, platforms
          );
          const isLinkNewGeneral = await resolveLibraryGeneralState(dependency);

          if (isLinkNewGeneral) {
            const sharedPath = path.join(linkNewCommitPath, '_shared');
            tx.recordOp('link', localPath, sharedPath);
            await linker.linkGeneral(localPath, sharedPath);
            await ensureLinkedRegistryState(
              dependency.libName,
              dependency.commit,
              dependency.branch,
              dependency.url,
              [GENERAL_PLATFORM],
              projectHash,
              true
            );
            generalLibs.add(dependency.libName);
            success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - General 库，创建链接`);
          } else if (linkNewExisting.length === 0) {
            const { KNOWN_PLATFORM_VALUES } = await import('../core/platform.js');
            const commitEntries = await fs.readdir(linkNewCommitPath, { withFileTypes: true });
            const availablePlatforms = commitEntries
              .filter(e => e.isDirectory() && e.name !== '_shared' && KNOWN_PLATFORM_VALUES.includes(e.name))
              .map(e => e.name);
            warn(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 不支持 ${platforms.join('/')} 平台 [可用: ${availablePlatforms.join(', ')}]`);
            const lnLibKey = registry.getLibraryKey(dependency.libName, dependency.commit);
            const lnLib = registry.getLibrary(lnLibKey);
            if (lnLib) {
              const unavailable = lnLib.unavailablePlatforms || [];
              for (const p of platforms) {
                if (!unavailable.includes(p) && !availablePlatforms.includes(p)) unavailable.push(p);
              }
              registry.updateLibrary(lnLibKey, { unavailablePlatforms: unavailable });
            }
            break;
          } else {
            tx.recordOp('link', localPath, linkNewCommitPath);
            await linker.linkLib(localPath, linkNewCommitPath, linkNewExisting);
            await ensureLinkedRegistryState(
              dependency.libName,
              dependency.commit,
              dependency.branch,
              dependency.url,
              linkNewExisting,
              projectHash,
              false
            );
            success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 创建链接 [${linkNewExisting.join(', ')}]`);
          }
          break;
        }
      }

      // 无论当前是跳过、补平台还是重建链接，都要把本地残留的平台目录清理到最终平台集合
      await linker.cleanupLocalExtraPlatforms(localPath, finalLinkPlatforms);
      await tx.save();
    }

    // 8. 并行处理 MISSING 依赖
    const missingItems = classified.filter((c) => c.status === DependencyStatus.MISSING);

    if (missingItems.length > 0 && download && !skipAllDownloads) {
      const toDownload = missingItems.filter((item) => {
        const libId = `${item.dependency.libName}@${item.dependency.commit}`;
        return downloadConfirmedLibs.has(libId);
      });

      if (toDownload.length > 0) {
        info(`开始并行下载 ${toDownload.length} 个库 (最多 ${concurrency} 个并发)...`);
        blank();

        const isTTY = process.stdout.isTTY ?? false;
        const multiBarManager = isTTY ? new MultiBarManager() : null;
        const downloadLimit = pLimit(concurrency);

        const downloadTasks = toDownload.map((item) =>
          downloadLimit(async () => {
            const { dependency, localPath } = item;
            const pLog = {
              info: (msg: string) => multiBarManager ? multiBarManager.log(`[info] ${msg}`) : info(msg),
              success: (msg: string) => multiBarManager ? multiBarManager.log(`[ok] ${msg}`) : success(msg),
              hint: (msg: string) => multiBarManager ? multiBarManager.log(`[hint] ${msg}`) : hint(msg),
              warn: (msg: string) => multiBarManager ? multiBarManager.log(`[warn] ${msg}`) : warn(msg),
              error: (msg: string) => multiBarManager ? multiBarManager.log(`[error] ${msg}`) : error(msg),
            };

            try {
              const storeCommitPath = path.join(storePath, dependency.libName, dependency.commit);
              const { existing, missing } = await store.checkPlatformCompleteness(
                dependency.libName, dependency.commit, platforms
              );

              if (missing.length === 0) {
                pLog.info(`${dependency.libName} 所有平台已存在，直接链接...`);
                tx.recordOp('link', localPath, storeCommitPath);
                await linker.linkLib(localPath, storeCommitPath, platforms);
                await ensureLinkedRegistryState(
                  dependency.libName,
                  dependency.commit,
                  dependency.branch,
                  dependency.url,
                  platforms,
                  projectHash,
                  false
                );
                pLog.success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 链接完成 [${platforms.join(', ')}]`);
                return { success: true, name: dependency.libName, downloadedPlatforms: platforms, skippedPlatforms: [] };
              }

              const dlLibKey = registry.getLibraryKey(dependency.libName, dependency.commit);
              const historyLib = registry.getLibrary(dlLibKey);
              const unavailablePlatforms = historyLib?.unavailablePlatforms || [];
              const dlToDownload = missing.filter(p => !unavailablePlatforms.includes(p));
              const knownUnavailable = missing.filter(p => unavailablePlatforms.includes(p));

              if (dlToDownload.length === 0) {
                if (knownUnavailable.length > 0) {
                  pLog.warn(`${dependency.libName} 平台 [${knownUnavailable.join(', ')}] 不支持（远程不存在）`);
                }
                return { success: false, name: dependency.libName, skipped: true, skippedPlatforms: missing, unsupported: true };
              }

              pLog.info(`下载 ${dependency.libName} [${dlToDownload.join(', ')}]...`);
              const estimatedSize = historyLib?.size;

              const downloadMonitor = new DownloadMonitor({
                name: `  ${dependency.libName}`, estimatedSize, getDirSize,
                manager: multiBarManager ?? undefined,
              });

              let downloadResult: codepac.DownloadResult;
              try {
                downloadResult = await codepac.downloadToTemp({
                  url: dependency.url, commit: dependency.commit, branch: dependency.branch,
                  libName: dependency.libName, platforms: dlToDownload, sparse: dependency.sparse,
                  vars: configVars,
                  onTempDirCreated: (_tempDir, libDir) => { downloadMonitor.start(libDir); },
                  onHeartbeat: (message) => { downloadMonitor.heartbeat(message); },
                });
              } finally {
                await downloadMonitor.stop();
              }

              if (downloadResult.cleanedPlatforms.length > 0) {
                pLog.hint(`  已过滤: ${downloadResult.cleanedPlatforms.join(', ')}`);
              }

              try {
                const assessment = assessDownloadResult(
                  dlToDownload,
                  dependency.sparse,
                  downloadResult
                );

                if (assessment.isPureGeneral) {
                  upsertLibraryAvailability(dependency, {
                    platforms: [GENERAL_PLATFORM],
                    isGeneral: true,
                  });
                  tx.recordOp('absorb', storeCommitPath, downloadResult.libDir);
                  await store.absorbGeneral(downloadResult.libDir, dependency.libName, dependency.commit);
                  const sharedPath = path.join(storeCommitPath, '_shared');
                  tx.recordOp('link', localPath, sharedPath);
                  await linker.linkGeneral(localPath, sharedPath);
                  await ensureLinkedRegistryState(
                    dependency.libName,
                    dependency.commit,
                    dependency.branch,
                    dependency.url,
                    [GENERAL_PLATFORM],
                    projectHash,
                    true
                  );
                  generalLibs.add(dependency.libName);
                  pLog.success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - General 库，下载完成`);
                  return { success: true, name: dependency.libName, downloadedPlatforms: [GENERAL_PLATFORM], skippedPlatforms: [], isGeneral: true };
                }

                const filteredDownloaded = assessment.downloadedRequested;
                const newUnavailable = assessment.unavailableRequested;
                if (newUnavailable.length > 0) {
                  const updatedUnavailable = [...new Set([...unavailablePlatforms, ...newUnavailable])];
                  upsertLibraryAvailability(dependency, {
                    unavailablePlatforms: updatedUnavailable,
                    isGeneral: false,
                  });
                  pLog.warn(`${dependency.libName} 平台 [${newUnavailable.join(', ')}] 远程不存在，已记录`);
                }

                if (filteredDownloaded.length > 0) {
                  tx.recordOp('absorb', storeCommitPath, downloadResult.libDir);
                  const downloadAbsorbResult = await store.absorbLib(
                    downloadResult.libDir, filteredDownloaded, dependency.libName, dependency.commit
                  );
                  await registerNestedLibraries(downloadAbsorbResult.nestedLibraries, projectHash);
                }

                const linkPlatforms = [...existing, ...filteredDownloaded];
                if (linkPlatforms.length === 0) {
                  return { success: false, name: dependency.libName, skipped: true, skippedPlatforms: platforms };
                }

                tx.recordOp('link', localPath, storeCommitPath);
                await linker.linkLib(localPath, storeCommitPath, linkPlatforms);
                await ensureLinkedRegistryState(
                  dependency.libName,
                  dependency.commit,
                  dependency.branch,
                  dependency.url,
                  linkPlatforms,
                  projectHash,
                  false
                );

                const notLinkedPlatforms = platforms.filter((p) => !linkPlatforms.includes(p));
                pLog.success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 下载完成 [${linkPlatforms.join(', ')}]`);
                return { success: true, name: dependency.libName, downloadedPlatforms: linkPlatforms, skippedPlatforms: notLinkedPlatforms };
              } finally {
                await fs.rm(downloadResult.tempDir, { recursive: true, force: true }).catch(() => {});
              }
            } catch (err) {
              pLog.error(`${dependency.libName} 下载失败: ${(err as Error).message}`);
              return { success: false, name: dependency.libName, error: (err as Error).message };
            }
          })
        );

        const results = await Promise.all(downloadTasks);
        multiBarManager?.stop();

        const succeeded = results.filter((r) => r.success);
        const failed = results.filter((r) => !r.success && !('skipped' in r && r.skipped));

        blank();
        info(`下载完成: ${succeeded.length}/${toDownload.length} 个库`);
        if (failed.length > 0) warn(`${failed.length} 个库下载失败`);

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

        for (const r of succeeded) downloadedLibs.push(r.name);
      }
    } else if (missingItems.length > 0 && !download) {
      for (const item of missingItems) {
        warn(`${item.dependency.libName} (${item.dependency.commit.slice(0, 7)}) - 缺失 (跳过下载)`);
      }
    }

    // 9. 处理嵌套依赖 (actions)
    const topLevelConfig = await parseCodepacDep(configPath);
    const actions = extractActions(topLevelConfig);

    const nestedLinkedDeps: NestedLinkedDep[] = [];

    if (actions.length > 0) {
      blank();
      separator();
      info(`发现 ${actions.length} 个嵌套依赖配置`);

      const nestedContext: NestedContext = {
        depth: 0, processedConfigs: new Set([configPath]), platforms, vars: configVars,
      };
      const thirdPartyDir = path.dirname(configPath);

      for (const action of actions) {
        await processAction(action, nestedContext, thirdPartyDir, {
          tx, registry, projectHash, projectRoot, dryRun, download, yes,
          generalLibs, downloadedLibs, nestedLinkedDeps,
        });
      }
    }

    // 10. 同步 cache 文件
    await syncCacheFile(configPath);

    // 11. 构建返回结果
    const primaryPlatform = platforms[0];
    const linkedDeps = classified
      .filter((c) => {
        if (c.status === DependencyStatus.MISSING) return downloadedLibs.includes(c.dependency.libName);
        return true;
      })
      .map((c) => ({
        libName: c.dependency.libName,
        commit: c.dependency.commit,
        platform: generalLibs.has(c.dependency.libName) ? GENERAL_PLATFORM : primaryPlatform,
        linkedPath: path.relative(projectRoot, c.localPath),
        scope,
      }));

    return {
      linkedDeps, nestedLinkedDeps, generalLibs, downloadedLibs, savedBytes, finalLinkPlatforms, stats,
    };
  } catch (err) {
    // 将异常传播给调用者（linkProject 的 try-catch 会处理回滚）
    throw err;
  }
}

/**
 * 执行链接操作
 */
export async function linkProject(projectPath: string, options: LinkOptions): Promise<void> {
  const {
    absolutePath,
    normalizedPath,
    configPath: discoveredConfigPath,
  } = await resolveProjectRootPath(projectPath);

  // === 阶段 1: 初始化 ===
  const cfg = await config.load();
  if (cfg?.logLevel) setLogLevel(cfg.logLevel);
  if (cfg?.proxy) setProxyConfig(cfg.proxy);
  const concurrency = cfg?.concurrency ?? 5;

  const registry = getRegistry();
  await registry.load();
  const existingProject = registry.getProjectByPath(normalizedPath);
  const rememberedPlatforms = existingProject?.platforms;

  // 确定平台列表
  let platforms: string[];
  if (options.platform && options.platform.length > 0) {
    platforms = parsePlatformArgs(options.platform);
  } else if (!options.yes && process.stdout.isTTY) {
    const selectedPlatforms = await selectPlatforms(rememberedPlatforms);
    if (selectedPlatforms === PROMPT_CANCELLED) {
      info('已取消');
      return;
    }
    platforms = selectedPlatforms;
    if (platforms.length === 0) {
      error('至少需要选择一个平台');
      process.exit(EXIT_CODES.MISUSE);
    }
  } else {
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

  // 发现可选配置文件
  const thirdpartyDir = path.join(normalizedPath, '3rdparty');
  const configDiscovery = await findAllCodepacConfigs(thirdpartyDir);
  let selectedOptionalConfigs: OptionalConfigInfo[] = [];

  if (configDiscovery && configDiscovery.optionalConfigs.length > 0) {
    if (options.config && options.config.length > 0) {
      for (const configName of options.config) {
        const found = configDiscovery.optionalConfigs.find(c => c.name === configName);
        if (!found) {
          error(`找不到指定的配置: ${configName}`);
          hint(`可用配置: ${configDiscovery.optionalConfigs.map(c => c.name).join(', ')}`);
          process.exit(EXIT_CODES.MISUSE);
        }
        selectedOptionalConfigs.push(found);
      }
    } else if (options.yes) {
      // --yes 模式：跳过可选配置选择
    } else if (process.stdout.isTTY) {
      const rememberedConfigs = existingProject?.optionalConfigs ?? [];
      const selectOptions: SelectOptionalConfigsOptions = {
        isTTY: true,
        specifiedConfigs: rememberedConfigs,
      };
      const selected = await selectOptionalConfigs(configDiscovery.optionalConfigs, selectOptions);
      if (selected === PROMPT_CANCELLED) {
        info('已取消');
        return;
      }
      selectedOptionalConfigs = selected;
    } else {
      error('发现可选配置文件，非交互模式下必须使用 --config 或 --yes 参数');
      hint(`可用配置: ${configDiscovery.optionalConfigs.map(c => c.name).join(', ')}`);
      hint(`示例: td link --config ${configDiscovery.optionalConfigs[0].name}`);
      hint('或使用 --yes 跳过可选配置');
      process.exit(EXIT_CODES.MISUSE);
    }
  }

  // 查找主配置文件
  const mainConfigPath = discoveredConfigPath;
  if (!mainConfigPath) {
    error(`找不到 codepac-dep.json 配置文件，已搜索: 3rdparty, .`);
    process.exit(EXIT_CODES.DATAERR);
  }

  // === 阶段 2: Submodule 检测 ===
  let selectedSubmodules: SubmoduleConfigWithSelection[] = [];
  if (options.submodules !== false) {
    const submoduleConfigs = await findSubmoduleConfigs(normalizedPath);
    if (submoduleConfigs.length > 0) {
      selectedSubmodules = await selectSubmodules(submoduleConfigs, options, existingProject?.submodules);

      // 为选中的 submodule 处理可选配置
      for (const sub of selectedSubmodules) {
        if (sub.optionalConfigs.length > 0 && !options.yes && process.stdout.isTTY) {
          info(`${sub.name} 发现可选配置:`);
          const selected = await selectOptionalConfigs(
            sub.optionalConfigs,
            { isTTY: true, specifiedConfigs: [] }
          );
          if (selected !== PROMPT_CANCELLED) {
            sub.selectedOptionalConfigs = selected;
          }
        }
      }
    }
  }

  // === 阶段 3: 规范化 + 事务准备 ===
  const normalizedRoot = normalizedPath;
  const wasNormalized = normalizedRoot !== absolutePath;

  if (wasNormalized) {
    info(`项目根目录规范化: ${absolutePath} → ${normalizedRoot}`);
    const oldHash = registry.hashPath(absolutePath);
    const oldProject = registry.getProject(oldHash);
    if (oldProject) {
      info('迁移旧的项目登记...');
      registry.removeProject(oldHash);
    }
  }

  const absConfigPath = path.resolve(normalizedRoot, getRelativeConfigPath(normalizedRoot, mainConfigPath));
  const allProjects = registry.listProjects();
  for (const proj of allProjects) {
    if (pathsEqual(proj.path, normalizedRoot)) continue;
    const projAbsConfig = path.resolve(proj.path, proj.configPath);
    if (pathsEqual(projAbsConfig, absConfigPath)) {
      info(`清理重复登记: ${proj.path}`);
      registry.removeProject(registry.hashPath(proj.path));
    }
  }

  const finalPath = normalizedRoot;

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

  const storePath = await store.getStorePath();
  const projectHash = registry.hashPath(finalPath);
  const tx = new Transaction(`link:${finalPath}`);
  await tx.begin();

  // === 阶段 4: 依次执行 linkScope ===
  try {
    // 主项目
    const mainResult = await linkScope({
      scopeName: '主项目',
      configPath: mainConfigPath,
      platforms,
      finalLinkPlatforms: platforms,
      scanExtraPlatforms: true,
      registry, tx, projectHash,
      projectRoot: finalPath,
      storePath,
      download: options.download,
      dryRun: options.dryRun,
      yes: options.yes,
      concurrency,
      optionalConfigs: selectedOptionalConfigs,
    });

    const finalLinkPlatforms = mainResult.finalLinkPlatforms;

    // 如果 dry-run 模式，linkScope 内已显示信息
    if (options.dryRun) {
      // submodule 也需要 dry-run 显示
      for (const sub of selectedSubmodules) {
        blank();
        separator();
        info(`子模块: ${sub.name}`);
        await linkScope({
          scopeName: sub.name,
          configPath: sub.configPath,
          platforms,
          finalLinkPlatforms,
          scanExtraPlatforms: false,
          registry, tx, projectHash,
          projectRoot: finalPath,
          storePath,
          download: options.download,
          dryRun: true,
          yes: options.yes,
          concurrency,
          optionalConfigs: sub.selectedOptionalConfigs,
          scope: sub.relativePath,
        });
      }
      return;
    }

    // Submodule scopes
    const subResults: LinkScopeResult[] = [];
    for (const sub of selectedSubmodules) {
      blank();
      separator();
      info(`链接子模块: ${sub.name}`);
      const subResult = await linkScope({
        scopeName: sub.name,
        configPath: sub.configPath,
        platforms,
        finalLinkPlatforms,
        scanExtraPlatforms: false,
        registry, tx, projectHash,
        projectRoot: finalPath,
        storePath,
        download: options.download,
        dryRun: options.dryRun,
        yes: options.yes,
        concurrency,
        optionalConfigs: sub.selectedOptionalConfigs,
        scope: sub.relativePath,
      });
      subResults.push(subResult);
    }

    // === 阶段 5: 合并结果、注册项目 ===
    const allGeneralLibs = new Set([
      ...mainResult.generalLibs,
      ...subResults.flatMap(r => [...r.generalLibs]),
    ]);

    const allDownloadedLibs = [
      ...mainResult.downloadedLibs,
      ...subResults.flatMap(r => r.downloadedLibs),
    ];

    // 合并所有依赖
    const allLinkedDeps = [
      ...mainResult.linkedDeps,
      ...mainResult.nestedLinkedDeps,
      ...subResults.flatMap(r => [...r.linkedDeps, ...r.nestedLinkedDeps]),
    ];

    // 获取旧引用
    const oldStoreKeys = registry.getProjectStoreKeys(projectHash);

    // 更新项目信息
    const relConfigPath = getRelativeConfigPath(finalPath, mainConfigPath);

    registry.addProject({
      path: finalPath,
      configPath: relConfigPath,
      lastLinked: new Date().toISOString(),
      platforms: finalLinkPlatforms,
      dependencies: allLinkedDeps,
      optionalConfigs: selectedOptionalConfigs.length > 0
        ? selectedOptionalConfigs.map(c => c.name) : undefined,
      submodules: selectedSubmodules.length > 0
        ? selectedSubmodules.map(s => s.relativePath) : undefined,
    });

    // 更新 Store 引用关系
    const newStoreKeys = allLinkedDeps.map((d) =>
      registry.getStoreKey(d.libName, d.commit, d.platform)
    );

    for (const key of oldStoreKeys) {
      if (!newStoreKeys.includes(key)) {
        registry.removeStoreReference(key, projectHash);
      }
    }
    for (const key of newStoreKeys) {
      registry.addStoreReference(key, projectHash);
    }

    await registry.save();
    await tx.commit();

    // === 阶段 6: 统计报告 ===
    const allSavedBytes = mainResult.savedBytes + subResults.reduce((sum, r) => sum + r.savedBytes, 0);

    blank();
    separator();

    if (selectedSubmodules.length > 0) {
      // 分组显示
      const mainLinked = mainResult.stats.linked + mainResult.stats.relink + mainResult.stats.replace +
        mainResult.stats.absorb + mainResult.stats.linkNew + mainResult.downloadedLibs.length;
      const mainNested = mainResult.nestedLinkedDeps.length;
      info(`主项目: ${mainLinked + mainNested} 个库` +
        (mainNested > 0 ? ` (顶层 ${mainLinked}, 嵌套 ${mainNested})` : ''));

      let totalLinked = mainLinked + mainNested;
      for (let i = 0; i < subResults.length; i++) {
        const subR = subResults[i];
        const subLinked = subR.stats.linked + subR.stats.relink + subR.stats.replace +
          subR.stats.absorb + subR.stats.linkNew + subR.downloadedLibs.length;
        const subNested = subR.nestedLinkedDeps.length;
        info(`${selectedSubmodules[i].name}: ${subLinked + subNested} 个库` +
          (subNested > 0 ? ` (顶层 ${subLinked}, 嵌套 ${subNested})` : ''));
        totalLinked += subLinked + subNested;
      }
      info(`完成: 共链接 ${totalLinked} 个库`);
    } else {
      const mainLinked = mainResult.stats.linked + mainResult.stats.relink + mainResult.stats.replace +
        mainResult.stats.absorb + mainResult.stats.linkNew + mainResult.downloadedLibs.length;
      const mainNested = mainResult.nestedLinkedDeps.length;
      const totalLinked = mainLinked + mainNested;
      if (mainNested > 0) {
        info(`完成: 链接 ${totalLinked} 个库 (顶层 ${mainLinked}, 嵌套 ${mainNested})`);
      } else {
        info(`完成: 链接 ${totalLinked} 个库`);
      }
    }

    if (allSavedBytes > 0) {
      info(`本次节省: ${formatSize(allSavedBytes)}`);
    }

    const totalSize = await store.getTotalSize();
    info(`Store 总计: ${formatSize(totalSize)}`);
    const unreferencedStores = registry.getUnreferencedStores();
    if (unreferencedStores.length > 0) {
      const unreferencedSize = unreferencedStores.reduce((sum, entry) => sum + entry.size, 0);
      hint(`无引用: ${unreferencedStores.length} 个 (${formatSize(unreferencedSize)}) - 可用 td clean 清理`);

      // capacity 策略：检查是否超过阈值
      const cleanStrategy = await config.get('cleanStrategy');
      if (cleanStrategy === 'capacity') {
        const threshold = (await config.get('unreferencedThreshold')) ?? 10 * 1024 * 1024 * 1024;
        if (unreferencedSize > threshold) {
          blank();
          warn(`无引用库容量 (${formatSize(unreferencedSize)}) 已超过阈值 (${formatSize(threshold)})`);

          if (!options.yes && process.stdout.isTTY) {
            // 交互模式：提供选项
            const halfCleanStores = registry.getStoresForHalfClean();
            const halfCleanSize = halfCleanStores.reduce((sum, e) => sum + e.size, 0);

            const action = await selectOption<'skip' | 'half' | 'all'>('选择清理方式:', [
              { name: '跳过本次', value: 'skip' },
              {
                name: `清理最久未引用的 (释放约 ${formatSize(halfCleanSize)})`,
                value: 'half',
              },
              { name: `全部清理 (释放 ${formatSize(unreferencedSize)})`, value: 'all' },
            ]);

            // ESC 取消视为跳过
            if (action !== PROMPT_CANCELLED && action !== 'skip') {
              const toClean = action === 'half' ? halfCleanStores : unreferencedStores;
              blank();
              info('正在清理...');
              let cleaned = 0;
              let freedSize = 0;
              for (const entry of toClean) {
                try {
                  await store.remove(entry.libName, entry.commit, entry.platform);
                  const storeKey = registry.getStoreKey(entry.libName, entry.commit, entry.platform);
                  registry.removeStore(storeKey);
                  freedSize += entry.size;
                  cleaned++;
                } catch (cleanErr) {
                  warn(`清理 ${entry.libName}/${entry.platform} 失败: ${(cleanErr as Error).message}`);
                }
              }
              await registry.save();
              success(`清理完成: 删除 ${cleaned} 个库，释放 ${formatSize(freedSize)}`);
            }
          } else {
            // 非交互模式：仅警告
            hint('使用 td clean 手动清理');
          }
        }
      }
    }

    // 检查更新
    const { checkForUpdates } = await import('../utils/update-check.js');
    await checkForUpdates();
  } catch (err) {
    // 链接过程出错，回滚事务
    error(`链接失败: ${(err as Error).message}`);
    hintStoreRepairCommand(err as Error);
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

function hintStoreRepairCommand(err: Error): void {
  const message = err.message;
  const isSharedPlatformConflict =
    message.includes('EEXIST') &&
    message.includes('_shared') &&
    KNOWN_PLATFORM_VALUES.some((platform) => message.includes(`${path.sep}_shared${path.sep}${platform}`) || message.includes(`/_shared/${platform}`));

  if (!isSharedPlatformConflict) {
    return;
  }

  hint('检测到 Store 结构冲突，可能是 _shared 中混入了平台目录。');
  hint('请运行 `td check --fix` 清理损坏的 Store 条目后再重试。');
}

/**
 * 注册 _shared 目录的 StoreEntry（如果存在）
 * 用于追踪平台库的共享内容大小
 *
 * @param libName 库名
 * @param commit commit hash
 * @param branch 分支名（可选，嵌套依赖可能没有）
 * @param url Git URL（可选，嵌套依赖可能没有）
 * @returns 是否成功注册（_shared 目录存在且有内容）
 */
async function registerSharedStore(
  libName: string,
  commit: string,
  branch: string = '',
  url: string = ''
): Promise<boolean> {
  const registry = getRegistry();
  const storeKey = registry.getStoreKey(libName, commit, SHARED_PLATFORM);

  // 如果已存在，不重复注册
  if (registry.getStore(storeKey)) {
    return true;
  }

  // 检查 _shared 目录是否存在
  const storePath = await config.getStorePath();
  if (!storePath) return false;

  const sharedPath = path.join(storePath, libName, commit, '_shared');
  try {
    await fs.access(sharedPath);
    const entries = await fs.readdir(sharedPath);
    if (entries.length === 0) {
      return false; // 空目录不注册
    }
  } catch {
    return false; // 目录不存在
  }

  // 计算 _shared 完整性信息并注册
  const integrity = await store.captureIntegrity(libName, commit, SHARED_PLATFORM);
  registry.addStore({
    libName,
    commit,
    platform: SHARED_PLATFORM,
    branch,
    url,
    ...integrity,
    usedBy: [], // _shared 不追踪引用，生命周期跟随平台
    createdAt: new Date().toISOString(),
    lastAccess: new Date().toISOString(),
  });

  debug(`注册 _shared: ${libName}:${commit.slice(0, 8)} (${formatSize(integrity.size)})`);
  return true;
}

async function ensureStoreInfo(
  libName: string,
  commit: string,
  platform: string,
  branch: string,
  url: string,
  projectHash?: string
): Promise<void> {
  const registry = getRegistry();
  const storeKey = registry.getStoreKey(libName, commit, platform);
  const existingEntry = registry.getStore(storeKey);

  if (!existingEntry) {
    const integrity = await store.captureIntegrity(libName, commit, platform);
    registry.addStore({
      libName,
      commit,
      platform,
      branch,
      url,
      ...integrity,
      usedBy: [],
      createdAt: new Date().toISOString(),
      lastAccess: new Date().toISOString(),
    });
  } else if (existingEntry.fileCount == null) {
    const integrity = await store.captureIntegrity(libName, commit, platform);
    registry.updateStore(storeKey, integrity);
  }

  if (projectHash) {
    registry.addStoreReference(storeKey, projectHash);
  }
}

async function syncLibraryInfo(
  libName: string,
  commit: string,
  branch: string,
  url: string,
  platforms: string[],
  isGeneral: boolean
): Promise<void> {
  const registry = getRegistry();
  const libKey = registry.getLibraryKey(libName, commit);
  const existingLibrary = registry.getLibrary(libKey);
  const normalizedPlatforms = [...new Set(platforms)];

  let totalSize = 0;
  for (const platform of normalizedPlatforms) {
    totalSize += await store.getSize(libName, commit, platform);
  }

  if (!existingLibrary) {
    registry.addLibrary({
      libName,
      commit,
      branch,
      url,
      platforms: normalizedPlatforms,
      size: totalSize,
      isGeneral,
      referencedBy: [],
      createdAt: new Date().toISOString(),
      lastAccess: new Date().toISOString(),
    });
    return;
  }

  registry.updateLibrary(libKey, {
    branch: branch || existingLibrary.branch,
    url: url || existingLibrary.url,
    platforms: normalizedPlatforms,
    size: totalSize,
    isGeneral,
    lastAccess: new Date().toISOString(),
  });
}

async function resolveStoredPlatforms(
  libName: string,
  commit: string,
  fallbackPlatforms: string[]
): Promise<string[]> {
  const storePath = await config.getStorePath();
  if (!storePath) {
    return [...new Set(fallbackPlatforms)];
  }

  const commitPath = path.join(storePath, libName, commit);
  try {
    const entries = await fs.readdir(commitPath, { withFileTypes: true });
    const storedPlatforms = entries
      .filter(entry => entry.isDirectory() && KNOWN_PLATFORM_VALUES.includes(entry.name))
      .map(entry => entry.name);

    return storedPlatforms.length > 0 ? storedPlatforms : [...new Set(fallbackPlatforms)];
  } catch {
    return [...new Set(fallbackPlatforms)];
  }
}

async function ensureLinkedRegistryState(
  libName: string,
  commit: string,
  branch: string,
  url: string,
  platforms: string[],
  projectHash: string,
  isGeneral: boolean
): Promise<void> {
  const linkedPlatforms = isGeneral ? [GENERAL_PLATFORM] : [...new Set(platforms)];
  const libraryPlatforms = isGeneral
    ? [GENERAL_PLATFORM]
    : await resolveStoredPlatforms(libName, commit, linkedPlatforms);

  for (const platform of linkedPlatforms) {
    await ensureStoreInfo(libName, commit, platform, branch, url, projectHash);
  }

  if (!isGeneral) {
    await registerSharedStore(libName, commit, branch, url);
  }

  await syncLibraryInfo(libName, commit, branch, url, libraryPlatforms, isGeneral);
}

/**
 * 注册嵌套依赖到 Registry
 * absorbLib 递归吸收嵌套依赖时只做文件操作，此函数负责 Registry 注册
 */
async function registerNestedLibraries(
  nestedLibraries: NestedAbsorbInfo[],
  projectHash: string
): Promise<void> {
  if (nestedLibraries.length === 0) return;

  debug(`注册 ${nestedLibraries.length} 个嵌套依赖: ${nestedLibraries.map(n => n.libName).join(', ')}`);
  const registry = getRegistry();

  // 注意：嵌套依赖从父库的 dependencies/ 目录递归发现，无法获取原始的 branch/url 信息
  // 使用空字符串作为占位符，代码中使用 if (entry.branch) 检查时会正确返回 false
  for (const nested of nestedLibraries) {
    if (nested.isGeneral) {
      // General 库：单个 StoreEntry
      const storeKey = registry.getStoreKey(nested.libName, nested.commit, GENERAL_PLATFORM);
      if (!registry.getStore(storeKey)) {
        const integrity = await store.captureIntegrity(nested.libName, nested.commit, GENERAL_PLATFORM);
        registry.addStore({
          libName: nested.libName,
          commit: nested.commit,
          platform: GENERAL_PLATFORM,
          branch: '',
          url: '',
          ...integrity,
          usedBy: [],
          createdAt: new Date().toISOString(),
          lastAccess: new Date().toISOString(),
        });
      }
      registry.addStoreReference(storeKey, projectHash);

      // 兼容旧结构：LibraryInfo
      const libKey = registry.getLibraryKey(nested.libName, nested.commit);
      if (!registry.getLibrary(libKey)) {
        registry.addLibrary({
          libName: nested.libName,
          commit: nested.commit,
          branch: '',
          url: '',
          platforms: [GENERAL_PLATFORM],
          size: nested.size,
          isGeneral: true,
          referencedBy: [],
          createdAt: new Date().toISOString(),
          lastAccess: new Date().toISOString(),
        });
      }
    } else {
      // 平台库：每个平台一个 StoreEntry
      for (const platform of nested.platforms) {
        const storeKey = registry.getStoreKey(nested.libName, nested.commit, platform);
        if (!registry.getStore(storeKey)) {
          const integrity = await store.captureIntegrity(nested.libName, nested.commit, platform);
          registry.addStore({
            libName: nested.libName,
            commit: nested.commit,
            platform,
            branch: '',
            url: '',
            ...integrity,
            usedBy: [],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          });
        }
        registry.addStoreReference(storeKey, projectHash);
      }

      // 注册 _shared 目录（如果存在）
      await registerSharedStore(nested.libName, nested.commit, '', '');

      // 兼容旧结构：LibraryInfo
      const libKey = registry.getLibraryKey(nested.libName, nested.commit);
      if (!registry.getLibrary(libKey)) {
        registry.addLibrary({
          libName: nested.libName,
          commit: nested.commit,
          branch: '',
          url: '',
          platforms: nested.platforms,
          size: nested.size,
          isGeneral: false,
          referencedBy: [],
          createdAt: new Date().toISOString(),
          lastAccess: new Date().toISOString(),
        });
      }
    }
  }
}

/**
 * 分类依赖的链接状态
 *
 * 统一检查逻辑，用于顶层 classifyDependencies 和嵌套依赖处理。
 * - General 库：检查根目录是否为指向 _shared 的正确符号链接
 * - 平台库：检查各平台子目录的符号链接状态
 */
export async function classifyLinkStatus(
  localPath: string,
  storeCommitPath: string,
  isGeneral: boolean,
  existingPlatforms: string[],
): Promise<'linked' | 'relink' | 'replace' | 'link_new'> {
  if (isGeneral) {
    const expectedTarget = path.join(storeCommitPath, '_shared');
    const status = await linker.getPathStatus(localPath, expectedTarget);
    switch (status) {
      case 'linked': return 'linked';
      case 'wrong_link':
      case 'broken_link': return 'relink';
      case 'directory': return 'replace';
      case 'missing':
      default: return 'link_new';
    }
  }

  // 平台库：检查各平台子目录的链接状态
  let allLinked = true;
  let hasBrokenOrWrong = false;
  let checkedCount = 0;

  for (const platform of existingPlatforms) {
    const platformLocalPath = path.join(localPath, platform);
    const platformStorePath = path.join(storeCommitPath, platform);
    const status = await linker.getPathStatus(platformLocalPath, platformStorePath);
    checkedCount++;
    if (status !== 'linked') {
      allLinked = false;
      if (status === 'wrong_link' || status === 'broken_link') {
        hasBrokenOrWrong = true;
      }
    }
  }

  if (checkedCount > 0 && allLinked) return 'linked';
  if (hasBrokenOrWrong) return 'relink';

  // Fallback：根据根路径是否存在判断
  try {
    await fs.lstat(localPath);
    return 'replace';
  } catch {
    return 'link_new';
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
  // 预加载配置，避免在循环中重复加载
  const cfg = await config.load();
  const unverifiedStrategy = cfg?.unverifiedLocalStrategy ?? 'download';

  for (const dep of dependencies) {
    const localPath = path.join(thirdPartyDir, dep.libName);
    const storeLibPath = store.getLibraryPath(storePath, dep.libName, dep.commit, primaryPlatform);

    // 检查 Store 中是否有任意请求的平台（而非只检查主平台）
    const { existing: rawExisting } = await store.checkPlatformCompleteness(dep.libName, dep.commit, platforms);

    // 完整性校验：验证 existing 平台的文件完整性
    const { valid: verifiedExisting, corrupted } = await verifyExistingPlatforms(dep.libName, dep.commit, rawExisting);

    // 清除损坏的平台数据
    if (corrupted.length > 0) {
      const registry = getRegistry();
      for (const platform of corrupted) {
        const storeKey = registry.getStoreKey(dep.libName, dep.commit, platform);
        registry.removeStore(storeKey);
        const platformPath = store.getLibraryPath(storePath, dep.libName, dep.commit, platform);
        await fs.rm(platformPath, { recursive: true, force: true }).catch(() => {});
      }
    }

    const existing = verifiedExisting;
    // 也检查是否为 General 库（有 _shared 且有内容）
    const isGeneral = await resolveLibraryGeneralState(dep);
    const inStore = existing.length > 0 || isGeneral;

    // 用于非 inStore 情况的本地路径状态检查
    const expectedTarget = isGeneral
      ? path.join(storePath, dep.libName, dep.commit, '_shared')
      : storeLibPath;
    const pathStatus = await linker.getPathStatus(localPath, expectedTarget);

    let status: DependencyStatus;

    if (inStore) {
      const storeCommitPath = path.join(storePath, dep.libName, dep.commit);
      const linkStatus = await classifyLinkStatus(localPath, storeCommitPath, isGeneral, existing);
      switch (linkStatus) {
        case 'linked': status = DependencyStatus.LINKED; break;
        case 'relink': status = DependencyStatus.RELINK; break;
        case 'replace': status = DependencyStatus.REPLACE; break;
        case 'link_new': status = DependencyStatus.LINK_NEW; break;
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
                if (unverifiedStrategy === 'absorb') {
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
  nestedLibraries: NestedAbsorbInfo[];
}

async function supplementMissingPlatforms(
  dependency: ParsedDependency,
  platforms: string[],
  registry: ReturnType<typeof getRegistry>,
  tx: Transaction,
  options: SupplementOptions = {}
): Promise<SupplementResult> {
  const result: SupplementResult = { downloaded: [], unavailable: [], nestedLibraries: [] };

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

    // 提示清理的平台（如果有）
    if (downloadResult.cleanedPlatforms.length > 0) {
      hint(`  已过滤: ${downloadResult.cleanedPlatforms.join(', ')}`);
    }

    try {
      // 5. 解释下载结果
      const assessment = assessDownloadResult(
        toDownload,
        dependency.sparse,
        downloadResult
      );
      const downloaded = assessment.downloadedRequested;
      result.downloaded = downloaded;

      // 6. 记录新发现的不可用平台
      const notFound = assessment.unavailableRequested;
      if (notFound.length > 0) {
        result.unavailable = notFound;
        const newUnavailable = [...new Set([...unavailablePlatforms, ...notFound])];
        upsertLibraryAvailability(dependency, {
          unavailablePlatforms: newUnavailable,
          isGeneral: false,
        });
        warn(`${dependency.libName} 平台 [${notFound.join(', ')}] 远程不存在，已记录`);
      }

      // 7. 吸收下载的内容到 Store（不做链接，由调用者负责）
      if (downloaded.length > 0) {
        const storePath = await store.getStorePath();
        const storeCommitPath = path.join(storePath, dependency.libName, dependency.commit);

        tx.recordOp('absorb', storeCommitPath, downloadResult.libDir);
        const supplementAbsorbResult = await store.absorbLib(
          downloadResult.libDir,
          downloaded,
          dependency.libName,
          dependency.commit
        );

        // 收集嵌套依赖（由调用者负责注册）
        result.nestedLibraries.push(...supplementAbsorbResult.nestedLibraries);

        // 8. 更新 Registry StoreEntry
        for (const platform of downloaded) {
          const storeKey = registry.getStoreKey(dependency.libName, dependency.commit, platform);
          if (!registry.getStore(storeKey)) {
            const integrity = await store.captureIntegrity(dependency.libName, dependency.commit, platform);
            registry.addStore({
              libName: dependency.libName,
              commit: dependency.commit,
              platform,
              branch: dependency.branch,
              url: dependency.url,
              ...integrity,
              usedBy: [],
              createdAt: new Date().toISOString(),
              lastAccess: new Date().toISOString(),
            });
          }
        }

        // 注册 _shared 目录（如果存在）
        await registerSharedStore(dependency.libName, dependency.commit, dependency.branch, dependency.url);

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
  projectRoot: string;  // 项目根目录，用于计算 linkedPath
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

  // 同步嵌套配置文件的 cache（兼容 checkValid.js 检测）
  await syncCacheFile(nestedConfigPath);

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
 * resolveLocalAndAbsorb 返回结果
 */
interface ResolveLocalResult {
  action: 'absorbed' | 'deleted' | 'skipped';
  isGeneral?: boolean;
  absorbResult?: AbsorbLocalResult;
}

/**
 * 统一的本地目录验证+吸收流程
 *
 * 对本地目录执行 verifyLocalCommit → 根据结果决定 absorb / delete / skip。
 * 消除了 linkNestedDependencies 中重复的 verifyLocalCommit + 平台检测 + absorb 逻辑。
 *
 * @param localPath 本地库目录路径
 * @param libName 库名
 * @param commit 预期 commit hash
 * @param options 策略选项
 */
async function resolveLocalAndAbsorb(
  localPath: string,
  libName: string,
  commit: string,
  options: {
    unverifiedStrategy: 'absorb' | 'download';
    dryRun: boolean;
    indent: string;
    onMatch?: () => void | Promise<void>;
    onMismatch?: (actualCommit?: string) => void | Promise<void>;
    onNoGit?: () => void | Promise<void>;
  }
): Promise<ResolveLocalResult> {
  const { unverifiedStrategy, dryRun, indent } = options;

  const verifyResult = await verifyLocalCommit(localPath, commit);

  switch (verifyResult.reason) {
    case 'match': {
      info(`${indent}  ${libName} - 本地 commit 匹配，吸收到 Store`);
      if (!dryRun) {
        await options.onMatch?.();
        const absorbResult = await store.absorbLocalLib(localPath, libName, commit);
        return { action: 'absorbed', isGeneral: absorbResult.isGeneral, absorbResult };
      }
      return { action: 'absorbed' };
    }
    case 'mismatch': {
      warn(
        `${indent}  ${libName}: 本地 commit (${verifyResult.actualCommit?.slice(0, 7)}) 与预期 (${commit.slice(0, 7)}) 不匹配，将重新下载`
      );
      if (!dryRun) {
        await options.onMismatch?.(verifyResult.actualCommit);
        await fs.rm(localPath, { recursive: true, force: true });
      }
      return { action: 'deleted' };
    }
    case 'no_git': {
      if (unverifiedStrategy === 'absorb') {
        info(`${indent}  ${libName}: 本地无 .git 目录，按配置直接吸收`);
        if (!dryRun) {
          await options.onNoGit?.();
          const absorbResult = await store.absorbLocalLib(localPath, libName, commit);
          return { action: 'absorbed', isGeneral: absorbResult.isGeneral, absorbResult };
        }
        return { action: 'absorbed' };
      } else {
        warn(`${indent}  ${libName}: 本地无 .git 目录，无法验证 commit，将重新下载`);
        if (!dryRun) {
          await fs.rm(localPath, { recursive: true, force: true });
        }
        return { action: 'deleted' };
      }
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
  const { tx, registry, projectHash, projectRoot, dryRun, download, generalLibs, downloadedLibs, nestedLinkedDeps } = options;
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

    // 检查 Store 状态和历史记录
    const libKey = registry.getLibraryKey(dep.libName, dep.commit);
    const historyLib = registry.getLibrary(libKey);
    const unavailablePlatforms = historyLib?.unavailablePlatforms || [];

    // 过滤掉已知不可用的平台
    const availablePlatforms = platforms.filter(p => !unavailablePlatforms.includes(p));
    const knownUnavailable = platforms.filter(p => unavailablePlatforms.includes(p));

    let storeHas = false;
    const existingPlatforms: string[] = [];
    for (const p of availablePlatforms) {
      if (await store.exists(dep.libName, dep.commit, p)) {
        existingPlatforms.push(p);
        storeHas = true;
      }
    }

    // 完整性校验：验证 existing 平台的文件完整性（与 classifyDependencies 同逻辑）
    if (existingPlatforms.length > 0) {
      const { valid: verifiedPlatforms, corrupted } = await verifyExistingPlatforms(
        dep.libName, dep.commit, existingPlatforms
      );
      if (corrupted.length > 0) {
        for (const p of corrupted) {
          const storeKey = registry.getStoreKey(dep.libName, dep.commit, p);
          registry.removeStore(storeKey);
          const platformPath = store.getLibraryPath(
            await store.getStorePath(), dep.libName, dep.commit, p
          );
          await fs.rm(platformPath, { recursive: true, force: true }).catch(() => {});
        }
        storeHas = verifiedPlatforms.length > 0;
      }
    }

    let isGeneral = await resolveLibraryGeneralState(dep);

    // 如果所有平台都已知不可用，跳过
    if (availablePlatforms.length === 0 && knownUnavailable.length > 0 && !isGeneral) {
      warn(`${indent}  ${dep.libName} - 平台 [${knownUnavailable.join(', ')}] 不支持（远程不存在）`);
      continue;
    }

    // Store 没有，但本地是目录时，验证 commit 并尝试 absorb
    if (!storeHas && !isGeneral && localExists && !localIsSymlink) {
      const cfg = await config.load();
      const strategy = (cfg?.unverifiedLocalStrategy ?? 'download') as 'absorb' | 'download';

      const resolveResult = await resolveLocalAndAbsorb(localPath, dep.libName, dep.commit, {
        unverifiedStrategy: strategy,
        dryRun,
        indent,
        onMatch: () => tx.recordOp('absorb', storeCommitPath, localPath),
        onNoGit: () => tx.recordOp('absorb', storeCommitPath, localPath),
      });

      if (resolveResult.action === 'absorbed' && !dryRun) {
        if (resolveResult.isGeneral) {
          isGeneral = true;
        }
        if (resolveResult.absorbResult?.nestedLibraries.length) {
          await registerNestedLibraries(resolveResult.absorbResult.nestedLibraries, projectHash);
        }
        storeHas = true;

        // 吸收为 General 后，检查是否实际需要平台内容
        // 本地可能只有部分文件（如只有 _shared 内容），被误分类为 General
        if (resolveResult.isGeneral && download) {
          const hasPlatformSparse = dep.sparse && !isSparseOnlyCommon(dep.sparse);
          if (hasPlatformSparse && availablePlatforms.length > 0) {
            try {
              const downloadResult = await codepac.downloadToTemp({
                url: dep.url,
                commit: dep.commit,
                branch: dep.branch,
                libName: dep.libName,
                platforms: availablePlatforms,
                sparse: dep.sparse,
                vars,
              });

              if (downloadResult.platformDirs.length > 0) {
                // 有平台内容 → 吸收平台目录，重新分类为平台库
                tx.recordOp('absorb', storeCommitPath, downloadResult.libDir);
                const nestedAbsorbResult = await store.absorbLib(
                  downloadResult.libDir,
                  downloadResult.platformDirs,
                  dep.libName,
                  dep.commit
                );
                await registerNestedLibraries(nestedAbsorbResult.nestedLibraries, projectHash);
                existingPlatforms.push(...downloadResult.platformDirs);
                isGeneral = false;
                info(`${indent}  ${dep.libName} - 补充平台内容 [${downloadResult.platformDirs.join(', ')}]`);
              }
              if (downloadResult.cleanedPlatforms.length > 0) {
                hint(`${indent}  已过滤: ${downloadResult.cleanedPlatforms.join(', ')}`);
              }
            } catch {
              // 下载失败，保持 General 分类
              warn(`${indent}  ${dep.libName} - 平台内容下载失败，保持 General 分类`);
            }
          }
        }
      }

      // 更新 localExists 状态（可能已被删除或 absorb）
      try {
        await fs.lstat(localPath);
        localExists = true;
      } catch {
        localExists = false;
      }
    }

    // 链接状态检查（与顶层 classifyDependencies 共享 classifyLinkStatus 逻辑）
    if (localExists && (storeHas || isGeneral)) {
      const linkStatus = await classifyLinkStatus(localPath, storeCommitPath, isGeneral, existingPlatforms);

      if (linkStatus === 'linked') {
        let linkedPlatforms = isGeneral ? [GENERAL_PLATFORM] : [...existingPlatforms];
        // 已链接，但需要检查是否需要补充缺失平台（与顶层依赖逻辑一致）
        if (!isGeneral) {
          const supplementResult = await supplementMissingPlatforms(
            dep,
            platforms,
            registry,
            tx,
            { vars }
          );

          // 注册嵌套依赖
          if (supplementResult.nestedLibraries.length > 0) {
            await registerNestedLibraries(supplementResult.nestedLibraries, projectHash);
          }

          // 如果补充了新平台，需要重新链接
          if (supplementResult.downloaded.length > 0) {
            success(`${indent}  ${dep.libName} - 补充平台 [${supplementResult.downloaded.join(', ')}]`);

            // 删除现有链接
            if (!dryRun) {
              await fs.rm(localPath, { recursive: true, force: true });
            }

            // 合并所有平台并重新链接
            const allPlatforms = [...existingPlatforms, ...supplementResult.downloaded];
            linkedPlatforms = allPlatforms;
            if (!dryRun) {
              tx.recordOp('link', localPath, storeCommitPath);
              await linker.linkLib(localPath, storeCommitPath, allPlatforms);
            }

            success(`${indent}  ${dep.libName} - 重新链接完成 [${allPlatforms.join(', ')}]`);
          }
        }

        await ensureLinkedRegistryState(
          dep.libName,
          dep.commit,
          dep.branch,
          dep.url,
          linkedPlatforms,
          projectHash,
          isGeneral
        );

        nestedLinkedDeps.push({
          libName: dep.libName,
          commit: dep.commit,
          platform: isGeneral ? GENERAL_PLATFORM : primaryPlatform,
          linkedPath: path.relative(projectRoot, localPath),
        });

        if (!isGeneral) {
          success(`${indent}  ${dep.libName} - 已链接`);
        }
        continue;
      }
      if (linkStatus === 'relink') {
        warn(`${indent}  ${dep.libName} - 链接异常（断链或指向错误），将重新链接`);
        if (!dryRun) {
          await fs.rm(localPath, { recursive: true, force: true });
        }
        localExists = false;
        localIsSymlink = false;
      }
      // 'replace' / 'link_new' 交由下方逻辑处理
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
        await ensureLinkedRegistryState(
          dep.libName,
          dep.commit,
          dep.branch,
          dep.url,
          [GENERAL_PLATFORM],
          projectHash,
          true
        );
        generalLibs.add(dep.libName);
        // 记录到 nestedLinkedDeps
        nestedLinkedDeps.push({
          libName: dep.libName,
          commit: dep.commit,
          platform: GENERAL_PLATFORM,
          linkedPath: path.relative(projectRoot, localPath),
        });
        success(`${indent}  ${dep.libName} - 链接完成 (General)`);
      } else {
        // 平台库：先补充缺失平台（与顶层依赖逻辑一致）
        const supplementResult = await supplementMissingPlatforms(
          dep,
          platforms,
          registry,
          tx,
          { vars }
        );

        // 注册嵌套依赖
        if (supplementResult.nestedLibraries.length > 0) {
          await registerNestedLibraries(supplementResult.nestedLibraries, projectHash);
        }

        // 合并所有可链接的平台（已有 + 新下载）
        const allPlatforms = [...existingPlatforms, ...supplementResult.downloaded];

        // 如果补充了新平台，提示用户
        if (supplementResult.downloaded.length > 0) {
          success(`${indent}  ${dep.libName} - 补充平台 [${supplementResult.downloaded.join(', ')}]`);
        }

        tx.recordOp('link', localPath, storeCommitPath);
        await linker.linkLib(localPath, storeCommitPath, allPlatforms);
        await ensureLinkedRegistryState(
          dep.libName,
          dep.commit,
          dep.branch,
          dep.url,
          allPlatforms,
          projectHash,
          false
        );
        // 记录到 nestedLinkedDeps
        nestedLinkedDeps.push({
          libName: dep.libName,
          commit: dep.commit,
          platform: primaryPlatform,
          linkedPath: path.relative(projectRoot, localPath),
        });
        success(`${indent}  ${dep.libName} - 链接完成 [${allPlatforms.join(', ')}]`);
      }
    } else if (download) {
      // Store 没有，需要下载
      info(`${indent}  ${dep.libName} - 下载中...`);

      if (dryRun) {
        info(`${indent}  ${dep.libName} - 将下载`);
        continue;
      }

      try {
        const nestedLibKey = registry.getLibraryKey(dep.libName, dep.commit);
        const nestedHistoryLib = registry.getLibrary(nestedLibKey);
        const downloadMonitor = new DownloadMonitor({
          name: `${indent}  ${dep.libName}`,
          estimatedSize: nestedHistoryLib?.size,
          getDirSize,
        });

        let downloadResult: codepac.DownloadResult;
        try {
          downloadResult = await codepac.downloadToTemp({
            url: dep.url,
            commit: dep.commit,
            branch: dep.branch,
            libName: dep.libName,
            platforms: availablePlatforms,
            sparse: dep.sparse,
            vars,
            onTempDirCreated: (_tempDir, libDir) => { downloadMonitor.start(libDir); },
            onHeartbeat: (message) => { downloadMonitor.heartbeat(message); },
          });
        } finally {
          await downloadMonitor.stop();
        }

        // 提示清理的平台（如果有）
        if (downloadResult.cleanedPlatforms.length > 0) {
          hint(`${indent}  已过滤: ${downloadResult.cleanedPlatforms.join(', ')}`);
        }

        const assessment = assessDownloadResult(
          availablePlatforms,
          dep.sparse,
          downloadResult
        );

        if (assessment.isPureGeneral) {
          // General 库处理
          upsertLibraryAvailability(dep, {
            platforms: [GENERAL_PLATFORM],
            isGeneral: true,
          });
          tx.recordOp('absorb', storeCommitPath, downloadResult.libDir);
          await store.absorbGeneral(downloadResult.libDir, dep.libName, dep.commit);

          const sharedPath = path.join(storeCommitPath, '_shared');
          tx.recordOp('link', localPath, sharedPath);
          await linker.linkGeneral(localPath, sharedPath);
          await ensureLinkedRegistryState(
            dep.libName,
            dep.commit,
            dep.branch,
            dep.url,
            [GENERAL_PLATFORM],
            projectHash,
            true
          );
          generalLibs.add(dep.libName);
          downloadedLibs.push(dep.libName);
          // 记录到 nestedLinkedDeps
          nestedLinkedDeps.push({
            libName: dep.libName,
            commit: dep.commit,
            platform: GENERAL_PLATFORM,
            linkedPath: path.relative(projectRoot, localPath),
          });
          success(`${indent}  ${dep.libName} - 下载完成 (General)`);
        } else if (assessment.downloadedRequested.length > 0) {
          // 平台库处理
          tx.recordOp('absorb', storeCommitPath, downloadResult.libDir);
          const nestedAbsorbResult = await store.absorbLib(
            downloadResult.libDir,
            assessment.downloadedRequested,
            dep.libName,
            dep.commit
          );
          await registerNestedLibraries(nestedAbsorbResult.nestedLibraries, projectHash);

          tx.recordOp('link', localPath, storeCommitPath);
          await linker.linkLib(localPath, storeCommitPath, assessment.downloadedRequested);
          await ensureLinkedRegistryState(
            dep.libName,
            dep.commit,
            dep.branch,
            dep.url,
            assessment.downloadedRequested,
            projectHash,
            false
          );
          downloadedLibs.push(dep.libName);
          // 记录到 nestedLinkedDeps
          nestedLinkedDeps.push({
            libName: dep.libName,
            commit: dep.commit,
            platform: primaryPlatform,
            linkedPath: path.relative(projectRoot, localPath),
          });

          // 检查并记录新发现的不可用平台
          const newUnavailable = assessment.unavailableRequested;
          if (newUnavailable.length > 0) {
            const updatedUnavailable = [...new Set([...unavailablePlatforms, ...newUnavailable])];
            upsertLibraryAvailability(dep, {
              unavailablePlatforms: updatedUnavailable,
              platforms: assessment.downloadedRequested,
              isGeneral: false,
            });
            warn(`${indent}  ${dep.libName} 平台 [${newUnavailable.join(', ')}] 远程不存在，已记录`);
          }

          success(`${indent}  ${dep.libName} - 下载完成 [${assessment.downloadedRequested.join(', ')}]`);
        } else {
          // 所有请求的平台都不可用，记录到 registry
          const newUnavailable = [...new Set([...unavailablePlatforms, ...availablePlatforms])];
          upsertLibraryAvailability(dep, {
            unavailablePlatforms: newUnavailable,
            isGeneral: false,
          });
          warn(`${indent}  ${dep.libName} - 下载成功但平台 [${availablePlatforms.join(', ')}] 不可用，已记录`);
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

/**
 * 合并多个配置的依赖列表，去重（后者覆盖前者）
 * @param main 主配置的依赖列表
 * @param optional 可选配置的依赖列表
 * @returns 合并后的依赖列表
 */
function mergeDepLists(main: ParsedDependency[], optional: ParsedDependency[]): ParsedDependency[] {
  // 使用 Map 按 libName 去重，后者覆盖前者
  const depMap = new Map<string, ParsedDependency>();

  for (const dep of main) {
    depMap.set(dep.libName, dep);
  }

  for (const dep of optional) {
    const existing = depMap.get(dep.libName);
    if (existing && existing.commit !== dep.commit) {
      // 同名库但 commit 不同，警告用户可选配置覆盖了主配置
      warn(`${dep.libName}: 可选配置 commit (${dep.commit.slice(0, 7)}) 覆盖主配置 (${existing.commit.slice(0, 7)})`);
    }
    depMap.set(dep.libName, dep);
  }

  return Array.from(depMap.values());
}

/**
 * 校验已有平台的完整性
 * 遍历 existing 平台列表，查询 Registry 中的 StoreEntry，
 * 如果有 fileCount，调用 quickVerify 校验；匹配则保留，不匹配则标记为 corrupted。
 * 没有 fileCount 的条目跳过校验（视为合法）。
 *
 * @param libName 库名
 * @param commit commit hash
 * @param existingPlatforms Store 中已有的平台列表
 * @returns { valid: string[]; corrupted: string[] } 合法和损坏的平台列表
 */
export async function verifyExistingPlatforms(
  libName: string,
  commit: string,
  existingPlatforms: string[]
): Promise<{ valid: string[]; corrupted: string[] }> {
  const valid: string[] = [];
  const corrupted: string[] = [];
  const registry = getRegistry();

  for (const platform of existingPlatforms) {
    const storeKey = registry.getStoreKey(libName, commit, platform);
    const entry = registry.getStore(storeKey);

    // 没有 StoreEntry，跳过校验视为合法
    if (!entry) {
      valid.push(platform);
      continue;
    }

    // 旧数据回填：升级后首次遇到无 fileCount 的条目，顺便记录完整性数据
    if (entry.fileCount == null) {
      try {
        const integrity = await store.captureIntegrity(libName, commit, platform);
        registry.updateStore(storeKey, integrity);
      } catch {
        // 回填失败不影响正常流程
      }
      valid.push(platform);
      continue;
    }

    const result = await store.quickVerify(libName, commit, platform, {
      size: entry.size,
      fileCount: entry.fileCount,
    });

    if (result.valid) {
      valid.push(platform);
    } else {
      corrupted.push(platform);
      warn(`${libName} (${commit.slice(0, 7)}) ${platform}: 完整性校验失败 - ${result.reason}`);
    }
  }

  return { valid, corrupted };
}

/**
 * 创建带完整性信息的 StoreEntry
 * 在 addStore 时自动采集 fileCount 和 contentHash
 * @param params StoreEntry 基础参数（不含 fileCount/contentHash）
 * @returns 包含完整性信息的 StoreEntry
 */
export async function createStoreEntryWithIntegrity(params: {
  libName: string;
  commit: string;
  platform: string;
  branch: string;
  url: string;
  size: number;
}): Promise<StoreEntry> {
  const integrity = await store.captureIntegrity(params.libName, params.commit, params.platform);
  return {
    ...params,
    ...integrity,
    usedBy: [],
    createdAt: new Date().toISOString(),
    lastAccess: new Date().toISOString(),
  };
}

export default createLinkCommand;
