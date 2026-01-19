/**
 * 全局操作锁
 * 防止多个 tanmi-dock 命令同时执行导致冲突
 */
import lockfile from 'proper-lockfile';
import fs from 'fs/promises';
import path from 'path';
import { getConfigDir } from '../core/platform.js';

const LOCK_FILE = 'tanmi-dock.lock';

let globalLockRelease: (() => Promise<void>) | null = null;

/**
 * 获取锁文件路径
 */
function getLockPath(): string {
  return path.join(getConfigDir(), LOCK_FILE);
}

/**
 * 获取全局锁
 * @returns 是否成功获取锁
 */
export async function acquireGlobalLock(): Promise<boolean> {
  const lockPath = getLockPath();

  try {
    // 确保配置目录和锁文件存在
    const dir = path.dirname(lockPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(lockPath, '', { flag: 'a' }); // 追加模式，文件存在则不覆盖

    globalLockRelease = await lockfile.lock(lockPath, {
      retries: 0, // 不重试，立即失败
      stale: 30000, // 30秒后锁过期（防止进程异常退出后锁不释放）
    });
    return true;
  } catch {
    return false; // 已有其他进程持有锁
  }
}

/**
 * 释放全局锁
 */
export async function releaseGlobalLock(): Promise<void> {
  if (globalLockRelease) {
    try {
      await globalLockRelease();
    } catch {
      // 忽略释放失败（可能锁已过期）
    }
    globalLockRelease = null;
  }
}

/**
 * 检查全局锁状态
 */
export async function isGlobalLocked(): Promise<boolean> {
  const lockPath = getLockPath();
  try {
    await fs.access(lockPath);
    return await lockfile.check(lockPath);
  } catch {
    return false;
  }
}

/**
 * 使用全局锁执行操作
 * @param fn 要执行的操作
 * @returns 操作返回值
 * @throws 如果无法获取锁
 */
export async function withGlobalLock<T>(fn: () => Promise<T>): Promise<T> {
  const acquired = await acquireGlobalLock();
  if (!acquired) {
    throw new Error('另一个 tanmi-dock 命令正在执行，请稍后重试');
  }
  try {
    return await fn();
  } finally {
    await releaseGlobalLock();
  }
}

export default {
  acquireGlobalLock,
  releaseGlobalLock,
  isGlobalLocked,
  withGlobalLock,
};
