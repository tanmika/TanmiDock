/**
 * Git 相关工具函数
 * 用于验证本地库的 commit 状态
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import * as logger from './logger.js';

const execFileAsync = promisify(execFile);

/** Git short hash 最小长度 */
const MIN_COMMIT_LENGTH = 7;

/** commit hash 格式校验 */
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;

export type VerifyReason = 'match' | 'mismatch' | 'no_git';
export type LocalCommitSource = 'commit_hash' | 'git_rev_parse' | 'none';
export type GitPathKind = 'directory' | 'file' | 'missing' | 'invalid';

export interface CommitVerifyResult {
  verified: boolean;
  actualCommit?: string;
  reason: VerifyReason;
}

export interface LocalGitStatusResult {
  hasGitMarker: boolean;
  gitPath: string;
  gitPathKind: GitPathKind;
  commitSource: LocalCommitSource;
  actualCommit?: string;
  commitHashPath: string;
  commitHashExists: boolean;
  commitHashValid: boolean;
  usedRevParse: boolean;
  isFullGit?: boolean;
  isShallow?: boolean;
  shallowFileExists?: boolean;
  reason?: string;
}

/**
 * 检测本地目录的 git commit hash
 *
 * 优先读取 .git/commit_hash 文件，回退到 git rev-parse HEAD。
 * 统一了 verifyLocalCommit 和 store.ts 嵌套依赖中的 commit 检测逻辑。
 *
 * @param localPath 本地目录路径
 * @returns commit hash 或 null（无 .git / 检测失败）
 */
export async function detectLocalCommit(localPath: string): Promise<string | null> {
  const gitPath = path.join(localPath, '.git');

  // Step 1: 检查 .git 是否存在（可以是目录或文件，支持 worktree）
  try {
    const stat = await fs.stat(gitPath);
    if (!stat.isDirectory() && !stat.isFile()) {
      logger.debug(`detectLocalCommit: ${localPath} 的 .git 既不是目录也不是文件`);
      return null;
    }
  } catch {
    logger.debug(`detectLocalCommit: ${localPath} 无 .git`);
    return null;
  }

  // Step 2: 优先检查 .git/commit_hash 文件
  const commitHashFile = path.join(gitPath, 'commit_hash');
  try {
    const content = await fs.readFile(commitHashFile, 'utf-8');
    const hash = content.trim();
    if (hash && COMMIT_HASH_PATTERN.test(hash)) {
      logger.debug(`detectLocalCommit: ${localPath} 从 commit_hash 文件获取 commit = ${hash}`);
      return hash;
    }
  } catch {
    // commit_hash 文件不存在或读取失败，继续尝试 git 命令
  }

  // Step 3: 回退到 git rev-parse HEAD
  try {
    const { stdout } = await execFileAsync('git', ['-C', localPath, 'rev-parse', 'HEAD'], {
      timeout: 5000,
    });
    const hash = stdout.trim();
    if (hash && COMMIT_HASH_PATTERN.test(hash)) {
      logger.debug(`detectLocalCommit: ${localPath} 当前 commit = ${hash}`);
      return hash;
    }
    logger.debug(`detectLocalCommit: git rev-parse 返回无效 hash: ${hash}`);
    return null;
  } catch (error) {
    logger.debug(
      `detectLocalCommit: git rev-parse 失败 - ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export async function inspectLocalGitStatus(localPath: string): Promise<LocalGitStatusResult> {
  const gitPath = path.join(localPath, '.git');
  const commitHashPath = path.join(gitPath, 'commit_hash');
  let gitPathKind: GitPathKind = 'missing';

  logger.debug(`[git-status] 开始检测本地库: path=${localPath}`);

  // Step 1: 检查 .git 是否存在（可以是目录或文件，支持 worktree）
  try {
    const stat = await fs.stat(gitPath);
    if (!stat.isDirectory() && !stat.isFile()) {
      logger.debug(`[git-status] .git 既不是目录也不是文件: path=${localPath}, gitPath=${gitPath}`);
      return {
        hasGitMarker: false,
        gitPath,
        gitPathKind: 'invalid',
        commitSource: 'none',
        commitHashPath,
        commitHashExists: false,
        commitHashValid: false,
        usedRevParse: false,
        reason: '.git 既不是目录也不是文件',
      };
    }
    gitPathKind = stat.isDirectory() ? 'directory' : 'file';
  } catch {
    logger.debug(`[git-status] 未发现 .git: path=${localPath}, gitPath=${gitPath}`);
    return {
      hasGitMarker: false,
      gitPath,
      gitPathKind: 'missing',
      commitSource: 'none',
      commitHashPath,
      commitHashExists: false,
      commitHashValid: false,
      usedRevParse: false,
      reason: '未发现 .git',
    };
  }

  // Step 2: 优先检查 .git/commit_hash 文件
  let commitHashExists = false;
  let commitHashValid = false;
  try {
    const content = await fs.readFile(commitHashPath, 'utf-8');
    commitHashExists = true;
    const hash = content.trim();
    if (hash && COMMIT_HASH_PATTERN.test(hash)) {
      commitHashValid = true;
      const shape = await inspectGitShape(localPath, gitPathKind, gitPath);
      logger.debug(
        `[git-status] 从 commit_hash 获取 commit: path=${localPath}, commit=${hash}, gitPathKind=${gitPathKind}, isFullGit=${shape.isFullGit ?? 'unknown'}, isShallow=${shape.isShallow ?? 'unknown'}`
      );
      return {
        hasGitMarker: true,
        gitPath,
        gitPathKind,
        commitSource: 'commit_hash',
        actualCommit: hash,
        commitHashPath,
        commitHashExists,
        commitHashValid,
        usedRevParse: false,
        ...shape,
      };
    }
    logger.debug(`[git-status] commit_hash 内容无效，准备回退 git rev-parse: path=${localPath}, content="${hash.slice(0, 80)}"`);
  } catch {
    logger.debug(`[git-status] commit_hash 不存在或读取失败，准备回退 git rev-parse: path=${localPath}, commitHashPath=${commitHashPath}`);
  }

  // Step 3: 回退到 git rev-parse HEAD
  try {
    const { stdout } = await execFileAsync('git', ['-C', localPath, 'rev-parse', 'HEAD'], {
      timeout: 5000,
    });
    const hash = stdout.trim();
    if (hash && COMMIT_HASH_PATTERN.test(hash)) {
      const shape = await inspectGitShape(localPath, gitPathKind, gitPath);
      logger.debug(
        `[git-status] 从 git rev-parse 获取 commit: path=${localPath}, commit=${hash}, commitHashExists=${commitHashExists}, gitPathKind=${gitPathKind}, isFullGit=${shape.isFullGit ?? 'unknown'}, isShallow=${shape.isShallow ?? 'unknown'}`
      );
      return {
        hasGitMarker: true,
        gitPath,
        gitPathKind,
        commitSource: 'git_rev_parse',
        actualCommit: hash,
        commitHashPath,
        commitHashExists,
        commitHashValid,
        usedRevParse: true,
        ...shape,
      };
    }
    logger.debug(`[git-status] git rev-parse 返回无效 hash: path=${localPath}, hash=${hash}`);
    return {
      hasGitMarker: true,
      gitPath,
      gitPathKind,
      commitSource: 'none',
      commitHashPath,
      commitHashExists,
      commitHashValid,
      usedRevParse: true,
      reason: `git rev-parse 返回无效 hash: ${hash}`,
      ...(await inspectGitShape(localPath, gitPathKind, gitPath)),
    };
  } catch (error) {
    logger.debug(
      `[git-status] git rev-parse 失败: path=${localPath}, error=${error instanceof Error ? error.message : String(error)}`
    );
    return {
      hasGitMarker: true,
      gitPath,
      gitPathKind,
      commitSource: 'none',
      commitHashPath,
      commitHashExists,
      commitHashValid,
      usedRevParse: true,
      reason: error instanceof Error ? error.message : String(error),
      ...(await inspectGitShape(localPath, gitPathKind, gitPath)),
    };
  }
}

async function inspectGitShape(
  localPath: string,
  gitPathKind: GitPathKind,
  gitPath: string
): Promise<Pick<LocalGitStatusResult, 'isFullGit' | 'isShallow' | 'shallowFileExists'>> {
  if (gitPathKind !== 'directory') {
    return {};
  }

  const objectsPath = path.join(gitPath, 'objects');
  const shallowPath = path.join(gitPath, 'shallow');
  const [isFullGit, shallowFileExists, isShallow] = await Promise.all([
    pathExists(objectsPath),
    pathExists(shallowPath),
    withTimeout(detectShallowRepository(localPath), 500, undefined),
  ]);

  return {
    isFullGit,
    shallowFileExists,
    isShallow,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function detectShallowRepository(localPath: string): Promise<boolean | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', localPath, 'rev-parse', '--is-shallow-repository'], {
      timeout: 5000,
    });
    const value = stdout.trim();
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  } catch (error) {
    logger.debug(
      `[git-status] shallow 状态检测失败: path=${localPath}, error=${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

/**
 * 验证本地目录的 git commit 是否与预期一致
 *
 * @param localPath 本地目录路径
 * @param expectedCommit 预期的 commit hash（完整 40 字符或至少 7 字符的前缀）
 * @returns 验证结果
 *
 * @example
 * // 完整 hash 匹配
 * await verifyLocalCommit('/path/to/lib', 'abc123def456...')
 * // 返回 { verified: true, actualCommit: 'abc123def456...', reason: 'match' }
 */
export async function verifyLocalCommit(
  localPath: string,
  expectedCommit: string
): Promise<CommitVerifyResult> {
  // Step 0: 验证 expectedCommit 有效性
  if (!expectedCommit || expectedCommit.length < MIN_COMMIT_LENGTH) {
    logger.debug(`verifyLocalCommit: expectedCommit 长度不足 (${expectedCommit?.length || 0} < ${MIN_COMMIT_LENGTH})`);
    return { verified: false, reason: 'no_git' };
  }

  // Step 1+2: 检测本地 commit
  const actualCommit = await detectLocalCommit(localPath);
  if (!actualCommit) {
    return { verified: false, reason: 'no_git' };
  }

  // Step 3: 比较 commit（单向前缀匹配：actual 以 expected 开头）
  const normalizedExpected = expectedCommit.toLowerCase();
  const normalizedActual = actualCommit.toLowerCase();

  const isMatch = normalizedActual.startsWith(normalizedExpected);

  if (isMatch) {
    logger.debug(`verifyLocalCommit: commit 匹配 (expected=${expectedCommit})`);
    return { verified: true, actualCommit, reason: 'match' };
  } else {
    logger.debug(
      `verifyLocalCommit: commit 不匹配 (expected=${expectedCommit}, actual=${actualCommit})`
    );
    return { verified: false, actualCommit, reason: 'mismatch' };
  }
}

// ============ Git Submodule 检测 ============

/** .gitmodules 中的 submodule 条目 */
export interface GitSubmodule {
  name: string;       // [submodule "InstantSDK"] 中的名称
  path: string;       // 相对于仓库根的路径
  url: string;        // git 仓库地址
  branch?: string;    // 跟踪分支（可选）
}

/** 含 codepac 配置的 submodule 信息 */
export interface SubmoduleConfig {
  name: string;                           // submodule 名
  relativePath: string;                   // 相对项目根的路径，如 "InstantSDK"
  absolutePath: string;                   // 绝对路径
  configPath: string;                     // codepac-dep.json 绝对路径
  depCount: number;                       // 依赖数量（选择 UI 显示用）
  optionalConfigs: OptionalConfigInfo[];  // 可选配置列表
}

// 延迟导入避免循环依赖
import type { OptionalConfigInfo } from '../core/parser.js';

/**
 * 解析 .gitmodules 文件内容
 * 纯文本解析，不依赖 git 命令
 *
 * @param content .gitmodules 文件内容
 * @returns 解析出的 submodule 列表
 */
export function parseGitmodules(content: string): GitSubmodule[] {
  const submodules: GitSubmodule[] = [];
  let current: Partial<GitSubmodule> | null = null;

  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // 跳过空行和注释行
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    // 匹配 [submodule "xxx"]
    const sectionMatch = line.match(/^\[submodule\s+"(.+)"\]$/);
    if (sectionMatch) {
      // 保存上一个完整的 submodule
      if (current && current.name && current.path && current.url) {
        submodules.push(current as GitSubmodule);
      }
      current = { name: sectionMatch[1] };
      continue;
    }

    // 匹配 key = value（支持 tab 和 space 混合缩进）
    if (current) {
      const kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
      if (kvMatch) {
        const key = kvMatch[1].toLowerCase();
        const value = kvMatch[2].trim();

        switch (key) {
          case 'path':
            current.path = value;
            break;
          case 'url':
            current.url = value;
            break;
          case 'branch':
            current.branch = value;
            break;
        }
      }
    }
  }

  // 保存最后一个 submodule
  if (current && current.name && current.path && current.url) {
    submodules.push(current as GitSubmodule);
  }

  return submodules;
}

/** 递归深度限制 */
const MAX_SUBMODULE_DEPTH = 5;

/**
 * 递归发现所有含 codepac 依赖配置的 submodule
 *
 * @param projectPath 项目路径
 * @param relativePrefix 相对路径前缀（递归用）
 * @param depth 当前递归深度
 * @returns 含配置的 submodule 列表
 */
export async function findSubmoduleConfigs(
  projectPath: string,
  relativePrefix: string = '',
  depth: number = 0,
  codepacPlatforms: string[] = []
): Promise<SubmoduleConfig[]> {
  if (depth >= MAX_SUBMODULE_DEPTH) {
    logger.debug(`findSubmoduleConfigs: 递归深度超限 (${depth}), 路径: ${projectPath}`);
    return [];
  }

  const gitmodulesPath = path.join(projectPath, '.gitmodules');
  let content: string;
  try {
    content = await fs.readFile(gitmodulesPath, 'utf-8');
  } catch {
    return [];
  }

  const submodules = parseGitmodules(content);
  if (submodules.length === 0) {
    return [];
  }

  // 延迟导入 parser 模块
  const { findCodepacConfig, findAllCodepacConfigs, parseCodepacDep, extractDependencies } =
    await import('../core/parser.js');

  const results: SubmoduleConfig[] = [];

  for (const sub of submodules) {
    const absolutePath = path.join(projectPath, sub.path);
    const relativePath = relativePrefix ? path.join(relativePrefix, sub.path) : sub.path;

    // 检查 submodule 目录是否存在（可能未 init）
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isDirectory()) continue;
    } catch {
      logger.debug(`findSubmoduleConfigs: submodule 目录不存在: ${absolutePath}`);
      continue;
    }

    // 查找 codepac-dep.json
    const configPath = await findCodepacConfig(absolutePath);
    if (!configPath) {
      // 无配置文件，但仍递归检查嵌套 submodule
      const nested = await findSubmoduleConfigs(absolutePath, relativePath, depth + 1, codepacPlatforms);
      results.push(...nested);
      continue;
    }

    // 解析依赖数量
    let depCount = 0;
    try {
      const config = await parseCodepacDep(configPath);
      const deps = extractDependencies(config, { platforms: codepacPlatforms, configPath });
      depCount = deps.length;
    } catch {
      logger.debug(`findSubmoduleConfigs: 解析配置失败: ${configPath}`);
      continue;
    }

    // 查找可选配置
    let optionalConfigs: OptionalConfigInfo[] = [];
    const configDir = path.dirname(configPath);
    const allConfigs = await findAllCodepacConfigs(configDir);
    if (allConfigs) {
      optionalConfigs = allConfigs.optionalConfigs;
    }

    results.push({
      name: sub.name,
      relativePath,
      absolutePath,
      configPath,
      depCount,
      optionalConfigs,
    });

    // 递归检查嵌套 submodule
    const nested = await findSubmoduleConfigs(absolutePath, relativePath, depth + 1, codepacPlatforms);
    results.push(...nested);
  }

  return results;
}

export default {
  detectLocalCommit,
  inspectLocalGitStatus,
  verifyLocalCommit,
  parseGitmodules,
  findSubmoduleConfigs,
};
