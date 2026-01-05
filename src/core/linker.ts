/**
 * 符号链接操作
 * - macOS: 使用 symlink
 * - Windows: 使用 junction (无需管理员权限)
 */
import fs from 'fs/promises';
import path from 'path';
import { isWindows } from './platform.js';

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

  // 复制目标内容
  await copyDir(absoluteTarget, linkPath);
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
    } else if (entry.isSymbolicLink()) {
      // 保持符号链接
      const linkTarget = await fs.readlink(srcPath);
      await fs.symlink(linkTarget, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * 检查路径状态
 */
export async function getPathStatus(
  localPath: string,
  expectedTarget: string
): Promise<'linked' | 'wrong_link' | 'directory' | 'missing'> {
  try {
    const lstat = await fs.lstat(localPath);

    if (lstat.isSymbolicLink()) {
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

export default {
  link,
  isSymlink,
  readLink,
  unlink,
  isValidLink,
  isCorrectLink,
  replaceWithLink,
  restoreFromLink,
  getPathStatus,
};
