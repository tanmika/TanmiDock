/**
 * 集成测试基础设施
 *
 * 提供测试环境创建、模拟数据生成、验证辅助函数
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { expect } from 'vitest';
import type { Registry } from '../../src/types/index.js';

// ============ 类型定义 ============

/**
 * 测试环境
 */
export interface TestEnv {
  /** 临时根目录 */
  tempDir: string;
  /** TANMI_DOCK_HOME 目录 */
  homeDir: string;
  /** Store 目录 */
  storeDir: string;
  /** 模拟项目目录 */
  projectDir: string;
  /** 清理函数 */
  cleanup: () => Promise<void>;
}

/**
 * 依赖配置
 */
export interface MockDependency {
  libName: string;
  linkedPath: string;
}

// ============ 环境管理 ============

/**
 * 保存原始环境变量
 */
let originalTanmiDockHome: string | undefined;

/**
 * 创建隔离测试环境
 * - 创建临时目录结构
 * - 设置 process.env.TANMI_DOCK_HOME
 * - 返回 TestEnv 对象
 */
export async function createTestEnv(): Promise<TestEnv> {
  // 保存原始环境变量
  originalTanmiDockHome = process.env.TANMI_DOCK_HOME;

  // 创建临时根目录
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tanmi-dock-test-'));

  // 创建目录结构
  const homeDir = path.join(tempDir, '.tanmi-dock');
  const storeDir = path.join(tempDir, 'store');
  const projectDir = path.join(tempDir, 'project');

  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(storeDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });

  // 设置环境变量
  process.env.TANMI_DOCK_HOME = homeDir;

  // 创建初始配置文件
  const config = {
    version: '1.1.0',
    initialized: true,
    storePath: storeDir,
    cleanStrategy: 'unreferenced',
    unusedDays: 30,
    autoDownload: true,
  };
  await fs.writeFile(
    path.join(homeDir, 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8'
  );

  // 创建空注册表
  const registry: Registry = {
    version: '1.0.0',
    projects: {},
    libraries: {},
    stores: {},
  };
  await fs.writeFile(
    path.join(homeDir, 'registry.json'),
    JSON.stringify(registry, null, 2),
    'utf-8'
  );

  // 返回 TestEnv
  return {
    tempDir,
    homeDir,
    storeDir,
    projectDir,
    cleanup: async () => {
      // 恢复环境变量
      if (originalTanmiDockHome !== undefined) {
        process.env.TANMI_DOCK_HOME = originalTanmiDockHome;
      } else {
        delete process.env.TANMI_DOCK_HOME;
      }

      // 删除临时目录
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

// ============ 模拟数据创建 ============

/**
 * 创建模拟 Store 数据
 * - 在 env.storeDir 下创建 libName/commit/platform 目录结构
 * - 每个平台目录下创建示例文件
 * - 创建 _shared 目录，包含 codepac-dep.json 等共享文件
 *
 * @param env 测试环境
 * @param libName 库名
 * @param commit 提交 hash
 * @param platforms 平台列表
 */
export async function createMockStoreData(
  env: TestEnv,
  libName: string,
  commit: string,
  platforms: string[]
): Promise<void> {
  const libDir = path.join(env.storeDir, libName, commit);

  // 创建各平台目录及示例文件
  for (const platform of platforms) {
    const platformDir = path.join(libDir, platform);
    await fs.mkdir(platformDir, { recursive: true });

    // 创建示例文件
    await fs.writeFile(
      path.join(platformDir, 'lib.a'),
      `Mock library for ${platform}`,
      'utf-8'
    );
    await fs.writeFile(
      path.join(platformDir, 'include.h'),
      `// Header for ${platform}`,
      'utf-8'
    );
  }

  // 创建 _shared 目录
  const sharedDir = path.join(libDir, '_shared');
  await fs.mkdir(sharedDir, { recursive: true });

  // 创建 codepac-dep.json
  const codepacDep = {
    version: '1.0.0',
    vars: {},
    repos: {
      common: [
        {
          url: `https://github.com/test/${libName}.git`,
          commit,
          branch: 'main',
          dir: libName,
        },
      ],
    },
  };
  await fs.writeFile(
    path.join(sharedDir, 'codepac-dep.json'),
    JSON.stringify(codepacDep, null, 2),
    'utf-8'
  );

  // 创建共享头文件
  await fs.writeFile(
    path.join(sharedDir, 'common.h'),
    `// Common header for ${libName}`,
    'utf-8'
  );
}

/**
 * 创建模拟项目结构
 * - 在 env.projectDir 下创建 3rdparty 目录
 * - deps 指定依赖列表 [{libName, linkedPath}]
 *
 * @param env 测试环境
 * @param deps 依赖列表
 */
export async function createMockProjectData(
  env: TestEnv,
  deps: MockDependency[]
): Promise<void> {
  const thirdpartyDir = path.join(env.projectDir, '3rdparty');
  await fs.mkdir(thirdpartyDir, { recursive: true });

  // 为每个依赖创建目录
  for (const dep of deps) {
    const depDir = path.join(thirdpartyDir, dep.libName);
    await fs.mkdir(depDir, { recursive: true });

    // 如果指定了 linkedPath，创建符号链接
    if (dep.linkedPath) {
      // 检查源路径是否存在
      try {
        await fs.access(dep.linkedPath);
        // 删除已创建的目录，用符号链接替换
        await fs.rm(depDir, { recursive: true });
        await fs.symlink(dep.linkedPath, depDir);
      } catch {
        // 源路径不存在，保持普通目录
      }
    }
  }

  // 创建 codepac-dep.json
  const codepacDep = {
    version: '1.0.0',
    vars: {},
    repos: {
      common: deps.map((dep) => ({
        url: `https://github.com/test/${dep.libName}.git`,
        commit: 'abc123',
        branch: 'main',
        dir: dep.libName,
      })),
    },
  };
  await fs.writeFile(
    path.join(env.projectDir, 'codepac-dep.json'),
    JSON.stringify(codepacDep, null, 2),
    'utf-8'
  );
}

// ============ 验证函数 ============

/**
 * 验证符号链接指向正确目标
 * - 符号链接存在且指向正确目标时不抛错
 * - 否则抛出断言错误
 *
 * @param linkPath 符号链接路径
 * @param expectedTarget 期望的目标路径
 */
export async function verifySymlink(
  linkPath: string,
  expectedTarget: string
): Promise<void> {
  // 检查路径是否存在
  const stats = await fs.lstat(linkPath);
  expect(stats.isSymbolicLink(), `${linkPath} 应该是符号链接`).toBe(true);

  // 检查符号链接目标
  const actualTarget = await fs.readlink(linkPath);

  // 规范化路径进行比较
  const normalizedActual = path.resolve(path.dirname(linkPath), actualTarget);
  const normalizedExpected = path.resolve(expectedTarget);

  expect(
    normalizedActual,
    `符号链接 ${linkPath} 应该指向 ${expectedTarget}`
  ).toBe(normalizedExpected);
}

/**
 * 验证路径不是符号链接
 * - 路径存在且不是符号链接时不抛错
 * - 否则抛出断言错误
 *
 * @param targetPath 要验证的路径
 */
export async function verifyNotSymlink(targetPath: string): Promise<void> {
  const stats = await fs.lstat(targetPath);
  expect(stats.isSymbolicLink(), `${targetPath} 不应该是符号链接`).toBe(false);
}

/**
 * 验证目录包含指定条目
 * - 目录存在且包含所有指定条目时不抛错
 * - 否则抛出断言错误
 *
 * @param dirPath 目录路径
 * @param expectedEntries 期望包含的条目列表
 */
export async function verifyDirectoryContents(
  dirPath: string,
  expectedEntries: string[]
): Promise<void> {
  const entries = await fs.readdir(dirPath);

  for (const expected of expectedEntries) {
    expect(
      entries,
      `目录 ${dirPath} 应该包含 ${expected}`
    ).toContain(expected);
  }
}

/**
 * 加载并返回 registry.json 数据
 *
 * @param env 测试环境
 * @returns Registry 数据
 */
export async function loadRegistry(env: TestEnv): Promise<Registry> {
  const registryPath = path.join(env.homeDir, 'registry.json');
  const content = await fs.readFile(registryPath, 'utf-8');
  return JSON.parse(content) as Registry;
}

/**
 * 保存 registry.json 数据
 *
 * @param env 测试环境
 * @param registry Registry 数据
 */
export async function saveRegistry(env: TestEnv, registry: Registry): Promise<void> {
  const registryPath = path.join(env.homeDir, 'registry.json');
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
}
