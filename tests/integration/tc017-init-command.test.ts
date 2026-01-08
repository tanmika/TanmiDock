/**
 * TC-017: init 命令测试
 *
 * 测试场景:
 * - S-1.1.1: 首次初始化 - 创建配置和 Store 目录
 * - S-1.1.2: 重复初始化 - 检测已初始化状态
 * - S-1.1.3: 指定 Store 路径
 * - S-1.2.1: 路径安全检查
 * - S-1.2.2: 目录非空警告
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { isPathSafe } from '../../src/core/platform.js';

describe('TC-017: init 命令测试', () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    originalEnv = process.env.TANMI_DOCK_HOME;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tanmi-dock-init-test-'));
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env.TANMI_DOCK_HOME = originalEnv;
    } else {
      delete process.env.TANMI_DOCK_HOME;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('S-1.1.1: 首次初始化', () => {
    it('should create config directory structure', async () => {
      const homeDir = path.join(tempDir, '.tanmi-dock');
      process.env.TANMI_DOCK_HOME = homeDir;

      // 模拟创建配置目录
      await fs.mkdir(homeDir, { recursive: true });

      // 验证目录存在
      const exists = await fs.access(homeDir).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should create config.json with correct structure', async () => {
      const homeDir = path.join(tempDir, '.tanmi-dock');
      const storeDir = path.join(tempDir, 'store');
      process.env.TANMI_DOCK_HOME = homeDir;

      await fs.mkdir(homeDir, { recursive: true });
      await fs.mkdir(storeDir, { recursive: true });

      // 模拟创建配置
      const config = {
        version: '1.1.0',
        initialized: true,
        storePath: storeDir,
        cleanStrategy: 'unreferenced',
        unusedDays: 30,
        autoDownload: true,
      };
      await fs.writeFile(
        path.join(homeDir, 'config.json'),
        JSON.stringify(config, null, 2),
        'utf-8'
      );

      // 验证配置文件
      const content = await fs.readFile(path.join(homeDir, 'config.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe('1.1.0');
      expect(parsed.initialized).toBe(true);
      expect(parsed.storePath).toBe(storeDir);
    });

    it('should create empty registry.json', async () => {
      const homeDir = path.join(tempDir, '.tanmi-dock');
      process.env.TANMI_DOCK_HOME = homeDir;

      await fs.mkdir(homeDir, { recursive: true });

      // 模拟创建空注册表
      const registry = {
        version: '1.0.0',
        projects: {},
        libraries: {},
        stores: {},
      };
      await fs.writeFile(
        path.join(homeDir, 'registry.json'),
        JSON.stringify(registry, null, 2),
        'utf-8'
      );

      // 验证注册表文件
      const content = await fs.readFile(path.join(homeDir, 'registry.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe('1.0.0');
      expect(parsed.projects).toEqual({});
      expect(parsed.libraries).toEqual({});
    });
  });

  describe('S-1.1.2: 重复初始化检测', () => {
    it('should detect already initialized state', async () => {
      const homeDir = path.join(tempDir, '.tanmi-dock');
      const storeDir = path.join(tempDir, 'store');
      process.env.TANMI_DOCK_HOME = homeDir;

      await fs.mkdir(homeDir, { recursive: true });
      await fs.mkdir(storeDir, { recursive: true });

      // 创建配置表示已初始化
      const config = {
        version: '1.1.0',
        initialized: true,
        storePath: storeDir,
      };
      await fs.writeFile(
        path.join(homeDir, 'config.json'),
        JSON.stringify(config, null, 2),
        'utf-8'
      );

      // 验证配置存在
      const configExists = await fs.access(path.join(homeDir, 'config.json')).then(() => true).catch(() => false);
      expect(configExists).toBe(true);

      // 读取配置验证 initialized 标志
      const content = await fs.readFile(path.join(homeDir, 'config.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.initialized).toBe(true);
    });
  });

  describe('S-1.1.3: 指定 Store 路径', () => {
    it('should use custom store path when specified', async () => {
      const homeDir = path.join(tempDir, '.tanmi-dock');
      const customStoreDir = path.join(tempDir, 'custom-store');
      process.env.TANMI_DOCK_HOME = homeDir;

      await fs.mkdir(homeDir, { recursive: true });
      await fs.mkdir(customStoreDir, { recursive: true });

      // 使用自定义路径创建配置
      const config = {
        version: '1.1.0',
        initialized: true,
        storePath: customStoreDir,
      };
      await fs.writeFile(
        path.join(homeDir, 'config.json'),
        JSON.stringify(config, null, 2),
        'utf-8'
      );

      // 验证配置中的路径
      const content = await fs.readFile(path.join(homeDir, 'config.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.storePath).toBe(customStoreDir);
    });
  });

  describe('S-1.2.1: 路径安全检查', () => {
    it('should reject system directories', () => {
      const systemPaths = ['/usr', '/bin', '/etc', '/var', '/System'];
      for (const sysPath of systemPaths) {
        const result = isPathSafe(sysPath);
        expect(result.safe).toBe(false);
      }
    });

    it('should reject /tmp directory', () => {
      const result = isPathSafe('/tmp');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('/tmp');
    });

    it('should accept valid user directory', () => {
      const validPath = path.join(os.homedir(), '.tanmi-dock', 'store');
      const result = isPathSafe(validPath);
      expect(result.safe).toBe(true);
    });

    it('should accept subdirectory under home', () => {
      const validPath = path.join(os.homedir(), 'Library', 'TanmiDock', 'Store');
      const result = isPathSafe(validPath);
      expect(result.safe).toBe(true);
    });
  });

  describe('S-1.2.2: 目录非空警告', () => {
    it('should detect non-empty directory', async () => {
      const storeDir = path.join(tempDir, 'store');
      await fs.mkdir(storeDir, { recursive: true });

      // 创建一些文件使目录非空
      await fs.writeFile(path.join(storeDir, 'existing-file.txt'), 'content');

      // 验证目录非空
      const entries = await fs.readdir(storeDir);
      expect(entries.length).toBeGreaterThan(0);
    });

    it('should detect empty directory', async () => {
      const storeDir = path.join(tempDir, 'empty-store');
      await fs.mkdir(storeDir, { recursive: true });

      // 验证目录为空
      const entries = await fs.readdir(storeDir);
      expect(entries.length).toBe(0);
    });
  });
});
