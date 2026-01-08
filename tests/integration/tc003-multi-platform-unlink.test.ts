/**
 * TC-003: unlink 还原测试
 *
 * 验证场景：
 * - 多平台链接后执行 unlink (restoreMultiPlatform)
 * - 单平台链接后执行 unlink (restoreFromLink)
 * - 符号链接变为真实目录
 * - 目录内有实际文件
 * - _shared 文件保持完整
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import {
  createTestEnv,
  createMockStoreData,
  verifyNotSymlink,
  verifyDirectoryContents,
  type TestEnv,
} from './setup.js';
import { linkLib, restoreMultiPlatform, restoreFromLink, isSymlink } from '../../src/core/linker.js';

describe('TC-003: 多平台 unlink 还原', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('should restore multi-platform symlinks to real directories', async () => {
    env = await createTestEnv();

    const libName = 'libRestore';
    const commit = 'restore123';
    const platforms = ['macOS', 'android'];

    // Given: 多平台链接后的项目
    await createMockStoreData(env, libName, commit, platforms);

    const localPath = path.join(env.projectDir, '3rdParty', libName);
    const storeCommitPath = path.join(env.storeDir, libName, commit);

    // 执行多平台链接
    await linkLib(localPath, storeCommitPath, platforms);

    // 验证链接前状态（是符号链接）
    const macOSStat = await fs.lstat(path.join(localPath, 'macOS'));
    expect(macOSStat.isSymbolicLink()).toBe(true);

    // When: 执行 restoreMultiPlatform（unlink 的核心操作）
    await restoreMultiPlatform(localPath);

    // Then: 符号链接变为真实目录
    for (const platform of platforms) {
      const platformPath = path.join(localPath, platform);

      // 不再是符号链接
      await verifyNotSymlink(platformPath);

      // 是真实目录
      const stat = await fs.lstat(platformPath);
      expect(stat.isDirectory()).toBe(true);

      // 目录内有实际文件
      const files = await fs.readdir(platformPath);
      expect(files.length).toBeGreaterThan(0);
      expect(files).toContain('lib.a');
    }
  });

  it('should preserve _shared files after unlink', async () => {
    env = await createTestEnv();

    const libName = 'libShared';
    const commit = 'shared123';
    const platforms = ['macOS', 'android'];

    await createMockStoreData(env, libName, commit, platforms);

    const localPath = path.join(env.projectDir, '3rdParty', libName);
    const storeCommitPath = path.join(env.storeDir, libName, commit);

    // 链接
    await linkLib(localPath, storeCommitPath, platforms);

    // 验证 _shared 文件存在
    const codepacDepPath = path.join(localPath, 'codepac-dep.json');
    await expect(fs.access(codepacDepPath)).resolves.toBeUndefined();

    // When: 还原
    await restoreMultiPlatform(localPath);

    // Then: _shared 文件保持完整
    await expect(fs.access(codepacDepPath)).resolves.toBeUndefined();

    const content = JSON.parse(await fs.readFile(codepacDepPath, 'utf-8'));
    expect(content.repos.common[0].commit).toBe(commit);
  });

  it('should handle directory with mixed content', async () => {
    env = await createTestEnv();

    const libName = 'libMixed';
    const commit = 'mixed123';
    const platforms = ['macOS'];

    await createMockStoreData(env, libName, commit, platforms);

    const localPath = path.join(env.projectDir, '3rdParty', libName);
    const storeCommitPath = path.join(env.storeDir, libName, commit);

    // 链接
    await linkLib(localPath, storeCommitPath, platforms);

    // 添加额外的普通文件（模拟用户添加的文件）
    await fs.writeFile(path.join(localPath, 'user-note.txt'), 'user content');

    // When: 还原
    await restoreMultiPlatform(localPath);

    // Then: 普通文件保留
    const userNote = await fs.readFile(path.join(localPath, 'user-note.txt'), 'utf-8');
    expect(userNote).toBe('user content');

    // 平台目录已还原
    await verifyNotSymlink(path.join(localPath, 'macOS'));
  });
});

describe('TC-003b: 单平台 unlink 还原 (restoreFromLink)', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('should restore single-platform top-level symlink to real directory', async () => {
    env = await createTestEnv();

    const libName = 'libSingle';
    const commit = 'single123';
    const platforms = ['macOS'];

    // Given: Store 中有库
    await createMockStoreData(env, libName, commit, platforms);

    const storeTarget = path.join(env.storeDir, libName, commit, 'macOS');
    const localPath = path.join(env.projectDir, '3rdParty', libName);

    // 创建单平台链接（顶层就是符号链接）
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.symlink(storeTarget, localPath);

    // 验证是符号链接
    expect(await isSymlink(localPath)).toBe(true);

    // When: 执行 restoreFromLink
    await restoreFromLink(localPath);

    // Then: 变为真实目录
    expect(await isSymlink(localPath)).toBe(false);

    const stat = await fs.lstat(localPath);
    expect(stat.isDirectory()).toBe(true);

    // 目录内有实际文件（从 Store 复制过来）
    const files = await fs.readdir(localPath);
    expect(files).toContain('lib.a');
    expect(files).toContain('include.h');
  });

  it('should preserve file contents after restore', async () => {
    env = await createTestEnv();

    const libName = 'libContent';
    const commit = 'content123';
    const platforms = ['android'];

    // Given: Store 中有库
    await createMockStoreData(env, libName, commit, platforms);

    const storeTarget = path.join(env.storeDir, libName, commit, 'android');
    const localPath = path.join(env.projectDir, '3rdParty', libName);

    // 创建单平台链接
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.symlink(storeTarget, localPath);

    // When: 还原
    await restoreFromLink(localPath);

    // Then: 文件内容正确
    const libContent = await fs.readFile(path.join(localPath, 'lib.a'), 'utf-8');
    expect(libContent).toContain('android');
  });

  it('should throw error for non-symlink path', async () => {
    env = await createTestEnv();

    // Given: 普通目录（不是符号链接）
    const localPath = path.join(env.projectDir, '3rdParty', 'normalDir');
    await fs.mkdir(localPath, { recursive: true });
    await fs.writeFile(path.join(localPath, 'file.txt'), 'content');

    // When/Then: 应该抛出错误
    await expect(restoreFromLink(localPath)).rejects.toThrow('不是符号链接');
  });

  it('should handle nested symlinks in restored directory', async () => {
    env = await createTestEnv();

    const libName = 'libNested';
    const commit = 'nested123';
    const platforms = ['macOS'];

    // Given: Store 中有库，且内部有符号链接
    await createMockStoreData(env, libName, commit, platforms);

    // 在 Store 的平台目录内添加一个符号链接
    const storePlatformPath = path.join(env.storeDir, libName, commit, 'macOS');
    const nestedTarget = path.join(storePlatformPath, 'lib.a');
    const nestedLink = path.join(storePlatformPath, 'lib-link.a');
    await fs.symlink(nestedTarget, nestedLink);

    const storeTarget = storePlatformPath;
    const localPath = path.join(env.projectDir, '3rdParty', libName);

    // 创建单平台链接
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.symlink(storeTarget, localPath);

    // When: 还原（应该保留内部的符号链接）
    await restoreFromLink(localPath);

    // Then: 内部符号链接被保留
    const nestedLinkLocal = path.join(localPath, 'lib-link.a');
    expect(await isSymlink(nestedLinkLocal)).toBe(true);

    // 但顶层不再是符号链接
    expect(await isSymlink(localPath)).toBe(false);
  });
});
