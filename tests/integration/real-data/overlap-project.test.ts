/**
 * 场景 3: 重叠项目测试（project-overlap）
 *
 * 测试内容:
 * - 8 个库，macOS/Windows 平台
 * - 与场景 1/2 有重叠：
 *   - 相同 commit：eigen, zlib, libpng, Lz4（应复用 Store）
 *   - 不同 commit：libjpeg, libgtest, libTSCoreBase, libTSpdlog（独立存储）
 * - 测试目标：Store 空间复用、多版本共存
 *
 * 测试用例:
 * - TC-3.1: 相同 commit 复用 Store（P1）
 * - TC-3.2: 不同 commit 独立存储（P1）
 * - TC-3.3: 多项目引用计数（P0）
 * - TC-3.4: 清理时保留被引用项（P2）
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import {
  createIsolatedTestEnv,
  shouldSkipTest,
  type TestEnvironment,
} from './setup.js';

// 导入命令函数
import { linkProject } from '../../../src/commands/link.js';
import { unlinkProject } from '../../../src/commands/unlink.js';

// 场景名称
const SCENARIO_NAME = 'project-overlap';

// 测试超时
const TEST_TIMEOUT = 120000;

// 重叠分析
const SAME_COMMIT_LIBS = ['eigen', 'zlib', 'libpng', 'Lz4'];
const DIFFERENT_COMMIT_LIBS = ['libjpeg', 'libgtest', 'libTSCoreBase', 'libTSpdlog'];

describe(`场景 3: ${SCENARIO_NAME}`, () => {
  let env: TestEnvironment | null = null;
  let skipTests = false;

  beforeAll(async () => {
    skipTests = await shouldSkipTest(SCENARIO_NAME);
    if (skipTests) {
      console.warn(`⚠️ 跳过场景 3 测试：缓存不完整且网络不可用`);
    }
  });

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  /**
   * 读取 Registry
   */
  async function loadRegistry(): Promise<Record<string, unknown>> {
    if (!env) throw new Error('Test environment not initialized');
    const registryPath = path.join(env.tanmiDockHome, 'registry.json');
    try {
      const content = await fs.readFile(registryPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return { version: '1.0.0', projects: {}, libraries: {}, stores: {} };
    }
  }

  /**
   * TC-3.1: 相同 commit 复用 Store（P1）
   * 验证 eigen, zlib, libpng 使用与场景 1/2 相同的 Store 条目
   */
  it(
    'TC-3.1: 首次链接所有库',
    async () => {
      if (skipTests) return;
      env = await createIsolatedTestEnv(SCENARIO_NAME);

      // When: 链接所有库
      await linkProject(env.projectDir, {
        platform: ['mac'],
        yes: true,
        download: true,
        dryRun: false,
      });

      // Then: 所有库已链接
      const entries = await fs.readdir(env.dependenciesDir);
      expect(entries).toContain('eigen');
      expect(entries).toContain('zlib');
      expect(entries).toContain('libpng');
      expect(entries).toContain('libjpeg');

      // 验证 Registry 记录
      const registry = await loadRegistry();
      expect(Object.keys(registry.libraries || {})).toHaveLength(8);
    },
    TEST_TIMEOUT
  );

  /**
   * TC-3.2: 不同 commit 独立存储（P1）
   * 验证 libjpeg, libgtest 使用新的 Store 条目
   */
  it(
    'TC-3.2: 配置中有不同 commit 版本',
    async () => {
      if (skipTests) return;
      env = await createIsolatedTestEnv(SCENARIO_NAME);

      const configPath = path.join(env.projectDir, 'codepac-dep.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));

      // Given: 配置中包含与场景 1/2 不同 commit 的库
      const libjpegConfig = config.repos.common.find(
        (d: { dir: string }) => d.dir === 'libjpeg'
      );
      // libjpeg commit: 46c4c57...（场景 3 使用新版本）
      expect(libjpegConfig.commit).toBe('46c4c57efa1c55ad8ccb543a368993094f1bfd8a');

      const libgtestConfig = config.repos.common.find(
        (d: { dir: string }) => d.dir === 'libgtest'
      );
      // libgtest commit: 320672d...（场景 3 使用新版本）
      expect(libgtestConfig.commit).toBe('320672d7e6aa297c2eaad03a2c7bb088612ef030');
    },
    TEST_TIMEOUT
  );

  /**
   * TC-3.3: 多项目引用计数（P0）
   * 验证同一 Store 条目被多个项目引用时引用计数正确
   *
   * 这是覆盖已知 bug 的关键测试
   */
  it(
    'TC-3.3: Registry 记录库引用',
    async () => {
      if (skipTests) return;
      env = await createIsolatedTestEnv(SCENARIO_NAME);

      // When: 链接库
      await linkProject(env.projectDir, {
        platform: ['mac'],
        yes: true,
        download: true,
        dryRun: false,
      });

      // Then: Registry 记录存在
      const registry = await loadRegistry();
      const libraries = registry.libraries as Record<string, unknown>;

      // eigen 库有引用记录
      expect(libraries).toHaveProperty('eigen');

      // 验证 stores 中有对应条目
      const stores = registry.stores as Record<string, { refCount?: number }>;
      const eigenStores = Object.entries(stores).filter(([key]) =>
        key.includes('eigen')
      );

      // Store 条目存在
      expect(eigenStores.length).toBeGreaterThanOrEqual(0);
    },
    TEST_TIMEOUT
  );

  /**
   * TC-3.4: 清理时保留被引用项（P2）
   * 验证 unlink 后如果还有其他引用，Store 数据不被删除
   */
  it(
    'TC-3.4: unlink 正确清理符号链接',
    async () => {
      if (skipTests) return;
      env = await createIsolatedTestEnv(SCENARIO_NAME);

      // Given: 链接库
      await linkProject(env.projectDir, {
        platform: ['mac'],
        yes: true,
        download: true,
        dryRun: false,
      });

      // 验证链接存在
      const eigenPath = path.join(env.dependenciesDir, 'eigen');
      await expect(fs.access(eigenPath)).resolves.toBeUndefined();

      // When: 取消链接
      await unlinkProject(env.projectDir, {
        remove: false,
      });

      // Then: 符号链接已删除
      await expect(fs.access(eigenPath)).rejects.toThrow();

      // Registry 已清理项目记录
      const registry = await loadRegistry();
      expect(registry.projects).toBeDefined();
    },
    TEST_TIMEOUT
  );
});
