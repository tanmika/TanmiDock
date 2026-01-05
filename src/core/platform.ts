/**
 * 跨平台适配工具
 */
import os from 'os';
import path from 'path';
import type { Platform } from '../types/index.js';

/**
 * 获取配置目录路径 (固定位置)
 * - macOS: ~/.tanmi-dock
 * - Windows: %USERPROFILE%\.tanmi-dock
 */
export function getConfigDir(): string {
  return path.join(os.homedir(), '.tanmi-dock');
}

/**
 * 获取配置文件路径
 */
export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

/**
 * 获取注册表文件路径
 */
export function getRegistryPath(): string {
  return path.join(getConfigDir(), 'registry.json');
}

/**
 * 获取当前平台
 */
export function getPlatform(): Platform {
  return process.platform === 'win32' ? 'win' : 'mac';
}

/**
 * 判断是否为 Windows
 */
export function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * 判断是否为 macOS
 */
export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

/**
 * 规范化路径分隔符
 */
export function normalizePath(p: string): string {
  return path.normalize(p);
}

/**
 * 展开 ~ 为用户主目录
 */
export function expandHome(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * 收缩路径，将用户主目录替换为 ~
 */
export function shrinkHome(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

/**
 * 获取路径的绝对路径
 */
export function resolvePath(p: string): string {
  return path.resolve(expandHome(p));
}

/**
 * 判断路径是否为绝对路径
 */
export function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p);
}

/**
 * 连接路径
 */
export function joinPath(...parts: string[]): string {
  return path.join(...parts);
}
