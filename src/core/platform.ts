/**
 * 跨平台适配工具
 */
import os from 'os';
import path from 'path';
import type { Platform } from '../types/index.js';

// ============ 平台选项配置 ============

/**
 * 平台选项定义
 */
export interface PlatformOption {
  key: string;           // CLI 参数 key (mac, ios, android...)
  value: string;         // Store 目录名 (macOS, iOS, android...)
  asan?: string;         // ASAN 版本目录名
  hwasan?: string;       // HWASAN 版本目录名 (仅 android)
}

/**
 * 支持的平台列表
 */
export const PLATFORM_OPTIONS: PlatformOption[] = [
  { key: 'mac', value: 'macOS', asan: 'macOS-asan' },
  { key: 'win', value: 'Win' },
  { key: 'ios', value: 'iOS', asan: 'iOS-asan' },
  { key: 'android', value: 'android', asan: 'android-asan', hwasan: 'android-hwasan' },
  { key: 'linux', value: 'ubuntu' },
  { key: 'wasm', value: 'wasm' },
  { key: 'ohos', value: 'ohos' },
];

/**
 * 通过 key 获取平台选项
 */
export function getPlatformOption(key: string): PlatformOption | undefined {
  return PLATFORM_OPTIONS.find((p) => p.key === key);
}

/**
 * 通过 value 获取平台选项
 */
export function getPlatformOptionByValue(value: string): PlatformOption | undefined {
  return PLATFORM_OPTIONS.find(
    (p) => p.value === value || p.asan === value || p.hwasan === value
  );
}

/**
 * key 转换为 value
 */
export function platformKeyToValue(key: string): string | undefined {
  return getPlatformOption(key)?.value;
}

/**
 * value 转换为 key (用于 codepac -p 参数)
 * 如果找不到映射，返回原值（自定义平台）
 */
export function platformValueToKey(value: string): string {
  const option = getPlatformOptionByValue(value);
  return option?.key ?? value;
}

/**
 * 获取平台的基础 key（用于传给 codepac）
 * 无论是 macOS 还是 macOS-asan，都返回 mac
 * 这样 codepac 会下载所有变体，之后再做清理
 */
export function getBaseKeyForCodepac(value: string): string {
  const option = getPlatformOptionByValue(value);
  return option?.key ?? value;
}

/**
 * 获取所有平台 keys
 */
export function getAllPlatformKeys(): string[] {
  return PLATFORM_OPTIONS.map((p) => p.key);
}

/**
 * 生成平台帮助文本
 * 显示可用的平台参数及其变体
 */
export function getPlatformHelpText(): string {
  const lines = ['\nPlatforms:'];
  for (const opt of PLATFORM_OPTIONS) {
    // 基础平台
    lines.push(`  ${opt.key.padEnd(12)} -> ${opt.value}`);
    // asan 变体
    if (opt.asan) {
      lines.push(`  ${(opt.key + '-asan').padEnd(12)} -> ${opt.asan}`);
    }
    // hwasan 变体
    if (opt.hwasan) {
      lines.push(`  ${(opt.key + '-hwasan').padEnd(12)} -> ${opt.hwasan}`);
    }
  }
  return lines.join('\n');
}

/**
 * 已知平台目录名列表 (用于多平台链接时识别平台子目录)
 */
export const KNOWN_PLATFORM_VALUES: string[] = [
  'macOS', 'macOS-asan',
  'Win',
  'iOS', 'iOS-asan',
  'android', 'android-asan', 'android-hwasan',
  'ubuntu',
  'wasm',
  'ohos',
];

// 平台名别名映射（小写 -> 标准形式）
// 用于处理不同仓库中使用的不同命名风格
const PLATFORM_ALIASES: Record<string, string> = {
  // macOS 变体
  'macos': 'macOS',
  'macos-asan': 'macOS-asan',
  // Windows 变体
  'win': 'Win',
  'windows': 'Win',
  // iOS 变体
  'ios': 'iOS',
  'ios-asan': 'iOS-asan',
  // Android 变体（已经是小写）
  'android': 'android',
  'android-asan': 'android-asan',
  'android-hwasan': 'android-hwasan',
  // Linux 变体
  'ubuntu': 'ubuntu',
  'linux': 'ubuntu',
  // 其他
  'wasm': 'wasm',
  'ohos': 'ohos',
};

// 构建小写到标准形式的映射表
const PLATFORM_VALUE_MAP: Map<string, string> = new Map(
  Object.entries(PLATFORM_ALIASES)
);

/**
 * 检查目录名是否为已知平台目录（大小写不敏感）
 */
export function isPlatformDir(name: string): boolean {
  return PLATFORM_VALUE_MAP.has(name.toLowerCase());
}

/**
 * 标准化平台目录名（例如 "macos" -> "macOS"）
 * 如果不是已知平台，返回原值
 */
export function normalizePlatformValue(name: string): string {
  return PLATFORM_VALUE_MAP.get(name.toLowerCase()) ?? name;
}

/**
 * General 类型库的平台标识
 * 用于只有 _shared 目录、无平台目录的库（如 eigen、header-only 库）
 */
export const GENERAL_PLATFORM = 'general';

/**
 * 检查 sparse 配置是否只有 common 内容（没有任何平台键）
 * 用于识别应该被当作 General 库处理的有 sparse 配置的库
 *
 * @example
 * // 返回 true - 只有 common
 * isSparseOnlyCommon({ common: ["include"] })
 *
 * // 返回 false - 有平台键
 * isSparseOnlyCommon({ common: ["include"], macOS: ["macOS"] })
 *
 * // 返回 false - 字符串形式的 sparse
 * isSparseOnlyCommon("${ALL_COMMON_SPARSE}")
 */
export function isSparseOnlyCommon(sparse: object | string | undefined): boolean {
  if (!sparse) return false;
  if (typeof sparse === 'string') return false;

  const keys = Object.keys(sparse);
  // 只有 common 键，或者完全没有键
  return keys.length === 0 || (keys.length === 1 && keys[0] === 'common');
}

/**
 * 获取配置目录路径
 * - 支持 TANMI_DOCK_HOME 环境变量覆盖（用于测试和开发）
 * - 默认: ~/.tanmi-dock (macOS) 或 %USERPROFILE%\.tanmi-dock (Windows)
 */
export function getConfigDir(): string {
  const envHome = process.env.TANMI_DOCK_HOME;
  if (envHome) {
    return envHome;
  }
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
 * 检查文件系统是否大小写不敏感
 * Windows 和 macOS (默认 APFS/HFS+) 是大小写不敏感的
 */
export function isCaseInsensitiveFS(): boolean {
  return isWindows() || isMacOS();
}

/**
 * 比较两个路径是否相等（考虑文件系统大小写敏感性）
 */
export function pathsEqual(p1: string, p2: string): boolean {
  if (isCaseInsensitiveFS()) {
    return p1.toLowerCase() === p2.toLowerCase();
  }
  return p1 === p2;
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

// ============ 路径安全验证 ============

/**
 * 安全敏感目录（禁止作为 Store）
 */
const FORBIDDEN_PATHS_UNIX = ['/etc', '/usr', '/bin', '/sbin', '/var', '/tmp', '/root', '/System'];
const FORBIDDEN_PATHS_WIN = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
];

/**
 * 路径安全检查结果
 */
export interface PathSafetyResult {
  safe: boolean;
  reason?: string;
}

/**
 * 检查路径是否安全
 */
export function isPathSafe(p: string): PathSafetyResult {
  const resolved = path.resolve(expandHome(p));
  const normalized = path.normalize(resolved);

  // 获取当前平台的禁止路径列表
  const forbiddenPaths = isWindows() ? FORBIDDEN_PATHS_WIN : FORBIDDEN_PATHS_UNIX;

  // 检查是否包含路径遍历且指向敏感目录
  if (p.includes('..')) {
    for (const forbidden of forbiddenPaths) {
      const forbiddenNorm = path.normalize(forbidden);
      if (
        normalized === forbiddenNorm ||
        normalized.startsWith(forbiddenNorm + path.sep) ||
        normalized.toLowerCase() === forbiddenNorm.toLowerCase() ||
        normalized.toLowerCase().startsWith(forbiddenNorm.toLowerCase() + path.sep)
      ) {
        return { safe: false, reason: `路径遍历指向系统敏感目录: ${forbidden}` };
      }
    }
  }

  // 检查是否直接指向敏感目录
  for (const forbidden of forbiddenPaths) {
    const forbiddenNorm = path.normalize(forbidden);
    // 大小写不敏感比较（主要针对 Windows）
    const normalizedLower = normalized.toLowerCase();
    const forbiddenLower = forbiddenNorm.toLowerCase();

    if (
      normalizedLower === forbiddenLower ||
      normalizedLower.startsWith(forbiddenLower + path.sep.toLowerCase())
    ) {
      return { safe: false, reason: `不能使用系统目录: ${forbidden}` };
    }
  }

  // 检查 /tmp（Unix 临时目录）
  if (!isWindows() && (normalized === '/tmp' || normalized.startsWith('/tmp/'))) {
    return { safe: false, reason: '不能使用系统临时目录: /tmp' };
  }

  return { safe: true };
}

/**
 * 确保路径安全，不安全时抛出错误
 */
export function ensurePathSafe(p: string): string {
  const result = isPathSafe(p);
  if (!result.safe) {
    throw new Error(`[安全] ${result.reason}`);
  }
  return path.resolve(expandHome(p));
}
