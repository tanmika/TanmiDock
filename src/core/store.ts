/**
 * Store 存储操作
 * Store 目录结构: {storePath}/{libName}/{commit}/{platform}/
 */
import fs from 'fs/promises';
import path from 'path';
import * as config from './config.js';
import { withFileLock } from '../utils/lock.js';
import { copyDir, getDirSize, copyDirWithProgress, removeDir } from '../utils/fs-utils.js';
import { KNOWN_PLATFORM_VALUES, GENERAL_PLATFORM } from './platform.js';

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
  platformPaths: Record<string, string>;  // { macOS: "Store/.../macOS", android: "..." } 新增的平台
  sharedPath: string;                     // Store/.../_shared
  skippedPlatforms: string[];             // 已存在而跳过的平台
}

/**
 * absorbLib 进度回调选项
 */
export interface AbsorbProgressOptions {
  /** 进度回调 (copiedBytes, totalBytes, currentItem) => void */
  onProgress?: (copiedBytes: number, totalBytes: number, currentItem: string) => void;
  /** 预计总大小 (bytes)，用于计算进度百分比 */
  totalSize?: number;
}

/**
 * 平台完整性检查结果
 */
export interface PlatformCompletenessResult {
  existing: string[];   // Store 中已有的平台
  missing: string[];    // Store 中缺失的平台
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
 * 当 platform 为 'general' 时，检查 _shared 目录是否存在且有内容
 */
export async function exists(libName: string, commit: string, platform: string): Promise<boolean> {
  try {
    const storePath = await getStorePath();

    if (platform === GENERAL_PLATFORM) {
      // General 库检查 _shared 目录是否存在且有内容
      const sharedPath = path.join(storePath, libName, commit, '_shared');
      await fs.access(sharedPath);
      const entries = await fs.readdir(sharedPath);
      return entries.length > 0; // 空目录视为不存在
    }

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
 * 跨文件系统安全移动目录
 * 先尝试 rename，失败时回退到 copy + delete
 *
 * @param sourcePath 源路径
 * @param targetPath 目标路径
 * @param progressOptions 进度回调选项（用于跨文件系统复制时）
 * @returns 是否使用了复制模式（跨文件系统）
 */
async function safeMoveDir(
  sourcePath: string,
  targetPath: string,
  progressOptions?: {
    onProgress?: (copiedBytes: number, totalBytes: number) => void;
    totalSize?: number;
  }
): Promise<boolean> {
  try {
    await fs.rename(sourcePath, targetPath);
    return false; // 使用 rename，非跨文件系统
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EXDEV') {
      // 跨文件系统，回退到复制 + 删除
      const totalSize = progressOptions?.totalSize ?? 0;
      if (progressOptions?.onProgress && totalSize > 0) {
        await copyDirWithProgress(sourcePath, targetPath, totalSize, progressOptions.onProgress);
      } else {
        await copyDir(sourcePath, targetPath);
      }
      await removeDir(sourcePath);
      return true; // 使用了复制模式
    }
    throw err;
  }
}

/**
 * 将库目录吸收到 Store 中（新版多平台支持）
 *
 * 遍历 libDir 内容，根据 KNOWN_PLATFORM_VALUES 判断:
 * - 平台目录 → 移动到 Store/.../平台名/
 * - 共享内容 → 移动到 Store/.../_shared/
 *
 * 当源和目标跨文件系统时（EXDEV），自动回退到复制+删除模式。
 *
 * @param libDir 源库目录路径 (tempDir/libName 或 3rdParty/libXxx)
 * @param platforms 要吸收的平台目录名列表
 * @param libName 库名
 * @param commit commit hash
 * @param progressOptions 进度回调选项（可选）
 * @returns AbsorbResult 包含 platformPaths 和 sharedPath
 */
export async function absorbLib(
  libDir: string,
  platforms: string[],
  libName: string,
  commit: string,
  progressOptions?: AbsorbProgressOptions
): Promise<AbsorbResult> {
  const storePath = await getStorePath();
  const baseDir = path.join(storePath, libName, commit);
  const sharedPath = path.join(baseDir, '_shared');

  // 确保基础目录和 _shared 目录存在
  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(sharedPath, { recursive: true });

  const platformPaths: Record<string, string> = {};
  const skippedPlatforms: string[] = [];

  // 跟踪已移动的文件，用于失败时回滚
  const movedFiles: Array<{ source: string; target: string }> = [];

  // 回滚函数：将已移动的文件移回原位置
  const rollbackMoves = async () => {
    for (const { source, target } of movedFiles.reverse()) {
      try {
        await fs.rename(target, source);
      } catch {
        // 回滚失败时忽略，尽力而为
      }
    }
  };

  // 读取 libDir 内容
  const entries = await fs.readdir(libDir, { withFileTypes: true });

  try {
    for (const entry of entries) {
      const sourcePath = path.join(libDir, entry.name);

      if (entry.isDirectory() && KNOWN_PLATFORM_VALUES.includes(entry.name)) {
        // 平台目录: 只移动用户选择的平台
        if (platforms.includes(entry.name)) {
          const targetPath = path.join(baseDir, entry.name);

          // 检查目标目录是否已存在
          try {
            await fs.access(targetPath);
            // 已存在，跳过移动
            skippedPlatforms.push(entry.name);
            continue;
          } catch {
            // 不存在，继续移动
          }

          try {
            // 使用 safeMoveDir 处理跨文件系统情况
            await safeMoveDir(sourcePath, targetPath, {
              onProgress: progressOptions?.onProgress
                ? (copied, total) => progressOptions.onProgress!(copied, total, entry.name)
                : undefined,
              totalSize: progressOptions?.totalSize,
            });
            platformPaths[entry.name] = targetPath;
            movedFiles.push({ source: sourcePath, target: targetPath });
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOTEMPTY' || code === 'EEXIST') {
              // 竞态条件：检查时不存在，移动时已存在，跳过
              skippedPlatforms.push(entry.name);
              continue;
            }
            throw err;
          }
        }
        // 非选择的平台目录不移动，保留在原位置
      } else {
        // 共享文件/目录: 移动到 _shared
        const targetPath = path.join(sharedPath, entry.name);

        // 检查目标是否已存在
        try {
          await fs.access(targetPath);
          // 已存在，跳过移动
          continue;
        } catch {
          // 不存在，继续移动
        }

        try {
          // 使用 safeMoveDir 处理跨文件系统情况（共享内容不传进度回调）
          if (entry.isDirectory()) {
            await safeMoveDir(sourcePath, targetPath);
          } else {
            // 文件直接 rename，失败时复制+删除
            try {
              await fs.rename(sourcePath, targetPath);
            } catch (renameErr) {
              if ((renameErr as NodeJS.ErrnoException).code === 'EXDEV') {
                await fs.copyFile(sourcePath, targetPath);
                await fs.unlink(sourcePath);
              } else {
                throw renameErr;
              }
            }
          }
          movedFiles.push({ source: sourcePath, target: targetPath });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOTEMPTY' || code === 'EEXIST') {
            // 竞态条件：检查时不存在，移动时已存在，跳过
            continue;
          }
          throw err;
        }
      }
    }
  } catch (err) {
    // 发生错误时回滚已移动的文件
    await rollbackMoves();
    throw err;
  }

  return {
    platformPaths,
    sharedPath,
    skippedPlatforms,
  };
}

/**
 * 吸收 General 库到 Store（整个内容移到 _shared）
 * 用于没有 sparse 配置的源码库
 * @param libDir 下载的库目录
 * @param libName 库名
 * @param commit commit hash
 */
export async function absorbGeneral(
  libDir: string,
  libName: string,
  commit: string
): Promise<string> {
  const storePath = await getStorePath();
  const baseDir = path.join(storePath, libName, commit);
  const sharedPath = path.join(baseDir, '_shared');

  // 确保基础目录存在
  await fs.mkdir(baseDir, { recursive: true });

  // 检查 _shared 是否已存在
  try {
    await fs.access(sharedPath);
    // 已存在，跳过
    return sharedPath;
  } catch {
    // 不存在，继续
  }

  // 直接把整个 libDir 移动到 _shared
  try {
    await fs.rename(libDir, sharedPath);
  } catch (renameErr) {
    if ((renameErr as NodeJS.ErrnoException).code === 'EXDEV') {
      // 跨文件系统，使用 safeMoveDir
      await safeMoveDir(libDir, sharedPath);
    } else {
      throw renameErr;
    }
  }

  return sharedPath;
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
 * 当 platform 为 'general' 时，删除整个 commit 目录（包含 _shared）
 */
export async function remove(libName: string, commit: string, platform: string): Promise<void> {
  const storePath = await getStorePath();
  const commitDir = path.join(storePath, libName, commit);

  if (platform === GENERAL_PLATFORM) {
    // General 库：直接删除整个 commit 目录
    await fs.rm(commitDir, { recursive: true, force: true });
  } else {
    // 平台库：只删除平台目录
    const libPath = getLibraryPath(storePath, libName, commit, platform);
    await fs.rm(libPath, { recursive: true, force: true });

    // 检查 commit 目录是否可以清理
    try {
      const remaining = await fs.readdir(commitDir);
      // 如果只剩 _shared 或完全为空，删除整个 commit 目录
      const hasOnlyShared = remaining.length === 1 && remaining[0] === '_shared';
      if (remaining.length === 0 || hasOnlyShared) {
        await fs.rm(commitDir, { recursive: true, force: true });
      }
    } catch {
      // 目录可能已不存在
    }
  }

  // 如果 lib 目录为空，也删除
  const libDir = path.join(storePath, libName);
  try {
    const libRemaining = await fs.readdir(libDir);
    if (libRemaining.length === 0) {
      await fs.rmdir(libDir);
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

/**
 * 检查 Store 中指定 lib/commit 的平台完整性
 *
 * 遍历请求的平台数组，检查每个平台目录是否存在于 Store 中，
 * 返回已存在和缺失的平台列表。
 *
 * @param libName 库名
 * @param commit commit hash
 * @param platforms 要检查的平台列表
 * @returns PlatformCompletenessResult 包含 existing 和 missing 数组
 */
export async function checkPlatformCompleteness(
  libName: string,
  commit: string,
  platforms: string[]
): Promise<PlatformCompletenessResult> {
  // 空数组直接返回
  if (platforms.length === 0) {
    return { existing: [], missing: [] };
  }

  const storePath = await getStorePath();
  const commitPath = getCommitPath(storePath, libName, commit);

  const existing: string[] = [];
  const missing: string[] = [];

  for (const platform of platforms) {
    const platformPath = path.join(commitPath, platform);
    try {
      await fs.access(platformPath);
      existing.push(platform);
    } catch {
      missing.push(platform);
    }
  }

  return { existing, missing };
}

/**
 * 检测 Store 中的库是否为 General 类型
 * 条件：有 _shared 目录（且有内容）且 无任何已知平台目录
 */
export async function isGeneralLib(libName: string, commit: string): Promise<boolean> {
  const storePath = await getStorePath();
  const commitPath = path.join(storePath, libName, commit);

  try {
    const entries = await fs.readdir(commitPath, { withFileTypes: true });
    const hasShared = entries.some(e => e.isDirectory() && e.name === '_shared');
    if (!hasShared) return false;

    // 检查 _shared 目录是否有内容（空目录不算 General 库）
    const sharedPath = path.join(commitPath, '_shared');
    const sharedEntries = await fs.readdir(sharedPath);
    if (sharedEntries.length === 0) return false;

    // KNOWN_PLATFORM_VALUES 已在文件顶部静态导入
    const hasPlatform = entries.some(e =>
      e.isDirectory() && KNOWN_PLATFORM_VALUES.includes(e.name)
    );

    return !hasPlatform;
  } catch {
    return false;
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
  checkPlatformCompleteness,
  isGeneralLib,
};
