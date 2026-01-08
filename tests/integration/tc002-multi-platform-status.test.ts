/**
 * TC-002: 多平台 status 检测
 *
 * 验证场景：
 * - 多平台链接后的项目结构（顶层普通目录，内部符号链接）
 * - 能正确检测链接状态
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import {
  createTestEnv,
  createMockStoreData,
  verifySymlink,
  verifyNotSymlink,
  type TestEnv,
} from './setup.js';
import { linkLib, isSymlink } from '../../src/core/linker.js';

/**
 * 检测链接状态（模拟 status 命令的检测逻辑）
 */
async function detectLinkStatus(localPath: string): Promise<{
  isLinked: boolean;
  isTopLevelLink: boolean;
  hasInternalLinks: boolean;
}> {
  const isTopLevelLink = await isSymlink(localPath);
  let hasInternalLinks = false;

  if (!isTopLevelLink) {
    try {
      const entries = await fs.readdir(localPath, { withFileTypes: true });
      for (const entry of entries) {
        if (await isSymlink(path.join(localPath, entry.name))) {
          hasInternalLinks = true;
          break;
        }
      }
    } catch {
      // 目录不存在或无法读取
    }
  }

  return {
    isLinked: isTopLevelLink || hasInternalLinks,
    isTopLevelLink,
    hasInternalLinks,
  };
}

describe('TC-002: 多平台 status 检测', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('should detect multi-platform linked directory as linked', async () => {
    env = await createTestEnv();

    const libName = 'libStatus';
    const commit = 'status123';
    const platforms = ['macOS', 'android'];

    // Given: 创建 Store 数据和多平台链接
    await createMockStoreData(env, libName, commit, platforms);

    const localPath = path.join(env.projectDir, '3rdParty', libName);
    const storeCommitPath = path.join(env.storeDir, libName, commit);

    // 执行多平台链接
    await linkLib(localPath, storeCommitPath, platforms);

    // 验证目录结构：
    // 3rdparty/libName/       ← 普通目录
    // ├── macOS/              ← 符号链接
    // └── android/            ← 符号链接

    // 顶层是普通目录，不是符号链接
    await verifyNotSymlink(localPath);

    // 内部是符号链接
    await verifySymlink(
      path.join(localPath, 'macOS'),
      path.join(storeCommitPath, 'macOS')
    );
    await verifySymlink(
      path.join(localPath, 'android'),
      path.join(storeCommitPath, 'android')
    );

    // When: 检测链接状态
    const status = await detectLinkStatus(localPath);

    // Then: 应该检测到已链接状态
    expect(status.isLinked).toBe(true);
    expect(status.hasInternalLinks).toBe(true);
    expect(status.isTopLevelLink).toBe(false);
  });

  it('should detect single-platform linked directory as linked', async () => {
    env = await createTestEnv();

    const libName = 'libSingle';
    const commit = 'single123';

    await createMockStoreData(env, libName, commit, ['macOS']);

    const localPath = path.join(env.projectDir, '3rdParty', libName);
    const storeCommitPath = path.join(env.storeDir, libName, commit);

    // 单平台链接（整体符号链接）
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.symlink(storeCommitPath, localPath);

    // When: 检测链接状态
    const status = await detectLinkStatus(localPath);

    // Then: 应该检测到顶层链接
    expect(status.isLinked).toBe(true);
    expect(status.isTopLevelLink).toBe(true);
  });

  it('should detect unlinked directory correctly', async () => {
    env = await createTestEnv();

    const libName = 'libUnlinked';
    const commit = 'unlinked123';

    await createMockStoreData(env, libName, commit, ['macOS']);

    const localPath = path.join(env.projectDir, '3rdParty', libName);

    // 创建普通目录（未链接）
    await fs.mkdir(localPath, { recursive: true });
    await fs.writeFile(path.join(localPath, 'test.txt'), 'test');

    // When: 检测链接状态
    const status = await detectLinkStatus(localPath);

    // Then: 应该检测为未链接
    expect(status.isLinked).toBe(false);
  });
});
