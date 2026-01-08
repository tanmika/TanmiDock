/**
 * linkLib 集成测试
 *
 * 测试 linkLib 函数的真实文件系统行为:
 * - 符号链接平台目录
 * - 复制共享文件
 * - registry 数据验证
 */
import { describe, it, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import {
  createTestEnv,
  createMockStoreData,
  verifySymlink,
  verifyDirectoryContents,
  type TestEnv,
} from './setup.js';
import { linkLib } from '../../src/core/linker.js';

describe('integration/linkLib', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('single platform linking', () => {
    it('should create symlink for single platform', async () => {
      env = await createTestEnv();

      // 创建 Store 数据
      await createMockStoreData(env, 'libTest', 'abc123', ['macOS']);

      // 创建本地目录路径
      const localPath = path.join(env.projectDir, '3rdParty', 'libTest');
      const storeCommitPath = path.join(env.storeDir, 'libTest', 'abc123');

      // 执行 linkLib
      await linkLib(localPath, storeCommitPath, ['macOS']);

      // 验证平台目录是符号链接
      const macOSPath = path.join(localPath, 'macOS');
      const expectedTarget = path.join(storeCommitPath, 'macOS');
      await verifySymlink(macOSPath, expectedTarget);
    });

    it('should copy _shared files to local directory', async () => {
      env = await createTestEnv();

      // 创建 Store 数据
      await createMockStoreData(env, 'libTest', 'abc123', ['macOS']);

      const localPath = path.join(env.projectDir, '3rdParty', 'libTest');
      const storeCommitPath = path.join(env.storeDir, 'libTest', 'abc123');

      // 执行 linkLib
      await linkLib(localPath, storeCommitPath, ['macOS']);

      // 验证 _shared 内容被复制（不是链接）
      const codepacDepPath = path.join(localPath, 'codepac-dep.json');
      const stat = await fs.lstat(codepacDepPath);

      // 应该是普通文件，不是符号链接
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isFile()).toBe(true);

      // 验证内容正确
      const content = JSON.parse(await fs.readFile(codepacDepPath, 'utf-8'));
      expect(content.repos.common[0].commit).toBe('abc123');
    });
  });

  describe('multiple platform linking', () => {
    it('should create symlinks for multiple platforms', async () => {
      env = await createTestEnv();

      // 创建包含多平台的 Store 数据
      await createMockStoreData(env, 'libMulti', 'def456', ['macOS', 'android', 'iOS']);

      const localPath = path.join(env.projectDir, '3rdParty', 'libMulti');
      const storeCommitPath = path.join(env.storeDir, 'libMulti', 'def456');

      // 执行 linkLib，链接两个平台
      await linkLib(localPath, storeCommitPath, ['macOS', 'android']);

      // 验证两个平台都是符号链接
      await verifySymlink(
        path.join(localPath, 'macOS'),
        path.join(storeCommitPath, 'macOS')
      );
      await verifySymlink(
        path.join(localPath, 'android'),
        path.join(storeCommitPath, 'android')
      );

      // iOS 不应该被链接
      const iOSPath = path.join(localPath, 'iOS');
      await expect(fs.lstat(iOSPath)).rejects.toThrow();
    });

    it('should handle all available platforms', async () => {
      env = await createTestEnv();

      await createMockStoreData(env, 'libAll', 'ghi789', ['macOS', 'Win', 'android', 'iOS']);

      const localPath = path.join(env.projectDir, '3rdParty', 'libAll');
      const storeCommitPath = path.join(env.storeDir, 'libAll', 'ghi789');

      // 链接所有平台
      await linkLib(localPath, storeCommitPath, ['macOS', 'Win', 'android', 'iOS']);

      // 验证目录包含所有平台链接和共享文件
      await verifyDirectoryContents(localPath, [
        'macOS',
        'Win',
        'android',
        'iOS',
        'codepac-dep.json',
        'common.h',
      ]);
    });
  });

  describe('directory structure', () => {
    it('should create correct directory structure', async () => {
      env = await createTestEnv();

      await createMockStoreData(env, 'libStruct', 'jkl012', ['macOS']);

      const localPath = path.join(env.projectDir, '3rdParty', 'libStruct');
      const storeCommitPath = path.join(env.storeDir, 'libStruct', 'jkl012');

      await linkLib(localPath, storeCommitPath, ['macOS']);

      // 验证结构:
      // 3rdParty/libStruct/
      // ├── macOS/      → Store/.../macOS/     (符号链接)
      // ├── codepac-dep.json                   (复制自 _shared)
      // └── common.h                           (复制自 _shared)

      const entries = await fs.readdir(localPath);
      expect(entries).toContain('macOS');
      expect(entries).toContain('codepac-dep.json');
      expect(entries).toContain('common.h');

      // 确保没有 _shared 目录（内容应该被展开到根目录）
      expect(entries).not.toContain('_shared');
    });

    it('should clean up existing directory before linking', async () => {
      env = await createTestEnv();

      await createMockStoreData(env, 'libClean', 'mno345', ['macOS']);

      const localPath = path.join(env.projectDir, '3rdParty', 'libClean');
      const storeCommitPath = path.join(env.storeDir, 'libClean', 'mno345');

      // 预先创建目录和文件
      await fs.mkdir(localPath, { recursive: true });
      await fs.writeFile(path.join(localPath, 'old-file.txt'), 'old content');

      // 执行 linkLib
      await linkLib(localPath, storeCommitPath, ['macOS']);

      // 旧文件应该被清理
      const entries = await fs.readdir(localPath);
      expect(entries).not.toContain('old-file.txt');

      // 新链接应该存在
      expect(entries).toContain('macOS');
    });
  });

  describe('error handling', () => {
    it('should skip non-existent platforms gracefully', async () => {
      env = await createTestEnv();

      // 只创建 macOS 平台
      await createMockStoreData(env, 'libPartial', 'pqr678', ['macOS']);

      const localPath = path.join(env.projectDir, '3rdParty', 'libPartial');
      const storeCommitPath = path.join(env.storeDir, 'libPartial', 'pqr678');

      // 尝试链接 macOS 和不存在的 android
      await linkLib(localPath, storeCommitPath, ['macOS', 'android']);

      // macOS 应该被链接
      await verifySymlink(
        path.join(localPath, 'macOS'),
        path.join(storeCommitPath, 'macOS')
      );

      // android 目录不应该存在（因为 Store 中没有）
      const androidPath = path.join(localPath, 'android');
      await expect(fs.lstat(androidPath)).rejects.toThrow();
    });

    it('should handle empty platforms array', async () => {
      env = await createTestEnv();

      await createMockStoreData(env, 'libEmpty', 'stu901', ['macOS']);

      const localPath = path.join(env.projectDir, '3rdParty', 'libEmpty');
      const storeCommitPath = path.join(env.storeDir, 'libEmpty', 'stu901');

      // 空平台列表
      await linkLib(localPath, storeCommitPath, []);

      // 目录应该存在
      await expect(fs.access(localPath)).resolves.toBeUndefined();

      // 没有平台链接
      const entries = await fs.readdir(localPath);
      expect(entries).not.toContain('macOS');

      // 但 _shared 内容应该被复制
      expect(entries).toContain('codepac-dep.json');
    });

    it('should handle missing _shared directory', async () => {
      env = await createTestEnv();

      // 手动创建没有 _shared 的 Store 数据
      const libDir = path.join(env.storeDir, 'libNoShared', 'vwx234');
      const platformDir = path.join(libDir, 'macOS');
      await fs.mkdir(platformDir, { recursive: true });
      await fs.writeFile(path.join(platformDir, 'lib.a'), 'mock lib');

      const localPath = path.join(env.projectDir, '3rdParty', 'libNoShared');
      const storeCommitPath = path.join(env.storeDir, 'libNoShared', 'vwx234');

      // 应该成功执行，不报错
      await linkLib(localPath, storeCommitPath, ['macOS']);

      // 平台链接应该存在
      await verifySymlink(
        path.join(localPath, 'macOS'),
        path.join(storeCommitPath, 'macOS')
      );

      // 目录中只有平台链接
      const entries = await fs.readdir(localPath);
      expect(entries).toEqual(['macOS']);
    });
  });

  describe('symlink target verification', () => {
    it('should create valid symlinks that resolve to correct files', async () => {
      env = await createTestEnv();

      await createMockStoreData(env, 'libValid', 'yza567', ['macOS']);

      const localPath = path.join(env.projectDir, '3rdParty', 'libValid');
      const storeCommitPath = path.join(env.storeDir, 'libValid', 'yza567');

      await linkLib(localPath, storeCommitPath, ['macOS']);

      // 通过符号链接访问文件
      const libPath = path.join(localPath, 'macOS', 'lib.a');
      const content = await fs.readFile(libPath, 'utf-8');

      expect(content).toBe('Mock library for macOS');
    });

    it('should maintain symlink after multiple operations', async () => {
      env = await createTestEnv();

      await createMockStoreData(env, 'libMultiOp', 'bcd890', ['macOS', 'android']);

      const localPath = path.join(env.projectDir, '3rdParty', 'libMultiOp');
      const storeCommitPath = path.join(env.storeDir, 'libMultiOp', 'bcd890');

      // 第一次链接
      await linkLib(localPath, storeCommitPath, ['macOS']);
      await verifySymlink(
        path.join(localPath, 'macOS'),
        path.join(storeCommitPath, 'macOS')
      );

      // 第二次链接（更换平台）
      await linkLib(localPath, storeCommitPath, ['android']);

      // macOS 应该被移除
      await expect(fs.lstat(path.join(localPath, 'macOS'))).rejects.toThrow();

      // android 应该存在
      await verifySymlink(
        path.join(localPath, 'android'),
        path.join(storeCommitPath, 'android')
      );
    });
  });
});
