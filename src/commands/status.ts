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

/**
 * 创建 status 命令
 */
export function createStatusCommand(): Command {
  return new Command('status')
    .description('查看当前项目的链接状态')
    .argument('[path]', '项目路径', '.')
    .action(async (projectPath: string) => {
      await ensureInitialized();
      await showStatus(projectPath);
    });
}

/**
 * 显示项目状态
 */
async function showStatus(projectPath: string): Promise<void> {
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
    info(`平台: ${projectInfo.platform === 'mac' ? 'macOS' : 'Windows'}`);
  } else {
    warn('此项目尚未链接');
  }

  blank();

  // 分析依赖状态
  const thirdPartyDir = path.dirname(configPath);
  const storePath = await store.getStorePath();

  let linked = 0;
  let broken = 0;
  let unlinked = 0;
  const brokenList: string[] = [];
  const unlinkedList: string[] = [];

  for (const dep of dependencies) {
    const localPath = path.join(thirdPartyDir, dep.libName);
    const storeLibPath = store.getLibraryPath(storePath, dep.libName, dep.commit);

    const isLink = await linker.isSymlink(localPath);

    if (isLink) {
      const isValid = await linker.isValidLink(localPath);
      const isCorrect = await linker.isCorrectLink(localPath, storeLibPath);

      if (isValid && isCorrect) {
        linked++;
      } else {
        broken++;
        brokenList.push(`${dep.libName} (${dep.commit.slice(0, 7)})`);
      }
    } else {
      // 检查是否存在
      try {
        await fs.access(localPath);
        unlinked++;
        unlinkedList.push(`${dep.libName} (${dep.commit.slice(0, 7)}) - 普通目录`);
      } catch {
        unlinked++;
        unlinkedList.push(`${dep.libName} (${dep.commit.slice(0, 7)}) - 不存在`);
      }
    }
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
