/**
 * TC-016: clean 命令测试
 *
 * 测试场景:
 * - S-5.1.1: unreferenced 策略 - 清理无引用库（含 _shared 目录）
 * - S-5.1.2: unused 策略 - 基于 unlinkedAt 时间清理
 * - S-5.1.3: manual 策略 - 用户选择清理（需要交互，跳过）
 * - S-5.2.1: 保护有引用的库
 * - S-5.2.2: 清理失效引用
 * - S-5.2.3: --dry-run 模式
 * - S-5.2.4: stores 记录同步删除
 *
 * v2.0 重写：调用 cleanLibraries() 入口函数，不手动模拟
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import {
  createTestEnv,
  createMockStoreDataV2,
  loadRegistry,
  saveRegistry,
  runCommand,
  verifyCleanResult,
  verifyDirectoryDeleted,
  verifyDirectoryExists,
  hashPath,
  type TestEnv,
} from './setup.js';
import type { Registry } from '../../src/types/index.js';

describe('TC-016: clean 命令测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('S-5.1.1: unreferenced 策略 - 清理无引用库', () => {
    it('should clean unreferenced library including _shared directory', async () => {
      env = await createTestEnv();

      const libName = 'libUnreferenced';
      const commit = 'unreferenced123456';

      // 使用 V2 创建包含 _shared 的完整 Store 数据
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        referencedBy: [], // 无引用
      });

      // 验证创建成功
      await verifyDirectoryExists(path.join(env.storeDir, libName, commit, '_shared'));
      await verifyDirectoryExists(path.join(env.storeDir, libName, commit, 'macOS'));

      // 调用 clean 命令
      await runCommand('clean', { force: true }, env);

      // 验证清理结果
      await verifyCleanResult(env, {
        shouldBeDeleted: [{ libName, commit, platforms: ['macOS'] }],
      });
    });

    it('should clean multiple unreferenced libraries', async () => {
      env = await createTestEnv();

      // 创建两个无引用库
      await createMockStoreDataV2(env, {
        libName: 'libA',
        commit: 'commitA123456',
        platforms: ['macOS', 'iOS'],
        referencedBy: [],
      });

      await createMockStoreDataV2(env, {
        libName: 'libB',
        commit: 'commitB123456',
        platforms: ['android'],
        referencedBy: [],
      });

      // 调用 clean 命令
      await runCommand('clean', { force: true }, env);

      // 验证两个库都被清理
      await verifyCleanResult(env, {
        shouldBeDeleted: [
          { libName: 'libA', commit: 'commitA123456', platforms: ['macOS', 'iOS'] },
          { libName: 'libB', commit: 'commitB123456', platforms: ['android'] },
        ],
      });
    });

    it('should clean library with only _shared directory remaining', async () => {
      env = await createTestEnv();

      const libName = 'libSharedOnly';
      const commit = 'sharedonly123456';

      // 手动创建只有 _shared 目录的情况
      const commitDir = path.join(env.storeDir, libName, commit);
      const sharedDir = path.join(commitDir, '_shared');
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.writeFile(path.join(sharedDir, 'codepac-dep.json'), '{}', 'utf-8');

      // 创建 Registry 记录
      const registry = await loadRegistry(env);
      const libKey = `${libName}:${commit}`;
      registry.libraries[libKey] = {
        libName,
        commit,
        branch: 'main',
        url: `https://github.com/test/${libName}.git`,
        platforms: [],
        size: 100,
        referencedBy: [],
        createdAt: new Date().toISOString(),
        lastAccess: new Date().toISOString(),
      };
      await saveRegistry(env, registry);

      // 验证 _shared 存在
      await verifyDirectoryExists(sharedDir);

      // 调用 clean 命令
      await runCommand('clean', { force: true }, env);

      // 验证 _shared 和整个 commit 目录都被删除
      await verifyDirectoryDeleted(sharedDir);
      await verifyDirectoryDeleted(commitDir);

      // 验证 registry 记录被删除
      const afterRegistry = await loadRegistry(env);
      expect(afterRegistry.libraries[libKey]).toBeUndefined();
    });
  });

  describe('S-5.1.2: unused 策略 - 基于 unlinkedAt 时间清理', () => {
    it('should identify library exceeding unused days threshold', async () => {
      env = await createTestEnv();

      const libName = 'libUnused';
      const commit = 'unused123456';

      // 创建 Store 数据（不含 Registry，手动设置 unlinkedAt）
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        registerInRegistry: false,
      });

      // 手动创建带有 unlinkedAt 超过 30 天的 Registry 记录
      const thirtyOneDaysAgo = Date.now() - (31 * 24 * 60 * 60 * 1000);
      const registry = await loadRegistry(env);
      const storeKey = `${libName}:${commit}:macOS`;
      registry.stores[storeKey] = {
        libName,
        commit,
        platform: 'macOS',
        branch: 'main',
        url: `https://github.com/test/${libName}.git`,
        size: 1024,
        usedBy: [],
        unlinkedAt: thirtyOneDaysAgo,
        createdAt: new Date().toISOString(),
        lastAccess: new Date().toISOString(),
      };
      await saveRegistry(env, registry);

      // 修改配置为 unused 策略
      const configPath = path.join(env.homeDir, 'config.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      config.cleanStrategy = 'unused';
      config.unusedDays = 30;
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

      // 调用 clean 命令
      await runCommand('clean', { force: true }, env);

      // 验证 stores 记录被删除
      const afterRegistry = await loadRegistry(env);
      expect(afterRegistry.stores[storeKey]).toBeUndefined();

      // 验证磁盘上的目录被删除
      await verifyDirectoryDeleted(path.join(env.storeDir, libName, commit, 'macOS'));
    });

    it('should not clean library within unused days threshold', async () => {
      env = await createTestEnv();

      const libName = 'libRecentUnused';
      const commit = 'recentunused123456';

      // 创建 Store 数据
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        registerInRegistry: false,
      });

      // 手动创建带有 unlinkedAt 未超过 30 天的 Registry 记录
      const tenDaysAgo = Date.now() - (10 * 24 * 60 * 60 * 1000);
      const registry = await loadRegistry(env);
      const storeKey = `${libName}:${commit}:macOS`;
      registry.stores[storeKey] = {
        libName,
        commit,
        platform: 'macOS',
        branch: 'main',
        url: `https://github.com/test/${libName}.git`,
        size: 1024,
        usedBy: [],
        unlinkedAt: tenDaysAgo,
        createdAt: new Date().toISOString(),
        lastAccess: new Date().toISOString(),
      };
      await saveRegistry(env, registry);

      // 修改配置为 unused 策略
      const configPath = path.join(env.homeDir, 'config.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      config.cleanStrategy = 'unused';
      config.unusedDays = 30;
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

      // 调用 clean 命令
      await runCommand('clean', { force: true }, env);

      // 验证 stores 记录未被删除
      const afterRegistry = await loadRegistry(env);
      expect(afterRegistry.stores[storeKey]).toBeDefined();

      // 验证磁盘上的目录未被删除
      await verifyDirectoryExists(path.join(env.storeDir, libName, commit, 'macOS'));
    });
  });

  describe('S-5.2.1: 保护有引用的库', () => {
    it('should not clean library with active references', async () => {
      env = await createTestEnv();

      const libName = 'libReferenced';
      const commit = 'referenced123456';

      // 创建有引用的库
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        referencedBy: [env.projectDir], // 有引用
      });

      // 同时创建项目记录
      const registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      registry.projects[projectHash] = {
        path: env.projectDir,
        platforms: ['macOS'],
        dependencies: [
          {
            libName,
            commit,
            linkedPath: `3rdParty/${libName}`,
            platform: 'macOS',
          },
        ],
      };
      await saveRegistry(env, registry);

      // 调用 clean 命令
      await runCommand('clean', { force: true }, env);

      // 验证库未被清理
      await verifyCleanResult(env, {
        shouldBeDeleted: [],
        shouldRemain: [{ libName, commit, platforms: ['macOS'] }],
      });
    });
  });

  describe('S-5.2.2: 清理失效引用', () => {
    it('should clean stale references from non-existent projects', async () => {
      env = await createTestEnv();

      const libName = 'libStaleRef';
      const commit = 'staleref123456';
      const staleProjectPath = '/nonexistent/stale/project';

      // 创建引用了不存在项目的库
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        referencedBy: [staleProjectPath],
      });

      // 验证初始状态有引用
      const beforeRegistry = await loadRegistry(env);
      const libKey = `${libName}:${commit}`;
      expect(beforeRegistry.libraries[libKey].referencedBy.length).toBeGreaterThan(0);

      // 调用 clean 命令（会先清理失效引用，然后清理无引用库）
      await runCommand('clean', { force: true }, env);

      // 由于项目不存在，引用会被清理，然后库变成无引用被删除
      await verifyCleanResult(env, {
        shouldBeDeleted: [{ libName, commit, platforms: ['macOS'] }],
      });
    });
  });

  describe('S-5.2.3: --dry-run 模式', () => {
    it('should not delete anything in dry-run mode', async () => {
      env = await createTestEnv();

      const libName = 'libDryRun';
      const commit = 'dryrun123456';

      // 创建无引用库
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 调用 clean 命令（dry-run 模式）
      await runCommand('clean', { dryRun: true, force: true }, env);

      // 验证库未被删除
      await verifyCleanResult(env, {
        shouldBeDeleted: [],
        shouldRemain: [{ libName, commit, platforms: ['macOS'] }],
      });
    });
  });

  describe('S-5.2.4: stores 记录同步删除', () => {
    it('should sync delete stores records when cleaning library', async () => {
      env = await createTestEnv();

      const libName = 'libStoresSync';
      const commit = 'storessync123456';

      // 创建多平台无引用库
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS', 'iOS', 'android'],
        referencedBy: [],
      });

      // 验证初始 stores 记录存在
      const beforeRegistry = await loadRegistry(env);
      expect(beforeRegistry.stores[`${libName}:${commit}:macOS`]).toBeDefined();
      expect(beforeRegistry.stores[`${libName}:${commit}:iOS`]).toBeDefined();
      expect(beforeRegistry.stores[`${libName}:${commit}:android`]).toBeDefined();

      // 调用 clean 命令
      await runCommand('clean', { force: true }, env);

      // 验证所有 stores 记录都被删除
      const afterRegistry = await loadRegistry(env);
      expect(afterRegistry.stores[`${libName}:${commit}:macOS`]).toBeUndefined();
      expect(afterRegistry.stores[`${libName}:${commit}:iOS`]).toBeUndefined();
      expect(afterRegistry.stores[`${libName}:${commit}:android`]).toBeUndefined();

      // 验证 libraries 记录也被删除
      expect(afterRegistry.libraries[`${libName}:${commit}`]).toBeUndefined();
    });
  });
});
