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
import { resolvePath, getPlatformHelpText } from '../core/platform.js';
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
    .addHelpText('after', getPlatformHelpText())
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

  // 预扫描 ABSORB 依赖的额外平台，让用户选择要链接的平台
  let finalLinkPlatforms: string[] = platforms; // 默认为用户请求的平台
  if (!options.yes && process.stdout.isTTY) {
    const { KNOWN_PLATFORM_VALUES } = await import('../core/platform.js');
    const absorbItems = classified.filter(c => c.status === DependencyStatus.ABSORB);

    // 收集所有本地存在的平台（去重）
    const allLocalPlatforms = new Set<string>();
    for (const item of absorbItems) {
      try {
        const entries = await fs.readdir(item.localPath, { withFileTypes: true });
        entries
          .filter(e => e.isDirectory() && KNOWN_PLATFORM_VALUES.includes(e.name))
          .forEach(e => allLocalPlatforms.add(e.name));
      } catch {
        // 读取失败，跳过
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
        case DependencyStatus.LINKED:
          // 已链接，跳过
          break;

        case DependencyStatus.RELINK: {
          // 重建链接（Store 已有，直接 linkLib）
          const relinkCommitPath = path.join(storePath, dependency.libName, dependency.commit);

          // 获取 Store 中实际存在的平台
          const { existing: relinkExisting } = await store.checkPlatformCompleteness(
            dependency.libName,
            dependency.commit,
            platforms
          );

          tx.recordOp('unlink', localPath);
          await linker.unlink(localPath);
          tx.recordOp('link', localPath, relinkCommitPath);
          await linker.linkLib(localPath, relinkCommitPath, relinkExisting);
          success(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 重建链接 [${relinkExisting.join(', ')}]`);
          break;
        }

        case DependencyStatus.REPLACE: {
          // Store 已有，删除本地目录，直接 linkLib
          const replaceSize = await getDirSize(localPath);
          const replaceCommitPath = path.join(storePath, dependency.libName, dependency.commit);

          // 获取 Store 中实际存在的平台
          const { existing: replaceExisting } = await store.checkPlatformCompleteness(
            dependency.libName,
            dependency.commit,
            platforms
          );

          tx.recordOp('replace', localPath, replaceCommitPath);
          await linker.linkLib(localPath, replaceCommitPath, platforms);
          savedBytes += replaceSize;
          success(
            `${dependency.libName} (${dependency.commit.slice(0, 7)}) - Store 已有，创建链接 [${replaceExisting.join(', ')}]`
          );
          break;
        }

        case DependencyStatus.ABSORB: {
          // 移入 Store（吸收本地目录所有平台内容）
          const absorbSize = await getDirSize(localPath);
          const storeCommitPath = path.join(storePath, dependency.libName, dependency.commit);

          // 1. 扫描本地平台目录
          const { KNOWN_PLATFORM_VALUES } = await import('../core/platform.js');
          const localDirEntries = await fs.readdir(localPath, { withFileTypes: true });
          const localPlatforms = localDirEntries
            .filter(entry => entry.isDirectory() && KNOWN_PLATFORM_VALUES.includes(entry.name))
            .map(entry => entry.name);

          // 2. 确定最终要吸收的平台（取本地存在的 ∩ 用户选择的）
          const finalPlatforms = localPlatforms.filter(p => finalLinkPlatforms.includes(p));

          tx.recordOp('absorb', localPath, storeCommitPath);
          const absorbResult = await store.absorbLib(
            localPath,
            finalPlatforms,
            dependency.libName,
            dependency.commit
          );

          // 获取所有可链接的平台（新吸收 + 已存在跳过的）
          const linkPlatforms = [...Object.keys(absorbResult.platformPaths), ...absorbResult.skippedPlatforms];
          if (linkPlatforms.length > 0) {
            tx.recordOp('link', localPath, storeCommitPath);
            await linker.linkLib(localPath, storeCommitPath, linkPlatforms);

            // 为每个平台创建 StoreEntry 并添加引用
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
              registry.addLibrary({
                libName: dependency.libName,
                commit: dependency.commit,
                branch: dependency.branch,
                url: dependency.url,
                platforms: linkPlatforms,
                size: absorbSize,
                referencedBy: [],
                createdAt: new Date().toISOString(),
                lastAccess: new Date().toISOString(),
              });
            }

            hint(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 本地已有，移入 Store [${linkPlatforms.join(', ')}]`);
          } else {
            warn(`${dependency.libName} (${dependency.commit.slice(0, 7)}) - 本地目录不含任何平台内容，跳过`);
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
            const downloadResult = await codepac.downloadToTemp({
              url: dependency.url,
              commit: dependency.commit,
              branch: dependency.branch,
              libName: dependency.libName,
              platforms: missing,
              sparse: dependency.sparse,
            });

            try {
              // 过滤：只保留实际下载的且在 missing 列表中的平台
              const filteredMissing = downloadResult.platformDirs.filter(p => missing.includes(p));
              if (filteredMissing.length > 0) {
                tx.recordOp('absorb', downloadResult.libDir, linkNewCommitPath);
                await store.absorbLib(
                  downloadResult.libDir,
                  filteredMissing,
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

          // 4. linkLib 实际存在的平台
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
        info(`开始并行下载 ${toDownload.length} 个库 (最多 3 个并发)...`);
        blank();

        // 并行控制器，最多同时 3 个下载
        const downloadLimit = pLimit(3);

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

              // 只下载缺失的平台
              info(`下载 ${dependency.libName} [${missing.join(', ')}]...`);

              // 1. 调用 downloadToTemp 只下载缺失的平台
              const downloadResult = await codepac.downloadToTemp({
                url: dependency.url,
                commit: dependency.commit,
                branch: dependency.branch,
                libName: dependency.libName,
                platforms: missing,
                sparse: dependency.sparse,
              });

              try {
                // 2. 过滤平台：只保留实际下载的且在 missing 列表中的平台
                const filteredMissing = downloadResult.platformDirs.filter(p => missing.includes(p));

                // 3. 调用 absorbLib 将临时目录内容移入 Store（如果有下载成功的平台）
                if (filteredMissing.length > 0) {
                  tx.recordOp('absorb', downloadResult.libDir, storeCommitPath);
                  await store.absorbLib(
                    downloadResult.libDir,
                    filteredMissing,
                    dependency.libName,
                    dependency.commit
                  );
                }

                // 4. 获取所有可链接的平台（已存在 + 新下载成功的）
                const linkPlatforms = [...existing, ...filteredMissing];
                if (linkPlatforms.length === 0) {
                  return {
                    success: false,
                    name: dependency.libName,
                    skipped: true,
                    skippedPlatforms: platforms,
                  };
                }

                // 5. 调用 linkLib 创建符号链接并复制共享文件
                tx.recordOp('link', localPath, storeCommitPath);
                await linker.linkLib(localPath, storeCommitPath, linkPlatforms);

                // 6. 为每个平台创建 StoreEntry 并添加引用
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
    const inStore = existing.length > 0;
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

export default createLinkCommand;
