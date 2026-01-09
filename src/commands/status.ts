/**
 * status 命令 - 查看当前项目状态
 */
import path from 'path';
import fs from 'fs/promises';
import { Command } from 'commander';
import { ensureInitialized } from '../core/guard.js';
import { parseProjectDependencies } from '../core/parser.js';
import { getRegistry } from '../core/registry.js';
import * as store from '../core/store.js';
import * as linker from '../core/linker.js';
import { resolvePath, shrinkHome } from '../core/platform.js';
import { info, warn, success, hint, blank, separator, title } from '../utils/logger.js';
import type { ParsedDependency } from '../types/index.js';

interface StatusOptions {
  json: boolean;
}

/**
 * 创建 status 命令
 */
export function createStatusCommand(): Command {
  return new Command('status')
    .description('查看当前项目的链接状态')
    .argument('[path]', '项目路径', '.')
    .option('--json', '输出 JSON 格式')
    .action(async (projectPath: string, options: StatusOptions) => {
      await ensureInitialized();
      await showStatus(projectPath, options);
    });
}

/**
 * 显示项目状态
 */
export async function showStatus(projectPath: string, options: StatusOptions): Promise<void> {
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
  const _storePath = await store.getStorePath();

  let linked = 0;
  let broken = 0;
  let unlinked = 0;
  const brokenList: string[] = [];
  const unlinkedList: string[] = [];

  for (const dep of dependencies) {
    const localPath = path.join(thirdPartyDir, dep.libName);

    // 检查链接状态：支持单平台（顶层符号链接）和多平台（内部符号链接）
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
    hint('运行 tanmi-dock link . 更新链接');
  }
}

/**
 * 链接状态检查结果
 */
interface LinkStatus {
  isLinked: boolean;  // 是否已链接（单平台或多平台）
  isValid: boolean;   // 链接是否有效
  reason: string;     // 未链接时的原因
}

/**
 * 检查目录的链接状态
 * 支持两种模式：
 * - 单平台：顶层目录是符号链接
 * - 多平台：顶层是普通目录，内部平台子目录是符号链接
 */
async function checkLinkStatus(localPath: string): Promise<LinkStatus> {
  // 1. 检查路径是否存在
  try {
    await fs.access(localPath);
  } catch {
    return { isLinked: false, isValid: false, reason: '不存在' };
  }

  // 2. 检查顶层是否是符号链接（单平台模式）
  const isTopLevelLink = await linker.isSymlink(localPath);
  if (isTopLevelLink) {
    const isValid = await linker.isValidLink(localPath);
    return { isLinked: true, isValid, reason: '' };
  }

  // 3. 检查内部是否有平台符号链接（多平台模式）
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
