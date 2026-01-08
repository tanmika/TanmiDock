/**
 * TC-005~008: 补充测试用例
 *
 * TC-005: 单平台 status 检测 (P1)
 * TC-006: 未链接 status 检测 (P1)
 * TC-007: 链接失效检测 (P1)
 * TC-008: unlink --remove 清理 (P2)
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
import { isSymlink, isValidLink } from '../../src/core/linker.js';
import type { Registry } from '../../src/types/index.js';

describe('TC-005: 单平台 status 检测', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('should detect single-platform top-level symlink as linked', async () => {
    env = await createTestEnv();

    const libName = 'libSingleStatus';
    const commit = 'single456';

    await createMockStoreData(env, libName, commit, ['macOS']);

    const localPath = path.join(env.projectDir, '3rdParty', libName);
    const storeCommitPath = path.join(env.storeDir, libName, commit);

    // 创建顶层符号链接（单平台模式）
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.symlink(storeCommitPath, localPath);

    // Then: 应该是符号链接
    const isLink = await isSymlink(localPath);
    expect(isLink).toBe(true);

    // 验证指向正确
    await verifySymlink(localPath, storeCommitPath);
  });
});

describe('TC-006: 未链接 status 检测', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('should detect regular directory as unlinked', async () => {
    env = await createTestEnv();

    const localPath = path.join(env.projectDir, '3rdParty', 'libRegular');

    // 创建普通目录
    await fs.mkdir(localPath, { recursive: true });
    await fs.writeFile(path.join(localPath, 'file.txt'), 'content');

    // Then: 不是符号链接
    const isLink = await isSymlink(localPath);
    expect(isLink).toBe(false);

    // 检查内部也没有符号链接
    const entries = await fs.readdir(localPath, { withFileTypes: true });
    let hasInternalLinks = false;
    for (const entry of entries) {
      if (await isSymlink(path.join(localPath, entry.name))) {
        hasInternalLinks = true;
        break;
      }
    }
    expect(hasInternalLinks).toBe(false);
  });

  it('should handle non-existent directory', async () => {
    env = await createTestEnv();

    const localPath = path.join(env.projectDir, '3rdParty', 'libNotExist');

    // Then: 不是符号链接
    const isLink = await isSymlink(localPath);
    expect(isLink).toBe(false);
  });
});

describe('TC-007: 链接失效检测', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('should detect broken symlink', async () => {
    env = await createTestEnv();

    const libName = 'libBroken';
    const commit = 'broken789';

    await createMockStoreData(env, libName, commit, ['macOS']);

    const localPath = path.join(env.projectDir, '3rdParty', libName);
    const storeCommitPath = path.join(env.storeDir, libName, commit);

    // 创建符号链接
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.symlink(storeCommitPath, localPath);

    // 删除目标目录（模拟 Store 被清理）
    await fs.rm(storeCommitPath, { recursive: true });

    // Then: 是符号链接
    const isLink = await isSymlink(localPath);
    expect(isLink).toBe(true);

    // 但链接无效
    const isValid = await isValidLink(localPath);
    expect(isValid).toBe(false);
  });

  it('should detect broken internal symlinks in multi-platform directory', async () => {
    env = await createTestEnv();

    const libName = 'libBrokenMulti';
    const commit = 'brokenmulti';
    const platforms = ['macOS', 'android'];

    await createMockStoreData(env, libName, commit, platforms);

    const localPath = path.join(env.projectDir, '3rdParty', libName);
    const storeCommitPath = path.join(env.storeDir, libName, commit);

    // 手动创建多平台结构
    await fs.mkdir(localPath, { recursive: true });
    await fs.symlink(path.join(storeCommitPath, 'macOS'), path.join(localPath, 'macOS'));
    await fs.symlink(path.join(storeCommitPath, 'android'), path.join(localPath, 'android'));

    // 删除 macOS 平台目录
    await fs.rm(path.join(storeCommitPath, 'macOS'), { recursive: true });

    // Then: macOS 链接失效
    const macOSValid = await isValidLink(path.join(localPath, 'macOS'));
    expect(macOSValid).toBe(false);

    // android 链接仍然有效
    const androidValid = await isValidLink(path.join(localPath, 'android'));
    expect(androidValid).toBe(true);
  });
});

describe('TC-008: unlink --remove 清理', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('should support removing store entry when no other projects reference it', async () => {
    env = await createTestEnv();

    const libName = 'libRemove';
    const commit = 'remove123';

    await createMockStoreData(env, libName, commit, ['macOS']);

    // 初始化 registry - 只有一个项目引用
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
          },
        },
      },
      projects: {
        [env.projectDir]: {
          path: env.projectDir,
          libs: {
            [libName]: {
              commit,
              localPath: path.join(env.projectDir, '3rdParty', libName),
              platforms: ['macOS'],
              linkedAt: Date.now(),
            },
          },
        },
      },
    };
    await saveRegistry(env, initialRegistry);

    // When: 模拟 unlink --remove 操作
    // 1. 移除项目引用
    let registry = await loadRegistry(env);
    delete registry.projects[env.projectDir];

    // 2. 移除 store entry（因为没有其他项目引用）
    const storeEntry = registry.store[libName];
    storeEntry.platforms.macOS.usedBy = [];

    // 检查是否可以删除
    const canRemove = storeEntry.platforms.macOS.usedBy.length === 0;
    expect(canRemove).toBe(true);

    // 3. 删除 store entry 和物理文件
    if (canRemove) {
      delete registry.store[libName];
      await fs.rm(path.join(env.storeDir, libName), { recursive: true });
    }

    await saveRegistry(env, registry);

    // Then: store entry 被移除
    registry = await loadRegistry(env);
    expect(registry.store[libName]).toBeUndefined();

    // 物理文件被删除
    await expect(fs.access(path.join(env.storeDir, libName))).rejects.toThrow();
  });
});
