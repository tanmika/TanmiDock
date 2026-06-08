/**
 * status 命令 - 查看项目状态
 */
import path from 'path';
import fs from 'fs/promises';
import { Command } from 'commander';
import { ensureInitialized } from '../core/guard.js';
import {
  findCodepacConfig,
  parseCodepacDep,
  extractDependencies,
  extractActions,
  parseActionCommand,
  extractNestedDependencies,
  resolveProjectRootPath,
  findAllCodepacConfigs,
} from '../core/parser.js';
import type { OptionalConfigInfo } from '../core/parser.js';
import { getRegistry } from '../core/registry.js';
import * as linker from '../core/linker.js';
import { resolvePath, shrinkHome } from '../core/platform.js';
import { formatSize } from '../utils/disk.js';
import { info, warn, success, hint, blank, separator, title, colorize, tree as printTree } from '../utils/logger.js';
import { selectWithCancel, PROMPT_CANCELLED } from '../utils/prompt.js';
import { findSubmoduleConfigs } from '../utils/git.js';
import type { TreeItem } from '../utils/logger.js';

interface ManualRuleStatus {
  key: string;
  libName: string;
  commit?: string;
  platforms: string[];
}

interface StatusDependency {
  libName: string;
  commit: string;
  localPath: string;
}

function parseManualRuleKey(key: string): { libName: string; commit?: string } {
  const atIndex = key.lastIndexOf('@');
  if (atIndex === -1) {
    return { libName: key };
  }
  return { libName: key.slice(0, atIndex), commit: key.slice(atIndex + 1) };
}

interface StatusOptions {
  all?: boolean;
  tree?: boolean;
  json?: boolean;
}

/**
 * 创建 status 命令
 */
export function createStatusCommand(): Command {
  return new Command('status')
    .description('查看链接状态')
    .argument('[path]', '项目路径')
    .option('--all', '查看所有已链接项目')
    .option('--tree', '树状展示库引用关系 (需配合 --all)')
    .option('--json', 'JSON 格式输出')
    .addHelpText(
      'after',
      `
无参数时进入交互式界面，可选择查看当前项目或所有已链接项目。

示例:
  td status                查互式选择
  td status .              查看当前项目
  td status ~/MyProject    查看指定项目
  td status --all          查看所有已链接项目
  td status --all --tree   树状显示库引用关系
  td status --all --json   JSON 格式输出 (AI 调用)`
    )
    .action(async (projectPath: string | undefined, options: StatusOptions) => {
      await ensureInitialized();

      // 有路径参数或 --all，直接执行
      if (projectPath !== undefined || options.all) {
        if (options.all) {
          await showAllProjects(options);
        } else {
          await showStatus(projectPath!, options);
        }
        return;
      }

      // 无参数，进入交互式界面
      await interactiveStatus();
    });
}

/**
 * 交互式状态查看
 */
async function interactiveStatus(): Promise<void> {
  const registry = getRegistry();
  await registry.load();
  const projects = registry.listProjects();

  // 检测当前目录是否是项目
  const cwd = process.cwd();
  const configPath = await findCodepacConfig(cwd);
  const hasCurrentProject = configPath !== null;

  const choices: Array<{ value: string; name: string }> = [];

  if (hasCurrentProject) {
    choices.push({
      value: 'current',
      name: `当前项目 (${shrinkHome(cwd)})`,
    });
  }

  choices.push({
    value: 'all',
    name: `所有已链接项目 (${projects.length} 个)`,
  });

  choices.push({
    value: 'exit',
    name: colorize('← 退出', 'dim'),
  });

  const selected = await selectWithCancel({
    message: '查看:',
    choices,
  });

  // ESC 或选择退出都退出
  if (selected === PROMPT_CANCELLED || selected === 'exit') {
    return;
  }

  blank();

  if (selected === 'current') {
    await showStatus('.', {});
  } else {
    await showAllProjects({});
  }
}

/**
 * 显示单个项目状态
 */
export async function showStatus(projectPath: string, options: StatusOptions): Promise<void> {
  const { absolutePath, normalizedPath } = await resolveProjectRootPath(projectPath);

  // 检查项目路径
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isDirectory()) {
      warn(`路径不是目录: ${absolutePath}`);
      process.exit(1);
    }
  } catch {
    warn(`路径不存在: ${absolutePath}`);
    process.exit(1);
  }

  // 解析依赖（先解析，获取 configPath）
  let configPath: string;

  try {
    configPath = await findCodepacConfig(normalizedPath) ?? '';
    if (!configPath) {
      throw new Error('找不到 codepac-dep.json 配置文件，已搜索: 3rdparty, .');
    }
  } catch (err) {
    warn((err as Error).message);
    process.exit(1);
  }

  // 加载注册表
  const registry = getRegistry();
  await registry.load();

  const projectInfo = registry.getProject(registry.hashPath(normalizedPath));
  const registeredPath = normalizedPath;
  const dependencies = await collectStatusDependencies({
    projectRoot: normalizedPath,
    configPath,
    projectInfo,
    includeSubmodules: false,
  });
  const allProjectDependencies = await collectStatusDependencies({
    projectRoot: normalizedPath,
    configPath,
    projectInfo,
    includeSubmodules: true,
  });
  const projectLibNames = new Set(allProjectDependencies.map((dep) => dep.libName));
  const projectRuleKeys = new Set(allProjectDependencies.map((dep) => `${dep.libName}@${dep.commit}`));
  const manualRules: ManualRuleStatus[] = registry.listManualUnavailableRules()
    .filter((rule) => projectLibNames.has(rule.key) || projectRuleKeys.has(rule.key))
    .map((rule) => {
      const parsed = parseManualRuleKey(rule.key);
      return { key: rule.key, libName: parsed.libName, commit: parsed.commit, platforms: rule.platforms };
    });

  // 显示项目信息
  title(`项目: ${shrinkHome(absolutePath)}`);

  if (projectInfo) {
    if (registeredPath !== absolutePath) {
      info(`注册路径: ${shrinkHome(registeredPath)}`);
    }
    info(`最后链接: ${formatDate(projectInfo.lastLinked)}`);
    info(`平台: ${projectInfo.platforms.join(', ') || '未指定'}`);
  } else {
    warn('此项目尚未链接');
  }

  if (manualRules.length > 0) {
    info(`手动平台缺失规则: ${manualRules.length} 条`);
  }

  blank();

  // 分析依赖状态
  let linked = 0;
  let broken = 0;
  let unlinked = 0;
  const brokenList: string[] = [];
  const unlinkedList: string[] = [];

  for (const dep of dependencies) {
    const linkStatus = await checkLinkStatus(dep.localPath);

    if (linkStatus.isLinked) {
      if (linkStatus.isValid) {
        linked++;
      } else {
        broken++;
        brokenList.push(`${dep.libName} (${dep.commit.slice(0, 7)})`);
      }
    } else {
      unlinked++;
      unlinkedList.push(`${dep.libName} (${dep.commit.slice(0, 7)}) - ${linkStatus.reason}`);
    }
  }

  // 检测 submodule 依赖
  const submoduleConfigs = await findSubmoduleConfigs(absolutePath);
  interface SubmoduleStatus {
    name: string;
    path: string;
    depCount: number;
    isLinked: boolean;
    linked: number;
    broken: number;
    unlinked: number;
    brokenList: string[];
    unlinkedList: string[];
  }
  const submoduleStatuses: SubmoduleStatus[] = [];

  for (const sub of submoduleConfigs) {
    const isLinked = projectInfo?.submodules?.includes(sub.relativePath) ?? false;
    const subStatus: SubmoduleStatus = {
      name: sub.name,
      path: sub.relativePath,
      depCount: sub.depCount,
      isLinked,
      linked: 0,
      broken: 0,
      unlinked: 0,
      brokenList: [],
      unlinkedList: [],
    };

    if (isLinked) {
      try {
        const subDeps = await collectScopeStatusDependencies(
          sub.configPath,
          projectInfo?.submoduleOptionalConfigs?.[sub.relativePath] ?? []
        );

        for (const dep of subDeps) {
          const linkStatus = await checkLinkStatus(dep.localPath);

          if (linkStatus.isLinked) {
            if (linkStatus.isValid) {
              subStatus.linked++;
            } else {
              subStatus.broken++;
              subStatus.brokenList.push(`${dep.libName} (${dep.commit.slice(0, 7)})`);
            }
          } else {
            subStatus.unlinked++;
            subStatus.unlinkedList.push(`${dep.libName} (${dep.commit.slice(0, 7)}) - ${linkStatus.reason}`);
          }
        }
      } catch {
        // 解析失败，仅显示未链接信息
      }
    }

    submoduleStatuses.push(subStatus);
  }

  // JSON 输出
  if (options.json) {
    const output: Record<string, unknown> = {
      project: absolutePath,
      lastLinked: projectInfo?.lastLinked ?? null,
      platforms: projectInfo?.platforms ?? [],
      dependencies: {
        total: dependencies.length,
        linked,
        broken,
        unlinked,
      },
      manualUnavailableRules: manualRules,
      brokenList,
      unlinkedList,
    };
    if (submoduleStatuses.length > 0) {
      output.submodules = submoduleStatuses.map(s => ({
        name: s.name,
        path: s.path,
        isLinked: s.isLinked,
        dependencies: {
          total: s.isLinked ? s.linked + s.broken + s.unlinked : s.depCount,
          linked: s.linked,
          broken: s.broken,
          unlinked: s.unlinked,
        },
      }));
    }
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // 显示统计
  info(`依赖状态 (${dependencies.length} 个):`);
  success(`  已链接: ${linked}`);

  if (broken > 0) {
    warn(`  链接失效: ${broken}`);
  }

  if (unlinked > 0) {
    warn(`  未链接: ${unlinked}`);
  }

  // 显示详情
  if (brokenList.length > 0) {
    blank();
    warn('链接失效的库:');
    for (const item of brokenList) {
      info(`  - ${item}`);
    }
  }

  if (unlinkedList.length > 0) {
    blank();
    warn('未链接的库:');
    for (const item of unlinkedList) {
      info(`  - ${item}`);
    }
  }

  if (manualRules.length > 0) {
    blank();
    info('手动平台缺失规则:');
    for (const rule of manualRules) {
      info(`  - ${rule.commit ? `${rule.libName}@${rule.commit.slice(0, 8)}` : `${rule.libName} (所有 commit)`}: ${rule.platforms.join(', ')}`);
    }
  }

  // 显示 submodule 状态
  if (submoduleStatuses.length > 0) {
    blank();
    separator();
    for (const sub of submoduleStatuses) {
      if (!sub.isLinked) {
        info(`[${sub.name}] 子模块 (${sub.depCount} 个依赖) - 未链接`);
        continue;
      }

      info(`[${sub.name}] 子模块 (${sub.depCount} 个依赖):`);
      success(`  已链接: ${sub.linked}`);
      if (sub.broken > 0) {
        warn(`  链接失效: ${sub.broken}`);
      }
      if (sub.unlinked > 0) {
        warn(`  未链接: ${sub.unlinked}`);
      }
      if (sub.brokenList.length > 0) {
        for (const item of sub.brokenList) {
          info(`    - ${item}`);
        }
      }
      if (sub.unlinkedList.length > 0) {
        for (const item of sub.unlinkedList) {
          info(`    - ${item}`);
        }
      }
    }
  }

  // 建议
  if (broken > 0 || unlinked > 0) {
    blank();
    separator();
    hint('运行 td link 更新链接');
  }
}

/**
 * 显示所有项目
 */
async function showAllProjects(options: StatusOptions): Promise<void> {
  const registry = getRegistry();
  await registry.load();

  const projects = registry.listProjects();
  const libraries = registry.listLibraries();

  if (options.json) {
    console.log(JSON.stringify({ projects, libraries }, null, 2));
    return;
  }

  if (options.tree) {
    await showTreeView(libraries, projects);
    return;
  }

  // 普通列表视图
  if (projects.length === 0) {
    info('暂无已链接的项目');
    blank();
    hint('使用 td link <path> 链接项目');
    return;
  }

  title(`已链接项目 (${projects.length} 个):`);
  blank();

  let index = 1;
  for (const project of projects) {
    const displayPath = shrinkHome(project.path);
    const pathExists = await checkPathExists(project.path);
    const projectHash = registry.hashPath(project.path);
    const projectSize = registry.getProjectSize(projectHash);

    info(`  ${index}. ${displayPath}`);
    info(`     最后链接: ${formatDate(project.lastLinked)}`);
    info(`     平台: ${project.platforms?.join(', ') || '未指定'}`);
    info(`     依赖: ${project.dependencies.length} 个`);
    info(`     占用空间: ${formatSize(projectSize)}`);

    if (!pathExists) {
      warn(`     [warn] 路径不存在（项目可能已删除）`);
    }

    blank();
    index++;
  }

  // 显示空间统计
  const spaceStats = registry.getSpaceStats();
  separator();
  info(`总占用: ${formatSize(spaceStats.actualSize)}`);
  if (spaceStats.savedSize > 0) {
    success(`节省空间: ${formatSize(spaceStats.savedSize)}`);
  }
}

/**
 * 显示树状视图
 */
async function showTreeView(
  libraries: Array<{ libName: string; commit: string; referencedBy: string[]; size: number }>,
  projects: Array<{ path: string }>
): Promise<void> {
  const registry = getRegistry();

  // 计算总大小
  let totalSize = 0;
  for (const lib of libraries) {
    totalSize += lib.size;
  }

  title(`Store: ${formatSize(totalSize)} (${libraries.length} 个库)`);
  blank();

  // 构建项目 hash 到路径的映射
  const hashToPath: Record<string, string> = {};
  for (const project of projects) {
    const hash = registry.hashPath(project.path);
    hashToPath[hash] = shrinkHome(project.path);
  }

  // 构建树
  const treeItems: TreeItem[] = [];

  for (const lib of libraries) {
    const libLabel = `${lib.libName} (${lib.commit.slice(0, 7)}) - ${formatSize(lib.size)}`;
    const children: TreeItem[] = [];

    for (const refHash of lib.referencedBy) {
      const projectPath = hashToPath[refHash];
      if (projectPath) {
        children.push({ label: projectPath });
      }
    }

    treeItems.push({
      label: libLabel,
      children,
      warn: lib.referencedBy.length === 0,
    });
  }

  printTree(treeItems);
}

async function collectStatusDependencies(params: {
  projectRoot: string;
  configPath: string;
  projectInfo: ReturnType<ReturnType<typeof getRegistry>['getProject']> | undefined;
  includeSubmodules: boolean;
}): Promise<StatusDependency[]> {
  const { projectRoot, configPath, projectInfo, includeSubmodules } = params;
  const dependencies = await collectScopeStatusDependencies(configPath, projectInfo?.optionalConfigs ?? []);

  if (!includeSubmodules || !projectInfo?.submodules || projectInfo.submodules.length === 0) {
    return dependencies;
  }

  const submoduleConfigs = await findSubmoduleConfigs(projectRoot);
  const selectedSubmodules = submoduleConfigs.filter((submodule) =>
    projectInfo.submodules?.includes(submodule.relativePath)
  );

  for (const submodule of selectedSubmodules) {
    dependencies.push(...await collectScopeStatusDependencies(
      submodule.configPath,
      projectInfo.submoduleOptionalConfigs?.[submodule.relativePath] ?? []
    ));
  }

  return dependencies;
}

async function collectScopeStatusDependencies(
  configPath: string,
  selectedOptionalConfigNames: string[]
): Promise<StatusDependency[]> {
  const dependencies: StatusDependency[] = [];
  const seen = new Set<string>();
  const visitedConfigs = new Set<string>();

  async function addConfigDependencies(currentConfigPath: string): Promise<void> {
    if (visitedConfigs.has(currentConfigPath)) return;
    visitedConfigs.add(currentConfigPath);

    const config = await parseCodepacDep(currentConfigPath);
    const configDir = path.dirname(currentConfigPath);

    for (const dependency of extractDependencies(config)) {
      addStatusDependency(dependencies, seen, {
        libName: dependency.libName,
        commit: dependency.commit,
        localPath: path.join(configDir, dependency.libName),
      });
    }

    await collectActionStatusDependencies({
      actions: extractActions(config),
      baseConfigDir: configDir,
      targetRootDir: configDir,
      dependencies,
      seen,
    });
  }

  await addConfigDependencies(configPath);

  const optionalConfigs = await resolveSelectedOptionalConfigs(configPath, selectedOptionalConfigNames);
  for (const optionalConfig of optionalConfigs) {
    await addConfigDependencies(optionalConfig.path);
  }

  return dependencies;
}

async function resolveSelectedOptionalConfigs(
  configPath: string,
  names: string[]
): Promise<OptionalConfigInfo[]> {
  if (names.length === 0) return [];
  const discovery = await findAllCodepacConfigs(path.dirname(configPath));
  if (!discovery) return [];
  return names
    .map((name) => discovery.optionalConfigs.find((config) => config.name === name))
    .filter((config): config is OptionalConfigInfo => Boolean(config));
}

async function collectActionStatusDependencies(params: {
  actions: Array<{ command: string; dir?: string }>;
  baseConfigDir: string;
  targetRootDir: string;
  dependencies: StatusDependency[];
  seen: Set<string>;
}): Promise<void> {
  const { actions, baseConfigDir, targetRootDir, dependencies, seen } = params;

  for (const action of actions) {
    let parsedAction;
    try {
      parsedAction = parseActionCommand(action.command);
    } catch {
      continue;
    }

    const nestedConfigPath = path.resolve(baseConfigDir, parsedAction.configDir, 'codepac-dep.json');
    let nested;
    try {
      nested = await extractNestedDependencies(nestedConfigPath, parsedAction.libraries);
    } catch {
      continue;
    }

    const nestedTargetDir = path.resolve(targetRootDir, parsedAction.targetDir);
    for (const dependency of nested.dependencies) {
      addStatusDependency(dependencies, seen, {
        libName: dependency.libName,
        commit: dependency.commit,
        localPath: path.join(nestedTargetDir, dependency.libName),
      });
    }

    if (!parsedAction.disableAction && nested.nestedActions.length > 0) {
      await collectActionStatusDependencies({
        actions: nested.nestedActions,
        baseConfigDir: path.dirname(nestedConfigPath),
        targetRootDir: nestedTargetDir,
        dependencies,
        seen,
      });
    }
  }
}

function addStatusDependency(
  dependencies: StatusDependency[],
  seen: Set<string>,
  dependency: StatusDependency
): void {
  const key = `${dependency.libName}:${dependency.commit}:${dependency.localPath}`;
  if (seen.has(key)) return;
  seen.add(key);
  dependencies.push(dependency);
}

/**
 * 链接状态检查结果
 */
interface LinkStatus {
  isLinked: boolean;
  isValid: boolean;
  reason: string;
}

/**
 * 检查目录的链接状态
 */
async function checkLinkStatus(localPath: string): Promise<LinkStatus> {
  try {
    await fs.access(localPath);
  } catch {
    return { isLinked: false, isValid: false, reason: '不存在' };
  }

  const isTopLevelLink = await linker.isSymlink(localPath);
  if (isTopLevelLink) {
    const isValid = await linker.isValidLink(localPath);
    return { isLinked: true, isValid, reason: '' };
  }

  try {
    const entries = await fs.readdir(localPath, { withFileTypes: true });
    let hasSymlink = false;
    let allValid = true;

    for (const entry of entries) {
      const entryPath = path.join(localPath, entry.name);
      if (await linker.isSymlink(entryPath)) {
        hasSymlink = true;
        if (!(await linker.isValidLink(entryPath))) {
          allValid = false;
        }
      }
    }

    if (hasSymlink) {
      return { isLinked: true, isValid: allValid, reason: '' };
    }
  } catch {
    // 读取目录失败
  }

  return { isLinked: false, isValid: false, reason: '普通目录' };
}

/**
 * 检查路径是否存在
 */
async function checkPathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 格式化日期
 */
function formatDate(isoString: string): string {
  const date = new Date(isoString);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export default createStatusCommand;
