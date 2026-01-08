/**
 * TC-012: REPLACE 场景测试
 *
 * 验证场景：
 * - 本地是普通目录，Store 已有库 → 替换为链接
 * - 本地是错误链接 → 重建链接
 * - 本地不存在 → 直接创建链接
 * - 备份选项
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { createTestEnv, createMockStoreData, type TestEnv } from './setup.js';
import { replaceWithLink, isSymlink, isCorrectLink } from '../../src/core/linker.js';

describe('TC-012: REPLACE 场景测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('should replace directory with symlink (no backup)', async () => {
    env = await createTestEnv();

    const libName = 'libReplace';
    const commit = 'replace123';
    const platforms = ['macOS'];

    // Given: Store 中已有库
    await createMockStoreData(env, libName, commit, platforms);
    const storeTarget = path.join(env.storeDir, libName, commit, 'macOS');

    // 本地存在普通目录（含文件）
    const localPath = path.join(env.projectDir, '3rdParty', libName);
    await fs.mkdir(localPath, { recursive: true });
    await fs.writeFile(path.join(localPath, 'local-file.txt'), 'local content');

    // 验证是普通目录
    expect(await isSymlink(localPath)).toBe(false);

    // When: 执行 replaceWithLink（不备份）
    const backupPath = await replaceWithLink(localPath, storeTarget, false);

    // Then: 变为符号链接
    expect(await isSymlink(localPath)).toBe(true);
    expect(await isCorrectLink(localPath, storeTarget)).toBe(true);

    // 无备份
    expect(backupPath).toBeNull();

    // 原目录已删除
    const entries = await fs.readdir(path.dirname(localPath));
    const backups = entries.filter(e => e.startsWith(`${libName}.backup`));
    expect(backups).toHaveLength(0);
  });

  it('should replace directory with symlink (with backup)', async () => {
    env = await createTestEnv();

    const libName = 'libBackup';
    const commit = 'backup123';
    const platforms = ['macOS'];

    // Given: Store 中已有库
    await createMockStoreData(env, libName, commit, platforms);
    const storeTarget = path.join(env.storeDir, libName, commit, 'macOS');

    // 本地存在普通目录（含文件）
    const localPath = path.join(env.projectDir, '3rdParty', libName);
    await fs.mkdir(localPath, { recursive: true });
    await fs.writeFile(path.join(localPath, 'important-file.txt'), 'important content');

    // When: 执行 replaceWithLink（备份）
    const backupPath = await replaceWithLink(localPath, storeTarget, true);

    // Then: 变为符号链接
    expect(await isSymlink(localPath)).toBe(true);
    expect(await isCorrectLink(localPath, storeTarget)).toBe(true);

    // 有备份
    expect(backupPath).not.toBeNull();
    expect(backupPath).toContain('.backup.');

    // 备份目录存在且内容完整
    await expect(fs.access(backupPath!)).resolves.toBeUndefined();
    const backupContent = await fs.readFile(path.join(backupPath!, 'important-file.txt'), 'utf-8');
    expect(backupContent).toBe('important content');
  });

  it('should recreate symlink when pointing to wrong target (RELINK)', async () => {
    env = await createTestEnv();

    const libName = 'libRelink';
    const oldCommit = 'old123';
    const newCommit = 'new456';
    const platforms = ['macOS'];

    // Given: Store 中有两个版本
    await createMockStoreData(env, libName, oldCommit, platforms);
    await createMockStoreData(env, libName, newCommit, platforms);

    const oldTarget = path.join(env.storeDir, libName, oldCommit, 'macOS');
    const newTarget = path.join(env.storeDir, libName, newCommit, 'macOS');

    // 本地链接指向旧版本
    const localPath = path.join(env.projectDir, '3rdParty', libName);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.symlink(oldTarget, localPath);

    // 验证指向旧版本
    expect(await isCorrectLink(localPath, oldTarget)).toBe(true);
    expect(await isCorrectLink(localPath, newTarget)).toBe(false);

    // When: 执行 replaceWithLink 指向新版本
    const backupPath = await replaceWithLink(localPath, newTarget, false);

    // Then: 链接更新为新版本
    expect(await isSymlink(localPath)).toBe(true);
    expect(await isCorrectLink(localPath, newTarget)).toBe(true);
    expect(await isCorrectLink(localPath, oldTarget)).toBe(false);

    // 无备份（链接替换不需要备份）
    expect(backupPath).toBeNull();
  });

  it('should skip when already correct link', async () => {
    env = await createTestEnv();

    const libName = 'libAlready';
    const commit = 'already123';
    const platforms = ['macOS'];

    // Given: Store 中已有库
    await createMockStoreData(env, libName, commit, platforms);
    const storeTarget = path.join(env.storeDir, libName, commit, 'macOS');

    // 本地已是正确的链接
    const localPath = path.join(env.projectDir, '3rdParty', libName);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.symlink(storeTarget, localPath);

    // 记录链接创建时间
    const statBefore = await fs.lstat(localPath);

    // When: 执行 replaceWithLink
    const backupPath = await replaceWithLink(localPath, storeTarget, false);

    // Then: 链接未改变
    expect(backupPath).toBeNull();
    expect(await isSymlink(localPath)).toBe(true);
    expect(await isCorrectLink(localPath, storeTarget)).toBe(true);

    // 链接未被重建（时间戳相同）
    const statAfter = await fs.lstat(localPath);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it('should create symlink when path does not exist', async () => {
    env = await createTestEnv();

    const libName = 'libNew';
    const commit = 'new123';
    const platforms = ['macOS'];

    // Given: Store 中已有库
    await createMockStoreData(env, libName, commit, platforms);
    const storeTarget = path.join(env.storeDir, libName, commit, 'macOS');

    // 本地路径不存在
    const localPath = path.join(env.projectDir, '3rdParty', libName);
    // 确保父目录存在
    await fs.mkdir(path.dirname(localPath), { recursive: true });

    // 验证不存在
    await expect(fs.access(localPath)).rejects.toThrow();

    // When: 执行 replaceWithLink
    const backupPath = await replaceWithLink(localPath, storeTarget, false);

    // Then: 创建了符号链接
    expect(await isSymlink(localPath)).toBe(true);
    expect(await isCorrectLink(localPath, storeTarget)).toBe(true);
    expect(backupPath).toBeNull();
  });

  it('should throw error for non-directory path', async () => {
    env = await createTestEnv();

    const libName = 'libFile';
    const commit = 'file123';
    const platforms = ['macOS'];

    // Given: Store 中已有库
    await createMockStoreData(env, libName, commit, platforms);
    const storeTarget = path.join(env.storeDir, libName, commit, 'macOS');

    // 本地路径是文件（不是目录）
    const localPath = path.join(env.projectDir, '3rdParty', libName);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, 'this is a file');

    // When/Then: 应该抛出错误
    await expect(replaceWithLink(localPath, storeTarget, false)).rejects.toThrow('不是目录');
  });

  it('should handle upgrade scenario (directory -> new version link)', async () => {
    env = await createTestEnv();

    const libName = 'libUpgrade';
    const newCommit = 'v2.0.0';
    const platforms = ['macOS', 'android'];

    // Given: Store 中有新版本
    await createMockStoreData(env, libName, newCommit, platforms);

    // 本地存在旧版本目录（非链接，用户之前手动下载的）
    const localPath = path.join(env.projectDir, '3rdParty', libName);
    await fs.mkdir(path.join(localPath, 'macOS'), { recursive: true });
    await fs.mkdir(path.join(localPath, 'android'), { recursive: true });
    await fs.writeFile(path.join(localPath, 'macOS', 'old-lib.a'), 'old macOS lib');
    await fs.writeFile(path.join(localPath, 'android', 'old-lib.so'), 'old android lib');
    await fs.writeFile(path.join(localPath, 'version.txt'), 'v1.0.0');

    // 新版本目标（单平台链接场景）
    const storeTarget = path.join(env.storeDir, libName, newCommit, 'macOS');

    // When: 执行替换（备份旧版本）
    const backupPath = await replaceWithLink(localPath, storeTarget, true);

    // Then: 链接到新版本
    expect(await isSymlink(localPath)).toBe(true);
    expect(await isCorrectLink(localPath, storeTarget)).toBe(true);

    // 旧版本已备份
    expect(backupPath).not.toBeNull();
    await expect(fs.access(path.join(backupPath!, 'version.txt'))).resolves.toBeUndefined();
    const oldVersion = await fs.readFile(path.join(backupPath!, 'version.txt'), 'utf-8');
    expect(oldVersion).toBe('v1.0.0');
  });
});
