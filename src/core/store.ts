/**
 * Store 存储操作
 * Store 目录结构: {storePath}/{libName}/{commit}/
 */
import fs from 'fs/promises';
import path from 'path';
import * as config from './config.js';

/**
 * 获取库在 Store 中的路径
 */
export function getLibraryPath(storePath: string, libName: string, commit: string): string {
  return path.join(storePath, libName, commit);
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
export async function exists(libName: string, commit: string): Promise<boolean> {
  try {
    const storePath = await getStorePath();
    const libPath = getLibraryPath(storePath, libName, commit);
    await fs.access(libPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取库的完整路径
 */
export async function getPath(libName: string, commit: string): Promise<string | null> {
  const storePath = await getStorePath();
  const libPath = getLibraryPath(storePath, libName, commit);
  try {
    await fs.access(libPath);
    return libPath;
  } catch {
    return null;
  }
}

/**
 * 将本地库目录移入 Store (absorb)
 * @param sourcePath 源目录路径
 * @param libName 库名
 * @param commit commit hash
 * @returns Store 中的库路径
 */
export async function absorb(sourcePath: string, libName: string, commit: string): Promise<string> {
  const storePath = await getStorePath();
  const targetPath = getLibraryPath(storePath, libName, commit);

  // 确保目标父目录存在
  const parentDir = path.dirname(targetPath);
  await fs.mkdir(parentDir, { recursive: true });

  // 检查目标是否已存在
  try {
    await fs.access(targetPath);
    throw new Error(`库已存在于 Store 中: ${libName}@${commit.slice(0, 7)}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  // 移动目录
  await fs.rename(sourcePath, targetPath);

  return targetPath;
}

/**
 * 复制库到 Store（不删除源目录）
 */
export async function copy(sourcePath: string, libName: string, commit: string): Promise<string> {
  const storePath = await getStorePath();
  const targetPath = getLibraryPath(storePath, libName, commit);

  // 确保目标父目录存在
  const parentDir = path.dirname(targetPath);
  await fs.mkdir(parentDir, { recursive: true });

  // 检查目标是否已存在
  try {
    await fs.access(targetPath);
    throw new Error(`库已存在于 Store 中: ${libName}@${commit.slice(0, 7)}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  // 递归复制目录
  await copyDir(sourcePath, targetPath);

  return targetPath;
}

/**
 * 递归复制目录
 */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * 从 Store 中删除库
 */
export async function remove(libName: string, commit: string): Promise<void> {
  const storePath = await getStorePath();
  const libPath = getLibraryPath(storePath, libName, commit);

  await fs.rm(libPath, { recursive: true, force: true });

  // 如果库目录为空，也删除
  const libDir = path.dirname(libPath);
  try {
    const remaining = await fs.readdir(libDir);
    if (remaining.length === 0) {
      await fs.rmdir(libDir);
    }
  } catch {
    // 目录可能已不存在
  }
}

/**
 * 获取库占用空间 (bytes)
 */
export async function getSize(libName: string, commit: string): Promise<number> {
  const storePath = await getStorePath();
  const libPath = getLibraryPath(storePath, libName, commit);

  return getDirSize(libPath);
}

/**
 * 递归计算目录大小
 */
async function getDirSize(dirPath: string): Promise<number> {
  let size = 0;

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        size += await getDirSize(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        size += stat.size;
      }
    }
  } catch {
    // 目录不存在或无法访问
  }

  return size;
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
export async function listLibraries(): Promise<Array<{ libName: string; commit: string; path: string }>> {
  const storePath = await getStorePath();
  const libraries: Array<{ libName: string; commit: string; path: string }> = [];

  try {
    const libDirs = await fs.readdir(storePath, { withFileTypes: true });

    for (const libDir of libDirs) {
      if (!libDir.isDirectory()) continue;

      const libPath = path.join(storePath, libDir.name);
      const commits = await fs.readdir(libPath, { withFileTypes: true });

      for (const commitDir of commits) {
        if (!commitDir.isDirectory()) continue;

        libraries.push({
          libName: libDir.name,
          commit: commitDir.name,
          path: path.join(libPath, commitDir.name),
        });
      }
    }
  } catch {
    // Store 目录不存在
  }

  return libraries;
}

/**
 * 获取库的已下载平台目录列表
 */
export async function getPlatforms(libName: string, commit: string): Promise<string[]> {
  const storePath = await getStorePath();
  const libPath = getLibraryPath(storePath, libName, commit);
  const platforms: string[] = [];

  try {
    const entries = await fs.readdir(libPath, { withFileTypes: true });

    for (const entry of entries) {
      // 排除 .git 和其他隐藏目录
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        platforms.push(entry.name);
      }
    }
  } catch {
    // 目录不存在
  }

  return platforms;
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
  getPlatforms,
  ensureStoreDir,
};
