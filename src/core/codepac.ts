/**
 * codepac 命令封装
 * 提供对 codepac CLI 工具的调用接口
 */
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { isPlatformDir, normalizePlatformValue, getBaseKeyForCodepac } from './platform.js';
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
  /** 进度回调 */
  onProgress?: (msg: string) => void;
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
  /** 实际保留的平台目录名（用户请求的） */
  platformDirs: string[];
  /** 共享文件列表 */
  sharedFiles: string[];
  /** 被清理的平台目录名（codepac 下载了但用户未请求的） */
  cleanedPlatforms: string[];
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
  const { url, commit, branch, libName, platforms, sparse, vars, onProgress, onTempDirCreated } = options;

  // 检查 codepac 是否安装
  if (!(await isCodepacInstalled())) {
    throw new Error('codepac 未安装，请先安装 codepac 工具');
  }

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

    // 构建 codepac 命令参数
    // 关键: codepac -p 需要基础 CLI key (mac/ios/android)
    // 无论用户请求 macOS 还是 macOS-asan，都传 mac 给 codepac
    // codepac 会下载所有变体，之后我们做清理
    const baseKeys = [...new Set(platforms.map(getBaseKeyForCodepac))];
    const args = ['install', '-cf', configPath, '-td', tempDir, '-p', ...baseKeys];

    // 调用 codepac
    await spawnCodepac(args, tempDir, onProgress);

    // 分析下载结果，区分平台目录和共享文件
    const entries = await fs.readdir(libDir, { withFileTypes: true });

    const downloadedPlatforms: string[] = [];
    const sharedFiles: string[] = [];

    for (const entry of entries) {
      const name = entry.name;
      if (isPlatformDir(name)) {
        // 标准化平台目录名（例如 "macos" -> "macOS"）
        downloadedPlatforms.push(normalizePlatformValue(name));
      } else {
        sharedFiles.push(name);
      }
    }

    // 后处理：清理用户未请求的平台目录
    // 例如用户只请求 macOS，但 codepac 下载了 macOS 和 macOS-asan
    const requestedSet = new Set(platforms);
    const platformDirs: string[] = [];
    const cleanedPlatforms: string[] = [];

    for (const platform of downloadedPlatforms) {
      if (requestedSet.has(platform)) {
        // 用户请求的平台，保留
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
      platformDirs,
      sharedFiles,
      cleanedPlatforms,
    };
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

/**
 * 内部辅助函数: 执行 codepac 命令
 */
function spawnCodepac(
  args: string[],
  cwd: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CODEPAC_CMD, args, {
      cwd,
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
        const errorMsg = stderr.trim() || `codepac 命令执行失败，退出码: ${code}`;
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
