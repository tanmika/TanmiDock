/**
 * projects 命令 - 查看所有已跟踪项目
 */
import fs from 'fs/promises';
import { Command } from 'commander';
import { ensureInitialized } from '../core/guard.js';
import { getRegistry } from '../core/registry.js';
import { shrinkHome } from '../core/platform.js';
import { formatSize } from '../utils/disk.js';
import { info, warn, title, blank, tree as printTree } from '../utils/logger.js';
import type { TreeItem } from '../utils/logger.js';

/**
 * 创建 projects 命令
 */
export function createProjectsCommand(): Command {
  return new Command('projects')
    .description('查看所有已跟踪项目')
    .option('--tree', '树状展示库引用关系')
    .option('--json', 'JSON 格式输出')
    .action(async (options) => {
      await ensureInitialized();
      await showProjects(options);
    });
}

interface ProjectsOptions {
  tree: boolean;
  json: boolean;
}

/**
 * 显示项目列表
 */
async function showProjects(options: ProjectsOptions): Promise<void> {
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
    info('暂无已跟踪的项目');
    blank();
    info('使用 tanmi-dock link <path> 链接项目');
    return;
  }

  title(`已跟踪项目 (${projects.length} 个):`);
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

export default createProjectsCommand;
