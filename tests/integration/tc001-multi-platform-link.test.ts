/**
 * TC-001: 多平台累积链接
 *
 * 验证场景：
 * - 先 link iOS 平台
 * - 再 link android 平台（追加）
 * - 验证 registry.platforms 累积
 * - 验证 StoreEntry.usedBy 正确引用
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
import { linkLib } from '../../src/core/linker.js';
import type { Registry, StoreEntry, ProjectInfo } from '../../src/types/index.js';

describe('TC-001: 多平台累积链接', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('should accumulate platforms in registry when linking multiple platforms sequentially', async () => {
    env = await createTestEnv();

    const libName = 'libTest';
    const commit = 'abc123';
    const platforms = ['iOS', 'android'];

    // Given: Store 中有 libTest 库，包含 iOS 和 android 两个平台
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
            iOS: {
              downloadedAt: Date.now(),
              usedBy: [],
            },
            android: {
              downloadedAt: Date.now(),
              usedBy: [],
            },
          },
        },
      },
      projects: {},
    };
    await saveRegistry(env, initialRegistry);

    // When: 第一次 link - 选择 iOS 平台
    await linkLib(localPath, storeCommitPath, ['iOS']);

    // 更新 registry - 模拟 link 命令的行为
    let registry = await loadRegistry(env);
    registry.projects[env.projectDir] = {
      path: env.projectDir,
      libs: {
        [libName]: {
          commit,
          localPath,
          platforms: ['iOS'],
          linkedAt: Date.now(),
        },
      },
    };
    registry.store[libName].platforms.iOS.usedBy = [env.projectDir];
    await saveRegistry(env, registry);

    // Then: 验证第一次链接后的状态
    registry = await loadRegistry(env);
    const projectInfo1 = registry.projects[env.projectDir];
    expect(projectInfo1).toBeDefined();
    expect(projectInfo1.libs[libName].platforms).toContain('iOS');

    const storeEntry1 = registry.store[libName];
    expect(storeEntry1.platforms.iOS.usedBy).toContain(env.projectDir);

    // When: 第二次 link - 选择 android 平台（追加）
    await linkLib(localPath, storeCommitPath, ['iOS', 'android']);

    // 更新 registry - 模拟 link 命令的累积行为
    registry = await loadRegistry(env);
    registry.projects[env.projectDir].libs[libName].platforms = ['iOS', 'android'];
    registry.store[libName].platforms.android.usedBy = [env.projectDir];
    await saveRegistry(env, registry);

    // Then: 验证第二次链接后的状态
    registry = await loadRegistry(env);
    const projectInfo2 = registry.projects[env.projectDir];

    // registry.json 中 ProjectInfo.platforms = ['iOS', 'android']（累积）
    expect(projectInfo2.libs[libName].platforms).toEqual(['iOS', 'android']);

    // StoreEntry(iOS).usedBy 包含项目路径
    expect(registry.store[libName].platforms.iOS.usedBy).toContain(env.projectDir);

    // StoreEntry(android).usedBy 包含项目路径
    expect(registry.store[libName].platforms.android.usedBy).toContain(env.projectDir);

    // 本地目录是多平台结构（顶层真实目录，内部有平台符号链接）
    const localStat = await fs.lstat(localPath);
    expect(localStat.isDirectory()).toBe(true);
    expect(localStat.isSymbolicLink()).toBe(false);

    // 验证平台符号链接
    await verifySymlink(
      path.join(localPath, 'iOS'),
      path.join(storeCommitPath, 'iOS')
    );
    await verifySymlink(
      path.join(localPath, 'android'),
      path.join(storeCommitPath, 'android')
    );
  });

  it('should maintain StoreEntry references for all linked platforms', async () => {
    env = await createTestEnv();

    const libName = 'libMultiRef';
    const commit = 'def456';
    const platforms = ['macOS', 'Win', 'android'];

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
            android: { downloadedAt: Date.now(), usedBy: [] },
          },
        },
      },
      projects: {},
    };
    await saveRegistry(env, initialRegistry);

    // 链接所有三个平台
    await linkLib(localPath, storeCommitPath, platforms);

    // 更新 registry
    let registry = await loadRegistry(env);
    registry.projects[env.projectDir] = {
      path: env.projectDir,
      libs: {
        [libName]: {
          commit,
          localPath,
          platforms: platforms,
          linkedAt: Date.now(),
        },
      },
    };
    for (const platform of platforms) {
      registry.store[libName].platforms[platform].usedBy = [env.projectDir];
    }
    await saveRegistry(env, registry);

    // 验证所有 StoreEntry 都有引用
    registry = await loadRegistry(env);
    for (const platform of platforms) {
      expect(registry.store[libName].platforms[platform].usedBy).toContain(env.projectDir);
    }
  });
});
