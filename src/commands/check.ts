/**
 * check 命令 - 健康检查（合并 doctor/verify/repair）
 */
import fs from 'fs/promises';
import path from 'path';
import { Command } from 'commander';
import { checkCodepacEnvironment } from '../core/codepac.js';
import type { CodepacEnvironmentCheck } from '../core/codepac.js';
import { getDiskInfo, formatSize } from '../utils/disk.js';
import * as config from '../core/config.js';
import { getRegistry } from '../core/registry.js';
import * as store from '../core/store.js';
import { KNOWN_PLATFORM_VALUES } from '../core/platform.js';
import {
  info,
  warn,
  success,
  error,
  hint,
  blank,
  title,
  separator,
  colorize,
  debug,
} from '../utils/logger.js';
import {
  selectWithCancel,
  checkboxWithCancel,
  confirmWithCancel,
  PROMPT_CANCELLED,
} from '../utils/prompt.js';

// ============ 类型定义 ============

interface EnvironmentCheck {
  codepac: { ok: boolean; message: string; details: CodepacEnvironmentCheck };
  config: { ok: boolean; message: string };
  store: { ok: boolean; path: string; message: string };
  disk: { ok: boolean; free: number; warn: boolean; message: string };
}

interface IntegrityIssue {
  invalidProjects: { hash: string; path: string }[];
  danglingLinks: {
    path: string;
    projectHash: string;
    dep: { libName: string; commit: string };
  }[];
  orphanLibraries: {
    libName: string;
    commit: string;
    size: number;
    path: string;
  }[];
  missingLibraries: { libName: string; commit: string; project: string }[];
  staleReferences: { libKey: string; projectHash: string; projectPath: string }[];
  corruptedStores: {
    libName: string;
    commit: string;
    platform: string;
    reason: string;
    kind?: 'integrity_mismatch' | 'shared_platform_conflict';
    conflictPlatforms?: string[];
    expected: { fileCount?: number; size?: number; contentHash?: string };
    actual: { fileCount: number; size: number; contentHash?: string };
  }[];
}

interface CheckResult {
  environment: EnvironmentCheck;
  integrity: IntegrityIssue;
  summary: {
    envErrors: number;
    envWarnings: number;
    integrityIssues: number;
    reclaimableSize: number;
  };
}

interface CheckOptions {
  fix: boolean;
  dryRun: boolean;
  json: boolean;
  force: boolean;
  integrity: boolean;
}

// ============ 命令创建 ============

export function createCheckCommand(): Command {
  return new Command('check')
    .description('健康检查（环境诊断 + 数据一致性验证）')
    .option('--fix', '直接修复所有问题')
    .option('--dry-run', '只显示问题，不修复')
    .option('--json', '输出 JSON 格式')
    .option('--force', '跳过确认')
    .option('--integrity', '校验 Store 文件完整性（fileCount + contentHash）')
    .action(async (options: CheckOptions) => {
      await runCheck(options);
    });
}

// ============ 主流程 ============

async function runCheck(options: CheckOptions): Promise<void> {
  const result = await collectAllIssues({ integrity: options.integrity });

  // JSON 输出
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // 渲染报告
  renderReport(result);

  const hasIssues = result.summary.integrityIssues > 0;
  const hasEnvErrors = result.summary.envErrors > 0;

  // dry-run 模式
  if (options.dryRun) {
    if (hasIssues) {
      blank();
      hint('运行 td check --fix 修复问题');
    }
    return;
  }

  // 环境错误无法修复
  if (hasEnvErrors) {
    blank();
    error('存在环境错误，请先解决环境问题');
    return;
  }

  // 无问题
  if (!hasIssues) {
    return;
  }

  // --fix 模式：直接修复
  if (options.fix) {
    await fixAllIssues(result.integrity, { force: options.force });
    return;
  }

  // 交互模式
  await interactiveCheck(result.integrity, options);
}

// ============ 数据收集 ============

async function collectAllIssues(options?: { integrity?: boolean }): Promise<CheckResult> {
  const environment = await checkEnvironment();
  const integrity = await checkIntegrity(options);

  // 计算汇总
  // 错误：检查项失败（ok === false），排除仅作为警告的项
  // 警告：目前只有 disk 有 warn 字段（空间 < 5GB 但不影响功能）
  const envErrors = [
    environment.codepac,
    environment.config,
    environment.store,
    environment.disk,
  ].filter((c) => !c.ok).length;
  const envWarnings = environment.disk.warn ? 1 : 0;

  const integrityIssues =
    integrity.invalidProjects.length +
    integrity.danglingLinks.length +
    integrity.orphanLibraries.length +
    integrity.missingLibraries.length +
    integrity.staleReferences.length +
    integrity.corruptedStores.length;

  const reclaimableSize = integrity.orphanLibraries.reduce(
    (sum, lib) => sum + lib.size,
    0
  );

  return {
    environment,
    integrity,
    summary: {
      envErrors,
      envWarnings,
      integrityIssues,
      reclaimableSize,
    },
  };
}

async function checkEnvironment(): Promise<EnvironmentCheck> {
  const codepacEnvironment = await checkCodepacEnvironment();
  const result: EnvironmentCheck = {
    codepac: { ok: false, message: '', details: codepacEnvironment },
    config: { ok: false, message: '' },
    store: { ok: false, path: '', message: '' },
    disk: { ok: false, free: 0, warn: false, message: '' },
  };

  debug(
    `[check] 环境检测开始: cwd=${process.cwd()}, codepac=${codepacEnvironment.codepacCommand.ok}, git=${codepacEnvironment.git.ok}, gitLfs=${codepacEnvironment.gitLfs.ok}, version=${codepacEnvironment.codepacVersion.ok}`
  );

  // 1. codepac / Git / Git LFS
  result.codepac = {
    ok: codepacEnvironment.ok,
    message: formatCodepacEnvironmentMessage(codepacEnvironment),
    details: codepacEnvironment,
  };

  // 2. 配置
  const cfg = await config.load();
  result.config = {
    ok: !!cfg,
    message: cfg ? '已初始化' : '未初始化，运行 td init',
  };

  // 3. Store 目录
  if (cfg?.storePath) {
    try {
      await fs.access(cfg.storePath);
      result.store = {
        ok: true,
        path: cfg.storePath,
        message: cfg.storePath,
      };
    } catch {
      result.store = {
        ok: false,
        path: cfg.storePath,
        message: '目录不存在或无权限',
      };
    }
  } else {
    result.store = {
      ok: false,
      path: '',
      message: '未配置',
    };
  }

  // 4. 磁盘空间
  const disks = await getDiskInfo();
  const storeDisk = disks.find((d) => cfg?.storePath?.startsWith(d.path));
  const targetDisk = storeDisk || disks.find((d) => d.isSystem) || disks[0];

  if (targetDisk) {
    const lowSpace = targetDisk.free < 5 * 1024 * 1024 * 1024;
    result.disk = {
      ok: true,
      free: targetDisk.free,
      warn: lowSpace,
      message: `${formatSize(targetDisk.free)} 可用${lowSpace ? ' (建议 > 5GB)' : ''}`,
    };
  } else {
    result.disk = {
      ok: false,
      free: 0,
      warn: false,
      message: '无法获取磁盘信息',
    };
  }

  debug(
    `[check] 环境检测完成: codepacOk=${result.codepac.ok}, configOk=${result.config.ok}, storeOk=${result.store.ok}, diskOk=${result.disk.ok}, diskWarn=${result.disk.warn}`
  );

  return result;
}

async function checkIntegrity(options?: { integrity?: boolean }): Promise<IntegrityIssue> {
  const result: IntegrityIssue = {
    invalidProjects: [],
    danglingLinks: [],
    orphanLibraries: [],
    missingLibraries: [],
    staleReferences: [],
    corruptedStores: [],
  };

  // 尝试加载 registry
  let registry;
  let storePath: string;
  try {
    registry = getRegistry();
    await registry.load();
    storePath = await store.getStorePath();
  } catch (err) {
    // 未初始化，跳过完整性检查
    debug(`[check] Registry 加载失败，跳过完整性检查: ${(err as Error).message}`);
    return result;
  }

  const projects = registry.listProjects();

  // 1. 检查项目和链接
  for (const project of projects) {
    const projectHash = registry.hashPath(project.path);

    // 检查项目路径
    try {
      await fs.access(project.path);
    } catch {
      result.invalidProjects.push({ hash: projectHash, path: project.path });
      continue;
    }

    // 检查依赖链接
    for (const dep of project.dependencies) {
      const linkPath = path.join(project.path, dep.linkedPath);
      const verifyPlatform = dep.platform ?? project.platforms?.[0];

      // 如果无法确定平台，跳过此依赖的完整性检查（数据不完整）
      if (!verifyPlatform) {
        continue;
      }

      try {
        const stat = await fs.lstat(linkPath);
        if (stat.isSymbolicLink()) {
          const actualTarget = await fs.readlink(linkPath);
          const resolvedTarget = path.resolve(path.dirname(linkPath), actualTarget);

          try {
            await fs.access(resolvedTarget);
          } catch {
            result.danglingLinks.push({
              path: linkPath,
              projectHash,
              dep: { libName: dep.libName, commit: dep.commit },
            });
          }
        }
      } catch {
        // 链接不存在，检查库是否在 Store
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
          result.orphanLibraries.push({ libName, commit, size, path: commitPath });
          continue;
        }

        const sharedConflict = await detectSharedPlatformConflict(commitPath);
        if (sharedConflict) {
          result.corruptedStores.push({
            libName,
            commit,
            platform: '_shared',
            kind: 'shared_platform_conflict',
            reason: `_shared 包含平台目录: ${sharedConflict.join(', ')}`,
            conflictPlatforms: sharedConflict,
            expected: {},
            actual: { fileCount: sharedConflict.length, size: 0 },
          });
        }
      }
    }
  } catch (err) {
    // Store 目录不存在或无法访问
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      debug(`[check] 扫描 Store 目录失败: ${e.message}`);
    }
  }

  // 3. 检查失效引用
  const libraries = registry.listLibraries();

  for (const lib of libraries) {
    const libKey = registry.getLibraryKey(lib.libName, lib.commit);

    for (const projectHash of lib.referencedBy) {
      const project = registry.getProject(projectHash);
      if (!project) {
        result.staleReferences.push({
          libKey,
          projectHash,
          projectPath: '(项目已删除)',
        });
        continue;
      }

      // 检查是否有有效链接
      let hasValidLink = false;
      const libStorePath = path.join(storePath, lib.libName, lib.commit);

      for (const dep of project.dependencies) {
        if (dep.libName === lib.libName && dep.commit === lib.commit) {
          const linkPath = path.join(project.path, dep.linkedPath);
          try {
            const stat = await fs.lstat(linkPath);
            if (stat.isSymbolicLink()) {
              const target = await fs.readlink(linkPath);
              const resolvedTarget = path.resolve(path.dirname(linkPath), target);
              if (resolvedTarget.startsWith(libStorePath)) {
                hasValidLink = true;
                break;
              }
            } else if (stat.isDirectory()) {
              // 多平台模式
              const entries = await fs.readdir(linkPath, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.isSymbolicLink()) {
                  const subLinkPath = path.join(linkPath, entry.name);
                  const subTarget = await fs.readlink(subLinkPath);
                  const resolvedSubTarget = path.resolve(linkPath, subTarget);
                  if (resolvedSubTarget.startsWith(libStorePath)) {
                    hasValidLink = true;
                    break;
                  }
                }
              }
              if (hasValidLink) break;
            }
          } catch (err) {
            // 检查子链接时出错，记录但继续
            debug(`[check] 检查子链接失败: ${(err as Error).message}`);
          }
        }
      }

      if (!hasValidLink) {
        result.staleReferences.push({
          libKey,
          projectHash,
          projectPath: project.path,
        });
      }
    }
  }

  // 4. --integrity 模式：校验 StoreEntry 文件完整性
  if (options?.integrity) {
    const stores = registry.listStores();
    for (const entry of stores) {
      if (entry.fileCount != null) {
        // 有 fileCount 的做 fullVerify
        const expectedData = {
          size: entry.size,
          fileCount: entry.fileCount,
          contentHash: entry.contentHash,
        };
        const verifyResult = await store.fullVerify(entry.libName, entry.commit, entry.platform, expectedData);
        if (!verifyResult.valid) {
          result.corruptedStores.push({
            libName: entry.libName,
            commit: entry.commit,
            platform: entry.platform,
            reason: verifyResult.reason || 'unknown',
            expected: expectedData,
            actual: verifyResult.actual ?? { fileCount: 0, size: 0 },
          });
        }
      } else {
        // 无 fileCount 的做回填（captureIntegrity）
        try {
          const integrity = await store.captureIntegrity(entry.libName, entry.commit, entry.platform);
          const storeKey = registry.getStoreKey(entry.libName, entry.commit, entry.platform);
          registry.updateStore(storeKey, {
            size: integrity.size,
            fileCount: integrity.fileCount,
            contentHash: integrity.contentHash,
          });
        } catch {
          debug(`[check] 回填完整性数据失败: ${entry.libName}:${entry.commit}:${entry.platform}`);
        }
      }
    }
    // 保存回填的数据
    await registry.save();
  }

  return result;
}

// ============ 报告渲染 ============

function renderReport(result: CheckResult): void {
  title('TanmiDock 健康检查');
  blank();

  // 环境状态
  info('环境状态');
  separator();

  const env = result.environment;
  renderCheck('codepac', env.codepac.ok, env.codepac.message, false);
  renderCodepacEnvironmentDetails(env.codepac.details);
  renderCheck('配置文件', env.config.ok, env.config.message, false);
  renderCheck('Store 目录', env.store.ok, env.store.message, false);
  renderCheck('磁盘空间', env.disk.ok, env.disk.message, env.disk.warn);

  blank();

  // 数据一致性
  info('数据一致性');
  separator();

  const integ = result.integrity;
  renderCheck(
    '项目记录',
    integ.invalidProjects.length === 0,
    integ.invalidProjects.length === 0
      ? '完整'
      : `${integ.invalidProjects.length} 个无效项目`,
    false
  );
  renderCheck(
    '符号链接',
    integ.danglingLinks.length === 0,
    integ.danglingLinks.length === 0
      ? '完整'
      : `${integ.danglingLinks.length} 个悬挂链接`,
    false
  );
  renderCheck(
    '孤立库',
    integ.orphanLibraries.length === 0,
    integ.orphanLibraries.length === 0
      ? '无'
      : `${integ.orphanLibraries.length} 个未登记 (${formatSize(result.summary.reclaimableSize)})`,
    false
  );
  renderCheck(
    '缺失库',
    integ.missingLibraries.length === 0,
    integ.missingLibraries.length === 0
      ? '无'
      : `${integ.missingLibraries.length} 个 (需 td link 下载)`,
    true // 显示为警告而非错误，因为需要用户手动下载
  );
  renderCheck(
    '引用关系',
    integ.staleReferences.length === 0,
    integ.staleReferences.length === 0
      ? '一致'
      : `${integ.staleReferences.length} 个失效引用`,
    false
  );
  renderCheck(
    'Store 完整性',
    integ.corruptedStores.length === 0,
    integ.corruptedStores.length === 0
      ? '完整'
      : `${integ.corruptedStores.length} 个损坏的 Store 条目`,
    false
  );

  blank();
  separator();

  // 汇总
  const { envErrors, envWarnings, integrityIssues, reclaimableSize } = result.summary;

  if (envErrors === 0 && envWarnings === 0 && integrityIssues === 0) {
    success('系统健康，无问题');
  } else {
    const parts: string[] = [];
    if (envErrors > 0) parts.push(`${envErrors} 个环境错误`);
    if (envWarnings > 0) parts.push(`${envWarnings} 个警告`);
    if (integrityIssues > 0) parts.push(`${integrityIssues} 个数据问题`);
    if (reclaimableSize > 0) parts.push(`可回收 ${formatSize(reclaimableSize)}`);

    warn(`发现问题: ${parts.join(', ')}`);
  }
}

function formatCodepacEnvironmentMessage(environment: CodepacEnvironmentCheck): string {
  if (environment.ok) {
    return environment.codepacVersion.version || 'CodePac、Git、Git LFS 可用';
  }

  const failures: string[] = [];
  if (!environment.codepacCommand.ok) {
    failures.push('CodePac 命令缺失');
  }
  if (!environment.git.ok) {
    failures.push(environment.git.version
      ? `Git 版本不足(${environment.git.version} < ${environment.git.minimumVersion})`
      : 'Git 不可用');
  }
  if (!environment.gitLfs.ok) {
    failures.push('Git LFS 不可用');
  }
  if (environment.codepacCommand.ok && !environment.codepacVersion.ok) {
    failures.push('codepac --version 执行失败');
  }

  return failures.join('；') || 'CodePac 环境不可用';
}

function renderCodepacEnvironmentDetails(environment: CodepacEnvironmentCheck): void {
  debug(
    `[check] CodePac 环境详情: commandOk=${environment.codepacCommand.ok}, gitVersion=${environment.git.version ?? 'unknown'}, gitOk=${environment.git.ok}, gitLfsOk=${environment.gitLfs.ok}, versionOk=${environment.codepacVersion.ok}`
  );

  if (environment.ok) {
    return;
  }

  if (!environment.codepacCommand.ok) {
    warn(`  - CodePac 命令: ${environment.codepacCommand.message}`);
  }
  if (!environment.git.ok) {
    warn(`  - Git: ${environment.git.message}`);
  }
  if (!environment.gitLfs.ok) {
    warn(`  - Git LFS: ${environment.gitLfs.message}`);
  }
  if (environment.codepacCommand.ok && !environment.codepacVersion.ok) {
    warn(`  - CodePac 版本命令: ${environment.codepacVersion.message}`);
    if (environment.codepacVersion.error) {
      debug(`[check] codepac --version 错误: ${environment.codepacVersion.error}`);
    }
  }
}

function renderCheck(
  name: string,
  ok: boolean,
  message: string,
  isWarning: boolean
): void {
  if (ok && !isWarning) {
    success(`[✓] ${name.padEnd(10)} ${message}`);
  } else if (isWarning) {
    warn(`[!] ${name.padEnd(10)} ${message}`);
  } else {
    error(`[✗] ${name.padEnd(10)} ${message}`);
  }
}

// ============ 交互式修复 ============

async function interactiveCheck(
  issues: IntegrityIssue,
  options: CheckOptions
): Promise<void> {
  blank();

  const action = await selectWithCancel({
    message: '选择操作',
    choices: [
      { name: '修复所有问题', value: 'fix-all' as const },
      { name: '选择性修复', value: 'select' as const },
      { name: '查看详情', value: 'detail' as const },
      { name: colorize('← 退出', 'dim'), value: 'exit' as const },
    ],
  });

  // ESC 取消 = 退出
  if (action === PROMPT_CANCELLED) {
    info('已取消');
    return;
  }

  switch (action) {
    case 'fix-all':
      await fixAllIssues(issues, { force: true });
      // 缺失库无法自动修复，需要提示用户
      if (issues.missingLibraries.length > 0) {
        blank();
        hint(`缺失库 (${issues.missingLibraries.length} 个) 需要通过 td link 重新下载`);
      }
      break;
    case 'select':
      await selectiveFix(issues, options);
      break;
    case 'detail':
      showDetails(issues);
      await interactiveCheck(issues, options);
      break;
    case 'exit':
      break;
  }
}

async function selectiveFix(
  issues: IntegrityIssue,
  options: CheckOptions
): Promise<void> {
  // 构建选项
  const choices: { name: string; value: string; checked: boolean }[] = [];

  if (issues.invalidProjects.length > 0) {
    choices.push({
      name: `清理 ${issues.invalidProjects.length} 个无效项目记录`,
      value: 'invalidProjects',
      checked: true,
    });
  }

  if (issues.danglingLinks.length > 0) {
    choices.push({
      name: `移除 ${issues.danglingLinks.length} 个悬挂链接`,
      value: 'danglingLinks',
      checked: true,
    });
  }

  if (issues.orphanLibraries.length > 0) {
    const size = formatSize(
      issues.orphanLibraries.reduce((sum, lib) => sum + lib.size, 0)
    );
    choices.push({
      name: `处理 ${issues.orphanLibraries.length} 个孤立库 (${size})`,
      value: 'orphanLibraries',
      checked: true,
    });
  }

  if (issues.staleReferences.length > 0) {
    choices.push({
      name: `移除 ${issues.staleReferences.length} 个失效引用`,
      value: 'staleReferences',
      checked: true,
    });
  }

  if (issues.corruptedStores.length > 0) {
    choices.push({
      name: `清除 ${issues.corruptedStores.length} 个损坏的 Store 条目`,
      value: 'corruptedStores',
      checked: true,
    });
  }

  if (choices.length === 0) {
    success('没有可修复的问题');
    return;
  }

  blank();
  const selected = await checkboxWithCancel({
    message: '选择要修复的问题:',
    choices,
  });

  // ESC 取消
  if (selected === PROMPT_CANCELLED) {
    info('已取消');
    return;
  }

  if (selected.length === 0) {
    info('未选择任何问题');
    return;
  }

  // 筛选要修复的问题
  const toFix: IntegrityIssue = {
    invalidProjects: selected.includes('invalidProjects')
      ? issues.invalidProjects
      : [],
    danglingLinks: selected.includes('danglingLinks') ? issues.danglingLinks : [],
    orphanLibraries: selected.includes('orphanLibraries')
      ? issues.orphanLibraries
      : [],
    missingLibraries: [], // 缺失库无法修复
    staleReferences: selected.includes('staleReferences')
      ? issues.staleReferences
      : [],
    corruptedStores: selected.includes('corruptedStores')
      ? issues.corruptedStores
      : [],
  };

  await fixAllIssues(toFix, { force: options.force });

  // 缺失库无法自动修复，需要提示用户
  if (issues.missingLibraries.length > 0) {
    blank();
    hint(`缺失库 (${issues.missingLibraries.length} 个) 需要通过 td link 重新下载`);
  }
}

function showDetails(issues: IntegrityIssue): void {
  blank();
  title('问题详情');
  blank();

  if (issues.invalidProjects.length > 0) {
    info(`无效项目 (${issues.invalidProjects.length}):`);
    for (const p of issues.invalidProjects) {
      hint(`  - ${p.path}`);
    }
    blank();
  }

  if (issues.danglingLinks.length > 0) {
    info(`悬挂链接 (${issues.danglingLinks.length}):`);
    for (const link of issues.danglingLinks) {
      hint(`  - ${link.path}`);
    }
    blank();
  }

  if (issues.orphanLibraries.length > 0) {
    info(`孤立库 (${issues.orphanLibraries.length}):`);
    for (const lib of issues.orphanLibraries) {
      hint(`  - ${lib.libName}/${lib.commit.slice(0, 7)} (${formatSize(lib.size)})`);
    }
    blank();
  }

  if (issues.missingLibraries.length > 0) {
    info(`缺失库 (${issues.missingLibraries.length}):`);
    for (const lib of issues.missingLibraries) {
      hint(`  - ${lib.libName}/${lib.commit.slice(0, 7)} (引用自 ${lib.project})`);
    }
    blank();
  }

  if (issues.staleReferences.length > 0) {
    info(`失效引用 (${issues.staleReferences.length}):`);
    for (const ref of issues.staleReferences) {
      hint(`  - ${ref.libKey} <- ${ref.projectPath}`);
    }
    blank();
  }

  if (issues.corruptedStores.length > 0) {
    info(`损坏的 Store 条目 (${issues.corruptedStores.length}):`);
    for (const item of issues.corruptedStores) {
      hint(`  - ${item.libName}/${item.commit.slice(0, 7)}/${item.platform}: ${item.reason}`);
      if (item.kind === 'shared_platform_conflict') {
        hint(`    冲突平台: ${item.conflictPlatforms?.join(', ') ?? '未知'}`);
      } else {
        hint(`    期望: fileCount=${item.expected.fileCount ?? '?'}, size=${item.expected.size ?? '?'}, hash=${item.expected.contentHash?.slice(0, 8) ?? '?'}`);
        hint(`    实际: fileCount=${item.actual.fileCount}, size=${item.actual.size}, hash=${item.actual.contentHash?.slice(0, 8) ?? '?'}`);
      }
    }
    blank();
  }
}

// ============ 修复执行 ============

interface FixOptions {
  force: boolean;
}

async function fixAllIssues(
  issues: IntegrityIssue,
  options: FixOptions
): Promise<void> {
  const totalIssues =
    issues.invalidProjects.length +
    issues.danglingLinks.length +
    issues.orphanLibraries.length +
    issues.staleReferences.length +
    issues.corruptedStores.length;

  if (totalIssues === 0) {
    success('没有需要修复的问题');
    return;
  }

  // 确认
  if (!options.force) {
    blank();
    const confirmed = await confirmWithCancel({
      message: `确认修复以上 ${totalIssues} 个问题?`,
      default: false,
    });
    if (confirmed === PROMPT_CANCELLED || !confirmed) {
      info('已取消修复');
      return;
    }
  }

  blank();
  separator();
  info('正在修复...');
  blank();

  const registry = getRegistry();
  await registry.load();
  const storePath = await store.getStorePath();

  let fixed = 0;

  // 1. 清理无效项目
  for (const p of issues.invalidProjects) {
    try {
      registry.removeProject(p.hash);
      success(`[ok] 清理项目: ${p.path}`);
      fixed++;
    } catch (err) {
      error(`[err] 清理项目失败: ${p.path} - ${(err as Error).message}`);
    }
  }

  // 2. 移除悬挂链接
  for (const link of issues.danglingLinks) {
    try {
      await fs.unlink(link.path);
      const project = registry.getProject(link.projectHash);
      if (project) {
        project.dependencies = project.dependencies.filter(
          (d) => !(d.libName === link.dep.libName && d.commit === link.dep.commit)
        );
        registry.updateProject(link.projectHash, {
          dependencies: project.dependencies,
        });
      }
      success(`[ok] 移除链接: ${link.path}`);
      fixed++;
    } catch (err) {
      error(`[err] 移除链接失败: ${link.path} - ${(err as Error).message}`);
    }
  }

  // 3. 删除孤立库
  for (const lib of issues.orphanLibraries) {
    try {
      await fs.rm(lib.path, { recursive: true, force: true });
      // 如果删除后 libName 目录为空，也一并删除
      const libDir = path.dirname(lib.path);
      const remaining = await fs.readdir(libDir).catch(() => ['placeholder']);
      if (remaining.length === 0) {
        await fs.rm(libDir, { recursive: true, force: true }).catch(() => {});
      }
      success(`[ok] 删除孤立库: ${lib.libName}/${lib.commit.slice(0, 7)}`);
      fixed++;
    } catch (err) {
      error(
        `[err] 删除孤立库失败: ${lib.libName}/${lib.commit.slice(0, 7)} - ${(err as Error).message}`
      );
    }
  }

  // 4. 移除失效引用
  for (const ref of issues.staleReferences) {
    try {
      // 移除 StoreEntry 引用（该库的所有平台）
      // 使用 lastIndexOf 安全解析 libKey，处理 libName 可能包含冒号的情况
      const colonIndex = ref.libKey.lastIndexOf(':');
      if (colonIndex === -1) {
        error(`[err] 无效的 libKey: ${ref.libKey}`);
        continue;
      }
      const libName = ref.libKey.slice(0, colonIndex);
      const commit = ref.libKey.slice(colonIndex + 1);
      const storeKeys = registry.getLibraryStoreKeys(libName, commit);
      for (const storeKey of storeKeys) {
        registry.removeStoreReference(storeKey, ref.projectHash);
      }
      success(`[ok] 移除引用: ${ref.libKey} <- ${ref.projectPath}`);
      fixed++;
    } catch (err) {
      error(`[err] 移除引用失败: ${ref.libKey} - ${(err as Error).message}`);
    }
  }

  // 5. 清理损坏的 Store 条目
  for (const item of issues.corruptedStores) {
    try {
      if (item.kind === 'shared_platform_conflict') {
        const storeKeys = registry.getLibraryStoreKeys(item.libName, item.commit);
        for (const storeKey of storeKeys) {
          registry.removeStore(storeKey);
        }
        const commitPath = path.join(storePath, item.libName, item.commit);
        await fs.rm(commitPath, { recursive: true, force: true });
        success(`[ok] 清理损坏 Store: ${item.libName}/${item.commit.slice(0, 7)} (移除整个 commit 缓存)`);
      } else {
        const storeKey = registry.getStoreKey(item.libName, item.commit, item.platform);
        registry.removeStore(storeKey);
        const platformPath = path.join(storePath, item.libName, item.commit, item.platform);
        await fs.rm(platformPath, { recursive: true, force: true });
        success(`[ok] 清理损坏 Store: ${item.libName}/${item.commit.slice(0, 7)}/${item.platform}`);
      }
      fixed++;
    } catch (err) {
      error(`[err] 清理损坏 Store 失败: ${item.libName}/${item.commit.slice(0, 7)}/${item.platform} - ${(err as Error).message}`);
    }
  }

  await registry.save();

  blank();
  separator();
  success(`修复完成: ${fixed} 个问题已解决`);
}

// ============ 工具函数 ============

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
  } catch (err) {
    // 计算大小时出错，返回已计算的部分
    debug(`[check] 计算目录大小失败: ${(err as Error).message}`);
  }
  return size;
}

async function detectSharedPlatformConflict(commitPath: string): Promise<string[] | null> {
  const sharedPath = path.join(commitPath, '_shared');
  try {
    const sharedEntries = await fs.readdir(sharedPath, { withFileTypes: true });
    const conflicts = sharedEntries
      .filter((entry) => entry.isDirectory() && KNOWN_PLATFORM_VALUES.includes(entry.name))
      .map((entry) => entry.name);
    return conflicts.length > 0 ? conflicts : null;
  } catch {
    return null;
  }
}

// ============ 兼容导出（供测试使用）============

/**
 * 验证完整性（兼容旧 verify 命令）
 */
export async function verifyIntegrity(): Promise<void> {
  const result = await collectAllIssues();
  renderReport(result);
}

export async function collectCheckResultForTest(options?: { integrity?: boolean }): Promise<CheckResult> {
  return collectAllIssues(options);
}

/**
 * 修复问题（兼容旧 repair 命令）
 */
export async function repairIssues(options: {
  dryRun: boolean;
  force: boolean;
}): Promise<void> {
  const result = await collectAllIssues();

  // 渲染报告
  renderReport(result);

  const hasIssues = result.summary.integrityIssues > 0;

  if (!hasIssues) {
    return;
  }

  if (options.dryRun) {
    blank();
    hint('运行 td check --fix 修复问题');
    return;
  }

  await fixAllIssues(result.integrity, { force: options.force });
}

/**
 * 校验所有 Store 条目的文件完整性
 * 遍历 registry 中的 StoreEntry，校验 fileCount/contentHash
 * --integrity 模式下调用，非 --integrity 不执行
 *
 * @returns 损坏的 Store 条目列表
 */
export async function checkStoreIntegrity(): Promise<IntegrityIssue['corruptedStores']> {
  const corrupted: IntegrityIssue['corruptedStores'] = [];

  let registry;
  try {
    registry = getRegistry();
    await registry.load();
  } catch {
    return corrupted;
  }

  const stores = registry.listStores();
  const scannedCommits = new Set<string>();
  for (const entry of stores) {
    const commitKey = `${entry.libName}:${entry.commit}`;
    if (!scannedCommits.has(commitKey)) {
      scannedCommits.add(commitKey);
      const storePath = await store.getStorePath();
      const commitPath = path.join(storePath, entry.libName, entry.commit);
      const sharedConflict = await detectSharedPlatformConflict(commitPath);
      if (sharedConflict) {
        corrupted.push({
          libName: entry.libName,
          commit: entry.commit,
          platform: '_shared',
          kind: 'shared_platform_conflict',
          reason: `_shared 包含平台目录: ${sharedConflict.join(', ')}`,
          conflictPlatforms: sharedConflict,
          expected: {},
          actual: { fileCount: sharedConflict.length, size: 0 },
        });
      }
    }

    if (entry.fileCount != null) {
      const expectedData = {
        size: entry.size,
        fileCount: entry.fileCount,
        contentHash: entry.contentHash,
      };
      const verifyResult = await store.fullVerify(entry.libName, entry.commit, entry.platform, expectedData);
      if (!verifyResult.valid) {
        corrupted.push({
          libName: entry.libName,
          commit: entry.commit,
          platform: entry.platform,
          reason: verifyResult.reason || 'unknown',
          expected: expectedData,
          actual: verifyResult.actual ?? { fileCount: 0, size: 0 },
        });
      }
    } else {
      // 无 fileCount 的做回填
      try {
        const integrity = await store.captureIntegrity(entry.libName, entry.commit, entry.platform);
        const storeKey = registry.getStoreKey(entry.libName, entry.commit, entry.platform);
        registry.updateStore(storeKey, {
          size: integrity.size,
          fileCount: integrity.fileCount,
          contentHash: integrity.contentHash,
        });
      } catch {
        debug(`[check] 回填完整性数据失败: ${entry.libName}:${entry.commit}:${entry.platform}`);
      }
    }
  }

  await registry.save();
  return corrupted;
}

/**
 * 修复损坏的 Store 条目
 * 清除损坏条目并从 Registry 中移除，使得下次 link 时重新下载
 *
 * @param corrupted 损坏条目列表
 */
export async function fixCorruptedStores(
  corrupted: IntegrityIssue['corruptedStores']
): Promise<void> {
  if (corrupted.length === 0) return;

  const registry = getRegistry();
  await registry.load();
  const storePath = await store.getStorePath();

  for (const item of corrupted) {
    try {
      if (item.kind === 'shared_platform_conflict') {
        const storeKeys = registry.getLibraryStoreKeys(item.libName, item.commit);
        for (const storeKey of storeKeys) {
          registry.removeStore(storeKey);
        }
        const commitPath = path.join(storePath, item.libName, item.commit);
        await fs.rm(commitPath, { recursive: true, force: true });
        success(`[ok] 清理损坏 Store: ${item.libName}/${item.commit.slice(0, 7)} (移除整个 commit 缓存)`);
      } else {
        const storeKey = registry.getStoreKey(item.libName, item.commit, item.platform);
        registry.removeStore(storeKey);
        const platformPath = path.join(storePath, item.libName, item.commit, item.platform);
        await fs.rm(platformPath, { recursive: true, force: true });
        success(`[ok] 清理损坏 Store: ${item.libName}/${item.commit.slice(0, 7)}/${item.platform}`);
      }
    } catch (err) {
      error(`[err] 清理损坏 Store 失败: ${item.libName}/${item.commit.slice(0, 7)}/${item.platform} - ${(err as Error).message}`);
    }
  }

  await registry.save();
}

export default createCheckCommand;
