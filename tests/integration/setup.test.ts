/**
 * setup.ts 单元测试
 *
 * 验证集成测试基础设施的正确性
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import {
  createTestEnv,
  createMockStoreData,
  createMockProjectData,
  verifySymlink,
  verifyNotSymlink,
  verifyDirectoryContents,
  loadRegistry,
  type TestEnv,
} from './setup.js';

describe('integration/setup', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('createTestEnv', () => {
    it('should create temp directory structure', async () => {
      env = await createTestEnv();

      // 验证目录存在
      expect(env.tempDir).toBeDefined();
      expect(env.homeDir).toBeDefined();
      expect(env.storeDir).toBeDefined();
      expect(env.projectDir).toBeDefined();

      // 验证目录实际存在
      await expect(fs.access(env.tempDir)).resolves.toBeUndefined();
      await expect(fs.access(env.homeDir)).resolves.toBeUndefined();
      await expect(fs.access(env.storeDir)).resolves.toBeUndefined();
      await expect(fs.access(env.projectDir)).resolves.toBeUndefined();
    });

    it('should set TANMI_DOCK_HOME environment variable', async () => {
      env = await createTestEnv();

      expect(process.env.TANMI_DOCK_HOME).toBe(env.homeDir);
    });

    it('should create config.json and registry.json', async () => {
      env = await createTestEnv();

      const configPath = path.join(env.homeDir, 'config.json');
      const registryPath = path.join(env.homeDir, 'registry.json');

      await expect(fs.access(configPath)).resolves.toBeUndefined();
      await expect(fs.access(registryPath)).resolves.toBeUndefined();

      // 验证 config.json 内容
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      expect(config.initialized).toBe(true);
      expect(config.storePath).toBe(env.storeDir);

      // 验证 registry.json 内容
      const registry = JSON.parse(await fs.readFile(registryPath, 'utf-8'));
      expect(registry.projects).toEqual({});
      expect(registry.stores).toEqual({});
    });

    it('should cleanup temp directory and restore env', async () => {
      const originalEnv = process.env.TANMI_DOCK_HOME;
      env = await createTestEnv();
      const tempDir = env.tempDir;

      await env.cleanup();
      env = null; // 标记已清理

      // 验证临时目录已删除
      await expect(fs.access(tempDir)).rejects.toThrow();

      // 验证环境变量已恢复
      expect(process.env.TANMI_DOCK_HOME).toBe(originalEnv);
    });
  });

  describe('createMockStoreData', () => {
    it('should create platform directories with files', async () => {
      env = await createTestEnv();
      await createMockStoreData(env, 'libTest', 'abc123', ['macOS', 'android']);

      const libDir = path.join(env.storeDir, 'libTest', 'abc123');

      // 验证平台目录
      await expect(fs.access(path.join(libDir, 'macOS'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(libDir, 'android'))).resolves.toBeUndefined();

      // 验证示例文件
      await expect(fs.access(path.join(libDir, 'macOS', 'lib.a'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(libDir, 'android', 'lib.a'))).resolves.toBeUndefined();
    });

    it('should create _shared directory with codepac-dep.json', async () => {
      env = await createTestEnv();
      await createMockStoreData(env, 'libTest', 'abc123', ['macOS', 'android']);

      const sharedDir = path.join(env.storeDir, 'libTest', 'abc123', '_shared');

      // 验证 _shared 目录
      await expect(fs.access(sharedDir)).resolves.toBeUndefined();

      // 验证 codepac-dep.json
      const codepacPath = path.join(sharedDir, 'codepac-dep.json');
      const codepac = JSON.parse(await fs.readFile(codepacPath, 'utf-8'));
      expect(codepac.repos.common[0].commit).toBe('abc123');
    });
  });

  describe('createMockProjectData', () => {
    it('should create 3rdparty directory structure', async () => {
      env = await createTestEnv();
      await createMockProjectData(env, [
        { libName: 'libA', linkedPath: '' },
        { libName: 'libB', linkedPath: '' },
      ]);

      const thirdpartyDir = path.join(env.projectDir, '3rdparty');

      // 验证目录存在
      await expect(fs.access(thirdpartyDir)).resolves.toBeUndefined();
      await expect(fs.access(path.join(thirdpartyDir, 'libA'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(thirdpartyDir, 'libB'))).resolves.toBeUndefined();
    });

    it('should create codepac-dep.json in project root', async () => {
      env = await createTestEnv();
      await createMockProjectData(env, [{ libName: 'libTest', linkedPath: '' }]);

      const codepacPath = path.join(env.projectDir, 'codepac-dep.json');
      const codepac = JSON.parse(await fs.readFile(codepacPath, 'utf-8'));

      expect(codepac.repos.common).toHaveLength(1);
      expect(codepac.repos.common[0].dir).toBe('libTest');
    });
  });

  describe('verifySymlink', () => {
    it('should pass for valid symlink', async () => {
      env = await createTestEnv();

      const targetDir = path.join(env.tempDir, 'target');
      const linkPath = path.join(env.tempDir, 'link');

      await fs.mkdir(targetDir);
      await fs.symlink(targetDir, linkPath);

      // 应该不抛错
      await expect(verifySymlink(linkPath, targetDir)).resolves.toBeUndefined();
    });

    it('should throw for non-symlink', async () => {
      env = await createTestEnv();

      const dirPath = path.join(env.tempDir, 'normaldir');
      await fs.mkdir(dirPath);

      await expect(verifySymlink(dirPath, '/some/target')).rejects.toThrow();
    });

    it('should throw for wrong target', async () => {
      env = await createTestEnv();

      const targetDir = path.join(env.tempDir, 'target');
      const wrongTarget = path.join(env.tempDir, 'wrong');
      const linkPath = path.join(env.tempDir, 'link');

      await fs.mkdir(targetDir);
      await fs.mkdir(wrongTarget);
      await fs.symlink(targetDir, linkPath);

      await expect(verifySymlink(linkPath, wrongTarget)).rejects.toThrow();
    });
  });

  describe('verifyNotSymlink', () => {
    it('should pass for regular directory', async () => {
      env = await createTestEnv();

      const dirPath = path.join(env.tempDir, 'normaldir');
      await fs.mkdir(dirPath);

      await expect(verifyNotSymlink(dirPath)).resolves.toBeUndefined();
    });

    it('should throw for symlink', async () => {
      env = await createTestEnv();

      const targetDir = path.join(env.tempDir, 'target');
      const linkPath = path.join(env.tempDir, 'link');

      await fs.mkdir(targetDir);
      await fs.symlink(targetDir, linkPath);

      await expect(verifyNotSymlink(linkPath)).rejects.toThrow();
    });
  });

  describe('verifyDirectoryContents', () => {
    it('should pass when all entries exist', async () => {
      env = await createTestEnv();

      const dirPath = path.join(env.tempDir, 'testdir');
      await fs.mkdir(dirPath);
      await fs.writeFile(path.join(dirPath, 'file1.txt'), 'content');
      await fs.writeFile(path.join(dirPath, 'file2.txt'), 'content');
      await fs.mkdir(path.join(dirPath, 'subdir'));

      await expect(
        verifyDirectoryContents(dirPath, ['file1.txt', 'file2.txt', 'subdir'])
      ).resolves.toBeUndefined();
    });

    it('should throw when entry is missing', async () => {
      env = await createTestEnv();

      const dirPath = path.join(env.tempDir, 'testdir');
      await fs.mkdir(dirPath);
      await fs.writeFile(path.join(dirPath, 'file1.txt'), 'content');

      await expect(
        verifyDirectoryContents(dirPath, ['file1.txt', 'missing.txt'])
      ).rejects.toThrow();
    });
  });

  describe('loadRegistry', () => {
    it('should load registry data', async () => {
      env = await createTestEnv();

      const registry = await loadRegistry(env);

      expect(registry.version).toBe('1.0.0');
      expect(registry.projects).toEqual({});
      expect(registry.stores).toEqual({});
    });
  });
});
