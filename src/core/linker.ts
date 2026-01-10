/**
 * 符号链接操作
 * - macOS: 使用 symlink
 * - Windows: 使用 junction (无需管理员权限)
 */
import fs from 'fs/promises';
import path from 'path';
import { isWindows, KNOWN_PLATFORM_VALUES } from './platform.js';
import { copyDir } from '../utils/fs-utils.js';

/**
 * 创建符号链接
 * @param target 目标路径（链接指向的位置）
 * @param linkPath 链接路径（创建链接的位置）
 */
export async function link(target: string, linkPath: string): Promise<void> {
  // 确保父目录存在
  const parentDir = path.dirname(linkPath);
  await fs.mkdir(parentDir, { recursive: true });

  // Windows 使用 junction，macOS 使用 dir 类型的 symlink
  const type = isWindows() ? 'junction' : 'dir';
  await fs.symlink(target, linkPath, type);
}

/**
 * 检查路径是否为符号链接
 */
export async function isSymlink(linkPath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(linkPath);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 读取符号链接目标
 */
export async function readLink(linkPath: string): Promise<string | null> {
  try {
    return await fs.readlink(linkPath);
  } catch {
    return null;
  }
}

/**
 * 删除符号链接
 */
export async function unlink(linkPath: string): Promise<void> {
  // 在 Windows 上，junction 需要用 rmdir 删除
  // 但 fs.unlink 在 Node.js 中可以处理符号链接
  try {
    const stat = await fs.lstat(linkPath);
    if (stat.isSymbolicLink()) {
      await fs.unlink(linkPath);
    }
  } catch {
    // 链接不存在，忽略
  }
}

/**
 * 检查符号链接是否有效（目标存在）
 */
export async function isValidLink(linkPath: string): Promise<boolean> {
  try {
    // lstat 检查链接本身是否存在
    const lstat = await fs.lstat(linkPath);
    if (!lstat.isSymbolicLink()) {
      return false;
    }

    // stat 检查链接目标是否存在（会跟随链接）
    await fs.stat(linkPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查符号链接是否指向正确的目标
 */
export async function isCorrectLink(linkPath: string, expectedTarget: string): Promise<boolean> {
  const actualTarget = await readLink(linkPath);
  if (!actualTarget) {
    return false;
  }

  // 规范化路径后比较
  const normalizedActual = path.resolve(path.dirname(linkPath), actualTarget);
  const normalizedExpected = path.resolve(expectedTarget);

  return normalizedActual === normalizedExpected;
}

/**
 * 将普通目录替换为符号链接
 * @param dirPath 要替换的目录路径
 * @param target 链接目标
 * @param backup 是否备份原目录（默认删除）
 * @returns 备份路径（如果有）
 */
export async function replaceWithLink(
  dirPath: string,
  target: string,
  backup = false
): Promise<string | null> {
  // 检查是否已经是正确的链接
  if (await isCorrectLink(dirPath, target)) {
    return null;
  }

  // 如果是链接但指向错误，先删除
  if (await isSymlink(dirPath)) {
    await unlink(dirPath);
    await link(target, dirPath);
    return null;
  }

  // 检查目录是否存在
  try {
    const stat = await fs.lstat(dirPath);
    if (!stat.isDirectory()) {
      throw new Error(`路径不是目录: ${dirPath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // 目录不存在，直接创建链接
      await link(target, dirPath);
      return null;
    }
    throw err;
  }

  let backupPath: string | null = null;

  if (backup) {
    // 备份目录
    backupPath = `${dirPath}.backup.${Date.now()}`;
    await fs.rename(dirPath, backupPath);
  } else {
    // 删除目录
    await fs.rm(dirPath, { recursive: true, force: true });
  }

  // 创建链接
  await link(target, dirPath);

  return backupPath;
}

/**
 * 将符号链接还原为普通目录（从目标复制内容）
 */
export async function restoreFromLink(linkPath: string): Promise<void> {
  const target = await readLink(linkPath);
  if (!target) {
    throw new Error(`不是符号链接: ${linkPath}`);
  }

  // 获取绝对目标路径
  const absoluteTarget = path.resolve(path.dirname(linkPath), target);

  // 删除链接
  await unlink(linkPath);

  // 复制目标内容（保留符号链接）
  await copyDir(absoluteTarget, linkPath, { preserveSymlinks: true });
}

/**
 * 将多平台链接目录还原为普通目录
 * 遍历目录内容，将符号链接替换为真实目录，保留非链接文件
 */
export async function restoreMultiPlatform(localPath: string): Promise<void> {
  // 遍历目录内容
  const entries = await fs.readdir(localPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(localPath, entry.name);

    // 检查是否为符号链接
    if (await isSymlink(entryPath)) {
      // 读取链接目标
      const target = await readLink(entryPath);
      if (!target) {
        continue; // 无法读取目标，跳过
      }

      // 获取绝对目标路径
      const absoluteTarget = path.resolve(path.dirname(entryPath), target);

      // 删除符号链接
      await unlink(entryPath);

      // 复制目标内容到原位置（保留符号链接结构，如 macOS framework）
      await copyDir(absoluteTarget, entryPath, { preserveSymlinks: true });
    }
    // 非符号链接的文件/目录保持不变（如 _shared 复制过来的文件）
  }
}

/**
 * 检查路径状态
 */
export async function getPathStatus(
  localPath: string,
  expectedTarget: string
): Promise<'linked' | 'wrong_link' | 'broken_link' | 'directory' | 'missing'> {
  try {
    const lstat = await fs.lstat(localPath);

    if (lstat.isSymbolicLink()) {
      // 先检查链接目标是否存在（断链检测）
      const isValid = await isValidLink(localPath);
      if (!isValid) {
        return 'broken_link';
      }

      const isCorrect = await isCorrectLink(localPath, expectedTarget);
      return isCorrect ? 'linked' : 'wrong_link';
    }

    if (lstat.isDirectory()) {
      return 'directory';
    }

    // 其他情况视为 missing
    return 'missing';
  } catch {
    return 'missing';
  }
}

/**
 * 链接库到项目（自动选择单平台/多平台策略）
 * @param localPath 本地路径 (3rdparty/libXxx)
 * @param storePath Store 根路径
 * @param libName 库名
 * @param commit commit hash
 * @param platforms 选择的平台列表
 */
export async function linkLibrary(
  localPath: string,
  storePath: string,
  libName: string,
  commit: string,
  platforms: string[]
): Promise<void> {
  if (platforms.length === 0) {
    throw new Error('至少需要一个平台');
  }

  if (platforms.length === 1) {
    // 单平台：直接链接到平台目录
    const target = path.join(storePath, libName, commit, platforms[0]);
    await replaceWithLink(localPath, target);
  } else {
    // 多平台：调用组合链接（3-2 实现）
    await linkMultiPlatform(localPath, storePath, libName, commit, platforms);
  }
}

/**
 * 多平台组合链接
 * 创建真实目录，内部分别链接各平台内容和共享内容
 * @param localPath 本地路径
 * @param storePath Store 根路径
 * @param libName 库名
 * @param commit commit hash
 * @param platforms 平台列表
 */
export async function linkMultiPlatform(
  localPath: string,
  storePath: string,
  libName: string,
  commit: string,
  platforms: string[]
): Promise<void> {
  // 1. 删除旧链接/目录，创建真实目录
  await fs.rm(localPath, { recursive: true, force: true });
  await fs.mkdir(localPath, { recursive: true });

  // 2. 取第一个平台作为共享内容来源
  const primaryPlatform = platforms[0];
  const primaryPath = path.join(storePath, libName, commit, primaryPlatform);

  // 3. 遍历主平台目录内容
  const entries = await fs.readdir(primaryPath, { withFileTypes: true });

  for (const entry of entries) {
    const linkPath = path.join(localPath, entry.name);

    if (KNOWN_PLATFORM_VALUES.includes(entry.name)) {
      // 平台目录：检查是否在选择列表中
      if (platforms.includes(entry.name)) {
        // 链接到对应 store 平台目录下的平台子目录
        const target = path.join(storePath, libName, commit, entry.name, entry.name);
        await link(target, linkPath);
      }
    } else {
      // 共享内容：链接到主平台
      const target = path.join(primaryPath, entry.name);
      await link(target, linkPath);
    }
  }

  // 4. 链接其他平台的平台目录（如果主平台没有）
  for (const platform of platforms.slice(1)) {
    if (!KNOWN_PLATFORM_VALUES.includes(platform)) continue;

    const linkPath = path.join(localPath, platform);
    // 如果还没链接（主平台可能已处理）
    if (!(await isSymlink(linkPath))) {
      const platformPath = path.join(storePath, libName, commit, platform, platform);
      // 检查目标是否存在
      try {
        await fs.access(platformPath);
        await link(platformPath, linkPath);
      } catch {
        // 目标不存在，跳过
      }
    }
  }
}

/**
 * 链接库到项目（新版：符号链接平台目录 + 复制共享文件）
 *
 * 目标结构:
 * ```
 * 3rdParty/libName/
 * ├── macOS/      → Store/.../macOS/     (符号链接)
 * ├── android/    → Store/.../android/   (符号链接)
 * ├── codepac-dep.json                   (复制自 _shared)
 * └── *.cmake                            (复制自 _shared)
 * ```
 *
 * @param localPath 本地路径 (3rdParty/libName)
 * @param storeCommitPath Store 中的 commit 路径 (Store/libName/commit)
 * @param platforms 要链接的平台列表
 */
export async function linkLib(
  localPath: string,
  storeCommitPath: string,
  platforms: string[]
): Promise<void> {
  // 1. 清理旧内容
  await fs.rm(localPath, { recursive: true, force: true });

  // 2. 创建目录
  await fs.mkdir(localPath, { recursive: true });

  try {
    // 3. 链接平台目录
    for (const platform of platforms) {
      const storePlatformPath = path.join(storeCommitPath, platform);

      // 检查 Store 中平台目录是否存在
      try {
        await fs.access(storePlatformPath);
      } catch {
        // 平台目录不存在，跳过
        continue;
      }

      const localPlatformPath = path.join(localPath, platform);
      const type = isWindows() ? 'junction' : 'dir';
      await fs.symlink(storePlatformPath, localPlatformPath, type);
    }

    // 4. 复制共享文件（非链接）
    const sharedPath = path.join(storeCommitPath, '_shared');
    try {
      await fs.access(sharedPath);
      // _shared 目录存在，复制其内容到 localPath
      await copyDir(sharedPath, localPath, { preserveSymlinks: true });
    } catch {
      // _shared 目录不存在，跳过
    }
  } catch (err) {
    // 链接失败时清理已创建的内容
    await fs.rm(localPath, { recursive: true, force: true });
    throw err;
  }
}

/**
 * 为 General 类型库创建整目录符号链接
 * 将 localPath 整个变为符号链接，指向 Store 的 _shared
 */
export async function linkGeneral(
  localPath: string,
  storeSharedPath: string
): Promise<void> {
  await fs.rm(localPath, { recursive: true, force: true });
  const type = isWindows() ? 'junction' : 'dir';
  await fs.symlink(storeSharedPath, localPath, type);
}

export default {
  link,
  isSymlink,
  readLink,
  unlink,
  isValidLink,
  isCorrectLink,
  replaceWithLink,
  restoreFromLink,
  restoreMultiPlatform,
  getPathStatus,
  linkLibrary,
  linkMultiPlatform,
  linkLib,
  linkGeneral,
};
