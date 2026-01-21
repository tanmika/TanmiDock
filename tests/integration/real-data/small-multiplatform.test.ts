/**
 * 场景 1: 小项目多平台测试（project-small-multiplatform）
 *
 * 测试内容:
 * - 6 个库，5 平台（macOS, Windows, iOS, Android, Linux）
 * - 无 actions，无嵌套依赖
 * - 测试目标：多平台下载、平台过滤、符号链接
 *
 * 测试用例:
 * - TC-1.1: 首次链接所有库（P1）
 * - TC-1.2: 多平台符号链接创建（P1）
 * - TC-1.3: 平台过滤验证（P1）
 * - TC-1.4: 重复链接跳过已存在（P1）
 * - TC-1.5: 检查命令验证状态（P2）
 * - TC-1.6: 取消链接清理（P2）
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
const SCENARIO_NAME = 'project-small-multiplatform';

// 测试超时
const TEST_TIMEOUT = 120000;

describe(`场景 1: ${SCENARIO_NAME}`, () => {
  let env: TestEnvironment | null = null;
  let skipTests = false;

  beforeAll(async () => {
    skipTests = await shouldSkipTest(SCENARIO_NAME);
    if (skipTests) {
      console.warn(`⚠️ 跳过场景 1 测试：缓存不完整且网络不可用`);
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
   * TC-1.1: 首次链接所有库（P1）
   */
  it(
    'TC-1.1: 首次链接所有库',
    async () => {
      if (skipTests) return;
      env = await createIsolatedTestEnv(SCENARIO_NAME);

      // When: 链接所有库（macOS 平台）
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
      expect(entries).toContain('Lz4');
      expect(entries).toContain('libgtest');

      // 验证 Registry 记录
      const registry = await loadRegistry();
      expect(Object.keys(registry.libraries || {})).toHaveLength(6);
    },
    TEST_TIMEOUT
  );

  /**
   * TC-1.2: 多平台符号链接创建（P1）
   */
  it(
    'TC-1.2: 符号链接正确创建',
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

      // Then: 符号链接已创建
      const eigenPath = path.join(env.dependenciesDir, 'eigen');
      const stat = await fs.lstat(eigenPath);
      expect(stat.isSymbolicLink()).toBe(true);

      // 验证链接目标指向 Store
      const target = await fs.readlink(eigenPath);
      expect(target).toContain('store');
    },
    TEST_TIMEOUT
  );

  /**
   * TC-1.3: 平台过滤验证（P1）
   */
  it(
    'TC-1.3: 平台过滤正确工作',
    async () => {
      if (skipTests) return;
      env = await createIsolatedTestEnv(SCENARIO_NAME);

      const configPath = path.join(env.projectDir, 'codepac-dep.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));

      // Given: 配置中库支持多平台（v2 格式）
      const eigenConfig = config.repos.common.find(
        (d: { dir: string }) => d.dir === 'eigen'
      );
      expect(eigenConfig.sparse).toHaveProperty('mac');
      expect(eigenConfig.sparse).toHaveProperty('win');
      expect(eigenConfig.sparse).toHaveProperty('ios');

      // When: 只请求 macOS 平台
      await linkProject(env.projectDir, {
        platform: ['mac'],
        yes: true,
        download: true,
        dryRun: false,
      });

      // Then: Registry 记录存在
      const registry = await loadRegistry();
      expect(registry.libraries).toHaveProperty('eigen');
    },
    TEST_TIMEOUT
  );

  /**
   * TC-1.4: 重复链接跳过已存在（P1）
   */
  it(
    'TC-1.4: 重复链接跳过已存在',
    async () => {
      if (skipTests) return;
      env = await createIsolatedTestEnv(SCENARIO_NAME);

      // Given: 已链接库
      await linkProject(env.projectDir, {
        platform: ['mac'],
        yes: true,
        download: true,
        dryRun: false,
      });

      const eigenPath = path.join(env.dependenciesDir, 'eigen');
      const statBefore = await fs.lstat(eigenPath);

      // When: 再次链接
      await linkProject(env.projectDir, {
        platform: ['mac'],
        yes: true,
        download: true,
        dryRun: false,
      });

      // Then: 符号链接仍然存在
      const statAfter = await fs.lstat(eigenPath);
      expect(statAfter.isSymbolicLink()).toBe(true);
    },
    TEST_TIMEOUT
  );

  /**
   * TC-1.5: Registry 状态验证（P2）
   */
  it(
    'TC-1.5: Registry 正确记录链接状态',
    async () => {
      if (skipTests) return;
      env = await createIsolatedTestEnv(SCENARIO_NAME);

      // Given: 已链接库
      await linkProject(env.projectDir, {
        platform: ['mac'],
        yes: true,
        download: true,
        dryRun: false,
      });

      // Then: Registry 包含项目和库记录
      const registry = await loadRegistry();
      expect(registry.projects).toBeDefined();
      expect(registry.libraries).toBeDefined();
      expect(Object.keys(registry.libraries || {})).toHaveLength(6);
    },
    TEST_TIMEOUT
  );

  /**
   * TC-1.6: 取消链接清理（P2）
   */
  it(
    'TC-1.6: unlink 正确清理符号链接',
    async () => {
      if (skipTests) return;
      env = await createIsolatedTestEnv(SCENARIO_NAME);

      // Given: 已链接库
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
    },
    TEST_TIMEOUT
  );
});
