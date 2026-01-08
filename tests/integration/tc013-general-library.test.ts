/**
 * TC-013: General 类型库测试
 *
 * 测试场景:
 * - S-2.1.4: General 库检测（Store 中只有 _shared，无平台目录）
 * - S-2.2.4: ABSORB General 库（本地无平台目录）
 * - S-2.3.6: LINK_NEW General 库
 * - S-3.1.3: unlink General 库还原
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import {
  createTestEnv,
  createMockGeneralStoreData,
  loadRegistry,
  saveRegistry,
  verifySymlink,
  type TestEnv,
} from './setup.js';
import { isSymlink, linkGeneral, restoreFromLink } from '../../src/core/linker.js';
import { isGeneralLib } from '../../src/core/store.js';
import { GENERAL_PLATFORM } from '../../src/core/platform.js';
import type { Registry } from '../../src/types/index.js';

describe('TC-013: General 类型库测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('S-2.1.4: General 库检测', () => {
    it('should detect General library (only _shared, no platform dirs)', async () => {
      env = await createTestEnv();

      const libName = 'libGeneral';
      const commit = 'general123';

      // 创建 General 类型 Store 数据（只有 _shared）
      await createMockGeneralStoreData(env, libName, commit);

      // 验证 isGeneralLib 检测
      const isGeneral = await isGeneralLib(libName, commit);
      expect(isGeneral).toBe(true);
    });

    it('should not detect platform library as General', async () => {
      env = await createTestEnv();

      const libName = 'libPlatform';
      const commit = 'platform123';

      // 创建带平台目录的 Store 数据
      const libDir = path.join(env.storeDir, libName, commit);
      await fs.mkdir(path.join(libDir, 'macOS'), { recursive: true });
      await fs.mkdir(path.join(libDir, '_shared'), { recursive: true });
      await fs.writeFile(path.join(libDir, 'macOS', 'lib.a'), 'mock');
      await fs.writeFile(path.join(libDir, '_shared', 'config.h'), 'mock');

      // 验证 isGeneralLib 返回 false
      const isGeneral = await isGeneralLib(libName, commit);
      expect(isGeneral).toBe(false);
    });

    it('should not detect empty library as General', async () => {
      env = await createTestEnv();

      const libName = 'libEmpty';
      const commit = 'empty123';

      // 创建空目录（无 _shared）
      const libDir = path.join(env.storeDir, libName, commit);
      await fs.mkdir(libDir, { recursive: true });

      // 验证 isGeneralLib 返回 false
      const isGeneral = await isGeneralLib(libName, commit);
      expect(isGeneral).toBe(false);
    });
  });

  describe('S-2.3.6: LINK_NEW General 库', () => {
    it('should link General library as whole directory symlink', async () => {
      env = await createTestEnv();

      const libName = 'libGeneralLink';
      const commit = 'generallink123';

      // 创建 General 类型 Store 数据
      await createMockGeneralStoreData(env, libName, commit);

      const localPath = path.join(env.projectDir, '3rdParty', libName);
      const sharedPath = path.join(env.storeDir, libName, commit, '_shared');

      // 确保父目录存在
      await fs.mkdir(path.dirname(localPath), { recursive: true });

      // 链接 General 库
      await linkGeneral(localPath, sharedPath);

      // 验证：localPath 是符号链接
      const isLink = await isSymlink(localPath);
      expect(isLink).toBe(true);

      // 验证：指向 _shared
      await verifySymlink(localPath, sharedPath);

      // 验证：可以访问共享文件
      const configContent = await fs.readFile(path.join(localPath, 'config.h'), 'utf-8');
      expect(configContent).toContain(libName);
    });

    it('should replace existing directory with symlink', async () => {
      env = await createTestEnv();

      const libName = 'libGeneralReplace';
      const commit = 'generalreplace123';

      // 创建 General 类型 Store 数据
      await createMockGeneralStoreData(env, libName, commit);

      const localPath = path.join(env.projectDir, '3rdParty', libName);
      const sharedPath = path.join(env.storeDir, libName, commit, '_shared');

      // 先创建一个普通目录
      await fs.mkdir(localPath, { recursive: true });
      await fs.writeFile(path.join(localPath, 'old-file.txt'), 'old content');

      // 链接 General 库（应该替换）
      await linkGeneral(localPath, sharedPath);

      // 验证：localPath 是符号链接
      const isLink = await isSymlink(localPath);
      expect(isLink).toBe(true);

      // 验证：旧文件不存在（被替换）
      const entries = await fs.readdir(localPath);
      expect(entries).not.toContain('old-file.txt');
    });
  });

  describe('S-3.1.3: unlink General 库还原', () => {
    it('should restore General library from symlink', async () => {
      env = await createTestEnv();

      const libName = 'libGeneralUnlink';
      const commit = 'generalunlink123';

      // 创建 General 类型 Store 数据
      await createMockGeneralStoreData(env, libName, commit);

      const localPath = path.join(env.projectDir, '3rdParty', libName);
      const sharedPath = path.join(env.storeDir, libName, commit, '_shared');

      // 确保父目录存在
      await fs.mkdir(path.dirname(localPath), { recursive: true });

      // 链接 General 库
      await linkGeneral(localPath, sharedPath);
      expect(await isSymlink(localPath)).toBe(true);

      // 还原
      await restoreFromLink(localPath);

      // 验证：不再是符号链接
      expect(await isSymlink(localPath)).toBe(false);

      // 验证：内容已复制
      const stat = await fs.stat(localPath);
      expect(stat.isDirectory()).toBe(true);

      // 验证：共享文件存在
      const entries = await fs.readdir(localPath);
      expect(entries).toContain('config.h');
      expect(entries).toContain('common.cmake');
    });
  });

  describe('Registry: General 库记录', () => {
    it('should record General library with GENERAL_PLATFORM', async () => {
      env = await createTestEnv();

      const libName = 'libGeneralRegistry';
      const commit = 'generalreg123';

      // 创建 General 类型 Store 数据
      await createMockGeneralStoreData(env, libName, commit);

      // 模拟 Registry 记录
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
            size: 1024,
            referencedBy: [env.projectDir],
            createdAt: new Date().toISOString(),
            lastAccess: new Date().toISOString(),
          },
        },
        stores: {
          [`${libName}@${commit}@${GENERAL_PLATFORM}`]: {
            libName,
            commit,
            platform: GENERAL_PLATFORM,
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

      // 验证加载
      const loaded = await loadRegistry(env);
      const project = loaded.projects[env.projectDir];
      expect(project.platforms).toContain(GENERAL_PLATFORM);
      expect(project.dependencies[0].platform).toBe(GENERAL_PLATFORM);

      const storeKey = `${libName}@${commit}@${GENERAL_PLATFORM}`;
      expect(loaded.stores[storeKey]).toBeDefined();
      expect(loaded.stores[storeKey].platform).toBe(GENERAL_PLATFORM);
    });
  });
});
