/**
 * 文件系统工具函数
 * 提取自 core/store.ts, core/linker.ts, commands/link.ts, commands/migrate.ts
 */
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createReadStream } from 'node:fs';
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

/**
 * 递归统计目录下的文件总数
 * @param dirPath 目录路径
 * @returns 文件总数，目录不存在返回 0
 */
export async function countFiles(dirPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('find', [dirPath, '-type', 'f'], {
      timeout: 30000,
    });
    // find 输出每行一个文件路径，空输出表示 0 个文件
    const trimmed = stdout.trim();
    if (trimmed === '') return 0;
    return trimmed.split('\n').length;
  } catch {
    // find 命令失败，回退到递归方式
  }

  return countFilesFallback(dirPath);
}

/**
 * 递归统计文件数（回退方案）
 */
async function countFilesFallback(dirPath: string): Promise<number> {
  let count = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        count += await countFilesFallback(fullPath);
      } else if (entry.isFile()) {
        count++;
      }
    }
  } catch {
    // 目录不存在或无法访问
  }
  return count;
}

/**
 * 计算目录内容的 MD5 哈希
 * 基于排序后的相对路径和文件内容，保证确定性
 * @param dirPath 目录路径
 * @returns MD5 哈希字符串
 */
export async function hashDirectory(dirPath: string): Promise<string> {
  // 收集所有文件的相对路径
  const files = await collectFilePaths(dirPath);
  files.sort();

  const hash = crypto.createHash('md5');

  for (const relPath of files) {
    hash.update(relPath);
    const absPath = path.join(dirPath, relPath);
    // 流式读取文件内容
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(absPath);
      stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
  }

  return hash.digest('hex');
}

/**
 * 递归收集目录下所有文件的相对路径
 */
async function collectFilePaths(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const { stdout } = await execFileAsync('find', [dirPath, '-type', 'f'], {
      timeout: 30000,
    });
    const trimmed = stdout.trim();
    if (trimmed === '') return files;
    for (const line of trimmed.split('\n')) {
      files.push(path.relative(dirPath, line));
    }
  } catch {
    // find 命令失败，回退到递归方式
    await collectFilePathsFallback(dirPath, dirPath, files);
  }
  return files;
}

/**
 * 递归收集文件路径（回退方案）
 */
async function collectFilePathsFallback(
  basePath: string,
  currentPath: string,
  files: string[]
): Promise<void> {
  try {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await collectFilePathsFallback(basePath, fullPath, files);
      } else if (entry.isFile()) {
        files.push(path.relative(basePath, fullPath));
      }
    }
  } catch {
    // 目录不存在或无法访问
  }
}

/**
 * 获取目录完整性信息（size + fileCount + contentHash）
 * @param dirPath 目录路径
 * @returns 完整性信息对象
 */
export async function getDirectoryIntegrity(dirPath: string): Promise<{
  size: number; fileCount: number; contentHash: string;
}> {
  const [size, fileCount, contentHash] = await Promise.all([
    getDirSize(dirPath),
    countFiles(dirPath),
    hashDirectory(dirPath),
  ]);
  return { size, fileCount, contentHash };
}

export default {
  copyDir,
  copyDirWithProgress,
  getDirSize,
  ensureDir,
  removeDir,
  countFiles,
  hashDirectory,
  getDirectoryIntegrity,
};
