/**
 * TC-009: 增量平台链接 (P1)
 *
 * 验证场景：
 * - 已链接 macOS 的项目
 * - 追加 android 平台
 * - 验证 registry.platforms 累积（非目录追加，linkLib 是重建）
 * - 验证新旧 StoreEntry 引用不丢失
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import {
  createTestEnv,
  createMockStoreData,
  loadRegistry,
  saveRegistry,
  verifySymlink,
  type TestEnv,
} from './setup.js';
import { linkLib } from '../../src/core/linker.js';
import type { Registry } from '../../src/types/index.js';

describe('TC-009: 增量平台链接', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('should accumulate platforms in registry when adding new platform', async () => {
    env = await createTestEnv();

    const libName = 'libIncremental';
    const commit = 'incr123';
    const allPlatforms = ['macOS', 'android', 'iOS'];

    // Given: Store 中有三个平台
    await createMockStoreData(env, libName, commit, allPlatforms);

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
            android: { downloadedAt: Date.now(), usedBy: [] },
            iOS: { downloadedAt: Date.now(), usedBy: [] },
          },
        },
      },
      projects: {},
    };
    await saveRegistry(env, initialRegistry);

    // When: 第一次链接 macOS
    await linkLib(localPath, storeCommitPath, ['macOS']);

    // 更新 registry
    let registry = await loadRegistry(env);
    registry.projects[env.projectDir] = {
      path: env.projectDir,
      libs: {
        [libName]: {
          commit,
          localPath,
          platforms: ['macOS'],
          linkedAt: Date.now(),
        },
      },
    };
    registry.store[libName].platforms.macOS.usedBy = [env.projectDir];
    await saveRegistry(env, registry);

    // Then: 第一次链接后状态正确
    registry = await loadRegistry(env);
    expect(registry.projects[env.projectDir].libs[libName].platforms).toEqual(['macOS']);
    expect(registry.store[libName].platforms.macOS.usedBy).toContain(env.projectDir);

    // When: 追加 android 平台（linkLib 是重建，但 registry 累积）
    await linkLib(localPath, storeCommitPath, ['macOS', 'android']);

    // 更新 registry - 累积平台
    registry = await loadRegistry(env);
    registry.projects[env.projectDir].libs[libName].platforms = ['macOS', 'android'];
    registry.store[libName].platforms.android.usedBy = [env.projectDir];
    await saveRegistry(env, registry);

    // Then: 平台累积
    registry = await loadRegistry(env);
    expect(registry.projects[env.projectDir].libs[libName].platforms).toEqual(['macOS', 'android']);

    // 旧平台引用保持
    expect(registry.store[libName].platforms.macOS.usedBy).toContain(env.projectDir);

    // 新平台引用添加
    expect(registry.store[libName].platforms.android.usedBy).toContain(env.projectDir);

    // 符号链接正确
    await verifySymlink(
      path.join(localPath, 'macOS'),
      path.join(storeCommitPath, 'macOS')
    );
    await verifySymlink(
      path.join(localPath, 'android'),
      path.join(storeCommitPath, 'android')
    );
  });

  it('should not lose existing StoreEntry references when rebuilding directory', async () => {
    env = await createTestEnv();

    const libName = 'libNoLose';
    const commit = 'nolose456';
    const platforms = ['macOS', 'Win'];

    await createMockStoreData(env, libName, commit, platforms);

    const localPath = path.join(env.projectDir, '3rdParty', libName);
    const storeCommitPath = path.join(env.storeDir, libName, commit);

    const otherProject = '/other/project';

    // 初始化 registry - macOS 已被其他项目使用
    const initialRegistry: Registry = {
      version: 2,
      store: {
        [libName]: {
          commit,
          platforms: {
            macOS: {
              downloadedAt: Date.now(),
              usedBy: [otherProject], // 其他项目已经在用
            },
            Win: { downloadedAt: Date.now(), usedBy: [] },
          },
        },
      },
      projects: {
        [otherProject]: {
          path: otherProject,
          libs: {
            [libName]: {
              commit,
              localPath: path.join(otherProject, '3rdParty', libName),
              platforms: ['macOS'],
              linkedAt: Date.now(),
            },
          },
        },
      },
    };
    await saveRegistry(env, initialRegistry);

    // When: 当前项目链接 macOS 和 Win
    await linkLib(localPath, storeCommitPath, platforms);

    // 更新 registry - 添加当前项目引用
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
    // 添加引用，不覆盖已有的
    if (!registry.store[libName].platforms.macOS.usedBy.includes(env.projectDir)) {
      registry.store[libName].platforms.macOS.usedBy.push(env.projectDir);
    }
    registry.store[libName].platforms.Win.usedBy.push(env.projectDir);
    await saveRegistry(env, registry);

    // Then: 其他项目的引用保持不变
    registry = await loadRegistry(env);
    expect(registry.store[libName].platforms.macOS.usedBy).toContain(otherProject);
    expect(registry.store[libName].platforms.macOS.usedBy).toContain(env.projectDir);

    // 当前项目引用正确
    expect(registry.store[libName].platforms.Win.usedBy).toContain(env.projectDir);
  });
});
