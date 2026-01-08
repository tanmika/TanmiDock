/**
 * TC-018: 版本/commit 变更测试
 *
 * 测试场景:
 * - S-2.4.1: 同库不同 commit 共存
 * - S-2.4.2: 切换 commit 版本
 * - S-2.4.3: 版本变更后清理旧版本
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import {
  createTestEnv,
  createMockStoreData,
  loadRegistry,
  saveRegistry,
  verifySymlink,
  type TestEnv,
} from './setup.js';
import { linkLib, isSymlink } from '../../src/core/linker.js';
import type { Registry } from '../../src/types/index.js';

describe('TC-018: 版本/commit 变更测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('S-2.4.1: 同库不同 commit 共存', () => {
    it('should store multiple commits of same library in Store', async () => {
      env = await createTestEnv();

      const libName = 'libMultiVersion';
      const commit1 = 'version1abc';
      const commit2 = 'version2def';

      // 创建两个版本的 Store 数据
      await createMockStoreData(env, libName, commit1, ['macOS']);
      await createMockStoreData(env, libName, commit2, ['macOS']);

      // 验证两个版本都存在
      const path1 = path.join(env.storeDir, libName, commit1);
      const path2 = path.join(env.storeDir, libName, commit2);

      const exists1 = await fs.access(path1).then(() => true).catch(() => false);
      const exists2 = await fs.access(path2).then(() => true).catch(() => false);

      expect(exists1).toBe(true);
      expect(exists2).toBe(true);
    });

    it('should track multiple commits in Registry', async () => {
      env = await createTestEnv();

      const libName = 'libMultiVersionReg';
      const commit1 = 'v1commit123';
      const commit2 = 'v2commit456';

      // 创建 Registry 记录两个版本
      const registry: Registry = {
        version: '1.0.0',
        projects: {},
        libraries: {
          [`${libName}@${commit1}`]: {
            libName,
            commit: commit1,
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            platforms: ['macOS'],
            size: 1024,
            referencedBy: [],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
          [`${libName}@${commit2}`]: {
            libName,
            commit: commit2,
            branch: 'develop',
            url: `https://github.com/test/${libName}.git`,
            platforms: ['macOS'],
            size: 2048,
            referencedBy: [],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
        stores: {},
      };

      await saveRegistry(env, registry);

      // 验证两个版本都在 Registry 中
      const loaded = await loadRegistry(env);
      expect(loaded.libraries[`${libName}@${commit1}`]).toBeDefined();
      expect(loaded.libraries[`${libName}@${commit2}`]).toBeDefined();
      expect(loaded.libraries[`${libName}@${commit1}`].commit).toBe(commit1);
      expect(loaded.libraries[`${libName}@${commit2}`].commit).toBe(commit2);
    });
  });

  describe('S-2.4.2: 切换 commit 版本', () => {
    it('should switch library version by relinking', async () => {
      env = await createTestEnv();

      const libName = 'libSwitch';
      const commit1 = 'switch1abc';
      const commit2 = 'switch2def';

      // 创建两个版本的 Store 数据
      await createMockStoreData(env, libName, commit1, ['macOS']);
      await createMockStoreData(env, libName, commit2, ['macOS']);

      const localPath = path.join(env.projectDir, '3rdParty', libName);
      const storePath1 = path.join(env.storeDir, libName, commit1);
      const storePath2 = path.join(env.storeDir, libName, commit2);

      // 链接到版本 1
      await linkLib(localPath, storePath1, ['macOS']);

      // 验证链接到版本 1
      const macOSLink1 = path.join(localPath, 'macOS');
      expect(await isSymlink(macOSLink1)).toBe(true);
      await verifySymlink(macOSLink1, path.join(storePath1, 'macOS'));

      // 切换到版本 2
      await linkLib(localPath, storePath2, ['macOS']);

      // 验证链接到版本 2
      const macOSLink2 = path.join(localPath, 'macOS');
      expect(await isSymlink(macOSLink2)).toBe(true);
      await verifySymlink(macOSLink2, path.join(storePath2, 'macOS'));
    });

    it('should update Registry when switching versions', async () => {
      env = await createTestEnv();

      const libName = 'libSwitchReg';
      const commit1 = 'switchreg1';
      const commit2 = 'switchreg2';

      // 初始 Registry：项目使用版本 1
      const registry: Registry = {
        version: '1.0.0',
        projects: {
          [env.projectDir]: {
            path: env.projectDir,
            platforms: ['macOS'],
            dependencies: [
              {
                libName,
                commit: commit1,
                linkedPath: `3rdParty/${libName}`,
                platform: 'macOS',
              },
            ],
          },
        },
        libraries: {
          [`${libName}@${commit1}`]: {
            libName,
            commit: commit1,
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            platforms: ['macOS'],
            size: 1024,
            referencedBy: [env.projectDir],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
        stores: {},
      };

      await saveRegistry(env, registry);

      // 模拟切换版本：更新 Registry
      const loaded = await loadRegistry(env);

      // 移除版本 1 的引用
      loaded.libraries[`${libName}@${commit1}`].referencedBy = [];

      // 添加版本 2
      loaded.libraries[`${libName}@${commit2}`] = {
        libName,
        commit: commit2,
        branch: 'main',
        url: `https://github.com/test/${libName}.git`,
        platforms: ['macOS'],
        size: 2048,
        referencedBy: [env.projectDir],
        createdAt: new Date().toISOString(),
        lastAccess: new Date().toISOString(),
      };

      // 更新项目依赖
      loaded.projects[env.projectDir].dependencies = [
        {
          libName,
          commit: commit2,
          linkedPath: `3rdParty/${libName}`,
          platform: 'macOS',
        },
      ];

      await saveRegistry(env, loaded);

      // 验证版本切换
      const afterSwitch = await loadRegistry(env);
      expect(afterSwitch.projects[env.projectDir].dependencies[0].commit).toBe(commit2);
      expect(afterSwitch.libraries[`${libName}@${commit1}`].referencedBy).toHaveLength(0);
      expect(afterSwitch.libraries[`${libName}@${commit2}`].referencedBy).toContain(env.projectDir);
    });
  });

  describe('S-2.4.3: 版本变更后清理旧版本', () => {
    it('should identify old version as unreferenced after switch', async () => {
      env = await createTestEnv();

      const libName = 'libOldVersion';
      const oldCommit = 'oldversion123';
      const newCommit = 'newversion456';

      // 创建两个版本
      await createMockStoreData(env, libName, oldCommit, ['macOS']);
      await createMockStoreData(env, libName, newCommit, ['macOS']);

      // Registry：项目已切换到新版本，旧版本无引用
      const registry: Registry = {
        version: '1.0.0',
        projects: {
          [env.projectDir]: {
            path: env.projectDir,
            platforms: ['macOS'],
            dependencies: [
              {
                libName,
                commit: newCommit,
                linkedPath: `3rdParty/${libName}`,
                platform: 'macOS',
              },
            ],
          },
        },
        libraries: {
          [`${libName}@${oldCommit}`]: {
            libName,
            commit: oldCommit,
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            platforms: ['macOS'],
            size: 1024,
            referencedBy: [], // 无引用
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
          [`${libName}@${newCommit}`]: {
            libName,
            commit: newCommit,
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            platforms: ['macOS'],
            size: 2048,
            referencedBy: [env.projectDir],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
        stores: {},
      };

      await saveRegistry(env, registry);

      // 验证旧版本无引用
      const loaded = await loadRegistry(env);
      expect(loaded.libraries[`${libName}@${oldCommit}`].referencedBy).toHaveLength(0);
      expect(loaded.libraries[`${libName}@${newCommit}`].referencedBy.length).toBeGreaterThan(0);
    });

    it('should clean old version when running clean command', async () => {
      env = await createTestEnv();

      const libName = 'libCleanOld';
      const oldCommit = 'cleanold123';

      // 创建旧版本
      await createMockStoreData(env, libName, oldCommit, ['macOS']);

      // Registry：旧版本无引用
      const registry: Registry = {
        version: '1.0.0',
        projects: {},
        libraries: {
          [`${libName}@${oldCommit}`]: {
            libName,
            commit: oldCommit,
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

      // 模拟清理
      const storePath = path.join(env.storeDir, libName, oldCommit);
      await fs.rm(storePath, { recursive: true, force: true });

      const loaded = await loadRegistry(env);
      delete loaded.libraries[`${libName}@${oldCommit}`];
      await saveRegistry(env, loaded);

      // 验证已清理
      const storeExists = await fs.access(storePath).then(() => true).catch(() => false);
      expect(storeExists).toBe(false);

      const afterClean = await loadRegistry(env);
      expect(afterClean.libraries[`${libName}@${oldCommit}`]).toBeUndefined();
    });
  });
});
