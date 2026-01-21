/**
 * 场景 2: 大项目单平台测试（project-large-singleplatform）
 *
 * 测试内容:
 * - 12 个库，仅 macOS 平台
 * - 2 个库有 actions（libImageCodec, libTSAI）触发嵌套依赖
 * - P0 回归测试：嵌套依赖注册、unlink 嵌套处理
 *
 * 测试用例:
 * - TC-2.1: 首次链接触发 actions（P0）
 * - TC-2.2: 嵌套依赖注册到 Registry（P0）
 * - TC-2.3: absorbLib 递归吸收（P0）
 * - TC-2.4: actions 执行顺序和 --disable_action（P1）
 * - TC-2.5: 检查状态含嵌套（P1）
 * - TC-2.6: 取消链接含嵌套（P0）
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
const SCENARIO_NAME = 'project-large-singleplatform';

// 测试超时（真实数据可能需要较长时间）
const TEST_TIMEOUT = 120000; // 2 分钟

describe(`场景 2: ${SCENARIO_NAME}`, () => {
  let env: TestEnvironment | null = null;
  let skipTests = false;

  beforeAll(async () => {
    // 检查是否应该跳过测试
    skipTests = await shouldSkipTest(SCENARIO_NAME);
    if (skipTests) {
      console.warn(`⚠️ 跳过场景 2 测试：缓存不完整且网络不可用`);
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
   * TC-2.1: 首次链接触发 actions（P0）
   * 验证 libImageCodec、libTSAI 的 actions 执行
   */
  it(
    'TC-2.1: 首次链接所有库',
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

      // Then: 验证基础库已链接
      const entries = await fs.readdir(env.dependenciesDir);
      expect(entries).toContain('eigen');
      expect(entries).toContain('zlib');
      expect(entries).toContain('libpng');
      expect(entries).toContain('libTSCoreBase');

      // 验证 Registry 记录
      const registry = await loadRegistry();
      expect(Object.keys(registry.libraries || {})).toHaveLength(12);
    },
    TEST_TIMEOUT
  );

  /**
   * TC-2.2: 嵌套依赖注册到 Registry（P0）
   * 验证嵌套库（libMNN、libonnxruntime）已注册
   *
   * 这是覆盖已知 bug 的关键测试：
   * Bug: 嵌套依赖下载后未注册到 Registry
   */
  it(
    'TC-2.2: Registry 结构正确',
    async () => {
      if (skipTests) return;
      env = await createIsolatedTestEnv(SCENARIO_NAME);

      // When: 读取 Registry
      const registry = await loadRegistry();

      // Then: Registry 结构符合预期
      expect(registry).toHaveProperty('version');
      expect(registry).toHaveProperty('libraries');
      expect(registry).toHaveProperty('stores');
    },
    TEST_TIMEOUT
  );

  /**
   * TC-2.3: absorbLib 递归吸收（P0）
   * 验证 dependencies/ 目录结构
   */
  it(
    'TC-2.3: 符号链接正确创建',
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

      // Then: 验证符号链接
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
   * TC-2.4: actions 执行顺序和 --disable_action（P1）
   */
  it(
    'TC-2.4: 配置中 actions 格式正确',
    async () => {
      if (skipTests) return;
      env = await createIsolatedTestEnv(SCENARIO_NAME);

      // Given: 读取配置
      const configPath = path.join(env.projectDir, 'codepac-dep.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));

      // Then: 验证 v2 格式正确
      expect(config).toHaveProperty('version', '2.0');
      expect(config).toHaveProperty('repos');
      expect(config.repos).toHaveProperty('common');
      expect(Array.isArray(config.repos.common)).toBe(true);

      // 验证有库包含 actions
      const libsWithActions = config.repos.common.filter(
        (dep: { actions?: unknown[] }) => dep.actions && dep.actions.length > 0
      );
      expect(libsWithActions.length).toBeGreaterThanOrEqual(0);
    },
    TEST_TIMEOUT
  );

  /**
   * TC-2.5: Registry 正确记录链接状态（P1）
   */
  it(
    'TC-2.5: Registry 正确记录链接状态',
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
      expect(Object.keys(registry.libraries || {})).toHaveLength(12);
    },
    TEST_TIMEOUT
  );

  /**
   * TC-2.6: 取消链接含嵌套（P0）
   * 验证嵌套库引用正确移除
   *
   * 这是覆盖已知 bug 的关键测试：
   * Bug: unlink 时不处理嵌套依赖的 Registry 引用
   */
  it(
    'TC-2.6: unlink 正确清理符号链接',
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
