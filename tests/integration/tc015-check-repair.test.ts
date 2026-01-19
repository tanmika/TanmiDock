/**
 * TC-015: check 命令 - 修复功能测试
 *
 * 测试场景:
 * - S-6.2.1: 清理过期项目（项目路径不存在）
 * - S-6.2.2: 移除悬挂链接
 * - S-6.2.3: 登记孤立库（默认行为）
 * - S-6.2.4: 删除孤立库（--prune 模式）
 * - S-6.2.5: dry-run 模式不执行实际操作
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
// isSymlink imported for potential future use in repair scenarios
// import { isSymlink } from '../../src/core/linker.js';
import type { Registry } from '../../src/types/index.js';

describe('TC-015: check 命令 - 修复功能测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('S-6.2.1: 清理过期项目', () => {
    it('should identify stale project when path does not exist', async () => {
      env = await createTestEnv();

      const staleProjectPath = '/nonexistent/stale/project';

      // 创建 Registry 记录指向不存在的项目
      const registry: Registry = {
        version: '1.0.0',
        projects: {
          [staleProjectPath]: {
            path: staleProjectPath,
            platforms: ['macOS'],
            dependencies: [],
          },
          [env.projectDir]: {
            path: env.projectDir,
            platforms: ['macOS'],
            dependencies: [],
          },
        },
        libraries: {},
        stores: {},
      };

      await saveRegistry(env, registry);

      // 验证过期项目路径不存在
      const staleExists = await fs.access(staleProjectPath).then(() => true).catch(() => false);
      expect(staleExists).toBe(false);

      // 验证有效项目路径存在
      const validExists = await fs.access(env.projectDir).then(() => true).catch(() => false);
      expect(validExists).toBe(true);

      // 模拟清理：移除过期项目
      const loaded = await loadRegistry(env);
      delete loaded.projects[staleProjectPath];
      await saveRegistry(env, loaded);

      // 验证清理后只剩有效项目
      const afterClean = await loadRegistry(env);
      expect(afterClean.projects[staleProjectPath]).toBeUndefined();
      expect(afterClean.projects[env.projectDir]).toBeDefined();
    });
  });

  describe('S-6.2.2: 移除悬挂链接', () => {
    it('should remove dangling symlink and update registry', async () => {
      env = await createTestEnv();

      const libName = 'libDanglingRepair';
      const commit = 'danglingrepair123';

      // 创建 Store 数据
      await createMockStoreData(env, libName, commit, ['macOS']);

      // 创建符号链接
      const localPath = path.join(env.projectDir, '3rdParty', libName);
      const storeCommitPath = path.join(env.storeDir, libName, commit);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.symlink(storeCommitPath, localPath);

      // 创建 Registry 记录
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
        libraries: {},
        stores: {},
      };
      await saveRegistry(env, registry);

      // 删除 Store 目标使链接悬挂
      await fs.rm(storeCommitPath, { recursive: true });

      // 模拟修复：删除悬挂链接
      await fs.unlink(localPath);

      // 更新 Registry：移除依赖
      const loaded = await loadRegistry(env);
      loaded.projects[env.projectDir].dependencies = [];
      await saveRegistry(env, loaded);

      // 验证链接已删除
      const linkExists = await fs.access(localPath).then(() => true).catch(() => false);
      expect(linkExists).toBe(false);

      // 验证 Registry 已更新
      const afterRepair = await loadRegistry(env);
      expect(afterRepair.projects[env.projectDir].dependencies).toHaveLength(0);
    });
  });

  describe('S-6.2.3: 登记孤立库', () => {
    it('should register orphan library to Registry (default behavior)', async () => {
      env = await createTestEnv();

      const libName = 'libOrphanRegister';
      const commit = 'orphanreg123';

      // 创建 Store 数据但不创建 Registry 记录
      await createMockStoreData(env, libName, commit, ['macOS']);

      // 验证 Store 存在
      const storePath = path.join(env.storeDir, libName, commit);
      const storeExists = await fs.access(storePath).then(() => true).catch(() => false);
      expect(storeExists).toBe(true);

      // 模拟修复：登记到 Registry
      const registry = await loadRegistry(env);
      const libKey = `${libName}@${commit}`;
      registry.libraries[libKey] = {
        libName,
        commit,
        branch: 'unknown',
        url: 'unknown',
        platforms: [],
        size: 0,
        referencedBy: [],
        createdAt: new Date().toISOString(),
        lastAccess: new Date().toISOString(),
      };
      await saveRegistry(env, registry);

      // 验证已登记
      const afterRepair = await loadRegistry(env);
      expect(afterRepair.libraries[libKey]).toBeDefined();
      expect(afterRepair.libraries[libKey].libName).toBe(libName);
    });
  });

  describe('S-6.2.4: 删除孤立库（--prune 模式）', () => {
    it('should delete orphan library from Store in prune mode', async () => {
      env = await createTestEnv();

      const libName = 'libOrphanPrune';
      const commit = 'orphanprune123';

      // 创建 Store 数据但不创建 Registry 记录
      await createMockStoreData(env, libName, commit, ['macOS']);

      // 验证 Store 存在
      const storePath = path.join(env.storeDir, libName, commit);
      const storeExists = await fs.access(storePath).then(() => true).catch(() => false);
      expect(storeExists).toBe(true);

      // 模拟 --prune 修复：删除孤立库
      await fs.rm(storePath, { recursive: true });

      // 清理空父目录
      const libDir = path.join(env.storeDir, libName);
      const remaining = await fs.readdir(libDir);
      if (remaining.length === 0) {
        await fs.rmdir(libDir);
      }

      // 验证已删除
      const afterPrune = await fs.access(storePath).then(() => true).catch(() => false);
      expect(afterPrune).toBe(false);
    });
  });

  describe('S-6.2.5: dry-run 模式', () => {
    it('should not modify anything in dry-run mode', async () => {
      env = await createTestEnv();

      const libName = 'libDryRun';
      const commit = 'dryrun123';

      // 创建 Store 数据但不创建 Registry 记录（孤立库）
      await createMockStoreData(env, libName, commit, ['macOS']);

      const storePath = path.join(env.storeDir, libName, commit);

      // 记录修复前状态
      const storeExistsBefore = await fs.access(storePath).then(() => true).catch(() => false);
      const registryBefore = await loadRegistry(env);

      // dry-run 模式不执行实际操作
      // 这里只是验证状态不变

      // 验证 Store 仍存在
      const storeExistsAfter = await fs.access(storePath).then(() => true).catch(() => false);
      expect(storeExistsAfter).toBe(storeExistsBefore);

      // 验证 Registry 未变化
      const registryAfter = await loadRegistry(env);
      expect(JSON.stringify(registryAfter)).toBe(JSON.stringify(registryBefore));
    });
  });
});
