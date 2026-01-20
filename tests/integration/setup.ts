/**
 * 集成测试基础设施
 *
 * 提供测试环境创建、模拟数据生成、验证辅助函数
 *
 * v2.0 更新：
 * - 新增 runCommand() 调用命令入口函数
 * - 新增 createMockStoreDataV2() 创建完整 v0.6 Store 结构
 * - 新增 verifyCleanResult() 验证清理结果
 * - 新增 verifyDirectoryDeleted() 验证目录完全删除
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { expect } from 'vitest';
import type { Registry, StoreEntry, LibraryInfo } from '../../src/types/index.js';

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
    unverifiedLocalStrategy: 'absorb', // 测试中默认吸收无 .git 的本地目录
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

/**
 * 创建 General 类型库的 Store 数据（只有 _shared，无平台目录）
 *
 * @param env 测试环境
 * @param libName 库名
 * @param commit 提交 hash
 */
export async function createMockGeneralStoreData(
  env: TestEnv,
  libName: string,
  commit: string
): Promise<void> {
  const libDir = path.join(env.storeDir, libName, commit);

  // 只创建 _shared 目录
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

  // 创建共享文件
  await fs.writeFile(
    path.join(sharedDir, 'common.cmake'),
    `# CMake config for ${libName}`,
    'utf-8'
  );
  await fs.writeFile(
    path.join(sharedDir, 'config.h'),
    `// Config header for ${libName}`,
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

// ============ v2.0 命令执行 ============

/**
 * 命令类型
 */
export type CommandName = 'clean' | 'link' | 'unlink' | 'status' | 'repair' | 'verify' | 'init';

/**
 * 命令选项类型
 */
export interface CleanOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface LinkOptions {
  platform?: string[];
  yes?: boolean;
  download?: boolean;
  dryRun?: boolean;
  config?: string[];
}

export interface UnlinkOptions {
  remove?: boolean;
}

export interface StatusOptions {
  json?: boolean;
}

export interface RepairOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface InitOptions {
  storePath?: string;
  yes?: boolean;
}

/**
 * 运行命令入口函数
 *
 * 这是集成测试的核心函数，确保测试调用真实的命令入口函数，
 * 而不是手动模拟命令行为。
 *
 * @param command 命令名称
 * @param options 命令选项
 * @param env 测试环境（用于设置 TANMI_DOCK_HOME）
 * @param projectPath 项目路径（link/unlink/status 命令需要）
 */
export async function runCommand(
  command: 'clean',
  options: CleanOptions,
  env: TestEnv
): Promise<void>;
export async function runCommand(
  command: 'link',
  options: LinkOptions,
  env: TestEnv,
  projectPath?: string
): Promise<void>;
export async function runCommand(
  command: 'unlink',
  options: UnlinkOptions,
  env: TestEnv,
  projectPath?: string
): Promise<void>;
export async function runCommand(
  command: 'status',
  options: StatusOptions,
  env: TestEnv,
  projectPath?: string
): Promise<void>;
export async function runCommand(
  command: 'repair',
  options: RepairOptions,
  env: TestEnv
): Promise<void>;
export async function runCommand(
  command: 'verify',
  options: Record<string, never>,
  env: TestEnv
): Promise<void>;
export async function runCommand(
  command: 'init',
  options: InitOptions,
  env: TestEnv
): Promise<void>;
export async function runCommand(
  command: CommandName,
  options: Record<string, unknown>,
  env: TestEnv,
  projectPath?: string
): Promise<void> {
  // 确保环境变量正确设置
  process.env.TANMI_DOCK_HOME = env.homeDir;

  // 清除 registry 单例缓存，确保每次测试使用新的 registry
  const { resetRegistry } = await import('../../src/core/registry.js');
  resetRegistry();

  switch (command) {
    case 'clean': {
      const { cleanLibraries } = await import('../../src/commands/clean.js');
      await cleanLibraries({
        dryRun: (options as CleanOptions).dryRun ?? false,
        force: (options as CleanOptions).force ?? true, // 测试中默认跳过确认
      });
      break;
    }
    case 'link': {
      const { linkProject } = await import('../../src/commands/link.js');
      const linkOpts = options as LinkOptions;
      await linkProject(projectPath ?? env.projectDir, {
        platform: linkOpts.platform,
        yes: linkOpts.yes ?? true, // 测试中默认跳过确认
        download: linkOpts.download ?? false,
        dryRun: linkOpts.dryRun ?? false,
        config: linkOpts.config,
      });
      break;
    }
    case 'unlink': {
      const { unlinkProject } = await import('../../src/commands/unlink.js');
      await unlinkProject(projectPath ?? env.projectDir, {
        remove: (options as UnlinkOptions).remove ?? false,
      });
      break;
    }
    case 'status': {
      const { showStatus } = await import('../../src/commands/status.js');
      await showStatus(projectPath ?? env.projectDir, {
        json: (options as StatusOptions).json ?? false,
      });
      break;
    }
    case 'repair': {
      const { repairIssues } = await import('../../src/commands/check.js');
      const repairOpts = options as RepairOptions;
      await repairIssues({
        dryRun: repairOpts.dryRun ?? false,
        force: repairOpts.force ?? true, // 测试中默认跳过确认
      });
      break;
    }
    case 'verify': {
      const { verifyIntegrity } = await import('../../src/commands/check.js');
      await verifyIntegrity();
      break;
    }
    case 'init': {
      const { initializeDock } = await import('../../src/commands/init.js');
      const initOpts = options as InitOptions;
      await initializeDock({
        storePath: initOpts.storePath ?? env.storeDir,
        yes: initOpts.yes ?? true,
      });
      break;
    }
  }
}

// ============ v2.0 增强 Fixture 创建 ============

/**
 * Store 数据 V2 配置
 */
export interface MockStoreDataV2Config {
  libName: string;
  commit: string;
  branch?: string;
  url?: string;
  platforms: string[];
  /** 是否创建 _shared 目录（默认 true） */
  createShared?: boolean;
  /** _shared 目录下的额外文件 */
  sharedFiles?: Record<string, string>;
  /** 各平台目录下的文件 */
  platformFiles?: Record<string, string>;
  /** 是否同时创建 Registry 记录（默认 true） */
  registerInRegistry?: boolean;
  /** 引用此库的项目路径列表 */
  referencedBy?: string[];
}

/**
 * 创建模拟 Store 数据 V2
 *
 * 生成完整的 v0.6 Store 结构：
 * - store/{libName}/{commit}/_shared/  共享文件目录
 * - store/{libName}/{commit}/{platform}/  平台目录
 *
 * @param env 测试环境
 * @param config Store 数据配置
 */
export async function createMockStoreDataV2(
  env: TestEnv,
  config: MockStoreDataV2Config
): Promise<void> {
  const {
    libName,
    commit,
    branch = 'main',
    url = `https://github.com/test/${libName}.git`,
    platforms,
    createShared = true,
    sharedFiles = {},
    platformFiles = {},
    registerInRegistry = true,
    referencedBy = [],
  } = config;

  const commitDir = path.join(env.storeDir, libName, commit);

  // 创建 _shared 目录
  if (createShared) {
    const sharedDir = path.join(commitDir, '_shared');
    await fs.mkdir(sharedDir, { recursive: true });

    // 默认创建 codepac-dep.json
    const codepacDep = {
      version: '1.0.0',
      vars: {},
      repos: {
        common: [
          {
            url,
            commit,
            branch,
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

    // 创建默认共享文件
    await fs.writeFile(
      path.join(sharedDir, 'common.h'),
      `// Common header for ${libName}`,
      'utf-8'
    );

    // 创建额外共享文件
    for (const [filename, content] of Object.entries(sharedFiles)) {
      await fs.writeFile(path.join(sharedDir, filename), content, 'utf-8');
    }
  }

  // 创建各平台目录
  let totalSize = 0;
  for (const platform of platforms) {
    const platformDir = path.join(commitDir, platform);
    await fs.mkdir(platformDir, { recursive: true });

    // 默认创建平台文件
    const libContent = `Mock library for ${platform}`;
    const headerContent = `// Header for ${platform}`;
    await fs.writeFile(path.join(platformDir, 'lib.a'), libContent, 'utf-8');
    await fs.writeFile(path.join(platformDir, 'include.h'), headerContent, 'utf-8');
    totalSize += libContent.length + headerContent.length;

    // 创建额外平台文件
    for (const [filename, content] of Object.entries(platformFiles)) {
      await fs.writeFile(path.join(platformDir, filename), content, 'utf-8');
      totalSize += content.length;
    }
  }

  // 注册到 Registry
  if (registerInRegistry) {
    const registry = await loadRegistry(env);
    const libKey = `${libName}:${commit}`;

    // 添加 LibraryInfo
    registry.libraries[libKey] = {
      libName,
      commit,
      branch,
      url,
      platforms,
      size: totalSize,
      referencedBy: referencedBy.map(p => hashPath(p)),
      createdAt: new Date().toISOString(),
      lastAccess: new Date().toISOString(),
    };

    // 添加 StoreEntry（每个平台一个）
    for (const platform of platforms) {
      const storeKey = `${libName}:${commit}:${platform}`;
      registry.stores[storeKey] = {
        libName,
        commit,
        platform,
        branch,
        url,
        size: Math.floor(totalSize / platforms.length),
        usedBy: referencedBy.map(p => hashPath(p)),
        createdAt: new Date().toISOString(),
        lastAccess: new Date().toISOString(),
      };
    }

    await saveRegistry(env, registry);
  }
}

/**
 * 计算路径 hash（与 registry 保持一致）
 * 使用 md5 前 12 位，与 src/core/registry.ts 中的 hashPath 一致
 */
export function hashPath(p: string): string {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(p).digest('hex').slice(0, 12);
}

// ============ v2.0 验证函数 ============

/**
 * 清理结果验证配置
 */
export interface CleanVerifyConfig {
  /** 应该被清理的库列表 */
  shouldBeDeleted: Array<{
    libName: string;
    commit: string;
    platforms: string[];
  }>;
  /** 应该保留的库列表 */
  shouldRemain?: Array<{
    libName: string;
    commit: string;
    platforms: string[];
  }>;
}

/**
 * 验证清理结果
 *
 * 同时检查：
 * 1. 磁盘状态 - 目录是否真的被删除
 * 2. Registry libraries 记录
 * 3. Registry stores 记录
 *
 * @param env 测试环境
 * @param config 验证配置
 */
export async function verifyCleanResult(
  env: TestEnv,
  config: CleanVerifyConfig
): Promise<void> {
  const registry = await loadRegistry(env);

  // 验证应该被删除的库
  for (const lib of config.shouldBeDeleted) {
    const libKey = `${lib.libName}:${lib.commit}`;

    // 1. 检查 libraries 记录是否删除
    expect(
      registry.libraries[libKey],
      `Library ${libKey} 应该从 registry.libraries 中删除`
    ).toBeUndefined();

    // 2. 检查各平台的 stores 记录是否删除
    for (const platform of lib.platforms) {
      const storeKey = `${libKey}:${platform}`;
      expect(
        registry.stores[storeKey],
        `Store ${storeKey} 应该从 registry.stores 中删除`
      ).toBeUndefined();

      // 3. 检查磁盘上的平台目录是否删除
      const platformDir = path.join(env.storeDir, lib.libName, lib.commit, platform);
      await verifyDirectoryDeleted(platformDir);
    }

    // 4. 检查 _shared 目录是否删除
    const sharedDir = path.join(env.storeDir, lib.libName, lib.commit, '_shared');
    await verifyDirectoryDeleted(sharedDir);

    // 5. 检查 commit 目录是否删除
    const commitDir = path.join(env.storeDir, lib.libName, lib.commit);
    await verifyDirectoryDeleted(commitDir);
  }

  // 验证应该保留的库
  if (config.shouldRemain) {
    for (const lib of config.shouldRemain) {
      const libKey = `${lib.libName}:${lib.commit}`;

      // 1. 检查 libraries 记录是否存在
      expect(
        registry.libraries[libKey],
        `Library ${libKey} 应该保留在 registry.libraries 中`
      ).toBeDefined();

      // 2. 检查磁盘上的目录是否存在
      for (const platform of lib.platforms) {
        const platformDir = path.join(env.storeDir, lib.libName, lib.commit, platform);
        const exists = await fs.access(platformDir).then(() => true).catch(() => false);
        expect(exists, `平台目录 ${platformDir} 应该存在`).toBe(true);
      }
    }
  }
}

/**
 * 验证目录已被完全删除
 *
 * @param dirPath 目录路径
 */
export async function verifyDirectoryDeleted(dirPath: string): Promise<void> {
  const exists = await fs.access(dirPath).then(() => true).catch(() => false);
  expect(exists, `目录 ${dirPath} 应该被删除`).toBe(false);
}

/**
 * 验证目录存在
 *
 * @param dirPath 目录路径
 */
export async function verifyDirectoryExists(dirPath: string): Promise<void> {
  const exists = await fs.access(dirPath).then(() => true).catch(() => false);
  expect(exists, `目录 ${dirPath} 应该存在`).toBe(true);
}

/**
 * 验证文件存在
 *
 * @param filePath 文件路径
 */
export async function verifyFileExists(filePath: string): Promise<void> {
  const exists = await fs.access(filePath).then(() => true).catch(() => false);
  expect(exists, `文件 ${filePath} 应该存在`).toBe(true);
}

/**
 * 验证 Store 中的库存在
 *
 * @param env 测试环境
 * @param libName 库名
 * @param commit commit hash
 * @param platforms 平台列表
 */
export async function verifyStoreExists(
  env: TestEnv,
  libName: string,
  commit: string,
  platforms: string[]
): Promise<void> {
  // 检查 _shared 目录
  const sharedDir = path.join(env.storeDir, libName, commit, '_shared');
  await verifyDirectoryExists(sharedDir);

  // 检查各平台目录
  for (const platform of platforms) {
    const platformDir = path.join(env.storeDir, libName, commit, platform);
    await verifyDirectoryExists(platformDir);
  }
}

/**
 * 验证 Registry 中的库记录
 *
 * @param env 测试环境
 * @param libName 库名
 * @param commit commit hash
 * @param platforms 平台列表
 */
export async function verifyRegistryEntry(
  env: TestEnv,
  libName: string,
  commit: string,
  platforms: string[]
): Promise<void> {
  const registry = await loadRegistry(env);
  const libKey = `${libName}:${commit}`;

  // 检查 libraries 记录
  expect(
    registry.libraries[libKey],
    `Library ${libKey} 应该存在于 registry.libraries`
  ).toBeDefined();

  // 检查 stores 记录
  for (const platform of platforms) {
    const storeKey = `${libKey}@${platform}`;
    expect(
      registry.stores[storeKey],
      `Store ${storeKey} 应该存在于 registry.stores`
    ).toBeDefined();
  }
}
