#!/usr/bin/env ts-node
/**
 * 测试数据准备脚本
 * 用于下载所有测试库到缓存目录
 *
 * 用法:
 *   npx tsx prepare.ts           # 下载所有库
 *   npx tsx prepare.ts --lib eigen  # 只下载指定库
 *   npx tsx prepare.ts --clean      # 清空缓存
 *   npx tsx prepare.ts --check      # 检查缓存状态
 */

import fs from 'fs/promises';
import path from 'path';
import { downloadToTemp } from '../../../src/core/codepac.js';

// 路径配置
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const MANIFEST_PATH = path.join(SCRIPT_DIR, 'manifest.json');
const CACHE_DIR = path.join(SCRIPT_DIR, 'cache');

// 类型定义
interface CommitInfo {
  usedIn: string[];
  platforms: string[];
  type: 'binary' | 'header-only';
  hasActions?: boolean;
  nestedDependencies?: string[];
}

// 标准 sparse 配置（用于 binary 类型库）
// 目录名必须与仓库中实际目录名匹配
const STANDARD_SPARSE: Record<string, string[]> = {
  mac: ['macOS', 'macOS-asan'],
  win: ['Win'],
  ios: ['iOS', 'iOS-asan'],
  android: ['android', 'android-asan', 'android-hwasan'],
  linux: ['ubuntu'],
  wasm: ['wasm'],
  ohos: ['ohos'],
};

interface LibraryInfo {
  repository: string;
  commits: Record<string, CommitInfo>;
}

interface Manifest {
  version: string;
  description: string;
  scenarios: Record<string, unknown>;
  libraries: Record<string, LibraryInfo>;
}

// 解析命令行参数
function parseArgs(): { lib?: string; clean?: boolean; check?: boolean } {
  const args = process.argv.slice(2);
  const result: { lib?: string; clean?: boolean; check?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lib' && args[i + 1]) {
      result.lib = args[i + 1];
      i++;
    } else if (args[i] === '--clean') {
      result.clean = true;
    } else if (args[i] === '--check') {
      result.check = true;
    }
  }

  return result;
}

// 检查缓存是否存在（检查库目录是否存在且非空）
async function checkCacheExists(libName: string, commitShort: string): Promise<boolean> {
  const cachePath = path.join(CACHE_DIR, libName, commitShort);
  try {
    const stat = await fs.stat(cachePath);
    if (!stat.isDirectory()) return false;
    const entries = await fs.readdir(cachePath);
    // 至少有 .git 或其他文件
    return entries.length > 0;
  } catch {
    return false;
  }
}

// manifest 平台值到 normalized 平台值的映射（用于 downloadToTemp platforms 参数）
// 这些值必须与 KNOWN_PLATFORM_VALUES 匹配
const MANIFEST_TO_NORMALIZED: Record<string, string> = {
  'macOS': 'macOS',
  'Windows': 'Win',
  'iOS': 'iOS',
  'Android': 'android',
  'android': 'android',
  'Linux': 'ubuntu',
};

// normalized 平台值到 CLI 键的映射（用于 sparse 配置）
const NORMALIZED_TO_CLI: Record<string, string> = {
  'macOS': 'mac',
  'Win': 'win',
  'iOS': 'ios',
  'android': 'android',
  'ubuntu': 'linux',
};

// 根据 normalized 平台列表生成 sparse 配置
function buildSparseConfig(normalizedPlatforms: string[]): Record<string, string[]> {
  const sparse: Record<string, string[]> = {};
  for (const platform of normalizedPlatforms) {
    const cliKey = NORMALIZED_TO_CLI[platform];
    if (cliKey && STANDARD_SPARSE[cliKey]) {
      sparse[cliKey] = STANDARD_SPARSE[cliKey];
    }
  }
  return sparse;
}

// 使用 tanmi-dock 的 downloadToTemp 下载库
async function downloadLib(
  libName: string,
  repository: string,
  commit: string,
  platformValues: string[],
  isBinary: boolean,
  onProgress?: (msg: string) => void
): Promise<void> {
  const commitShort = commit.substring(0, 7);
  const targetDir = path.join(CACHE_DIR, libName, commitShort);

  // 转换 manifest 平台值到 normalized 平台值（与 KNOWN_PLATFORM_VALUES 匹配）
  // 例如: "Windows" -> "Win", "Linux" -> "ubuntu"
  const normalizedPlatforms = platformValues.map(pv => MANIFEST_TO_NORMALIZED[pv] || pv);

  // 为 binary 类型库生成 sparse 配置
  // header-only 类型库不需要 sparse，会下载整个仓库
  const sparse = isBinary ? buildSparseConfig(normalizedPlatforms) : undefined;

  // 调用 tanmi-dock 的下载函数
  // platforms 参数使用 normalized 值（macOS, Win, iOS, android, ubuntu）
  const result = await downloadToTemp({
    url: repository,
    commit,
    branch: 'master',
    libName,
    platforms: normalizedPlatforms,
    sparse,
    onProgress: (msg) => {
      if (onProgress) {
        onProgress(msg);
      }
    },
  });

  // 如果是从缓存返回的，不需要移动或清理
  if (result.fromCache) {
    // 缓存已存在于正确位置，无需处理
    return;
  }

  // 移动到缓存目录
  await fs.mkdir(path.dirname(targetDir), { recursive: true });

  // 如果目标已存在，先删除
  await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});

  // 移动下载的库目录
  await fs.rename(result.libDir, targetDir);

  // 清理临时目录（只有新下载时才清理）
  await fs.rm(result.tempDir, { recursive: true, force: true }).catch(() => {});
}

// 检查缓存状态
async function checkCacheStatus(manifest: Manifest): Promise<void> {
  console.log('\n=== 缓存状态检查 ===\n');

  let total = 0;
  let cached = 0;
  let missing = 0;

  for (const [libName, libInfo] of Object.entries(manifest.libraries)) {
    for (const [commit, commitInfo] of Object.entries(libInfo.commits)) {
      const commitShort = commit.substring(0, 7);
      total++;

      const exists = await checkCacheExists(libName, commitShort);

      if (exists) {
        cached++;
        console.log(`✅ ${libName}@${commitShort} [${commitInfo.platforms.join(', ')}]`);
      } else {
        missing++;
        console.log(`❌ ${libName}@${commitShort} [${commitInfo.platforms.join(', ')}]`);
      }
    }
  }

  console.log('\n=== 统计 ===');
  console.log(`总计: ${total}`);
  console.log(`已缓存: ${cached}`);
  console.log(`缺失: ${missing}`);
}

// 清理缓存
async function cleanCache(): Promise<void> {
  console.log('清理缓存目录...');
  await fs.rm(CACHE_DIR, { recursive: true, force: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(path.join(CACHE_DIR, '.gitkeep'), '# 保持 cache 目录存在\n');
  console.log('✅ 缓存已清理');
}

// 下载所有库
async function downloadAll(manifest: Manifest, targetLib?: string): Promise<void> {
  console.log('\n=== 开始下载测试数据 ===\n');

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const [libName, libInfo] of Object.entries(manifest.libraries)) {
    // 如果指定了库名，只下载指定的库
    if (targetLib && libName !== targetLib) {
      continue;
    }

    for (const [commit, commitInfo] of Object.entries(libInfo.commits)) {
      const commitShort = commit.substring(0, 7);

      // 检查是否已缓存
      const exists = await checkCacheExists(libName, commitShort);

      if (exists) {
        console.log(`⏭️  跳过 ${libName}@${commitShort} (已缓存)`);
        skipped++;
        continue;
      }

      const isBinary = commitInfo.type === 'binary';
      console.log(`📥 下载 ${libName}@${commitShort} [${commitInfo.platforms.join(', ')}] (${commitInfo.type})`);

      try {
        await downloadLib(libName, libInfo.repository, commit, commitInfo.platforms, isBinary, (msg) => {
          // 只显示关键进度
          if (msg.includes('Cloning') || msg.includes('Checking out') || msg.includes('Done')) {
            console.log(`   ${msg}`);
          }
        });
        console.log(`✅ ${libName}@${commitShort} 下载完成`);
        downloaded++;
      } catch (err) {
        console.error(`❌ ${libName}@${commitShort} 下载失败: ${(err as Error).message}`);
        failed++;
      }
    }
  }

  console.log('\n=== 下载完成 ===');
  console.log(`下载: ${downloaded}`);
  console.log(`跳过: ${skipped}`);
  console.log(`失败: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

// 主函数
async function main(): Promise<void> {
  const args = parseArgs();

  // 读取 manifest
  const manifestContent = await fs.readFile(MANIFEST_PATH, 'utf-8');
  const manifest: Manifest = JSON.parse(manifestContent);

  // 确保缓存目录存在
  await fs.mkdir(CACHE_DIR, { recursive: true });

  if (args.clean) {
    await cleanCache();
    return;
  }

  if (args.check) {
    await checkCacheStatus(manifest);
    return;
  }

  await downloadAll(manifest, args.lib);
}

// 执行
main().catch((err) => {
  console.error('错误:', err.message);
  process.exit(1);
});
