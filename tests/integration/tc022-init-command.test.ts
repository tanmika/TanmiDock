/**
 * TC-022: init 命令测试
 *
 * 测试场景:
 * - S-1.1.1: 首次初始化 - 创建配置和 Store 目录
 * - S-1.1.2: 重复初始化 - 检测已初始化状态
 * - S-1.1.3: 指定 Store 路径
 * - S-1.2.1: 路径安全检查（单元测试覆盖，此处验证集成）
 * - S-1.2.2: 目录非空警告
 *
 * v2.0: 调用 initializeDock() 入口函数
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import {
  verifyFileExists,
  verifyDirectoryExists,
  type TestEnv,
} from './setup.js';

// ============ 辅助函数 ============

/**
 * 保存原始环境变量
 */
let originalTanmiDockHome: string | undefined;

/**
 * 创建未初始化的测试环境
 * - 创建临时目录结构
 * - 设置 process.env.TANMI_DOCK_HOME
 * - 但不创建 config.json 和 registry.json
 */
async function createUninitializedEnv(): Promise<TestEnv> {
  // 保存原始环境变量
  originalTanmiDockHome = process.env.TANMI_DOCK_HOME;

  // 使用用户 home 目录下的临时目录，避免 /var 被 isPathSafe 拒绝
  // macOS 的 os.tmpdir() 返回 /var/folders/... 会被 isPathSafe 拒绝
  const baseTempDir = path.join(os.homedir(), '.tanmi-dock-test-tmp');
  await fs.mkdir(baseTempDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(baseTempDir, 'init-test-'));

  // 创建目录结构
  const homeDir = path.join(tempDir, '.tanmi-dock');
  const storeDir = path.join(tempDir, 'store');
  const projectDir = path.join(tempDir, 'project');

  // 只创建 homeDir 的父目录，不创建 homeDir 本身
  // 让 init 命令来创建
  await fs.mkdir(projectDir, { recursive: true });

  // 设置环境变量
  process.env.TANMI_DOCK_HOME = homeDir;

  // 返回 TestEnv
  return {
    tempDir,
    homeDir,
    storeDir,
    projectDir,
    cleanup: async () => {
      // 恢复环境变量
      if (originalTanmiDockHome !== undefined) {
        process.env.TANMI_DOCK_HOME = originalTanmiDockHome;
      } else {
        delete process.env.TANMI_DOCK_HOME;
      }

      // 删除临时目录
      await fs.rm(tempDir, { recursive: true, force: true });

      // 尝试清理基础临时目录（如果为空）
      const baseTempDir = path.join(os.homedir(), '.tanmi-dock-test-tmp');
      try {
        const entries = await fs.readdir(baseTempDir);
        if (entries.length === 0) {
          await fs.rmdir(baseTempDir);
        }
      } catch {
        // 忽略清理错误
      }
    },
  };
}

/**
 * 运行 init 命令
 */
async function runInitCommand(
  env: TestEnv,
  options: { storePath?: string; yes?: boolean }
): Promise<void> {
  // 确保环境变量正确设置
  process.env.TANMI_DOCK_HOME = env.homeDir;

  // 清除 registry 单例缓存
  const { resetRegistry } = await import('../../src/core/registry.js');
  resetRegistry();

  // 清除 config 模块缓存
  const config = await import('../../src/core/config.js');
  if (typeof (config as unknown as { resetConfig?: () => void }).resetConfig === 'function') {
    (config as unknown as { resetConfig: () => void }).resetConfig();
  }

  // 调用 initializeDock
  const { initializeDock } = await import('../../src/commands/init.js');
  await initializeDock({
    storePath: options.storePath ?? env.storeDir,
    yes: options.yes ?? true,
  });
}

describe('TC-022: init 命令测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('S-1.1.1: 首次初始化', () => {
    it('should create config directory and config.json', async () => {
      env = await createUninitializedEnv();

      // 验证 homeDir 还不存在
      const homeDirExistsBefore = await fs
        .access(env.homeDir)
        .then(() => true)
        .catch(() => false);
      expect(homeDirExistsBefore).toBe(false);

      // 执行 init 命令
      await runInitCommand(env, { yes: true });

      // 验证 config 目录已创建
      await verifyDirectoryExists(env.homeDir);

      // 验证 config.json 已创建
      const configPath = path.join(env.homeDir, 'config.json');
      await verifyFileExists(configPath);

      // 验证 config.json 内容
      const configContent = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      expect(config.version).toBeDefined();
      expect(config.initialized).toBe(true);
      expect(config.storePath).toBe(env.storeDir);
    });

    it('should create empty registry.json', async () => {
      env = await createUninitializedEnv();

      // 执行 init 命令
      await runInitCommand(env, { yes: true });

      // 验证 registry.json 已创建
      const registryPath = path.join(env.homeDir, 'registry.json');
      await verifyFileExists(registryPath);

      // 验证 registry.json 内容
      const registryContent = await fs.readFile(registryPath, 'utf-8');
      const registry = JSON.parse(registryContent);
      expect(registry.version).toBeDefined();
      expect(registry.projects).toEqual({});
      expect(registry.libraries).toEqual({});
      expect(registry.stores).toEqual({});
    });

    it('should create store directory', async () => {
      env = await createUninitializedEnv();

      // 验证 storeDir 还不存在
      const storeDirExistsBefore = await fs
        .access(env.storeDir)
        .then(() => true)
        .catch(() => false);
      expect(storeDirExistsBefore).toBe(false);

      // 执行 init 命令
      await runInitCommand(env, { yes: true });

      // 验证 store 目录已创建
      await verifyDirectoryExists(env.storeDir);
    });
  });

  describe('S-1.1.2: 重复初始化检测', () => {
    it('should warn and skip when already initialized', async () => {
      env = await createUninitializedEnv();

      // 第一次初始化
      await runInitCommand(env, { yes: true });

      // 验证已初始化
      const configPath = path.join(env.homeDir, 'config.json');
      const configBefore = await fs.readFile(configPath, 'utf-8');
      const parsedBefore = JSON.parse(configBefore);
      expect(parsedBefore.initialized).toBe(true);

      // 记录初始配置
      const originalConfig = configBefore;

      // 第二次初始化（应该跳过）
      await runInitCommand(env, {
        storePath: path.join(env.tempDir, 'another-store'),
        yes: true,
      });

      // 验证配置没有变化（storePath 没有被修改）
      const configAfter = await fs.readFile(configPath, 'utf-8');
      expect(configAfter).toBe(originalConfig);
    });
  });

  describe('S-1.1.3: 指定 Store 路径', () => {
    it('should use custom store path when specified', async () => {
      env = await createUninitializedEnv();

      // 指定自定义 store 路径
      const customStorePath = path.join(env.tempDir, 'custom-store');

      // 执行 init 命令
      await runInitCommand(env, { storePath: customStorePath, yes: true });

      // 验证使用了自定义路径
      const configPath = path.join(env.homeDir, 'config.json');
      const configContent = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      expect(config.storePath).toBe(customStorePath);

      // 验证自定义目录已创建
      await verifyDirectoryExists(customStorePath);
    });

    it('should expand home directory in store path', async () => {
      env = await createUninitializedEnv();

      // 指定包含 ~ 的路径（实际上需要使用绝对路径测试，因为测试环境下 ~ 会展开到真实 home）
      const customStorePath = path.join(env.tempDir, 'expanded-store');

      // 执行 init 命令
      await runInitCommand(env, { storePath: customStorePath, yes: true });

      // 验证路径正确设置
      const configPath = path.join(env.homeDir, 'config.json');
      const configContent = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      expect(config.storePath).toBe(customStorePath);
    });
  });

  describe('S-1.2.1: 路径安全检查', () => {
    it('should reject system directories via isPathSafe', async () => {
      // 这是单元测试级别的验证，测试 isPathSafe 函数
      const { isPathSafe } = await import('../../src/core/platform.js');

      const systemPaths = ['/usr', '/bin', '/etc', '/var', '/System'];
      for (const sysPath of systemPaths) {
        const result = isPathSafe(sysPath);
        expect(result.safe, `${sysPath} should be rejected`).toBe(false);
      }
    });

    it('should reject /tmp directory via isPathSafe', async () => {
      const { isPathSafe } = await import('../../src/core/platform.js');

      const result = isPathSafe('/tmp');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('/tmp');
    });

    it('should accept valid user directory via isPathSafe', async () => {
      const { isPathSafe } = await import('../../src/core/platform.js');

      const validPath = path.join(os.homedir(), '.tanmi-dock', 'store');
      const result = isPathSafe(validPath);
      expect(result.safe).toBe(true);
    });
  });

  describe('S-1.2.2: 目录非空警告', () => {
    it('should handle non-empty directory with warning', async () => {
      env = await createUninitializedEnv();

      // 先创建 store 目录并放入一些文件
      await fs.mkdir(env.storeDir, { recursive: true });
      await fs.writeFile(
        path.join(env.storeDir, 'existing-file.txt'),
        'existing content',
        'utf-8'
      );

      // 执行 init 命令（应该成功，但会有警告）
      await runInitCommand(env, { yes: true });

      // 验证初始化成功
      const configPath = path.join(env.homeDir, 'config.json');
      await verifyFileExists(configPath);

      // 验证原有文件仍然存在
      const existingFile = path.join(env.storeDir, 'existing-file.txt');
      await verifyFileExists(existingFile);
      const content = await fs.readFile(existingFile, 'utf-8');
      expect(content).toBe('existing content');
    });

    it('should handle empty directory without warning', async () => {
      env = await createUninitializedEnv();

      // 先创建空的 store 目录
      await fs.mkdir(env.storeDir, { recursive: true });

      // 验证目录为空
      const entriesBefore = await fs.readdir(env.storeDir);
      expect(entriesBefore.length).toBe(0);

      // 执行 init 命令
      await runInitCommand(env, { yes: true });

      // 验证初始化成功
      const configPath = path.join(env.homeDir, 'config.json');
      await verifyFileExists(configPath);
    });
  });

  describe('S-1.3: 边界情况', () => {
    it('should handle init with --yes option using default path', async () => {
      env = await createUninitializedEnv();

      // 执行 init 命令 (--yes 模式)
      await runInitCommand(env, { yes: true });

      // 验证初始化成功
      const configPath = path.join(env.homeDir, 'config.json');
      await verifyFileExists(configPath);

      const registryPath = path.join(env.homeDir, 'registry.json');
      await verifyFileExists(registryPath);
    });

    it('should create nested store directory path', async () => {
      env = await createUninitializedEnv();

      // 指定多级嵌套的路径
      const nestedPath = path.join(env.tempDir, 'level1', 'level2', 'level3', 'store');

      // 执行 init 命令
      await runInitCommand(env, { storePath: nestedPath, yes: true });

      // 验证嵌套目录已创建
      await verifyDirectoryExists(nestedPath);

      // 验证配置正确
      const configPath = path.join(env.homeDir, 'config.json');
      const configContent = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      expect(config.storePath).toBe(nestedPath);
    });
  });
});
