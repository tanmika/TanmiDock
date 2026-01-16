/**
 * 文件锁工具
 * 防止多进程并发写入导致数据损坏
 */
import lockfile from 'proper-lockfile';
import fs from 'fs/promises';
import path from 'path';

export interface LockOptions {
  /** 获取锁失败时的重试次数 (默认 3) */
  retries?: number;
  /** 锁过期时间 ms (默认 10000) */
  stale?: number;
  /** 重试间隔 ms (默认 100) */
  retryWait?: number;
}

const DEFAULT_OPTIONS: Required<LockOptions> = {
  retries: 3,
  stale: 10000,
  retryWait: 100,
};

/**
 * 使用文件锁执行操作
 * @param filePath 要锁定的文件路径
 * @param fn 要执行的操作
 * @param options 锁配置选项
 * @returns 操作返回值
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options?: LockOptions
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // 确保文件存在（proper-lockfile 需要文件存在）
  await ensureFileExists(filePath);

  const release = await lockfile.lock(filePath, {
    retries: {
      retries: opts.retries,
      minTimeout: opts.retryWait,
      maxTimeout: opts.retryWait * 2,
    },
    stale: opts.stale,
  });

  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch {
      // 忽略释放失败（锁可能已过期或被删除）
    }
  }
}

/**
 * 检查文件是否被锁定
 */
export async function isLocked(filePath: string): Promise<boolean> {
  try {
    return await lockfile.check(filePath);
  } catch {
    return false;
  }
}

/**
 * 确保文件存在（锁定需要文件存在）
 */
async function ensureFileExists(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    // 文件不存在，创建空文件
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, '', 'utf-8');
  }
}

export default {
  withFileLock,
  isLocked,
};
