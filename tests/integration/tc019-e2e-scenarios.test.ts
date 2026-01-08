/**
 * TC-019: E2E 端到端测试
 *
 * 测试场景:
 * - E2E-1: 完整 link -> status -> unlink 流程
 * - E2E-2: 多项目共享同一库
 * - E2E-3: 库版本升级流程
 * - E2E-4: 多平台库完整生命周期
 * - E2E-5: General 库完整生命周期
 * - E2E-6: 错误恢复场景
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import {
  createTestEnv,
  createMockStoreData,
  createMockGeneralStoreData,
  loadRegistry,
  saveRegistry,
  verifySymlink,
  verifyDirectoryContents,
  type TestEnv,
} from './setup.js';
import {
  isSymlink,
  isValidLink,
  linkLib,
  linkGeneral,
  restoreFromLink,
  restoreMultiPlatform,
} from '../../src/core/linker.js';
import { GENERAL_PLATFORM } from '../../src/core/platform.js';
import type { Registry } from '../../src/types/index.js';

describe('TC-019: E2E 端到端测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('E2E-1: 完整 link -> status -> unlink 流程', () => {
    it('should complete full lifecycle of a library', async () => {
      env = await createTestEnv();

      const libName = 'libE2E1';
      const commit = 'e2e1commit';
      const platforms = ['macOS', 'android'];

      // === Phase 1: Link ===
      // 创建 Store 数据
      await createMockStoreData(env, libName, commit, platforms);

      const localPath = path.join(env.projectDir, '3rdParty', libName);
      const storeCommitPath = path.join(env.storeDir, libName, commit);

      // 链接库
      await linkLib(localPath, storeCommitPath, platforms);

      // 创建 Registry 记录
      const registry: Registry = {
        version: '1.0.0',
        projects: {
          [env.projectDir]: {
            path: env.projectDir,
            platforms,
            dependencies: [
              {
                libName,
                commit,
                linkedPath: `3rdParty/${libName}`,
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
            platforms,
            size: 2048,
            referencedBy: [env.projectDir],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
        stores: {},
      };
      await saveRegistry(env, registry);

      // === Phase 2: Status ===
      // 验证链接状态
      for (const platform of platforms) {
        const platformLink = path.join(localPath, platform);
        expect(await isSymlink(platformLink)).toBe(true);
        expect(await isValidLink(platformLink)).toBe(true);
        await verifySymlink(platformLink, path.join(storeCommitPath, platform));
      }

      // 验证共享文件
      await verifyDirectoryContents(localPath, ['macOS', 'android', 'common.h', 'codepac-dep.json']);

      // === Phase 3: Unlink ===
      // 还原多平台链接
      await restoreMultiPlatform(localPath);

      // 验证不再是链接
      for (const platform of platforms) {
        const platformPath = path.join(localPath, platform);
        expect(await isSymlink(platformPath)).toBe(false);
        // 验证内容已复制
        const stat = await fs.stat(platformPath);
        expect(stat.isDirectory()).toBe(true);
      }

      // 更新 Registry
      const loaded = await loadRegistry(env);
      delete loaded.projects[env.projectDir];
      loaded.libraries[`${libName}@${commit}`].referencedBy = [];
      await saveRegistry(env, loaded);

      // 验证 Registry 更新
      const afterUnlink = await loadRegistry(env);
      expect(afterUnlink.projects[env.projectDir]).toBeUndefined();
      expect(afterUnlink.libraries[`${libName}@${commit}`].referencedBy).toHaveLength(0);
    });
  });

  describe('E2E-2: 多项目共享同一库', () => {
    it('should allow multiple projects to share same library', async () => {
      env = await createTestEnv();

      const libName = 'libShared';
      const commit = 'sharedcommit';
      const platform = 'macOS';

      // 创建 Store 数据
      await createMockStoreData(env, libName, commit, [platform]);

      // 创建两个项目目录
      const project1 = path.join(env.tempDir, 'project1');
      const project2 = path.join(env.tempDir, 'project2');
      await fs.mkdir(project1, { recursive: true });
      await fs.mkdir(project2, { recursive: true });

      const storeCommitPath = path.join(env.storeDir, libName, commit);

      // 两个项目都链接同一个库
      const localPath1 = path.join(project1, '3rdParty', libName);
      const localPath2 = path.join(project2, '3rdParty', libName);

      await linkLib(localPath1, storeCommitPath, [platform]);
      await linkLib(localPath2, storeCommitPath, [platform]);

      // 创建 Registry
      const registry: Registry = {
        version: '1.0.0',
        projects: {
          [project1]: {
            path: project1,
            platforms: [platform],
            dependencies: [{ libName, commit, linkedPath: `3rdParty/${libName}` }],
          },
          [project2]: {
            path: project2,
            platforms: [platform],
            dependencies: [{ libName, commit, linkedPath: `3rdParty/${libName}` }],
          },
        },
        libraries: {
          [`${libName}@${commit}`]: {
            libName,
            commit,
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            platforms: [platform],
            size: 1024,
            referencedBy: [project1, project2],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
        stores: {},
      };
      await saveRegistry(env, registry);

      // 验证两个项目的链接都指向同一个 Store
      await verifySymlink(path.join(localPath1, platform), path.join(storeCommitPath, platform));
      await verifySymlink(path.join(localPath2, platform), path.join(storeCommitPath, platform));

      // 验证库有两个引用
      const loaded = await loadRegistry(env);
      expect(loaded.libraries[`${libName}@${commit}`].referencedBy).toHaveLength(2);

      // 项目 1 取消链接
      await restoreMultiPlatform(localPath1);
      loaded.projects[project1].dependencies = [];
      loaded.libraries[`${libName}@${commit}`].referencedBy = [project2];
      await saveRegistry(env, loaded);

      // 验证项目 2 仍然有效
      expect(await isValidLink(path.join(localPath2, platform))).toBe(true);

      // 验证 Store 仍存在（因为还有引用）
      const storeExists = await fs.access(storeCommitPath).then(() => true).catch(() => false);
      expect(storeExists).toBe(true);
    });
  });

  describe('E2E-3: 库版本升级流程', () => {
    it('should upgrade library version correctly', async () => {
      env = await createTestEnv();

      const libName = 'libUpgrade';
      const oldCommit = 'oldversion';
      const newCommit = 'newversion';
      const platform = 'macOS';

      // 创建两个版本的 Store 数据
      await createMockStoreData(env, libName, oldCommit, [platform]);
      await createMockStoreData(env, libName, newCommit, [platform]);

      const localPath = path.join(env.projectDir, '3rdParty', libName);
      const oldStorePath = path.join(env.storeDir, libName, oldCommit);
      const newStorePath = path.join(env.storeDir, libName, newCommit);

      // === 初始状态：链接到旧版本 ===
      await linkLib(localPath, oldStorePath, [platform]);
      await verifySymlink(path.join(localPath, platform), path.join(oldStorePath, platform));

      // === 升级：切换到新版本 ===
      await linkLib(localPath, newStorePath, [platform]);
      await verifySymlink(path.join(localPath, platform), path.join(newStorePath, platform));

      // 更新 Registry
      const registry: Registry = {
        version: '1.0.0',
        projects: {
          [env.projectDir]: {
            path: env.projectDir,
            platforms: [platform],
            dependencies: [{ libName, commit: newCommit, linkedPath: `3rdParty/${libName}` }],
          },
        },
        libraries: {
          [`${libName}@${oldCommit}`]: {
            libName,
            commit: oldCommit,
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            platforms: [platform],
            size: 1024,
            referencedBy: [], // 旧版本无引用
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
          [`${libName}@${newCommit}`]: {
            libName,
            commit: newCommit,
            branch: 'main',
            url: `https://github.com/test/${libName}.git`,
            platforms: [platform],
            size: 2048,
            referencedBy: [env.projectDir],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
        stores: {},
      };
      await saveRegistry(env, registry);

      // 验证旧版本可清理
      const loaded = await loadRegistry(env);
      expect(loaded.libraries[`${libName}@${oldCommit}`].referencedBy).toHaveLength(0);
      expect(loaded.libraries[`${libName}@${newCommit}`].referencedBy).toHaveLength(1);
    });
  });

  describe('E2E-5: General 库完整生命周期', () => {
    it('should complete full lifecycle of General library', async () => {
      env = await createTestEnv();

      const libName = 'libGeneralE2E';
      const commit = 'generale2e';

      // === Phase 1: Link ===
      await createMockGeneralStoreData(env, libName, commit);

      const localPath = path.join(env.projectDir, '3rdParty', libName);
      const sharedPath = path.join(env.storeDir, libName, commit, '_shared');

      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await linkGeneral(localPath, sharedPath);

      // 创建 Registry
      const registry: Registry = {
        version: '1.0.0',
        projects: {
          [env.projectDir]: {
            path: env.projectDir,
            platforms: [GENERAL_PLATFORM],
            dependencies: [
              {
                libName,
                commit,
                linkedPath: `3rdParty/${libName}`,
                platform: GENERAL_PLATFORM,
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
            platforms: [GENERAL_PLATFORM],
            size: 512,
            referencedBy: [env.projectDir],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
        stores: {},
      };
      await saveRegistry(env, registry);

      // === Phase 2: Status ===
      expect(await isSymlink(localPath)).toBe(true);
      expect(await isValidLink(localPath)).toBe(true);
      await verifySymlink(localPath, sharedPath);

      // 验证可访问共享文件
      const entries = await fs.readdir(localPath);
      expect(entries).toContain('common.cmake');
      expect(entries).toContain('config.h');

      // === Phase 3: Unlink ===
      await restoreFromLink(localPath);

      // 验证已还原
      expect(await isSymlink(localPath)).toBe(false);
      const stat = await fs.stat(localPath);
      expect(stat.isDirectory()).toBe(true);

      // 验证内容完整
      const restoredEntries = await fs.readdir(localPath);
      expect(restoredEntries).toContain('common.cmake');
      expect(restoredEntries).toContain('config.h');
    });
  });

  describe('E2E-6: 错误恢复场景', () => {
    it('should handle Store deletion gracefully', async () => {
      env = await createTestEnv();

      const libName = 'libRecovery';
      const commit = 'recoverycommit';
      const platform = 'macOS';

      // 创建 Store 和链接
      await createMockStoreData(env, libName, commit, [platform]);

      const localPath = path.join(env.projectDir, '3rdParty', libName);
      const storeCommitPath = path.join(env.storeDir, libName, commit);

      await linkLib(localPath, storeCommitPath, [platform]);

      // 验证初始状态正常
      expect(await isValidLink(path.join(localPath, platform))).toBe(true);

      // 模拟 Store 被意外删除
      await fs.rm(storeCommitPath, { recursive: true });

      // 验证链接失效
      expect(await isSymlink(path.join(localPath, platform))).toBe(true);
      expect(await isValidLink(path.join(localPath, platform))).toBe(false);

      // 验证可以检测到问题（verify 场景）
      const linkTarget = await fs.readlink(path.join(localPath, platform));
      const resolvedTarget = path.resolve(path.dirname(path.join(localPath, platform)), linkTarget);
      const targetExists = await fs.access(resolvedTarget).then(() => true).catch(() => false);
      expect(targetExists).toBe(false);
    });

    it('should handle partial multi-platform link failure', async () => {
      env = await createTestEnv();

      const libName = 'libPartialFail';
      const commit = 'partialfail';
      const platforms = ['macOS', 'android'];

      // 只创建 macOS 平台数据
      const libDir = path.join(env.storeDir, libName, commit);
      await fs.mkdir(path.join(libDir, 'macOS'), { recursive: true });
      await fs.mkdir(path.join(libDir, '_shared'), { recursive: true });
      await fs.writeFile(path.join(libDir, 'macOS', 'lib.a'), 'mock');
      await fs.writeFile(path.join(libDir, '_shared', 'config.h'), 'mock');

      const localPath = path.join(env.projectDir, '3rdParty', libName);
      const storeCommitPath = path.join(env.storeDir, libName, commit);

      // 尝试链接两个平台（android 不存在）
      await linkLib(localPath, storeCommitPath, platforms);

      // 验证 macOS 链接成功
      expect(await isSymlink(path.join(localPath, 'macOS'))).toBe(true);

      // android 不应该被创建（因为 Store 中不存在）
      const androidExists = await fs.access(path.join(localPath, 'android'))
        .then(() => true)
        .catch(() => false);
      expect(androidExists).toBe(false);

      // 共享文件应该被复制
      const configExists = await fs.access(path.join(localPath, 'config.h'))
        .then(() => true)
        .catch(() => false);
      expect(configExists).toBe(true);
    });
  });
});
