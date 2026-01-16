/**
 * 文件系统工具函数
 * 提取自 core/store.ts, core/linker.ts, commands/link.ts, commands/migrate.ts
 */
import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface CopyDirOptions {
  /** 是否保留符号链接 (默认 false，复制链接目标内容) */
  preserveSymlinks?: boolean;
}

/**
 * 递归复制目录
 * @param src 源目录
 * @param dest 目标目录
 * @param options 复制选项
 */
export async function copyDir(
  src: string,
  dest: string,
  options: CopyDirOptions = {}
): Promise<void> {
  const { preserveSymlinks = false } = options;

  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath, options);
    } else if (preserveSymlinks && entry.isSymbolicLink()) {
      // 保持符号链接
      const linkTarget = await fs.readlink(srcPath);
      await fs.symlink(linkTarget, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * 带进度回调的目录复制
 * @param src 源目录
 * @param dest 目标目录
 * @param totalSize 预计总大小 (bytes)
 * @param onProgress 进度回调 (copiedBytes, totalBytes) => void
 */
export async function copyDirWithProgress(
  src: string,
  dest: string,
  totalSize: number,
  onProgress?: (copiedBytes: number, totalBytes: number) => void
): Promise<void> {
  let copiedBytes = 0;

  async function copyRecursive(srcDir: string, destDir: string): Promise<void> {
    await fs.mkdir(destDir, { recursive: true });
    const entries = await fs.readdir(srcDir, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (entry.isDirectory()) {
        await copyRecursive(srcPath, destPath);
      } else {
        const stat = await fs.stat(srcPath);
        await fs.copyFile(srcPath, destPath);
        copiedBytes += stat.size;
        onProgress?.(copiedBytes, totalSize);
      }
    }
  }

  await copyRecursive(src, dest);
}

/**
 * 计算目录大小（使用系统命令 du 加速）
 * @param dirPath 目录路径
 * @returns 目录大小 (bytes)
 */
export async function getDirSize(dirPath: string): Promise<number> {
  try {
    // 使用 du -sk 获取目录大小（KB），比递归遍历快很多
    // -s: 汇总, -k: 以 KB 为单位
    const { stdout } = await execFileAsync('du', ['-sk', dirPath], {
      timeout: 30000, // 30 秒超时
    });
    // 输出格式: "12345\t/path/to/dir"
    const sizeKB = parseInt(stdout.split('\t')[0], 10);
    if (!Number.isNaN(sizeKB)) {
      return sizeKB * 1024;
    }
  } catch {
    // du 命令失败，回退到递归方式
  }

  // 回退：递归遍历（Windows 或 du 失败时）
  return getDirSizeFallback(dirPath);
}

/**
 * 递归计算目录大小（回退方案）
 */
async function getDirSizeFallback(dirPath: string): Promise<number> {
  let size = 0;

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        size += await getDirSizeFallback(fullPath);
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
 * 确保目录存在
 * @param dirPath 目录路径
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * 安全删除目录
 * @param dirPath 目录路径
 */
export async function removeDir(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { recursive: true, force: true });
}

export default {
  copyDir,
  copyDirWithProgress,
  getDirSize,
  ensureDir,
  removeDir,
};
