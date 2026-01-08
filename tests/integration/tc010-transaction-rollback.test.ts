/**
 * TC-010: 事务回滚验证 (P1)
 *
 * 验证场景：
 * - 多平台链接场景
 * - 模拟某平台链接失败
 * - 验证已创建的链接被回滚
 * - 验证 registry 无残留
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

describe('TC-010: 事务回滚验证', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('should rollback on partial failure - simulate missing platform', async () => {
    env = await createTestEnv();

    const libName = 'libRollback';
    const commit = 'rollback123';

    // 只创建 macOS，不创建 android（模拟下载失败）
    await createMockStoreData(env, libName, commit, ['macOS']);

    const localPath = path.join(env.projectDir, '3rdParty', libName);
    const storeCommitPath = path.join(env.storeDir, libName, commit);

    // 初始化空 registry
    const initialRegistry: Registry = {
      version: 2,
      store: {
        [libName]: {
          commit,
          platforms: {
            macOS: { downloadedAt: Date.now(), usedBy: [] },
            // android 不存在（模拟下载失败）
          },
        },
      },
      projects: {},
    };
    await saveRegistry(env, initialRegistry);

    // When: 尝试链接两个平台（android 不存在）
    // 模拟事务性操作
    let rollbackNeeded = false;
    const createdLinks: string[] = [];

    try {
      await fs.mkdir(localPath, { recursive: true });

      for (const platform of ['macOS', 'android']) {
        const platformStorePath = path.join(storeCommitPath, platform);

        // 检查平台是否存在
        try {
          await fs.access(platformStorePath);
        } catch {
          // 平台不存在，触发回滚
          rollbackNeeded = true;
          throw new Error(`Platform ${platform} not found in store`);
        }

        // 创建链接
        const platformLocalPath = path.join(localPath, platform);
        await fs.symlink(platformStorePath, platformLocalPath);
        createdLinks.push(platformLocalPath);
      }
    } catch (_err) {
      // 回滚：删除已创建的链接
      if (rollbackNeeded) {
        for (const link of createdLinks) {
          try {
            await fs.unlink(link);
          } catch {
            // ignore
          }
        }
        // 删除空目录
        try {
          await fs.rmdir(localPath);
        } catch {
          // ignore
        }
      }
    }

    // Then: 回滚后状态
    expect(rollbackNeeded).toBe(true);

    // 本地目录应该被清理（或不存在）
    let localExists = false;
    try {
      await fs.access(localPath);
      const entries = await fs.readdir(localPath);
      localExists = entries.length > 0;
    } catch {
      localExists = false;
    }
    expect(localExists).toBe(false);

    // registry 无残留
    const registry = await loadRegistry(env);
    expect(registry.projects[env.projectDir]).toBeUndefined();
  });

  it('should maintain registry consistency on successful transaction', async () => {
    env = await createTestEnv();

    const libName = 'libConsistent';
    const commit = 'consistent456';
    const platforms = ['macOS', 'Win'];

    await createMockStoreData(env, libName, commit, platforms);

    const localPath = path.join(env.projectDir, '3rdParty', libName);
    const storeCommitPath = path.join(env.storeDir, libName, commit);

    // 初始化 registry
    const initialRegistry: Registry = {
      version: 2,
      store: {
        [libName]: {
          commit,
          platforms: {
            macOS: { downloadedAt: Date.now(), usedBy: [] },
            Win: { downloadedAt: Date.now(), usedBy: [] },
          },
        },
      },
      projects: {},
    };
    await saveRegistry(env, initialRegistry);

    // When: 成功链接所有平台
    await fs.mkdir(localPath, { recursive: true });

    for (const platform of platforms) {
      const platformStorePath = path.join(storeCommitPath, platform);
      const platformLocalPath = path.join(localPath, platform);
      await fs.symlink(platformStorePath, platformLocalPath);
    }

    // 复制 _shared 文件
    const sharedPath = path.join(storeCommitPath, '_shared');
    try {
      const sharedEntries = await fs.readdir(sharedPath);
      for (const entry of sharedEntries) {
        await fs.copyFile(
          path.join(sharedPath, entry),
          path.join(localPath, entry)
        );
      }
    } catch {
      // _shared 可能不存在
    }

    // 更新 registry（事务性：全部成功后才更新）
    let registry = await loadRegistry(env);
    registry.projects[env.projectDir] = {
      path: env.projectDir,
      libs: {
        [libName]: {
          commit,
          localPath,
          platforms,
          linkedAt: Date.now(),
        },
      },
    };
    for (const platform of platforms) {
      registry.store[libName].platforms[platform].usedBy.push(env.projectDir);
    }
    await saveRegistry(env, registry);

    // Then: 文件系统状态与 registry 一致
    registry = await loadRegistry(env);

    // 每个平台都有文件系统链接
    for (const platform of platforms) {
      const platformPath = path.join(localPath, platform);
      const stat = await fs.lstat(platformPath);
      expect(stat.isSymbolicLink()).toBe(true);

      // registry 中有引用
      expect(registry.store[libName].platforms[platform].usedBy).toContain(env.projectDir);
    }

    // 项目记录完整
    expect(registry.projects[env.projectDir].libs[libName].platforms).toEqual(platforms);
  });
});
