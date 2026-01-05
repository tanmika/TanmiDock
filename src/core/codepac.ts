/**
 * codepac 命令封装
 * 提供对 codepac CLI 工具的调用接口
 */
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

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
  /** 进度回调 */
  onProgress?: (message: string) => void;
  /** 是否静默模式 */
  silent?: boolean;
}

/**
 * 使用 codepac 安装依赖
 */
export async function install(options: InstallOptions): Promise<void> {
  const { configPath, targetDir, onProgress, silent } = options;

  // 检查 codepac 是否安装
  if (!(await isCodepacInstalled())) {
    throw new Error('codepac 未安装，请先安装 codepac 工具');
  }

  // 构建命令参数
  const args = ['install', '-c', configPath, '-d', targetDir];

  return new Promise((resolve, reject) => {
    const proc = spawn(CODEPAC_CMD, args, {
      cwd: path.dirname(configPath),
      stdio: silent ? 'ignore' : 'pipe',
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
  const { url, commit, branch, targetDir, sparse, onProgress, silent } = options;

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

  // 构建命令参数
  const args = ['update', '-c', configPath, '-d', targetDir];
  if (libName) {
    args.push('-n', libName);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(CODEPAC_CMD, args, {
      cwd: path.dirname(configPath),
      stdio: 'pipe',
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

export default {
  isCodepacInstalled,
  getVersion,
  install,
  installSingle,
  update,
};
