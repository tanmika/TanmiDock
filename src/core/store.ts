/**
 * Store 存储操作
 * Store 目录结构: {storePath}/{libName}/{commit}/{platform}/
 */
import fs from 'fs/promises';
import path from 'path';
import * as config from './config.js';
import { withFileLock } from '../utils/lock.js';
import { copyDir, getDirSize } from '../utils/fs-utils.js';

/**
 * 获取库在 Store 中的路径
 */
export function getLibraryPath(storePath: string, libName: string, commit: string, platform: string): string {
  return path.join(storePath, libName, commit, platform);
}

/**
 * 获取当前配置的 Store 路径
 */
export async function getStorePath(): Promise<string> {
  const storePath = await config.getStorePath();
  if (!storePath) {
    throw new Error('Store 路径未配置，请先运行 tanmi-dock init');
  }
  return storePath;
}

/**
 * 检查库是否存在于 Store 中
 */
export async function exists(libName: string, commit: string, platform: string): Promise<boolean> {
  try {
    const storePath = await getStorePath();
    const libPath = getLibraryPath(storePath, libName, commit, platform);
    await fs.access(libPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取库的完整路径
 */
export async function getPath(libName: string, commit: string, platform: string): Promise<string | null> {
  const storePath = await getStorePath();
  const libPath = getLibraryPath(storePath, libName, commit, platform);
  try {
    await fs.access(libPath);
    return libPath;
  } catch {
    return null;
  }
}

/**
 * 将本地库目录移入 Store (absorb)
 * 使用原子重命名 + 错误处理，避免 TOCTOU 竞态条件
 * @param sourcePath 源目录路径
 * @param libName 库名
 * @param commit commit hash
 * @param platform 平台名
 * @returns Store 中的库路径
 */
export async function absorb(sourcePath: string, libName: string, commit: string, platform: string): Promise<string> {
  const storePath = await getStorePath();
  const targetPath = getLibraryPath(storePath, libName, commit, platform);

  // 确保目标父目录存在
  const parentDir = path.dirname(targetPath);
  await fs.mkdir(parentDir, { recursive: true });

  // 直接尝试重命名，让文件系统保证原子性
  // 如果目标已存在，rename 会失败并返回 ENOTEMPTY 或 EEXIST
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      throw new Error(`库已存在于 Store 中: ${libName}@${commit.slice(0, 7)}/${platform}`);
    }
    throw err;
  }

  return targetPath;
}

/**
 * 复制库到 Store（不删除源目录）
 * 使用文件锁保护检查-创建操作，避免 TOCTOU 竞态条件
 */
export async function copy(sourcePath: string, libName: string, commit: string, platform: string): Promise<string> {
  const storePath = await getStorePath();
  const targetPath = getLibraryPath(storePath, libName, commit, platform);

  // 确保目标父目录存在
  const parentDir = path.dirname(targetPath);
  await fs.mkdir(parentDir, { recursive: true });

  // 使用文件锁保护检查和复制操作
  // 锁定父目录，防止并发复制同一库
  await withFileLock(parentDir, async () => {
    // 检查目标是否已存在（在锁内检查，安全）
    try {
      await fs.access(targetPath);
      throw new Error(`库已存在于 Store 中: ${libName}@${commit.slice(0, 7)}/${platform}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    // 递归复制目录（在锁内执行，安全）
    await copyDir(sourcePath, targetPath);
  });

  return targetPath;
}

/**
 * 从 Store 中删除库
 */
export async function remove(libName: string, commit: string, platform: string): Promise<void> {
  const storePath = await getStorePath();
  const libPath = getLibraryPath(storePath, libName, commit, platform);

  await fs.rm(libPath, { recursive: true, force: true });

  // 如果 commit 目录为空，也删除
  const commitDir = path.dirname(libPath);
  try {
    const remaining = await fs.readdir(commitDir);
    if (remaining.length === 0) {
      await fs.rmdir(commitDir);
      // 如果 lib 目录也为空，也删除
      const libDir = path.dirname(commitDir);
      const libRemaining = await fs.readdir(libDir);
      if (libRemaining.length === 0) {
        await fs.rmdir(libDir);
      }
    }
  } catch {
    // 目录可能已不存在
  }
}

/**
 * 获取库占用空间 (bytes)
 */
export async function getSize(libName: string, commit: string, platform: string): Promise<number> {
  const storePath = await getStorePath();
  const libPath = getLibraryPath(storePath, libName, commit, platform);

  return getDirSize(libPath);
}

/**
 * 获取 Store 总大小
 */
export async function getTotalSize(): Promise<number> {
  const storePath = await getStorePath();
  return getDirSize(storePath);
}

/**
 * 列出 Store 中所有库
 */
export async function listLibraries(): Promise<
  Array<{ libName: string; commit: string; platform: string; path: string }>
> {
  const storePath = await getStorePath();
  const libraries: Array<{ libName: string; commit: string; platform: string; path: string }> = [];

  try {
    const libDirs = await fs.readdir(storePath, { withFileTypes: true });

    for (const libDir of libDirs) {
      if (!libDir.isDirectory()) continue;

      const libPath = path.join(storePath, libDir.name);
      const commits = await fs.readdir(libPath, { withFileTypes: true });

      for (const commitDir of commits) {
        if (!commitDir.isDirectory()) continue;

        const commitPath = path.join(libPath, commitDir.name);
        const platforms = await fs.readdir(commitPath, { withFileTypes: true });

        for (const platformDir of platforms) {
          if (!platformDir.isDirectory()) continue;

          libraries.push({
            libName: libDir.name,
            commit: commitDir.name,
            platform: platformDir.name,
            path: path.join(commitPath, platformDir.name),
          });
        }
      }
    }
  } catch {
    // Store 目录不存在
  }

  return libraries;
}

/**
 * 验证平台目录是否有有效内容
 * @returns true 有内容，false 为空或只有隐藏文件
 */
export async function validatePlatform(
  libName: string,
  commit: string,
  platform: string
): Promise<boolean> {
  const platformPath = await getPath(libName, commit, platform);
  if (!platformPath) return false;

  try {
    const entries = await fs.readdir(platformPath);
    // 过滤隐藏文件
    const visible = entries.filter(e => !e.startsWith('.'));
    return visible.length > 0;
  } catch {
    return false;
  }
}

/**
 * 确保 Store 目录存在
 */
export async function ensureStoreDir(): Promise<void> {
  const storePath = await getStorePath();
  await fs.mkdir(storePath, { recursive: true });
}

export default {
  getLibraryPath,
  getStorePath,
  exists,
  getPath,
  absorb,
  copy,
  remove,
  getSize,
  getTotalSize,
  listLibraries,
  validatePlatform,
  ensureStoreDir,
};
