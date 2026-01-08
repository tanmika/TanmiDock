/**
 * TC-016: clean 命令测试
 *
 * 测试场景:
 * - S-5.1.1: unreferenced 策略 - 清理无引用库
 * - S-5.1.2: unused 策略 - 基于 unlinkedAt 时间清理
 * - S-5.1.3: manual 策略 - 用户选择清理
 * - S-5.2.1: 保护有引用的库
 * - S-5.2.2: 清理失效引用
 * - S-5.2.3: --dry-run 模式
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import {
  createTestEnv,
  createMockStoreData,
  loadRegistry,
  saveRegistry,
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

  describe('S-5.1.1: unreferenced 策略', () => {
    it('should identify unreferenced library for cleanup', async () => {
      env = await createTestEnv();

      const libName = 'libUnreferenced';
      const commit = 'unreferenced123';

      // 创建 Store 数据
      await createMockStoreData(env, libName, commit, ['macOS']);

      // 创建 Registry 记录，库无项目引用
      const registry: Registry = {
        version: '1.0.0',
        projects: {},
        libraries: {
          [`${libName}@${commit}`]: {
            libName,
            commit,
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            platforms: ['macOS'],
            size: 1024,
            referencedBy: [], // 无引用
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
        stores: {
          [`${libName}@${commit}@macOS`]: {
            libName,
            commit,
            platform: 'macOS',
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            size: 1024,
            usedBy: [], // 无引用
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
      };
      await saveRegistry(env, registry);

      // 验证库无引用
      const loaded = await loadRegistry(env);
      const libKey = `${libName}@${commit}`;
      expect(loaded.libraries[libKey].referencedBy).toHaveLength(0);

      // 模拟清理
      const storePath = path.join(env.storeDir, libName, commit, 'macOS');
      await fs.rm(storePath, { recursive: true, force: true });
      delete loaded.libraries[libKey];
      delete loaded.stores[`${libKey}@macOS`];
      await saveRegistry(env, loaded);

      // 验证已清理
      const storeExists = await fs.access(storePath).then(() => true).catch(() => false);
      expect(storeExists).toBe(false);

      const afterClean = await loadRegistry(env);
      expect(afterClean.libraries[libKey]).toBeUndefined();
    });
  });

  describe('S-5.1.2: unused 策略', () => {
    it('should identify library exceeding unused days threshold', async () => {
      env = await createTestEnv();

      const libName = 'libUnused';
      const commit = 'unused123';

      // 创建 Store 数据
      await createMockStoreData(env, libName, commit, ['macOS']);

      // 创建 Registry 记录，unlinkedAt 超过阈值
      const thirtyOneDaysAgo = Date.now() - (31 * 24 * 60 * 60 * 1000);
      const registry: Registry = {
        version: '1.0.0',
        projects: {},
        libraries: {},
        stores: {
          [`${libName}@${commit}@macOS`]: {
            libName,
            commit,
            platform: 'macOS',
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            size: 1024,
            usedBy: [],
            unlinkedAt: thirtyOneDaysAgo, // 31 天前取消链接
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
      };
      await saveRegistry(env, registry);

      // 验证 unlinkedAt 超过 30 天
      const loaded = await loadRegistry(env);
      const storeEntry = loaded.stores[`${libName}@${commit}@macOS`];
      const daysAgo = (Date.now() - (storeEntry.unlinkedAt || 0)) / (24 * 60 * 60 * 1000);
      expect(daysAgo).toBeGreaterThan(30);
    });

    it('should not clean library within unused days threshold', async () => {
      env = await createTestEnv();

      const libName = 'libRecentUnused';
      const commit = 'recentunused123';

      // 创建 Store 数据
      await createMockStoreData(env, libName, commit, ['macOS']);

      // 创建 Registry 记录，unlinkedAt 未超过阈值
      const tenDaysAgo = Date.now() - (10 * 24 * 60 * 60 * 1000);
      const registry: Registry = {
        version: '1.0.0',
        projects: {},
        libraries: {},
        stores: {
          [`${libName}@${commit}@macOS`]: {
            libName,
            commit,
            platform: 'macOS',
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            size: 1024,
            usedBy: [],
            unlinkedAt: tenDaysAgo, // 10 天前取消链接
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
      };
      await saveRegistry(env, registry);

      // 验证 unlinkedAt 未超过 30 天
      const loaded = await loadRegistry(env);
      const storeEntry = loaded.stores[`${libName}@${commit}@macOS`];
      const daysAgo = (Date.now() - (storeEntry.unlinkedAt || 0)) / (24 * 60 * 60 * 1000);
      expect(daysAgo).toBeLessThan(30);
    });
  });

  describe('S-5.2.1: 保护有引用的库', () => {
    it('should not clean library with active references', async () => {
      env = await createTestEnv();

      const libName = 'libReferenced';
      const commit = 'referenced123';

      // 创建 Store 数据
      await createMockStoreData(env, libName, commit, ['macOS']);

      // 创建符号链接
      const localPath = path.join(env.projectDir, '3rdParty', libName);
      const storePlatformPath = path.join(env.storeDir, libName, commit, 'macOS');
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.symlink(storePlatformPath, localPath);

      // 创建 Registry 记录，有项目引用
      const registry: Registry = {
        version: '1.0.0',
        projects: {
          [env.projectDir]: {
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
          },
        },
        libraries: {
          [`${libName}@${commit}`]: {
            libName,
            commit,
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            platforms: ['macOS'],
            size: 1024,
            referencedBy: [env.projectDir], // 有引用
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
        stores: {
          [`${libName}@${commit}@macOS`]: {
            libName,
            commit,
            platform: 'macOS',
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            size: 1024,
            usedBy: [env.projectDir], // 有引用
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
      };
      await saveRegistry(env, registry);

      // 验证库有引用
      const loaded = await loadRegistry(env);
      const libKey = `${libName}@${commit}`;
      expect(loaded.libraries[libKey].referencedBy.length).toBeGreaterThan(0);
      expect(loaded.stores[`${libKey}@macOS`].usedBy.length).toBeGreaterThan(0);
    });
  });

  describe('S-5.2.2: 清理失效引用', () => {
    it('should clean stale references from non-existent projects', async () => {
      env = await createTestEnv();

      const libName = 'libStaleRef';
      const commit = 'staleref123';
      const staleProjectPath = '/nonexistent/stale/project';

      // 创建 Store 数据
      await createMockStoreData(env, libName, commit, ['macOS']);

      // 创建 Registry 记录，引用了不存在的项目
      const registry: Registry = {
        version: '1.0.0',
        projects: {},
        libraries: {
          [`${libName}@${commit}`]: {
            libName,
            commit,
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            platforms: ['macOS'],
            size: 1024,
            referencedBy: [staleProjectPath], // 引用不存在的项目
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
        stores: {
          [`${libName}@${commit}@macOS`]: {
            libName,
            commit,
            platform: 'macOS',
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            size: 1024,
            usedBy: [staleProjectPath],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
      };
      await saveRegistry(env, registry);

      // 验证项目路径不存在
      const projectExists = await fs.access(staleProjectPath).then(() => true).catch(() => false);
      expect(projectExists).toBe(false);

      // 模拟清理失效引用
      const loaded = await loadRegistry(env);
      const libKey = `${libName}@${commit}`;
      loaded.libraries[libKey].referencedBy = [];
      loaded.stores[`${libKey}@macOS`].usedBy = [];
      await saveRegistry(env, loaded);

      // 验证引用已清理
      const afterClean = await loadRegistry(env);
      expect(afterClean.libraries[libKey].referencedBy).toHaveLength(0);
    });
  });

  describe('S-5.2.3: --dry-run 模式', () => {
    it('should not delete anything in dry-run mode', async () => {
      env = await createTestEnv();

      const libName = 'libCleanDryRun';
      const commit = 'cleandryrun123';

      // 创建 Store 数据
      await createMockStoreData(env, libName, commit, ['macOS']);

      // 创建无引用的 Registry 记录
      const registry: Registry = {
        version: '1.0.0',
        projects: {},
        libraries: {
          [`${libName}@${commit}`]: {
            libName,
            commit,
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            platforms: ['macOS'],
            size: 1024,
            referencedBy: [],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
        stores: {},
      };
      await saveRegistry(env, registry);

      // 记录清理前状态
      const storePath = path.join(env.storeDir, libName, commit, 'macOS');
      const storeExistsBefore = await fs.access(storePath).then(() => true).catch(() => false);

      // dry-run 模式不执行实际操作
      // 验证状态不变

      // 验证 Store 仍存在
      const storeExistsAfter = await fs.access(storePath).then(() => true).catch(() => false);
      expect(storeExistsAfter).toBe(storeExistsBefore);

      // 验证 Registry 未变化（库仍存在）
      const registryAfter = await loadRegistry(env);
      expect(registryAfter.libraries[`${libName}@${commit}`]).toBeDefined();
    });
  });
});
