/**
 * codepac 命令封装
 * 提供对 codepac CLI 工具的调用接口
 */
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import {
  isPlatformDir,
  normalizePlatformValue,
  getBaseKeyForCodepac,
  platformValueToKey,
  collectRequestedPlatformTargets,
  getRequestedPlatformTargets,
  resolveSparseConfig,
} from './platform.js';
import type { ProxyConfig } from '../types/index.js';
import * as logger from '../utils/logger.js';

const execAsync = promisify(exec);

// 代理配置缓存
let cachedProxyEnv: Record<string, string> | null = null;

/**
 * 设置代理配置（由外部调用）
 */
export function setProxyConfig(proxy: ProxyConfig | undefined): void {
  if (!proxy) {
    cachedProxyEnv = null;
    return;
  }

  cachedProxyEnv = {};
  if (proxy.http) {
    cachedProxyEnv['HTTP_PROXY'] = proxy.http;
    cachedProxyEnv['http_proxy'] = proxy.http;
  }
  if (proxy.https) {
    cachedProxyEnv['HTTPS_PROXY'] = proxy.https;
    cachedProxyEnv['https_proxy'] = proxy.https;
  }
  if (proxy.noProxy && proxy.noProxy.length > 0) {
    cachedProxyEnv['NO_PROXY'] = proxy.noProxy.join(',');
    cachedProxyEnv['no_proxy'] = proxy.noProxy.join(',');
  }
}

/**
 * 获取带代理配置的环境变量
 */
function getEnvWithProxy(): NodeJS.ProcessEnv {
  if (!cachedProxyEnv) {
    return process.env;
  }
  return { ...process.env, ...cachedProxyEnv };
}

/**
 * codepac 命令名称
 */
const CODEPAC_CMD = 'codepac';
const GIT_CMD = 'git';

/**
 * 检查 codepac 是否已安装
 */
export async function isCodepacInstalled(): Promise<boolean> {
  try {
    await execAsync(`${CODEPAC_CMD} --version`, { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取 codepac 版本
 */
export async function getVersion(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`${CODEPAC_CMD} --version`, { encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * 安装依赖选项
 */
export interface InstallOptions {
  /** codepac-dep.json 配置文件路径 */
  configPath: string;
  /** 目标目录（3rdparty 目录） */
  targetDir: string;
  /** 平台目录名 (macOS, iOS, android...) - 传给 codepac -p */
  platform?: string;
  /** 进度回调 */
  onProgress?: (message: string) => void;
  /** 是否静默模式 */
  silent?: boolean;
}

/**
 * 使用 codepac 安装依赖
 */
export async function install(options: InstallOptions): Promise<void> {
  const { configPath, targetDir, platform, onProgress, silent } = options;

  // 检查 codepac 是否安装
  if (!(await isCodepacInstalled())) {
    throw new Error('codepac 未安装，请先安装 codepac 工具');
  }

  // 拆分配置路径为目录和文件名
  const configDir = path.dirname(configPath);
  const configFileName = path.basename(configPath);

  // 构建命令参数
  const args = ['install', '--configdir', configDir, '--configfile', configFileName, '--targetdir', targetDir];

  // 添加平台参数
  if (platform) {
    args.push('-p', platform);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(CODEPAC_CMD, args, {
      cwd: configDir,
      stdio: silent ? 'ignore' : 'pipe',
      env: getEnvWithProxy(),
    });

    let stderr = '';

    if (proc.stdout && onProgress) {
      proc.stdout.on('data', (data: Buffer) => {
        const message = data.toString().trim();
        if (message) {
          onProgress(message);
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
    }

    proc.on('error', (err) => {
      reject(new Error(`无法执行 codepac 命令: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const errorMsg = stderr.trim() || `codepac 命令执行失败，退出码: ${code}`;
        reject(new Error(errorMsg));
      }
    });
  });
}

/**
 * 安装单个库选项
 */
export interface InstallSingleOptions {
  /** 库的 Git URL */
  url: string;
  /** commit hash */
  commit: string;
  /** 分支名 */
  branch: string;
  /** 目标目录 */
  targetDir: string;
  /** 平台目录名 (macOS, iOS, android...) - 传给 codepac -p */
  platform?: string;
  /** sparse checkout 配置 */
  sparse?: object | string;
  /** 进度回调 */
  onProgress?: (message: string) => void;
  /** 是否静默模式 */
  silent?: boolean;
}

/**
 * 使用 codepac 安装单个库
 * 注意：这需要 codepac 支持单库安装，如果不支持则需要创建临时配置文件
 */
export async function installSingle(options: InstallSingleOptions): Promise<void> {
  const { url, commit, branch, targetDir, platform, sparse, onProgress, silent } = options;

  // 检查 codepac 是否安装
  if (!(await isCodepacInstalled())) {
    throw new Error('codepac 未安装，请先安装 codepac 工具');
  }

  // 创建临时配置
  const fs = await import('fs/promises');
  const os = await import('os');

  const tempDir = os.tmpdir();
  const tempConfigPath = path.join(tempDir, `codepac-temp-${Date.now()}.json`);

  const tempConfig = {
    version: '1.0.0',
    repos: {
      common: [
        {
          url,
          commit,
          branch,
          dir: path.basename(targetDir),
          ...(sparse && { sparse }),
        },
      ],
    },
  };

  try {
    await fs.writeFile(tempConfigPath, JSON.stringify(tempConfig, null, 2), 'utf-8');

    await install({
      configPath: tempConfigPath,
      targetDir: path.dirname(targetDir),
      platform,
      onProgress,
      silent,
    });
  } finally {
    // 清理临时文件
    try {
      await fs.unlink(tempConfigPath);
    } catch {
      // 忽略清理错误
    }
  }
}

/**
 * 更新库到最新 commit
 */
export interface UpdateOptions {
  /** codepac-dep.json 配置文件路径 */
  configPath: string;
  /** 目标目录 */
  targetDir: string;
  /** 要更新的库名（不指定则更新所有） */
  libName?: string;
  /** 进度回调 */
  onProgress?: (message: string) => void;
}

/**
 * 更新依赖
 */
export async function update(options: UpdateOptions): Promise<void> {
  const { configPath, targetDir, libName, onProgress } = options;

  // 检查 codepac 是否安装
  if (!(await isCodepacInstalled())) {
    throw new Error('codepac 未安装，请先安装 codepac 工具');
  }

  // 拆分配置路径为目录和文件名
  const configDir = path.dirname(configPath);
  const configFileName = path.basename(configPath);

  // 构建命令参数（库名直接作为参数，不用 -n）
  const args = ['update'];
  if (libName) {
    args.push(libName);
  }
  args.push('--configdir', configDir, '--configfile', configFileName, '--targetdir', targetDir);

  return new Promise((resolve, reject) => {
    const proc = spawn(CODEPAC_CMD, args, {
      cwd: configDir,
      stdio: 'pipe',
      env: getEnvWithProxy(),
    });

    let stderr = '';

    if (proc.stdout && onProgress) {
      proc.stdout.on('data', (data: Buffer) => {
        const message = data.toString().trim();
        if (message) {
          onProgress(message);
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
    }

    proc.on('error', (err) => {
      reject(new Error(`无法执行 codepac 命令: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const errorMsg = stderr.trim() || `codepac update 命令执行失败，退出码: ${code}`;
        reject(new Error(errorMsg));
      }
    });
  });
}

// ============ downloadToTemp 接口定义 ============

/**
 * 下载选项
 */
export interface DownloadOptions {
  /** 库的 Git URL */
  url: string;
  /** commit hash */
  commit: string;
  /** 分支名 */
  branch: string;
  /** 库名称 */
  libName: string;
  /** 平台 CLI keys: ["mac", "android"] */
  platforms: string[];
  /** sparse checkout 配置 */
  sparse?: object | string;
  /** codepac 变量定义（用于解析 sparse 中的变量引用） */
  vars?: Record<string, string>;
  /** 是否使用 Git 非完整拉取以降低下载空间消耗，默认开启 */
  useGitLightweightDownload?: boolean;
  /** 进度回调 */
  onProgress?: (msg: string) => void;
  /** 长时间静默时的保活回调 */
  onHeartbeat?: (msg: string) => void;
  /** 临时目录创建后回调（用于启动进度监控） */
  onTempDirCreated?: (tempDir: string, libDir: string) => void;
}

/**
 * 下载结果
 */
export interface DownloadResult {
  /** 临时目录根路径 */
  tempDir: string;
  /** 库目录: tempDir/libName */
  libDir: string;
  /** codepac 实际下载到的全部平台目录（清理前） */
  allPlatformDirs: string[];
  /** 实际保留的平台目录名（满足请求的平台承载目录） */
  platformDirs: string[];
  /** 共享文件列表 */
  sharedFiles: string[];
  /** 被清理的平台目录名（codepac 下载了但用户未请求的） */
  cleanedPlatforms: string[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CommandRunOptions {
  env?: NodeJS.ProcessEnv;
  onProgress?: (msg: string) => void;
  onHeartbeat?: (msg: string) => void;
  forwardStdout?: boolean;
}

interface DownloadedLibraryEntries {
  downloadedPlatforms: string[];
  sharedFiles: string[];
}

/**
 * 生成唯一临时目录名
 */
function generateTempDirName(): string {
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 8);
  return `tanmi-dock-${timestamp}-${randomId}`;
}

/**
 * 下载库到临时目录
 *
 * @param options 下载选项
 * @returns 下载结果，包含临时目录路径、平台目录和共享文件列表
 * @throws 如果下载失败，会清理临时目录后抛出错误
 *
 * @deprecated installSingle 已被本函数替代
 */
export async function downloadToTemp(options: DownloadOptions): Promise<DownloadResult> {
  const {
    url,
    commit,
    branch,
    libName,
    platforms,
    sparse,
    vars,
    useGitLightweightDownload = true,
    onProgress,
    onHeartbeat,
    onTempDirCreated,
  } = options;

  // 创建唯一临时目录
  const tempDirName = generateTempDirName();
  const tempDir = path.join(os.tmpdir(), tempDirName);
  const libDir = path.join(tempDir, libName);

  // 生成临时配置文件路径
  const configPath = path.join(tempDir, 'codepac-dep.json');

  try {
    // 创建临时目录
    await fs.mkdir(tempDir, { recursive: true });

    // 通知调用方临时目录已创建（用于启动进度监控）
    onTempDirCreated?.(tempDir, libDir);

    // 生成临时 codepac 配置文件（包含变量定义以支持 sparse 变量引用）
    const tempConfig: Record<string, unknown> = {
      version: '1.0.0',
      repos: {
        common: [
          {
            url,
            commit,
            branch,
            dir: libName,
            ...(sparse && { sparse }),
          },
        ],
      },
    };

    // 如果有变量定义，添加到配置中
    if (vars && Object.keys(vars).length > 0) {
      tempConfig.vars = vars;
    }

    await fs.writeFile(configPath, JSON.stringify(tempConfig, null, 2), 'utf-8');

    const gitDownloaded = useGitLightweightDownload
      ? await tryDownloadWithGit(options, tempDir, libDir).catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        onProgress?.(`Git 轻量下载失败，切换 codepac 下载: ${message}`);
        try {
          await fs.rm(libDir, { recursive: true, force: true });
        } catch {
          // 忽略回退前的清理错误，后续 codepac 仍会在临时目录中重新下载。
        }
        return false;
      })
      : false;

    if (!gitDownloaded) {
      // 检查 codepac 是否安装
      if (!(await isCodepacInstalled())) {
        throw new Error('codepac 未安装，请先安装 codepac 工具');
      }

      // 构建 codepac 命令参数
      // 关键: codepac -p 需要基础 CLI key (mac/ios/android)
      // 无论用户请求 macOS 还是 macOS-asan，都传 mac 给 codepac
      // codepac 会下载所有变体，之后我们做清理
      const baseKeys = [...new Set(platforms.map(getBaseKeyForCodepac))];
      const args = ['install', '-cf', configPath, '-td', tempDir, '-p', ...baseKeys];

      // 调用 codepac
      await spawnCodepac(args, tempDir, onProgress, onHeartbeat);
    }

    return analyzeDownloadedLibrary({ tempDir, libDir, platforms, sparse, vars });
  } catch (error) {
    // 清理临时目录
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }

    // 重新抛出原始错误
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`下载库失败: ${message}`);
  }
}

async function tryDownloadWithGit(options: DownloadOptions, tempDir: string, libDir: string): Promise<boolean> {
  const { url, commit, branch, platforms, sparse, vars, onProgress, onHeartbeat } = options;

  if (platforms.length === 0 || !isCommitHash(commit)) {
    return false;
  }

  const sparseConfig = resolveSparseConfig(sparse, vars);
  if (sparse && !sparseConfig) {
    return false;
  }

  onProgress?.('尝试使用 Git 轻量下载');

  await spawnGit(['--version'], tempDir, onProgress, onHeartbeat);
  await spawnGit(['lfs', 'version'], tempDir, onProgress, onHeartbeat);

  await spawnGit(
    [
      'clone',
      '--filter=blob:none',
      '--depth',
      '1',
      '--single-branch',
      '--no-checkout',
      '--branch',
      branch,
      url,
      libDir,
    ],
    tempDir,
    onProgress,
    onHeartbeat,
    { GIT_LFS_SKIP_SMUDGE: '1' }
  );

  const partialCloneFilter = await spawnGit(
    ['-C', libDir, 'config', '--get', 'remote.origin.partialclonefilter'],
    tempDir,
    undefined,
    onHeartbeat,
    undefined,
    false
  );
  if (partialCloneFilter.stdout.trim() !== 'blob:none') {
    throw new Error('远端未启用 blob:none 轻量克隆');
  }

  const sparseCheckoutPaths = sparseConfig
    ? buildSparseCheckoutPaths(platforms, sparseConfig)
    : await buildRepositorySparseCheckoutPaths(libDir, platforms, sparse, vars, tempDir, onHeartbeat);

  if (sparseCheckoutPaths.length === 0) {
    throw new Error('无法推导 Git sparse checkout 路径');
  }
  await spawnGit(['-C', libDir, 'sparse-checkout', 'init', '--no-cone'], tempDir, onProgress, onHeartbeat);
  await spawnGit(
    ['-C', libDir, 'sparse-checkout', 'set', '--no-cone', ...sparseCheckoutPaths],
    tempDir,
    onProgress,
    onHeartbeat
  );

  try {
    await checkoutGitCommit(libDir, commit, tempDir, onProgress, onHeartbeat);
  } catch {
    await spawnGit(['-C', libDir, 'fetch', '--depth', '1', 'origin', commit], tempDir, onProgress, onHeartbeat, {
      GIT_LFS_SKIP_SMUDGE: '1',
    });
    await checkoutGitCommit(libDir, commit, tempDir, onProgress, onHeartbeat);
  }

  const includePaths = sparseConfig
    ? buildSparseGitLfsIncludePaths(platforms, sparseConfig)
    : await buildGitLfsIncludePathsFromRepository(libDir, platforms, sparse, vars, tempDir, onHeartbeat);
  const expectedLfsPaths = sparseConfig
    ? await buildGitLfsFilePathsForIncludes(libDir, includePaths, tempDir, onHeartbeat)
    : includePaths;

  if (includePaths.length > 0) {
    await spawnGit(
      ['-C', libDir, 'lfs', 'pull', '--include', includePaths.join(','), '--exclude', ''],
      tempDir,
      onProgress,
      onHeartbeat
    );
  }

  await verifyGitDownloadResult({ libDir, platforms, sparse, vars, expectedLfsPaths });
  await finalizeMinisizeGitDownload(libDir, tempDir, onProgress, onHeartbeat);

  onProgress?.('Git 轻量下载完成');
  return true;
}

function isCommitHash(commit: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(commit);
}

function buildSparseGitLfsIncludePaths(platforms: string[], sparseConfig: Record<string, unknown[]>): string[] {
  return expandGitLfsIncludeRoots(buildSparseCheckoutPaths(platforms, sparseConfig));
}

function buildSparseCheckoutPaths(platforms: string[], sparseConfig: Record<string, unknown[]>): string[] {
  const includeRoots: string[] = [];
  const commonItems = sparseConfig.common;

  if (Array.isArray(commonItems)) {
    includeRoots.push(...commonItems.filter((item): item is string => typeof item === 'string'));
  }

  for (const platform of platforms) {
    const rawItems = getSparseItemsForPlatform(platform, sparseConfig);
    if (Array.isArray(rawItems)) {
      includeRoots.push(...rawItems.filter((item): item is string => typeof item === 'string'));
    } else {
      includeRoots.push(...getRequestedPlatformTargets(platform, sparseConfig));
    }
  }

  return [...new Set(includeRoots.map((item) => normalizeGitPath(item)).filter((item): item is string => Boolean(item)))];
}

function getSparseItemsForPlatform(platform: string, sparseConfig: Record<string, unknown[]>): unknown[] | undefined {
  const candidateKeys = [
    platform,
    platformValueToKey(platform),
    normalizePlatformValue(platform),
    getBaseKeyForCodepac(platform),
  ];

  for (const key of new Set(candidateKeys)) {
    const items = sparseConfig[key];
    if (Array.isArray(items)) {
      return items;
    }
  }

  return undefined;
}

async function buildGitLfsIncludePathsFromRepository(
  libDir: string,
  platforms: string[],
  sparse: object | string | undefined,
  vars: Record<string, string> | undefined,
  cwd: string,
  onHeartbeat?: (msg: string) => void
): Promise<string[]> {
  const requestedTargets = new Set(collectRequestedPlatformTargets(platforms, sparse, vars));
  const lfsPaths = await listGitLfsFilePaths(libDir, cwd, onHeartbeat);
  const selectedPaths = lfsPaths.filter((line) => {
    const [topLevel] = line.split('/');
    if (!topLevel || !isPlatformDir(topLevel)) {
      return true;
    }
    return requestedTargets.has(normalizePlatformValue(topLevel));
  });

  return [...new Set(selectedPaths)];
}

async function buildGitLfsFilePathsForIncludes(
  libDir: string,
  includePaths: string[],
  cwd: string,
  onHeartbeat?: (msg: string) => void
): Promise<string[]> {
  const includeRoots = includePaths
    .map((item) => normalizeGitPath(item.replace(/\/\*\*$/g, '')))
    .filter((item): item is string => Boolean(item));
  const uniqueIncludeRoots = [...new Set(includeRoots)];

  if (uniqueIncludeRoots.length === 0) {
    return [];
  }

  const lfsPaths = await listGitLfsFilePaths(libDir, cwd, onHeartbeat);
  return lfsPaths.filter((lfsPath) => uniqueIncludeRoots.some((root) => lfsPath === root || lfsPath.startsWith(`${root}/`)));
}

async function listGitLfsFilePaths(
  libDir: string,
  cwd: string,
  onHeartbeat?: (msg: string) => void
): Promise<string[]> {
  const result = await spawnGit(
    ['-C', libDir, 'lfs', 'ls-files', '--all', '--name-only'],
    cwd,
    undefined,
    onHeartbeat,
    undefined,
    false
  );

  return result.stdout
    .split(/\r?\n/)
    .map((line) => normalizeGitPath(line))
    .filter((line): line is string => Boolean(line));
}

async function buildRepositorySparseCheckoutPaths(
  libDir: string,
  platforms: string[],
  sparse: object | string | undefined,
  vars: Record<string, string> | undefined,
  cwd: string,
  onHeartbeat?: (msg: string) => void
): Promise<string[]> {
  const requestedTargets = new Set(collectRequestedPlatformTargets(platforms, sparse, vars));
  const result = await spawnGit(['-C', libDir, 'ls-tree', '--name-only', 'HEAD'], cwd, undefined, onHeartbeat, undefined, false);
  const topLevelEntries = result.stdout
    .split(/\r?\n/)
    .map((line) => normalizeGitPath(line))
    .filter((line): line is string => Boolean(line));
  const hasRequestedPlatform = topLevelEntries.some((entry) => (
    isPlatformDir(entry) && requestedTargets.has(normalizePlatformValue(entry))
  ));

  if (!hasRequestedPlatform) {
    throw new Error('仓库顶层目录未包含请求平台');
  }

  const selectedEntries = topLevelEntries.filter((entry) => {
    if (!isPlatformDir(entry)) {
      return true;
    }
    return requestedTargets.has(normalizePlatformValue(entry));
  });

  return selectedEntries.flatMap((entry) => [entry, `${entry}/**`]);
}

function expandGitLfsIncludeRoots(paths: string[]): string[] {
  const result: string[] = [];

  for (const rawPath of paths) {
    const normalized = normalizeGitPath(rawPath);
    if (!normalized) continue;
    result.push(normalized);
    result.push(`${normalized}/**`);
  }

  return [...new Set(result)];
}

function normalizeGitPath(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/g, '');

  if (!normalized || normalized === '.' || normalized.startsWith('/')) {
    return null;
  }

  if (normalized.split('/').some((part) => part === '..')) {
    return null;
  }

  return normalized;
}

async function checkoutGitCommit(
  libDir: string,
  commit: string,
  cwd: string,
  onProgress?: (msg: string) => void,
  onHeartbeat?: (msg: string) => void
): Promise<void> {
  await spawnGit(['-C', libDir, 'checkout', commit], cwd, onProgress, onHeartbeat, {
    GIT_LFS_SKIP_SMUDGE: '1',
  });
}

async function verifyGitDownloadResult(options: {
  libDir: string;
  platforms: string[];
  sparse?: object | string;
  vars?: Record<string, string>;
  expectedLfsPaths: string[];
}): Promise<void> {
  const { libDir, platforms, sparse, vars, expectedLfsPaths } = options;
  const result = await inspectDownloadedLibrary(libDir);
  const requestedTargets = new Set(collectRequestedPlatformTargets(platforms, sparse, vars));
  const missingTargets = [...requestedTargets].filter((platform) => !result.downloadedPlatforms.includes(platform));

  if (missingTargets.length > 0) {
    throw new Error(`Git 下载结果缺少请求平台目录: ${missingTargets.join(', ')}`);
  }

  const unresolvedPointer = await findFirstUnresolvedLfsPointer(libDir, expectedLfsPaths);
  if (unresolvedPointer) {
    throw new Error(`Git LFS 文件未完成下载: ${unresolvedPointer}`);
  }
}

async function finalizeMinisizeGitDownload(
  libDir: string,
  cwd: string,
  onProgress?: (msg: string) => void,
  onHeartbeat?: (msg: string) => void
): Promise<void> {
  const gitDir = await resolveGitDir(libDir);
  if (!gitDir) {
    onProgress?.('Git minisize 收尾跳过: 未发现 .git 目录');
    return;
  }

  const gitLog = await spawnGit(['-C', libDir, 'log', '-1'], cwd, undefined, onHeartbeat, undefined, false);
  const head = await spawnGit(['-C', libDir, 'rev-parse', 'HEAD'], cwd, undefined, onHeartbeat, undefined, false);
  const commit = head.stdout.trim();

  onProgress?.(`Git minisize 收尾: gitdir=${gitDir}`);
  const cleanupSummary = await cleanupRepoAndSubmoduleGitPayloads(libDir);
  onProgress?.(
    `Git minisize 收尾: 清理 .git/lfs 和 .git/objects，仓库数=${cleanupSummary.repoCount}, 目录数=${cleanupSummary.cleanedDirectoryCount}`
  );
  if (cleanupSummary.submodulePaths.length > 0) {
    onProgress?.(`Git minisize 收尾: 已处理 submodule=${cleanupSummary.submodulePaths.join(',')}`);
  }

  const repoName = path.basename(libDir);
  const commitMessagePath = path.join(gitDir, 'commit_message');
  const commitHashPath = path.join(gitDir, 'commit_hash');
  await fs.writeFile(
    commitMessagePath,
    `=============== ${repoName} ===============\n${gitLog.stdout}`,
    'utf-8'
  );
  await fs.writeFile(commitHashPath, commit, 'utf-8');
  onProgress?.(`Git minisize 收尾完成: commit_hash=${commit.slice(0, 12)}, marker=${commitHashPath}`);
}

async function cleanupRepoAndSubmoduleGitPayloads(repoDir: string): Promise<{
  repoCount: number;
  cleanedDirectoryCount: number;
  submodulePaths: string[];
}> {
  let repoCount = 0;
  let cleanedDirectoryCount = 0;

  const rootCleaned = await cleanupGitPayload(repoDir);
  repoCount += rootCleaned === null ? 0 : 1;
  cleanedDirectoryCount += rootCleaned ?? 0;

  const submodulePaths = await collectGitSubmodulePaths(repoDir);
  for (const submodulePath of submodulePaths) {
    const submoduleCleaned = await cleanupGitPayload(path.join(repoDir, submodulePath));
    repoCount += submoduleCleaned === null ? 0 : 1;
    cleanedDirectoryCount += submoduleCleaned ?? 0;
  }

  return { repoCount, cleanedDirectoryCount, submodulePaths };
}

async function cleanupGitPayload(repoDir: string): Promise<number | null> {
  const gitDir = await resolveGitDir(repoDir);
  if (!gitDir) return null;

  return (
    await cleanupGitPayloadDirectory(path.join(gitDir, 'lfs'))
    + await cleanupGitPayloadDirectory(path.join(gitDir, 'objects'))
  );
}

async function cleanupGitPayloadDirectory(payloadDir: string): Promise<number> {
  let entries: Array<string | { name: string; isDirectory?: () => boolean }> = [];
  try {
    const dirEntries = await fs.readdir(payloadDir, { withFileTypes: true });
    entries = Array.isArray(dirEntries)
      ? dirEntries as Array<string | { name: string; isDirectory?: () => boolean }>
      : [];
  } catch {
    return 0;
  }

  let cleanedCount = 0;
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const isDirectory = typeof entry === 'string' ? true : entry.isDirectory?.() ?? false;
    if (!isDirectory) continue;

    const entryPath = path.join(payloadDir, name);
    await fs.rm(entryPath, { recursive: true, force: true });
    await fs.mkdir(entryPath, { recursive: true });
    cleanedCount++;
  }

  return cleanedCount;
}

async function resolveGitDir(repoDir: string): Promise<string | null> {
  const gitPath = path.join(repoDir, '.git');
  try {
    const stat = await fs.stat(gitPath);
    if (stat.isDirectory()) {
      return gitPath;
    }
    if (!stat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const content = await fs.readFile(gitPath, 'utf-8');
    if (typeof content !== 'string') {
      return null;
    }
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match) {
      return null;
    }
    return path.resolve(repoDir, match[1].trim());
  } catch {
    return null;
  }
}

async function collectGitSubmodulePaths(repoDir: string): Promise<string[]> {
  const gitmodulesPath = path.join(repoDir, '.gitmodules');
  let content: string;
  try {
    content = await fs.readFile(gitmodulesPath, 'utf-8');
  } catch {
    return [];
  }
  if (typeof content !== 'string') {
    return [];
  }

  const paths: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^path\s*=\s*(.+)$/);
    if (!match) continue;
    const submodulePath = normalizeGitPath(match[1]);
    if (submodulePath) {
      paths.push(submodulePath);
    }
  }

  const nestedPaths = await Promise.all(
    paths.map(async (submodulePath) => {
      const childPaths = await collectGitSubmodulePaths(path.join(repoDir, submodulePath));
      return childPaths.map((childPath) => `${submodulePath}/${childPath}`);
    })
  );

  return [...new Set([...paths, ...nestedPaths.flat()])];
}

async function findFirstUnresolvedLfsPointer(libDir: string, relativePaths: string[]): Promise<string | null> {
  for (const relativePath of relativePaths) {
    const content = await readSmallTextFile(path.join(libDir, relativePath));
    if (content?.startsWith('version https://git-lfs.github.com/spec/v1')) {
      return relativePath;
    }
  }

  return null;
}

async function readSmallTextFile(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > 1024) {
      return null;
    }
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

async function analyzeDownloadedLibrary(options: {
  tempDir: string;
  libDir: string;
  platforms: string[];
  sparse?: object | string;
  vars?: Record<string, string>;
}): Promise<DownloadResult> {
  const { tempDir, libDir, platforms, sparse, vars } = options;
  const { downloadedPlatforms, sharedFiles } = await inspectDownloadedLibrary(libDir);

  // 后处理：清理用户未请求的平台目录
  // 例如用户只请求 macOS，但 codepac 下载了 macOS 和 macOS-asan
  const requestedTargets = new Set(collectRequestedPlatformTargets(platforms, sparse, vars));
  const platformDirs: string[] = [];
  const cleanedPlatforms: string[] = [];

  for (const platform of downloadedPlatforms) {
    if (requestedTargets.has(platform)) {
      // 请求平台直接命中，或通过 sparse 映射命中承载目录时保留
      platformDirs.push(platform);
    } else {
      // 用户未请求的平台，删除
      const platformPath = path.join(libDir, platform);
      try {
        await fs.rm(platformPath, { recursive: true, force: true });
        cleanedPlatforms.push(platform);
      } catch (err) {
        logger.warn(`清理平台目录 ${platform} 失败: ${(err as Error).message}`);
      }
    }
  }

  return {
    tempDir,
    libDir,
    allPlatformDirs: downloadedPlatforms,
    platformDirs,
    sharedFiles,
    cleanedPlatforms,
  };
}

async function inspectDownloadedLibrary(libDir: string): Promise<DownloadedLibraryEntries> {
  let entries: Array<string | { name: string; isDirectory: () => boolean }> = [];
  try {
    const dirEntries = await fs.readdir(libDir, { withFileTypes: true });
    entries = Array.isArray(dirEntries)
      ? dirEntries as Array<string | { name: string; isDirectory: () => boolean }>
      : [];
  } catch {
    entries = [];
  }

  const downloadedPlatforms: string[] = [];
  const sharedFiles: string[] = [];

  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const isDirectory = typeof entry === 'string' ? false : entry.isDirectory();
    if (isDirectory && isPlatformDir(name)) {
      const platformPath = path.join(libDir, name);
      const platformHasFiles = await directoryHasFiles(platformPath);
      if (platformHasFiles) {
        // 标准化平台目录名（例如 "macos" -> "macOS"）
        downloadedPlatforms.push(normalizePlatformValue(name));
      } else {
        sharedFiles.push(name);
      }
    } else {
      sharedFiles.push(name);
    }
  }

  return { downloadedPlatforms, sharedFiles };
}

async function directoryHasFiles(dirPath: string, depth: number = 0): Promise<boolean> {
  if (depth > 32) {
    return true;
  }
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      if (name.startsWith('.')) continue;
      if (typeof entry === 'string') return true;
      if (typeof entry.isFile === 'function' && entry.isFile()) return true;
      if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) return true;
      if (entry.isDirectory() && await directoryHasFiles(path.join(dirPath, name), depth + 1)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function spawnGit(
  args: string[],
  cwd: string,
  onProgress?: (msg: string) => void,
  onHeartbeat?: (msg: string) => void,
  extraEnv?: NodeJS.ProcessEnv,
  forwardStdout = true
): Promise<CommandResult> {
  return spawnCommand(GIT_CMD, args, cwd, {
    onProgress,
    onHeartbeat,
    env: { ...getEnvWithProxy(), ...extraEnv },
    forwardStdout,
  });
}

/**
 * 内部辅助函数: 执行 codepac 命令
 */
function spawnCodepac(
  args: string[],
  cwd: string,
  onProgress?: (msg: string) => void,
  onHeartbeat?: (msg: string) => void
): Promise<void> {
  return spawnCommand(CODEPAC_CMD, args, cwd, {
    onProgress,
    onHeartbeat,
    env: getEnvWithProxy(),
  }).then(() => undefined);
}

function spawnCommand(
  command: string,
  args: string[],
  cwd: string,
  options: CommandRunOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: 'pipe',
      env: options.env ?? getEnvWithProxy(),
    });

    if (!proc) {
      reject(new Error(`无法执行 ${command} 命令`));
      return;
    }

    let stdout = '';
    let stderr = '';
    const heartbeatIntervalMs = 10000;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

    const clearHeartbeat = (): void => {
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const resetHeartbeat = (): void => {
      if (!options.onHeartbeat) return;
      clearHeartbeat();
      heartbeatTimer = setTimeout(() => {
        options.onHeartbeat?.('仍在处理中，可能在同步大文件，期间无新日志');
        resetHeartbeat();
      }, heartbeatIntervalMs);
    };

    resetHeartbeat();

    if (proc.stdout) {
      proc.stdout.on('data', (data: Buffer) => {
        resetHeartbeat();
        const chunk = data.toString();
        stdout += chunk;
        const message = chunk.trim();
        if (message && options.onProgress && options.forwardStdout !== false) {
          options.onProgress(message);
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        resetHeartbeat();
        stderr += data.toString();
      });
    }

    proc.on('error', (err) => {
      clearHeartbeat();
      reject(new Error(`无法执行 ${command} 命令: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearHeartbeat();
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const errorMsg = stderr.trim() || `${command} 命令执行失败，退出码: ${code}`;
        reject(new Error(errorMsg));
      }
    });
  });
}

export default {
  isCodepacInstalled,
  getVersion,
  install,
  installSingle,
  update,
  downloadToTemp,
};
