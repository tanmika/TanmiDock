/**
 * 全局操作锁
 * 防止多个 tanmi-dock 命令同时执行导致冲突
 *
 * 改进：写入 PID 到锁文件，当持有锁的进程已死时立即清理残留锁，
 * 无需等待 stale 超时。解决进程被 kill/管道中断后锁残留的问题。
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
 * 检查指定 PID 的进程是否仍存活
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // 信号 0 不发送信号，仅检查进程是否存在
    return true;
  } catch {
    return false;
  }
}

/**
 * 从锁文件读取持有者 PID
 * @returns PID 或 null（无法读取/解析时）
 */
async function readHolderPid(lockPath: string): Promise<number | null> {
  try {
    const content = await fs.readFile(lockPath, 'utf-8');
    const pid = parseInt(content.trim(), 10);
    return isNaN(pid) || pid <= 0 ? null : pid;
  } catch {
    return null;
  }
}

/**
 * 强制清理残留的锁目录
 * proper-lockfile 使用 {file}.lock 目录作为实际锁
 */
async function forceCleanStaleLock(lockPath: string): Promise<void> {
  const lockDir = `${lockPath}.lock`;
  try {
    await fs.rm(lockDir, { recursive: true, force: true });
  } catch {
    // 清理失败不阻塞
  }
}

/**
 * 内部：尝试获取锁并写入 PID
 */
async function tryAcquire(lockPath: string): Promise<boolean> {
  globalLockRelease = await lockfile.lock(lockPath, {
    retries: 0,
    stale: 30000, // 30秒后锁过期（兜底机制）
  });
  // 获取成功后写入当前 PID，供其他进程检测
  await fs.writeFile(lockPath, String(process.pid), 'utf-8');
  return true;
}

/**
 * 获取全局锁
 * @returns 是否成功获取锁
 */
export async function acquireGlobalLock(): Promise<boolean> {
  const lockPath = getLockPath();

  // 确保配置目录和锁文件存在
  const dir = path.dirname(lockPath);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(lockPath);
  } catch {
    await fs.writeFile(lockPath, '', 'utf-8');
  }

  try {
    return await tryAcquire(lockPath);
  } catch {
    // 锁获取失败 → 检查持有者是否仍存活
    const holderPid = await readHolderPid(lockPath);
    if (holderPid !== null && !isProcessAlive(holderPid)) {
      // 持有者进程已死，清理残留锁并重试
      await forceCleanStaleLock(lockPath);
      try {
        return await tryAcquire(lockPath);
      } catch {
        return false;
      }
    }
    return false;
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
    const locked = await lockfile.check(lockPath);
    if (!locked) return false;

    // 锁存在，但检查持有者是否仍存活
    const holderPid = await readHolderPid(lockPath);
    if (holderPid !== null && !isProcessAlive(holderPid)) {
      return false; // 持有者已死，锁实际是残留的
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取锁的持有者信息（用于错误提示）
 */
async function getLockHolderInfo(): Promise<string> {
  const lockPath = getLockPath();
  const pid = await readHolderPid(lockPath);
  if (pid !== null) {
    return `(PID: ${pid})`;
  }
  return '';
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
    const holderInfo = await getLockHolderInfo();
    const lockDir = `${getLockPath()}.lock`;
    throw new Error(
      `另一个 tanmi-dock 命令正在执行${holderInfo}，请稍后重试\n` +
        `[hint] 如确认无其他命令运行，可手动清理: rm -rf "${lockDir}"`
    );
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
