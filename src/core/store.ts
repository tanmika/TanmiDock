/**
 * Store 存储操作
 * Store 目录结构: {storePath}/{libName}/{commit}/{platform}/
 */
import fs from 'fs/promises';
import path from 'path';
import * as config from './config.js';
import { withFileLock } from '../utils/lock.js';
import { copyDir, getDirSize } from '../utils/fs-utils.js';
import { KNOWN_PLATFORM_VALUES } from './platform.js';

/**
 * Store 版本类型
 * - v0.5: 旧版结构，双层平台目录
 * - v0.6: 新版结构，单层平台目录 + _shared
 * - unknown: 未知或空目录
 */
export type StoreVersion = 'v0.5' | 'v0.6' | 'unknown';

/**
 * absorbLib 返回结果
 */
export interface AbsorbResult {
  platformPaths: Record<string, string>;  // { macOS: "Store/.../macOS", android: "..." }
  sharedPath: string;                     // Store/.../_shared
}

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
 * @deprecated 使用 absorbLib 替代
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
 * 将库目录吸收到 Store 中（新版多平台支持）
 *
 * 遍历 libDir 内容，根据 KNOWN_PLATFORM_VALUES 判断:
 * - 平台目录 → 移动到 Store/.../平台名/
 * - 共享内容 → 移动到 Store/.../_shared/
 *
 * @param libDir 源库目录路径 (tempDir/libName 或 3rdParty/libXxx)
 * @param platforms 要吸收的平台目录名列表
 * @param libName 库名
 * @param commit commit hash
 * @returns AbsorbResult 包含 platformPaths 和 sharedPath
 */
export async function absorbLib(
  libDir: string,
  platforms: string[],
  libName: string,
  commit: string
): Promise<AbsorbResult> {
  const storePath = await getStorePath();
  const baseDir = path.join(storePath, libName, commit);
  const sharedPath = path.join(baseDir, '_shared');

  // 确保基础目录和 _shared 目录存在
  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(sharedPath, { recursive: true });

  const platformPaths: Record<string, string> = {};

  // 读取 libDir 内容
  const entries = await fs.readdir(libDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(libDir, entry.name);

    if (entry.isDirectory() && KNOWN_PLATFORM_VALUES.includes(entry.name)) {
      // 平台目录: 只移动用户选择的平台
      if (platforms.includes(entry.name)) {
        const targetPath = path.join(baseDir, entry.name);

        try {
          await fs.rename(sourcePath, targetPath);
          platformPaths[entry.name] = targetPath;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOTEMPTY' || code === 'EEXIST') {
            throw new Error(`平台目录已存在于 Store 中: ${libName}@${commit.slice(0, 7)}/${entry.name}`);
          }
          throw err;
        }
      }
      // 非选择的平台目录不移动，保留在原位置
    } else {
      // 共享文件/目录: 移动到 _shared
      const targetPath = path.join(sharedPath, entry.name);

      try {
        await fs.rename(sourcePath, targetPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOTEMPTY' || code === 'EEXIST') {
          throw new Error(`共享文件已存在于 Store 中: ${libName}@${commit.slice(0, 7)}/_shared/${entry.name}`);
        }
        throw err;
      }
    }
  }

  return {
    platformPaths,
    sharedPath,
  };
}

/**
 * @deprecated 不再需要，使用 absorbLib 替代
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

/**
 * 获取 commit 路径（辅助函数）
 * @param storePath Store 根目录路径
 * @param libName 库名
 * @param commit commit hash
 * @returns commit 目录路径
 */
export function getCommitPath(storePath: string, libName: string, commit: string): string {
  return path.join(storePath, libName, commit);
}

/**
 * 检测 Store 版本
 *
 * 检测逻辑:
 * - 存在 _shared 目录 → v0.6
 * - 存在双层平台目录 (platform/platform) → v0.5
 * - 其他情况 → unknown
 *
 * @param commitPath commit 目录路径
 * @returns Store 版本
 */
export async function detectStoreVersion(commitPath: string): Promise<StoreVersion> {
  // 检查目录是否存在
  try {
    await fs.access(commitPath);
  } catch {
    return 'unknown';
  }

  // 检查 _shared 目录 → v0.6
  const sharedPath = path.join(commitPath, '_shared');
  try {
    await fs.access(sharedPath);
    return 'v0.6';
  } catch {
    // _shared 不存在，继续检查
  }

  // 检查是否有双层平台目录 → v0.5
  for (const platform of KNOWN_PLATFORM_VALUES) {
    const innerPath = path.join(commitPath, platform, platform);
    try {
      await fs.access(innerPath);
      return 'v0.5';
    } catch {
      // 继续检查下一个平台
    }
  }

  return 'unknown';
}

/**
 * 确保 Store 兼容性
 *
 * 检测指定库的 Store 版本，如果是 v0.5 旧版结构则抛出错误，
 * 提示用户删除后重新 link。
 *
 * @param storePath Store 根目录路径
 * @param libName 库名
 * @param commit commit hash
 * @throws Error 当检测到 v0.5 旧版结构时
 */
export async function ensureCompatibleStore(
  storePath: string,
  libName: string,
  commit: string
): Promise<void> {
  const commitPath = getCommitPath(storePath, libName, commit);

  // 检查目录是否存在
  try {
    await fs.access(commitPath);
  } catch {
    // 目录不存在，新库无需检测
    return;
  }

  const version = await detectStoreVersion(commitPath);

  if (version === 'v0.5') {
    throw new Error(
      `Store 结构不兼容 (v0.5)\n` +
      `库: ${libName}@${commit.slice(0, 7)}\n` +
      `请删除后重新 link:\n` +
      `  rm -rf "${commitPath}"\n` +
      `  tanmi-dock link`
    );
  }
}

export default {
  getLibraryPath,
  getStorePath,
  exists,
  getPath,
  absorb,
  absorbLib,
  copy,
  remove,
  getSize,
  getTotalSize,
  listLibraries,
  validatePlatform,
  ensureStoreDir,
  getCommitPath,
  detectStoreVersion,
  ensureCompatibleStore,
};
