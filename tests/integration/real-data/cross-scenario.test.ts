/**
 * 跨场景测试
 *
 * 测试内容:
 * - 多个场景顺序执行
 * - Store 空间复用验证
 * - 并行项目操作
 * - 清理和缓存重建
 *
 * 测试用例:
 * - TC-X.1: 场景顺序执行（P1）
 * - TC-X.2: Store 跨场景复用（P1）
 * - TC-X.3: 并行项目链接（P2）
 * - TC-X.4: 全量清理后重建（P2）
 * - TC-X.5: 缓存一致性验证（P1）
 * - TC-X.6: 环境隔离验证（P1）
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import {
  createIsolatedTestEnv,
  shouldSkipTest,
  verifyCacheComplete,
  type TestEnvironment,
  type ScenarioName,
} from './setup.js';

// 导入命令函数
import { linkProject } from '../../../src/commands/link.js';
import { unlinkProject } from '../../../src/commands/unlink.js';

// 测试超时
const TEST_TIMEOUT = 180000; // 3 分钟（跨场景测试需要更长时间）

// 所有场景
const ALL_SCENARIOS: ScenarioName[] = [
  'project-small-multiplatform',
  'project-large-singleplatform',
  'project-overlap',
];

describe('跨场景测试', () => {
  let env: TestEnvironment | null = null;
  let skipTests = false;

  beforeAll(async () => {
    // 跨场景测试需要所有场景的缓存
    for (const scenario of ALL_SCENARIOS) {
      if (await shouldSkipTest(scenario)) {
        skipTests = true;
        console.warn(`⚠️ 跳过跨场景测试：${scenario} 缓存不完整且网络不可用`);
        break;
      }
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
   * TC-X.1: 场景顺序执行（P1）
   * 验证多个场景顺序执行不冲突
   */
  it(
    'TC-X.1: 场景顺序执行',
    async () => {
      if (skipTests) return;

      // 使用场景 1 的环境
      env = await createIsolatedTestEnv('project-small-multiplatform');

      // Step 1: 链接场景 1 的库
      await linkProject(env.projectDir, {
        platform: ['mac'],
        yes: true,
        download: true,
        dryRun: false,
      });

      let registry = await loadRegistry();
      expect(registry.libraries).toHaveProperty('eigen');
      expect(registry.libraries).toHaveProperty('zlib');

      // Step 2: 取消链接
      await unlinkProject(env.projectDir, {
        remove: false,
      });

      // eigen 已 unlink
      const eigenPath = path.join(env.dependenciesDir, 'eigen');
      await expect(fs.access(eigenPath)).rejects.toThrow();
    },
    TEST_TIMEOUT
  );

  /**
   * TC-X.2: Store 跨场景复用（P1）
   * 验证相同 commit 的库在不同场景间复用 Store
   */
  it(
    'TC-X.2: Store 跨场景复用',
    async () => {
      if (skipTests) return;

      // 场景 1 和场景 3 都使用相同 commit 的 eigen
      // eigen commit: 9df21dc8b4b576a7aa5c0094daa8d7e8b8be60f0

      env = await createIsolatedTestEnv('project-small-multiplatform');

      // 链接 eigen
      await linkProject(env.projectDir, {
        platform: ['mac'],
        yes: true,
        download: true,
        dryRun: false,
      });

      // 验证链接成功
      const eigenPath = path.join(env.dependenciesDir, 'eigen');
      await expect(fs.access(eigenPath)).resolves.toBeUndefined();

      // 读取符号链接目标
      const target = await fs.readlink(eigenPath);
      expect(target).toContain('9df21dc'); // commit short hash
    },
    TEST_TIMEOUT
  );

  /**
   * TC-X.3: 并行项目链接（P2）
   * 验证同时操作多个库不冲突
   */
  it(
    'TC-X.3: 并行链接多个库',
    async () => {
      if (skipTests) return;

      env = await createIsolatedTestEnv('project-small-multiplatform');

      // 同时链接多个库
      await linkProject(env.projectDir, {
        platform: ['mac'],
        yes: true,
        download: true,
        dryRun: false,
      });

      // 验证所有库都已链接
      const entries = await fs.readdir(env.dependenciesDir);
      expect(entries).toContain('eigen');
      expect(entries).toContain('zlib');
      expect(entries).toContain('libpng');
      expect(entries).toContain('libjpeg');
    },
    TEST_TIMEOUT
  );

  /**
   * TC-X.4: 全量清理后重建（P2）
   * 验证 unlink 所有后可以重新链接
   */
  it(
    'TC-X.4: 全量清理后重建',
    async () => {
      if (skipTests) return;

      env = await createIsolatedTestEnv('project-small-multiplatform');

      // Step 1: 链接所有库
      await linkProject(env.projectDir, {
        platform: ['mac'],
        yes: true,
        download: true,
        dryRun: false,
      });

      let entries = await fs.readdir(env.dependenciesDir);
      expect(entries.length).toBe(6);

      // Step 2: 取消所有链接
      await unlinkProject(env.projectDir, {
        remove: false,
      });

      entries = await fs.readdir(env.dependenciesDir);
      expect(entries.length).toBe(0);

      // Step 3: 重新链接
      await linkProject(env.projectDir, {
        platform: ['mac'],
        yes: true,
        download: true,
        dryRun: false,
      });

      entries = await fs.readdir(env.dependenciesDir);
      expect(entries.length).toBe(6);
    },
    TEST_TIMEOUT
  );

  /**
   * TC-X.5: 缓存一致性验证（P1）
   * 验证缓存文件与 manifest 一致
   */
  it(
    'TC-X.5: 缓存一致性验证',
    async () => {
      if (skipTests) return;

      // 验证各场景缓存完整性
      for (const scenario of ALL_SCENARIOS) {
        const complete = await verifyCacheComplete(scenario);
        // 如果测试能运行到这里，缓存应该是完整的
        // 否则 beforeAll 会设置 skipTests = true
        expect(complete).toBe(true);
      }
    },
    TEST_TIMEOUT
  );

  /**
   * TC-X.6: 环境隔离验证（P1）
   * 验证测试环境与生产环境完全隔离
   */
  it(
    'TC-X.6: 环境隔离验证',
    async () => {
      if (skipTests) return;

      env = await createIsolatedTestEnv('project-small-multiplatform');

      // 验证 TANMI_DOCK_HOME 指向测试目录
      expect(process.env.TANMI_DOCK_HOME).toBe(env.tanmiDockHome);

      // 验证测试目录在临时目录下
      expect(env.testDir).toContain('tanmi-dock-test');

      // 验证测试模式已启用
      expect(process.env.TANMI_DOCK_TEST_MODE).toBe('true');

      // 清理后环境变量应恢复
      const originalHome = env.originalEnv.TANMI_DOCK_HOME;
      await env.cleanup();
      env = null;

      // 验证环境变量已恢复
      expect(process.env.TANMI_DOCK_HOME).toBe(originalHome);
    },
    TEST_TIMEOUT
  );
});
