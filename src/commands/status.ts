/**
 * status 命令 - 查看项目状态
 */
import path from 'path';
import fs from 'fs/promises';
import { Command } from 'commander';
import { select } from '@inquirer/prompts';
import { ensureInitialized } from '../core/guard.js';
import { parseProjectDependencies, findCodepacConfig } from '../core/parser.js';
import { getRegistry } from '../core/registry.js';
import * as store from '../core/store.js';
import * as linker from '../core/linker.js';
import { resolvePath, shrinkHome } from '../core/platform.js';
import { formatSize } from '../utils/disk.js';
import { info, warn, success, hint, blank, separator, title, colorize, tree as printTree } from '../utils/logger.js';
import type { ParsedDependency } from '../types/index.js';
import type { TreeItem } from '../utils/logger.js';

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
          await showProjectStatus(projectPath!, options);
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
    name: colorize('退出', 'gray'),
  });

  const selected = await select({
    message: '查看:',
    choices,
  });

  if (selected === 'exit') {
    return;
  }

  blank();

  if (selected === 'current') {
    await showProjectStatus('.', {});
  } else {
    await showAllProjects({});
  }
}

/**
 * 显示单个项目状态
 */
async function showProjectStatus(projectPath: string, options: StatusOptions): Promise<void> {
  const absolutePath = resolvePath(projectPath);

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

  // 加载注册表
  const registry = getRegistry();
  await registry.load();

  const projectHash = registry.hashPath(absolutePath);
  const projectInfo = registry.getProject(projectHash);

  // 解析依赖
  let dependencies: ParsedDependency[];
  let configPath: string;

  try {
    const result = await parseProjectDependencies(absolutePath);
    dependencies = result.dependencies;
    configPath = result.configPath;
  } catch (err) {
    warn((err as Error).message);
    process.exit(1);
  }

  // 显示项目信息
  title(`项目: ${shrinkHome(absolutePath)}`);

  if (projectInfo) {
    info(`最后链接: ${formatDate(projectInfo.lastLinked)}`);
    info(`平台: ${projectInfo.platforms.join(', ') || '未指定'}`);
  } else {
    warn('此项目尚未链接');
  }

  blank();

  // 分析依赖状态
  const thirdPartyDir = path.dirname(configPath);

  let linked = 0;
  let broken = 0;
  let unlinked = 0;
  const brokenList: string[] = [];
  const unlinkedList: string[] = [];

  for (const dep of dependencies) {
    const localPath = path.join(thirdPartyDir, dep.libName);
    const linkStatus = await checkLinkStatus(localPath);

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

  // JSON 输出
  if (options.json) {
    const output = {
      project: absolutePath,
      lastLinked: projectInfo?.lastLinked ?? null,
      platforms: projectInfo?.platforms ?? [],
      dependencies: {
        total: dependencies.length,
        linked,
        broken,
        unlinked,
      },
      brokenList,
      unlinkedList,
    };
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

    info(`  ${index}. ${displayPath}`);
    info(`     最后链接: ${formatDate(project.lastLinked)}`);
    info(`     平台: ${project.platforms?.join(', ') || '未指定'}`);
    info(`     依赖: ${project.dependencies.length} 个`);

    if (!pathExists) {
      warn(`     [warn] 路径不存在（项目可能已删除）`);
    }

    blank();
    index++;
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
