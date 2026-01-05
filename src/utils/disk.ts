/**
 * 磁盘空间检测工具
 * - macOS: 读取 / 和 /Volumes/*
 * - Windows: 读取 C:\, D:\ 等盘符
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { isWindows } from '../core/platform.js';
import type { DiskInfo } from '../types/index.js';

const execAsync = promisify(exec);

/**
 * 获取所有磁盘信息
 */
export async function getDiskInfo(): Promise<DiskInfo[]> {
  if (isWindows()) {
    return getWindowsDisks();
  }
  return getMacDisks();
}

/**
 * macOS: 获取磁盘信息
 */
async function getMacDisks(): Promise<DiskInfo[]> {
  const disks: DiskInfo[] = [];

  // 获取根分区
  try {
    const rootInfo = await getDiskUsage('/');
    if (rootInfo) {
      disks.push({
        path: '/',
        label: '系统盘',
        total: rootInfo.total,
        free: rootInfo.free,
        isSystem: true,
      });
    }
  } catch {
    // 忽略错误
  }

  // 获取 /Volumes 下的其他卷
  try {
    const volumes = await fs.readdir('/Volumes');
    for (const volume of volumes) {
      const volumePath = path.join('/Volumes', volume);

      // 跳过系统盘链接
      try {
        const stat = await fs.lstat(volumePath);
        if (stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }

      try {
        const info = await getDiskUsage(volumePath);
        if (info) {
          disks.push({
            path: volumePath,
            label: volume,
            total: info.total,
            free: info.free,
            isSystem: false,
          });
        }
      } catch {
        // 忽略无法访问的卷
      }
    }
  } catch {
    // /Volumes 不存在或无法访问
  }

  return disks;
}

/**
 * Windows: 获取磁盘信息
 */
async function getWindowsDisks(): Promise<DiskInfo[]> {
  const disks: DiskInfo[] = [];

  try {
    // 使用 wmic 获取磁盘信息
    const { stdout } = await execAsync(
      'wmic logicaldisk get caption,freespace,size,volumename /format:csv',
      { encoding: 'utf8' }
    );

    const lines = stdout.trim().split('\n').slice(1); // 跳过表头

    for (const line of lines) {
      const parts = line.trim().split(',');
      if (parts.length < 5) continue;

      const [, caption, freeSpace, size, volumeName] = parts;
      if (!caption || !size) continue;

      const drivePath = caption + '\\';
      const total = parseInt(size, 10);
      const free = parseInt(freeSpace, 10) || 0;

      // C: 通常是系统盘
      const isSystem = caption.toUpperCase() === 'C:';

      disks.push({
        path: drivePath,
        label: volumeName || (isSystem ? '系统盘' : '本地磁盘'),
        total: isNaN(total) ? 0 : total,
        free: isNaN(free) ? 0 : free,
        isSystem,
      });
    }
  } catch {
    // wmic 命令失败，尝试备用方法
    try {
      const drives = ['C:', 'D:', 'E:', 'F:', 'G:', 'H:'];
      for (const drive of drives) {
        try {
          const info = await getDiskUsage(drive + '\\');
          if (info) {
            disks.push({
              path: drive + '\\',
              label: drive === 'C:' ? '系统盘' : '本地磁盘',
              total: info.total,
              free: info.free,
              isSystem: drive === 'C:',
            });
          }
        } catch {
          // 磁盘不存在
        }
      }
    } catch {
      // 忽略错误
    }
  }

  return disks;
}

/**
 * 获取指定路径的磁盘使用情况
 */
async function getDiskUsage(targetPath: string): Promise<{ total: number; free: number } | null> {
  if (isWindows()) {
    return getWindowsDiskUsage(targetPath);
  }
  return getMacDiskUsage(targetPath);
}

/**
 * macOS: 使用 df 命令获取磁盘使用情况
 */
async function getMacDiskUsage(
  targetPath: string
): Promise<{ total: number; free: number } | null> {
  try {
    const { stdout } = await execAsync(`df -k "${targetPath}"`, { encoding: 'utf8' });
    const lines = stdout.trim().split('\n');
    if (lines.length < 2) return null;

    // 解析 df 输出: Filesystem 1K-blocks Used Available Use% Mounted
    const parts = lines[1].split(/\s+/);
    if (parts.length < 4) return null;

    const totalBlocks = parseInt(parts[1], 10);
    const availableBlocks = parseInt(parts[3], 10);

    return {
      total: totalBlocks * 1024,
      free: availableBlocks * 1024,
    };
  } catch {
    return null;
  }
}

/**
 * Windows: 获取磁盘使用情况
 */
async function getWindowsDiskUsage(
  targetPath: string
): Promise<{ total: number; free: number } | null> {
  try {
    // 提取盘符
    const drive = targetPath.match(/^([A-Za-z]:)/)?.[1];
    if (!drive) return null;

    const { stdout } = await execAsync(
      `wmic logicaldisk where "caption='${drive}'" get freespace,size /format:csv`,
      { encoding: 'utf8' }
    );

    const lines = stdout.trim().split('\n').slice(1);
    if (lines.length === 0) return null;

    const parts = lines[0].trim().split(',');
    if (parts.length < 3) return null;

    const [, freeSpace, size] = parts;

    return {
      total: parseInt(size, 10) || 0,
      free: parseInt(freeSpace, 10) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * 格式化文件大小
 */
export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = bytes / Math.pow(k, i);

  return `${size.toFixed(1)} ${units[i]}`;
}

/**
 * 解析大小字符串为字节数
 */
export function parseSize(sizeStr: string): number {
  const match = sizeStr.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)?$/i);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();

  const units: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
  };

  return Math.floor(value * (units[unit] || 1));
}

/**
 * 检查路径所在磁盘是否有足够空间
 */
export async function hasEnoughSpace(targetPath: string, requiredBytes: number): Promise<boolean> {
  const usage = await getDiskUsage(targetPath);
  if (!usage) return true; // 无法获取时假设足够

  return usage.free >= requiredBytes;
}

/**
 * 获取路径所在磁盘的可用空间
 */
export async function getFreeSpace(targetPath: string): Promise<number> {
  const usage = await getDiskUsage(targetPath);
  return usage?.free ?? 0;
}

/**
 * 获取默认 Store 路径建议
 */
export async function getDefaultStorePaths(): Promise<
  Array<{ path: string; label: string; free: number; recommended: boolean }>
> {
  const disks = await getDiskInfo();
  const home = os.homedir();
  const suggestions: Array<{ path: string; label: string; free: number; recommended: boolean }> =
    [];

  // 默认路径: ~/.tanmi-dock/store
  const defaultPath = path.join(home, '.tanmi-dock', 'store');
  const homeDisk = disks.find((d) => defaultPath.startsWith(d.path) || d.isSystem);

  suggestions.push({
    path: defaultPath,
    label: '默认位置',
    free: homeDisk?.free ?? 0,
    recommended: false,
  });

  // 非系统盘的建议
  const nonSystemDisks = disks.filter((d) => !d.isSystem && d.free > 10 * 1024 * 1024 * 1024); // 至少 10GB

  for (const disk of nonSystemDisks) {
    const storePath = path.join(disk.path, '.tanmi-dock', 'store');
    suggestions.push({
      path: storePath,
      label: disk.label || disk.path,
      free: disk.free,
      recommended: true, // 非系统盘通常空间更大
    });
  }

  // 按可用空间排序，推荐的排前面
  suggestions.sort((a, b) => {
    if (a.recommended !== b.recommended) {
      return a.recommended ? -1 : 1;
    }
    return b.free - a.free;
  });

  return suggestions;
}

export default {
  getDiskInfo,
  formatSize,
  parseSize,
  hasEnoughSpace,
  getFreeSpace,
  getDefaultStorePaths,
};
