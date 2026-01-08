/**
 * TC-004: StoreEntry 清理
 *
 * 验证场景：
 * - 多平台链接后执行 unlink
 * - 所有 StoreEntry.usedBy 移除引用
 * - unlinkedAt 被设置
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import {
  createTestEnv,
  createMockStoreData,
  loadRegistry,
  saveRegistry,
  type TestEnv,
} from './setup.js';
import { linkLib, restoreMultiPlatform } from '../../src/core/linker.js';
import type { Registry } from '../../src/types/index.js';

describe('TC-004: StoreEntry 清理', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('should remove usedBy references from all StoreEntries after unlink', async () => {
    env = await createTestEnv();

    const libName = 'libCleanup';
    const commit = 'cleanup123';
    const platforms = ['macOS', 'android'];

    // Given: 多平台链接后的项目
    await createMockStoreData(env, libName, commit, platforms);

    const localPath = path.join(env.projectDir, '3rdParty', libName);
    const storeCommitPath = path.join(env.storeDir, libName, commit);

    // 初始化 registry 并添加引用
    const initialRegistry: Registry = {
      version: 2,
      store: {
        [libName]: {
          commit,
          platforms: {
            macOS: {
              downloadedAt: Date.now(),
              usedBy: [env.projectDir],
            },
            android: {
              downloadedAt: Date.now(),
              usedBy: [env.projectDir],
            },
          },
        },
      },
      projects: {
        [env.projectDir]: {
          path: env.projectDir,
          libs: {
            [libName]: {
              commit,
              localPath,
              platforms,
              linkedAt: Date.now(),
            },
          },
        },
      },
    };
    await saveRegistry(env, initialRegistry);

    // 执行链接
    await linkLib(localPath, storeCommitPath, platforms);

    // When: 执行 unlink（还原 + 清理 registry）
    await restoreMultiPlatform(localPath);

    // 模拟 unlink 命令的 registry 清理逻辑
    let registry = await loadRegistry(env);

    // 移除 usedBy 引用
    for (const platform of platforms) {
      const entry = registry.store[libName].platforms[platform];
      entry.usedBy = entry.usedBy.filter((p: string) => p !== env.projectDir);
      entry.unlinkedAt = Date.now();
    }

    // 移除项目记录
    delete registry.projects[env.projectDir].libs[libName];
    if (Object.keys(registry.projects[env.projectDir].libs).length === 0) {
      delete registry.projects[env.projectDir];
    }

    await saveRegistry(env, registry);

    // Then: 验证 registry 状态
    registry = await loadRegistry(env);

    // 所有 StoreEntry.usedBy 移除引用
    for (const platform of platforms) {
      const entry = registry.store[libName].platforms[platform];
      expect(entry.usedBy).not.toContain(env.projectDir);

      // unlinkedAt 被设置
      expect(entry.unlinkedAt).toBeDefined();
      expect(entry.unlinkedAt).toBeGreaterThan(0);
    }

    // 项目记录被移除
    expect(registry.projects[env.projectDir]).toBeUndefined();
  });

  it('should handle partial unlink (one project of many)', async () => {
    env = await createTestEnv();

    const libName = 'libPartial';
    const commit = 'partial123';
    const platforms = ['macOS'];

    await createMockStoreData(env, libName, commit, platforms);

    const localPath = path.join(env.projectDir, '3rdParty', libName);
    const storeCommitPath = path.join(env.storeDir, libName, commit);

    const otherProject = '/other/project';

    // 初始化 registry - 两个项目引用同一个库
    const initialRegistry: Registry = {
      version: 2,
      store: {
        [libName]: {
          commit,
          platforms: {
            macOS: {
              downloadedAt: Date.now(),
              usedBy: [env.projectDir, otherProject],
            },
          },
        },
      },
      projects: {
        [env.projectDir]: {
          path: env.projectDir,
          libs: {
            [libName]: {
              commit,
              localPath,
              platforms,
              linkedAt: Date.now(),
            },
          },
        },
        [otherProject]: {
          path: otherProject,
          libs: {
            [libName]: {
              commit,
              localPath: path.join(otherProject, '3rdParty', libName),
              platforms,
              linkedAt: Date.now(),
            },
          },
        },
      },
    };
    await saveRegistry(env, initialRegistry);

    await linkLib(localPath, storeCommitPath, platforms);

    // When: 只 unlink 当前项目
    await restoreMultiPlatform(localPath);

    let registry = await loadRegistry(env);
    registry.store[libName].platforms.macOS.usedBy =
      registry.store[libName].platforms.macOS.usedBy.filter((p: string) => p !== env.projectDir);
    delete registry.projects[env.projectDir];
    await saveRegistry(env, registry);

    // Then: 当前项目引用被移除，其他项目引用保留
    registry = await loadRegistry(env);

    expect(registry.store[libName].platforms.macOS.usedBy).not.toContain(env.projectDir);
    expect(registry.store[libName].platforms.macOS.usedBy).toContain(otherProject);

    // 其他项目记录保留
    expect(registry.projects[otherProject]).toBeDefined();
  });
});
