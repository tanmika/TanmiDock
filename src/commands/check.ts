/**
 * check 命令 - 健康检查（合并 doctor/verify/repair）
 */
import fs from 'fs/promises';
import path from 'path';
import { Command } from 'commander';
import { isCodepacInstalled } from '../core/codepac.js';
import { getDiskInfo, formatSize } from '../utils/disk.js';
import * as config from '../core/config.js';
import { getRegistry } from '../core/registry.js';
import * as store from '../core/store.js';
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
} from '../utils/logger.js';
import {
  selectWithCancel,
  checkboxWithCancel,
  confirmWithCancel,
  PROMPT_CANCELLED,
} from '../utils/prompt.js';

// ============ 类型定义 ============

interface EnvironmentCheck {
  codepac: { ok: boolean; message: string };
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
  prune: boolean;
  force: boolean;
}

// ============ 命令创建 ============

export function createCheckCommand(): Command {
  return new Command('check')
    .description('健康检查（环境诊断 + 数据一致性验证）')
    .option('--fix', '直接修复所有问题')
    .option('--dry-run', '只显示问题，不修复')
    .option('--json', '输出 JSON 格式')
    .option('--prune', '删除孤立库而非登记（与 --fix 配合使用）')
    .option('--force', '跳过确认')
    .action(async (options: CheckOptions) => {
      await runCheck(options);
    });
}

// ============ 主流程 ============

async function runCheck(options: CheckOptions): Promise<void> {
  const result = await collectAllIssues();

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
    await fixAllIssues(result.integrity, {
      prune: options.prune,
      force: options.force,
    });
    return;
  }

  // 交互模式
  await interactiveCheck(result.integrity, options);
}

// ============ 数据收集 ============

async function collectAllIssues(): Promise<CheckResult> {
  const environment = await checkEnvironment();
  const integrity = await checkIntegrity();

  // 计算汇总
  const envErrors = Object.values(environment).filter(
    (c) => !c.ok && !('warn' in c && c.warn)
  ).length;
  const envWarnings = Object.values(environment).filter(
    (c) => 'warn' in c && c.warn
  ).length;

  const integrityIssues =
    integrity.invalidProjects.length +
    integrity.danglingLinks.length +
    integrity.orphanLibraries.length +
    integrity.missingLibraries.length +
    integrity.staleReferences.length;

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
  const result: EnvironmentCheck = {
    codepac: { ok: false, message: '' },
    config: { ok: false, message: '' },
    store: { ok: false, path: '', message: '' },
    disk: { ok: false, free: 0, warn: false, message: '' },
  };

  // 1. codepac
  const hasCodepac = await isCodepacInstalled();
  result.codepac = {
    ok: hasCodepac,
    message: hasCodepac ? '已安装' : '未安装，无法下载库',
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

  return result;
}

async function checkIntegrity(): Promise<IntegrityIssue> {
  const result: IntegrityIssue = {
    invalidProjects: [],
    danglingLinks: [],
    orphanLibraries: [],
    missingLibraries: [],
    staleReferences: [],
  };

  // 尝试加载 registry
  let registry;
  let storePath: string;
  try {
    registry = getRegistry();
    await registry.load();
    storePath = await store.getStorePath();
  } catch {
    // 未初始化，跳过完整性检查
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
      const verifyPlatform = dep.platform ?? project.platforms?.[0] ?? 'macOS';

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
        }
      }
    }
  } catch {
    // Store 目录不存在
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
          } catch {
            // 忽略
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
      await fixAllIssues(issues, { prune: options.prune, force: true });
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

  // 孤立库处理方式
  let pruneOrphans = options.prune;
  if (selected.includes('orphanLibraries') && !options.prune) {
    blank();
    const orphanAction = await selectWithCancel({
      message: '孤立库处理方式',
      choices: [
        { name: '登记到 Registry（保留文件）', value: 'register' as const },
        { name: '删除文件（释放空间）', value: 'delete' as const },
      ],
    });
    // ESC 取消 = 默认登记
    if (orphanAction === PROMPT_CANCELLED) {
      pruneOrphans = false;
    } else {
      pruneOrphans = orphanAction === 'delete';
    }
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
  };

  await fixAllIssues(toFix, { prune: pruneOrphans, force: options.force });

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
}

// ============ 修复执行 ============

interface FixOptions {
  prune: boolean;
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
    issues.staleReferences.length;

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

  // 3. 处理孤立库
  for (const lib of issues.orphanLibraries) {
    try {
      if (options.prune) {
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

        // 扫描平台子目录
        try {
          const entries = await fs.readdir(lib.path, { withFileTypes: true });
          for (const entry of entries) {
            if (
              entry.isDirectory() &&
              !entry.name.startsWith('.') &&
              entry.name !== '_shared'
            ) {
              const platform = entry.name;
              const platformPath = path.join(lib.path, platform);
              const platformSize = await getDirSizeRecursive(platformPath);
              registry.addStore({
                libName: lib.libName,
                commit: lib.commit,
                platform,
                branch: 'unknown',
                url: 'unknown',
                size: platformSize,
                usedBy: [],
                createdAt: new Date().toISOString(),
                lastAccess: new Date().toISOString(),
              });
            }
          }
        } catch {
          // 忽略
        }

        success(`[ok] 登记孤立库: ${lib.libName}/${lib.commit.slice(0, 7)}`);
      }
      fixed++;
    } catch (err) {
      error(
        `[err] 处理孤立库失败: ${lib.libName}/${lib.commit.slice(0, 7)} - ${(err as Error).message}`
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
  } catch {
    // 忽略
  }
  return size;
}

// ============ 兼容导出（供测试使用）============

/**
 * 验证完整性（兼容旧 verify 命令）
 */
export async function verifyIntegrity(): Promise<void> {
  const result = await collectAllIssues();
  renderReport(result);
}

/**
 * 修复问题（兼容旧 repair 命令）
 */
export async function repairIssues(options: {
  dryRun: boolean;
  prune: boolean;
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

  await fixAllIssues(result.integrity, {
    prune: options.prune,
    force: options.force,
  });
}

export default createCheckCommand;
