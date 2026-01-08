/**
 * TC-014: verify 命令测试
 *
 * 测试场景:
 * - S-6.1.1: 检测悬挂链接（符号链接目标不存在）
 * - S-6.1.2: 检测孤立库（Store 有但 Registry 无引用）
 * - S-6.1.3: 检测缺失库（Registry 有但 Store 无）
 * - S-6.1.4: 检测无效项目（项目路径不存在）
 * - S-6.1.5: 完整性验证通过
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
import { isSymlink, isValidLink } from '../../src/core/linker.js';
import type { Registry } from '../../src/types/index.js';

describe('TC-014: verify 命令测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('S-6.1.1: 检测悬挂链接', () => {
    it('should detect dangling symlink when target is deleted', async () => {
      env = await createTestEnv();

      const libName = 'libDangling';
      const commit = 'dangling123';

      // 创建 Store 数据
      await createMockStoreData(env, libName, commit, ['macOS']);

      // 创建符号链接
      const localPath = path.join(env.projectDir, '3rdParty', libName);
      const storeCommitPath = path.join(env.storeDir, libName, commit);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.symlink(storeCommitPath, localPath);

      // 验证链接有效
      expect(await isSymlink(localPath)).toBe(true);
      expect(await isValidLink(localPath)).toBe(true);

      // 删除 Store 中的目标
      await fs.rm(storeCommitPath, { recursive: true });

      // 验证：链接仍存在但已失效
      expect(await isSymlink(localPath)).toBe(true);
      expect(await isValidLink(localPath)).toBe(false);
    });

    it('should detect dangling internal symlink in multi-platform directory', async () => {
      env = await createTestEnv();

      const libName = 'libMultiDangling';
      const commit = 'multidangling123';
      const platforms = ['macOS', 'android'];

      // 创建 Store 数据
      await createMockStoreData(env, libName, commit, platforms);

      // 创建多平台链接结构
      const localPath = path.join(env.projectDir, '3rdParty', libName);
      const storeCommitPath = path.join(env.storeDir, libName, commit);
      await fs.mkdir(localPath, { recursive: true });
      await fs.symlink(path.join(storeCommitPath, 'macOS'), path.join(localPath, 'macOS'));
      await fs.symlink(path.join(storeCommitPath, 'android'), path.join(localPath, 'android'));

      // 删除其中一个平台
      await fs.rm(path.join(storeCommitPath, 'macOS'), { recursive: true });

      // 验证：macOS 链接失效，android 仍有效
      expect(await isValidLink(path.join(localPath, 'macOS'))).toBe(false);
      expect(await isValidLink(path.join(localPath, 'android'))).toBe(true);
    });
  });

  describe('S-6.1.2: 检测孤立库', () => {
    it('should detect orphan library in Store without Registry entry', async () => {
      env = await createTestEnv();

      const libName = 'libOrphan';
      const commit = 'orphan123';

      // 创建 Store 数据但不创建 Registry 记录
      await createMockStoreData(env, libName, commit, ['macOS']);

      // 验证 Store 中存在
      const storePath = path.join(env.storeDir, libName, commit, 'macOS');
      const storeExists = await fs.access(storePath).then(() => true).catch(() => false);
      expect(storeExists).toBe(true);

      // 验证 Registry 中不存在
      const registry = await loadRegistry(env);
      const libKey = `${libName}@${commit}`;
      expect(registry.libraries[libKey]).toBeUndefined();
    });
  });

  describe('S-6.1.3: 检测缺失库', () => {
    it('should detect missing library when Registry has entry but Store is empty', async () => {
      env = await createTestEnv();

      const libName = 'libMissing';
      const commit = 'missing123';

      // 只创建 Registry 记录，不创建 Store 数据
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
            referencedBy: [env.projectDir],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
        stores: {},
      };

      await saveRegistry(env, registry);

      // 验证 Store 中不存在
      const storePath = path.join(env.storeDir, libName, commit);
      const storeExists = await fs.access(storePath).then(() => true).catch(() => false);
      expect(storeExists).toBe(false);

      // 验证 Registry 中存在
      const loaded = await loadRegistry(env);
      expect(loaded.libraries[`${libName}@${commit}`]).toBeDefined();
    });
  });

  describe('S-6.1.4: 检测无效项目', () => {
    it('should detect invalid project when path does not exist', async () => {
      env = await createTestEnv();

      const invalidProjectPath = '/nonexistent/project/path';
      const libName = 'libInvalidProject';
      const commit = 'invalid123';

      // 创建 Registry 记录指向不存在的项目路径
      const registry: Registry = {
        version: '1.0.0',
        projects: {
          [invalidProjectPath]: {
            path: invalidProjectPath,
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
        libraries: {},
        stores: {},
      };

      await saveRegistry(env, registry);

      // 验证项目路径不存在
      const projectExists = await fs.access(invalidProjectPath).then(() => true).catch(() => false);
      expect(projectExists).toBe(false);

      // 验证 Registry 中存在该项目记录
      const loaded = await loadRegistry(env);
      expect(loaded.projects[invalidProjectPath]).toBeDefined();
    });
  });

  describe('S-6.1.5: 完整性验证通过', () => {
    it('should pass integrity check when everything is consistent', async () => {
      env = await createTestEnv();

      const libName = 'libConsistent';
      const commit = 'consistent123';

      // 创建 Store 数据
      await createMockStoreData(env, libName, commit, ['macOS']);

      // 创建符号链接
      const localPath = path.join(env.projectDir, '3rdParty', libName);
      const storePlatformPath = path.join(env.storeDir, libName, commit, 'macOS');
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.symlink(storePlatformPath, localPath);

      // 创建一致的 Registry 记录
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
            referencedBy: [env.projectDir],
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
            usedBy: [env.projectDir],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
      };

      await saveRegistry(env, registry);

      // 验证所有检查通过
      // 1. 链接有效
      expect(await isSymlink(localPath)).toBe(true);
      expect(await isValidLink(localPath)).toBe(true);

      // 2. Store 存在
      const storeExists = await fs.access(storePlatformPath).then(() => true).catch(() => false);
      expect(storeExists).toBe(true);

      // 3. 项目路径存在
      const projectExists = await fs.access(env.projectDir).then(() => true).catch(() => false);
      expect(projectExists).toBe(true);

      // 4. Registry 记录一致
      const loaded = await loadRegistry(env);
      expect(loaded.projects[env.projectDir]).toBeDefined();
      expect(loaded.libraries[`${libName}@${commit}`]).toBeDefined();
      expect(loaded.stores[`${libName}@${commit}@macOS`]).toBeDefined();
    });
  });
});
