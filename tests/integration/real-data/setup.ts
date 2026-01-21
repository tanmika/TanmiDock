/**
 * 测试环境隔离设置
 * 提供隔离的测试目录和环境变量管理
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// 路径配置
const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/real-data');
const SCENARIOS_DIR = path.join(FIXTURES_DIR, 'scenarios');
const CACHE_DIR = path.join(FIXTURES_DIR, 'cache');
const MANIFEST_PATH = path.join(FIXTURES_DIR, 'manifest.json');

// 场景类型
export type ScenarioName = 'project-small-multiplatform' | 'project-large-singleplatform' | 'project-overlap';

// 测试环境接口
export interface TestEnvironment {
  /** 隔离的测试目录 */
  testDir: string;
  /** 项目目录（包含 codepac-dep.json） */
  projectDir: string;
  /** dependencies 目录 */
  dependenciesDir: string;
  /** TANMI_DOCK_HOME 目录 */
  tanmiDockHome: string;
  /** 清理函数 */
  cleanup: () => Promise<void>;
  /** 原始环境变量（用于恢复） */
  originalEnv: Record<string, string | undefined>;
}

/**
 * 生成唯一测试目录名
 */
function generateTestDirName(): string {
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 8);
  return `tanmi-dock-test-${timestamp}-${randomId}`;
}

/**
 * 创建隔离的测试环境
 *
 * @param scenarioName 场景名称
 * @returns 测试环境对象
 */
export async function createIsolatedTestEnv(scenarioName: ScenarioName): Promise<TestEnvironment> {
  // 创建唯一测试目录
  const testDirName = generateTestDirName();
  const testDir = path.join(os.tmpdir(), testDirName);
  const projectDir = path.join(testDir, 'project');
  const dependenciesDir = path.join(projectDir, 'dependencies');
  const tanmiDockHome = path.join(testDir, '.tanmi-dock');

  // 保存原始环境变量
  const originalEnv: Record<string, string | undefined> = {
    TANMI_DOCK_HOME: process.env.TANMI_DOCK_HOME,
    TANMI_DOCK_TEST_MODE: process.env.TANMI_DOCK_TEST_MODE,
    TANMI_DOCK_CACHE: process.env.TANMI_DOCK_CACHE,
    TANMI_DOCK_REQUIRE_CACHE: process.env.TANMI_DOCK_REQUIRE_CACHE,
  };

  // 创建目录结构
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(dependenciesDir, { recursive: true });
  await fs.mkdir(tanmiDockHome, { recursive: true });

  // 创建 Store 目录
  const storeDir = path.join(tanmiDockHome, 'store');
  await fs.mkdir(storeDir, { recursive: true });

  // 创建 tanmi-dock 配置文件
  const dockConfig = {
    version: '1.1.0',
    initialized: true,
    storePath: storeDir,
    cleanStrategy: 'unreferenced',
    unusedDays: 30,
    unreferencedThreshold: 10 * 1024 * 1024 * 1024,
    autoDownload: true,
    concurrency: 5,
    logLevel: 'info',
    unverifiedLocalStrategy: 'download',
  };
  await fs.writeFile(
    path.join(tanmiDockHome, 'config.json'),
    JSON.stringify(dockConfig, null, 2)
  );

  // 复制场景配置
  const scenarioDir = path.join(SCENARIOS_DIR, scenarioName);
  const configSrc = path.join(scenarioDir, 'codepac-dep.json');
  const configDst = path.join(projectDir, 'codepac-dep.json');
  await fs.copyFile(configSrc, configDst);

  // 设置环境变量
  process.env.TANMI_DOCK_HOME = tanmiDockHome;
  process.env.TANMI_DOCK_TEST_MODE = 'true';
  process.env.TANMI_DOCK_CACHE = CACHE_DIR;
  // 默认不强制要求缓存，允许实时下载
  process.env.TANMI_DOCK_REQUIRE_CACHE = 'false';

  // 清理函数
  const cleanup = async (): Promise<void> => {
    // 恢复环境变量
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    // 删除测试目录
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  };

  return {
    testDir,
    projectDir,
    dependenciesDir,
    tanmiDockHome,
    cleanup,
    originalEnv,
  };
}

/**
 * 检查缓存是否完整
 *
 * @param scenarioName 场景名称，不指定则检查所有
 * @returns 缓存是否完整
 */
export async function verifyCacheComplete(scenarioName?: ScenarioName): Promise<boolean> {
  try {
    const manifestContent = await fs.readFile(MANIFEST_PATH, 'utf-8');
    const manifest = JSON.parse(manifestContent);

    for (const [libName, libInfo] of Object.entries(manifest.libraries)) {
      const lib = libInfo as { repository: string; commits: Record<string, { usedIn: string[]; platforms: string[] }> };

      for (const [commit, commitInfo] of Object.entries(lib.commits)) {
        // 如果指定了场景，只检查该场景使用的库
        if (scenarioName && !commitInfo.usedIn.includes(scenarioName)) {
          continue;
        }

        const commitShort = commit.substring(0, 7);

        // 检查库目录是否存在（不检查平台子目录，因为缓存结构可能不同）
        const cachePath = path.join(CACHE_DIR, libName, commitShort);
        try {
          const stat = await fs.stat(cachePath);
          if (!stat.isDirectory()) {
            return false;
          }
          // 检查目录非空
          const entries = await fs.readdir(cachePath);
          if (entries.length === 0) {
            return false;
          }
        } catch {
          return false;
        }
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * 检查网络是否可用
 *
 * @returns 网络是否可用
 */
export async function checkNetworkAvailable(): Promise<boolean> {
  try {
    // 尝试 DNS 解析一个常用域名
    const dns = await import('dns');
    return new Promise((resolve) => {
      dns.lookup('git.truesightai.com', (err) => {
        resolve(!err);
      });
    });
  } catch {
    return false;
  }
}

/**
 * 跳过测试条件：缓存不完整且网络不可用
 *
 * @param scenarioName 场景名称
 * @returns 是否应该跳过测试
 */
export async function shouldSkipTest(scenarioName?: ScenarioName): Promise<boolean> {
  const cacheComplete = await verifyCacheComplete(scenarioName);
  if (cacheComplete) {
    return false;
  }

  const networkAvailable = await checkNetworkAvailable();
  return !networkAvailable;
}

/**
 * 获取缓存目录路径
 */
export function getCacheDir(): string {
  return CACHE_DIR;
}

/**
 * 获取场景配置目录路径
 */
export function getScenariosDir(): string {
  return SCENARIOS_DIR;
}

/**
 * 获取 manifest 路径
 */
export function getManifestPath(): string {
  return MANIFEST_PATH;
}
