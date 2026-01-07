/**
 * codepac 模块测试
 * 主要验证参数构造的正确性
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock spawn 函数
const mockSpawn = vi.fn();

// Mock exec - 可配置返回值
let mockExecShouldFail = false;

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, callback?: (...args: unknown[]) => void) => {
    if (callback) {
      if (mockExecShouldFail) {
        callback(new Error('command not found'), '', 'codepac: command not found');
      } else {
        callback(null, 'Version 2.0.56', '');
      }
    }
    return { stdout: '', stderr: '' };
  }),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fs/promises for installSingle and downloadToTemp tests
const mockWriteFile = vi.fn();
const mockUnlink = vi.fn();
const mockMkdir = vi.fn();
const mockRm = vi.fn();
const mockReaddir = vi.fn();
vi.mock('fs/promises', () => ({
  default: {
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    unlink: (...args: unknown[]) => mockUnlink(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    rm: (...args: unknown[]) => mockRm(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args),
  },
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rm: (...args: unknown[]) => mockRm(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
}));

// Mock os for installSingle and downloadToTemp tests
vi.mock('os', () => ({
  default: {
    tmpdir: () => '/tmp',
  },
  tmpdir: () => '/tmp',
}));

// 导入被测模块
import * as codepac from '../../src/core/codepac.js';

// 创建模拟进程的辅助函数
function createMockProcess(exitCode = 0, stderrData = '') {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  // 延迟触发事件，模拟异步行为
  setImmediate(() => {
    if (stderrData) {
      proc.stderr.emit('data', Buffer.from(stderrData));
    }
    proc.emit('close', exitCode);
  });

  return proc;
}

describe('codepac', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockReset();
    mockWriteFile.mockReset();
    mockUnlink.mockReset();
    mockMkdir.mockReset();
    mockRm.mockReset();
    mockReaddir.mockReset();
    mockExecShouldFail = false;
  });

  describe('isCodepacInstalled', () => {
    it('should return true when codepac is available', async () => {
      const result = await codepac.isCodepacInstalled();
      expect(result).toBe(true);
    });

    it('should return false when codepac is not available', async () => {
      mockExecShouldFail = true;
      const result = await codepac.isCodepacInstalled();
      expect(result).toBe(false);
    });
  });

  describe('getVersion', () => {
    // 注意：getVersion 使用 promisify(exec)，在 vitest mock 环境下
    // promisify 的行为可能与真实环境不同，这里只验证函数不会崩溃
    it('should not throw error when codepac is available', async () => {
      await expect(codepac.getVersion()).resolves.not.toThrow();
    });

    it('should return null when codepac is not available', async () => {
      mockExecShouldFail = true;
      const result = await codepac.getVersion();
      expect(result).toBe(null);
    });
  });

  describe('install - parameter construction', () => {
    it('should construct correct arguments with all options', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.install({
        configPath: '/path/to/config/codepac-dep.json',
        targetDir: '/path/to/target',
        platform: 'macOS',
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'codepac',
        [
          'install',
          '--configdir', '/path/to/config',
          '--configfile', 'codepac-dep.json',
          '--targetdir', '/path/to/target',
          '-p', 'macOS',
        ],
        expect.objectContaining({
          cwd: '/path/to/config',
        })
      );
    });

    it('should construct correct arguments without platform', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.install({
        configPath: '/tmp/codepac-dep.json',
        targetDir: '/tmp/output',
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'codepac',
        [
          'install',
          '--configdir', '/tmp',
          '--configfile', 'codepac-dep.json',
          '--targetdir', '/tmp/output',
        ],
        expect.anything()
      );
    });

    it('should handle different config file names', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.install({
        configPath: '/custom/path/my-deps.json',
        targetDir: '/output',
        platform: 'android',
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'codepac',
        [
          'install',
          '--configdir', '/custom/path',
          '--configfile', 'my-deps.json',
          '--targetdir', '/output',
          '-p', 'android',
        ],
        expect.anything()
      );
    });

    it('should set cwd to config directory', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.install({
        configPath: '/some/deep/path/deps.json',
        targetDir: '/target',
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'codepac',
        expect.any(Array),
        expect.objectContaining({
          cwd: '/some/deep/path',
        })
      );
    });

    it('should reject when codepac is not installed', async () => {
      mockExecShouldFail = true;

      await expect(
        codepac.install({
          configPath: '/path/to/config.json',
          targetDir: '/path/to/target',
        })
      ).rejects.toThrow('codepac 未安装');
    });

    it('should call onProgress callback with stdout data', async () => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();

      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from('Downloading libtest...'));
        proc.stdout.emit('data', Buffer.from('Installing libtest...'));
        proc.emit('close', 0);
      });

      mockSpawn.mockReturnValue(proc);

      const onProgress = vi.fn();
      await codepac.install({
        configPath: '/tmp/config.json',
        targetDir: '/tmp/output',
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledWith('Downloading libtest...');
      expect(onProgress).toHaveBeenCalledWith('Installing libtest...');
      expect(onProgress).toHaveBeenCalledTimes(2);
    });

    it('should use stdio ignore in silent mode', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.install({
        configPath: '/tmp/config.json',
        targetDir: '/tmp/output',
        silent: true,
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'codepac',
        expect.any(Array),
        expect.objectContaining({
          stdio: 'ignore',
        })
      );
    });

    it('should use stdio pipe in non-silent mode', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.install({
        configPath: '/tmp/config.json',
        targetDir: '/tmp/output',
        silent: false,
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'codepac',
        expect.any(Array),
        expect.objectContaining({
          stdio: 'pipe',
        })
      );
    });
  });

  describe('installSingle', () => {
    it('should create temp config with correct structure', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      mockUnlink.mockResolvedValue(undefined);
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.installSingle({
        url: 'git@example.com:repo/lib.git',
        commit: 'abc123',
        branch: 'main',
        targetDir: '/output/libtest',
        platform: 'macOS',
      });

      // 验证临时配置文件被创建
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const [filePath, content] = mockWriteFile.mock.calls[0];
      expect(filePath).toMatch(/^\/tmp\/codepac-temp-\d+\.json$/);

      // 验证配置内容格式
      const config = JSON.parse(content);
      expect(config.version).toBe('1.0.0');
      expect(config.repos.common).toHaveLength(1);
      expect(config.repos.common[0]).toEqual({
        url: 'git@example.com:repo/lib.git',
        commit: 'abc123',
        branch: 'main',
        dir: 'libtest',
      });
    });

    it('should include sparse config when provided as object', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      mockUnlink.mockResolvedValue(undefined);
      mockSpawn.mockReturnValue(createMockProcess(0));

      const sparseConfig = { mac: ['macOS'], win: ['Win'] };
      await codepac.installSingle({
        url: 'git@example.com:repo/lib.git',
        commit: 'abc123',
        branch: 'main',
        targetDir: '/output/libtest',
        sparse: sparseConfig,
      });

      const [, content] = mockWriteFile.mock.calls[0];
      const config = JSON.parse(content);
      expect(config.repos.common[0].sparse).toEqual(sparseConfig);
    });

    it('should include sparse config when provided as string', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      mockUnlink.mockResolvedValue(undefined);
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.installSingle({
        url: 'git@example.com:repo/lib.git',
        commit: 'abc123',
        branch: 'main',
        targetDir: '/output/libtest',
        sparse: '${ALL_COMMON_SPARSE}',
      });

      const [, content] = mockWriteFile.mock.calls[0];
      const config = JSON.parse(content);
      expect(config.repos.common[0].sparse).toBe('${ALL_COMMON_SPARSE}');
    });

    it('should pass correct targetDir to install (parent of targetDir)', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      mockUnlink.mockResolvedValue(undefined);
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.installSingle({
        url: 'git@example.com:repo/lib.git',
        commit: 'abc123',
        branch: 'main',
        targetDir: '/some/path/libtest',
      });

      // install 应该使用 targetDir 的父目录
      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain('--targetdir');
      const targetDirIndex = args.indexOf('--targetdir');
      expect(args[targetDirIndex + 1]).toBe('/some/path');
    });

    it('should cleanup temp file after successful install', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      mockUnlink.mockResolvedValue(undefined);
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.installSingle({
        url: 'git@example.com:repo/lib.git',
        commit: 'abc123',
        branch: 'main',
        targetDir: '/output/libtest',
      });

      expect(mockUnlink).toHaveBeenCalledTimes(1);
      expect(mockUnlink.mock.calls[0][0]).toMatch(/^\/tmp\/codepac-temp-\d+\.json$/);
    });

    it('should cleanup temp file even after failed install', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      mockUnlink.mockResolvedValue(undefined);
      mockSpawn.mockReturnValue(createMockProcess(1, 'Install failed'));

      await expect(
        codepac.installSingle({
          url: 'git@example.com:repo/lib.git',
          commit: 'abc123',
          branch: 'main',
          targetDir: '/output/libtest',
        })
      ).rejects.toThrow();

      // 即使安装失败，也应该清理临时文件
      expect(mockUnlink).toHaveBeenCalledTimes(1);
    });

    it('should reject when codepac is not installed', async () => {
      mockExecShouldFail = true;

      await expect(
        codepac.installSingle({
          url: 'git@example.com:repo/lib.git',
          commit: 'abc123',
          branch: 'main',
          targetDir: '/output/libtest',
        })
      ).rejects.toThrow('codepac 未安装');
    });

    it('should ignore cleanup errors silently', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      mockUnlink.mockRejectedValue(new Error('ENOENT'));
      mockSpawn.mockReturnValue(createMockProcess(0));

      // 不应该抛出异常
      await expect(
        codepac.installSingle({
          url: 'git@example.com:repo/lib.git',
          commit: 'abc123',
          branch: 'main',
          targetDir: '/output/libtest',
        })
      ).resolves.not.toThrow();
    });
  });

  describe('update - parameter construction', () => {
    it('should construct correct arguments with library name', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.update({
        configPath: '/path/to/config/codepac-dep.json',
        targetDir: '/path/to/target',
        libName: 'libtest',
      });

      // 库名应该直接跟在 update 后面，不是用 -n
      expect(mockSpawn).toHaveBeenCalledWith(
        'codepac',
        [
          'update',
          'libtest',
          '--configdir', '/path/to/config',
          '--configfile', 'codepac-dep.json',
          '--targetdir', '/path/to/target',
        ],
        expect.anything()
      );
    });

    it('should construct correct arguments without library name', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.update({
        configPath: '/path/to/codepac-dep.json',
        targetDir: '/path/to/target',
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'codepac',
        [
          'update',
          '--configdir', '/path/to',
          '--configfile', 'codepac-dep.json',
          '--targetdir', '/path/to/target',
        ],
        expect.anything()
      );
    });

    it('should reject when codepac is not installed', async () => {
      mockExecShouldFail = true;

      await expect(
        codepac.update({
          configPath: '/path/to/config.json',
          targetDir: '/path/to/target',
        })
      ).rejects.toThrow('codepac 未安装');
    });

    it('should call onProgress callback with stdout data', async () => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();

      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from('Checking libtest...'));
        proc.stdout.emit('data', Buffer.from('Updated to abc123'));
        proc.emit('close', 0);
      });

      mockSpawn.mockReturnValue(proc);

      const onProgress = vi.fn();
      await codepac.update({
        configPath: '/tmp/config.json',
        targetDir: '/tmp/output',
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledWith('Checking libtest...');
      expect(onProgress).toHaveBeenCalledWith('Updated to abc123');
      expect(onProgress).toHaveBeenCalledTimes(2);
    });

    it('should reject with stderr message on non-zero exit code', async () => {
      mockSpawn.mockReturnValue(createMockProcess(1, 'Error: branch not found'));

      await expect(
        codepac.update({
          configPath: '/path/to/config.json',
          targetDir: '/path/to/target',
        })
      ).rejects.toThrow('branch not found');
    });

    it('should reject with default message when stderr is empty', async () => {
      mockSpawn.mockReturnValue(createMockProcess(1, ''));

      await expect(
        codepac.update({
          configPath: '/path/to/config.json',
          targetDir: '/path/to/target',
        })
      ).rejects.toThrow('退出码: 1');
    });

    it('should handle spawn error event', async () => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();

      setImmediate(() => {
        proc.emit('error', new Error('spawn ENOENT'));
      });

      mockSpawn.mockReturnValue(proc);

      await expect(
        codepac.update({
          configPath: '/path/to/config.json',
          targetDir: '/path/to/target',
        })
      ).rejects.toThrow('无法执行 codepac 命令');
    });
  });

  describe('error handling', () => {
    it('should reject with stderr message on non-zero exit code', async () => {
      mockSpawn.mockReturnValue(createMockProcess(1, 'Error: repository not found'));

      await expect(
        codepac.install({
          configPath: '/path/to/config.json',
          targetDir: '/path/to/target',
        })
      ).rejects.toThrow('repository not found');
    });

    it('should reject with default message when stderr is empty', async () => {
      mockSpawn.mockReturnValue(createMockProcess(1, ''));

      await expect(
        codepac.install({
          configPath: '/path/to/config.json',
          targetDir: '/path/to/target',
        })
      ).rejects.toThrow('退出码: 1');
    });

    it('should handle spawn error event', async () => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();

      setImmediate(() => {
        proc.emit('error', new Error('spawn ENOENT'));
      });

      mockSpawn.mockReturnValue(proc);

      await expect(
        codepac.install({
          configPath: '/path/to/config.json',
          targetDir: '/path/to/target',
        })
      ).rejects.toThrow('无法执行 codepac 命令');
    });
  });

  describe('downloadToTemp', () => {
    it('should create temp directory with correct naming pattern', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'CMakeLists.txt', isDirectory: () => false },
      ]);

      mockSpawn.mockReturnValue(createMockProcess(0));

      const result = await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: 'abc123',
        branch: 'main',
        libName: 'libtest',
        platforms: ['mac'],
      });

      // 验证临时目录命名模式
      expect(result.tempDir).toMatch(/tanmi-dock-\d+-[a-z0-9]+$/);
      expect(result.libDir).toContain('libtest');
    });

    it('should classify platform directories using KNOWN_PLATFORM_VALUES', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);

      // Mock readdir 返回平台目录和共享文件
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'macOS-asan', isDirectory: () => true },
        { name: 'Win', isDirectory: () => true },
        { name: 'CMakeLists.txt', isDirectory: () => false },
        { name: 'include', isDirectory: () => true },
        { name: 'README.md', isDirectory: () => false },
      ]);

      mockSpawn.mockReturnValue(createMockProcess(0));

      const result = await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: 'abc123',
        branch: 'main',
        libName: 'libtest',
        platforms: ['mac', 'win'],
      });

      // 验证平台目录识别
      expect(result.platformDirs).toContain('macOS');
      expect(result.platformDirs).toContain('macOS-asan');
      expect(result.platformDirs).toContain('Win');

      // 验证共享文件识别（非平台目录）
      expect(result.sharedFiles).toContain('CMakeLists.txt');
      expect(result.sharedFiles).toContain('include');
      expect(result.sharedFiles).toContain('README.md');

      // 验证平台目录不在共享文件中
      expect(result.sharedFiles).not.toContain('macOS');
      expect(result.sharedFiles).not.toContain('Win');
    });

    it('should pass multiple platforms to codepac with -p flag', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
      ]);

      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: 'abc123',
        branch: 'main',
        libName: 'libtest',
        platforms: ['mac', 'win', 'ios'],
      });

      // 验证 codepac 命令参数格式: -p platform1 platform2 platform3
      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain('-p');
      const pIndex = args.indexOf('-p');
      expect(args[pIndex + 1]).toBe('mac');
      expect(args[pIndex + 2]).toBe('win');
      expect(args[pIndex + 3]).toBe('ios');
    });

    it('should cleanup temp directory on failure', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);

      // 模拟 codepac 命令失败
      mockSpawn.mockReturnValue(createMockProcess(1, 'Download failed'));

      await expect(
        codepac.downloadToTemp({
          url: 'git@example.com:repo/lib.git',
          commit: 'abc123',
          branch: 'main',
          libName: 'libtest',
          platforms: ['mac'],
        })
      ).rejects.toThrow('下载库失败');

      // 验证临时目录被清理
      expect(mockRm).toHaveBeenCalledWith(
        expect.stringMatching(/tanmi-dock-\d+-[a-z0-9]+$/),
        { recursive: true, force: true }
      );
    });

    it('should reject when codepac is not installed', async () => {
      mockExecShouldFail = true;

      await expect(
        codepac.downloadToTemp({
          url: 'git@example.com:repo/lib.git',
          commit: 'abc123',
          branch: 'main',
          libName: 'libtest',
          platforms: ['mac'],
        })
      ).rejects.toThrow('codepac 未安装');
    });

    it('should include sparse config when provided', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
      ]);

      let writtenConfig: unknown = null;
      mockWriteFile.mockImplementation(async (_path: unknown, content: unknown) => {
        if (typeof content === 'string') {
          writtenConfig = JSON.parse(content);
        }
      });

      mockSpawn.mockReturnValue(createMockProcess(0));

      const sparseConfig = { mac: ['macOS'], win: ['Win'] };
      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: 'abc123',
        branch: 'main',
        libName: 'libtest',
        platforms: ['mac'],
        sparse: sparseConfig,
      });

      // 验证 sparse 配置被写入临时配置文件
      expect(writtenConfig).toBeDefined();
      expect((writtenConfig as { repos: { common: Array<{ sparse: unknown }> } }).repos.common[0].sparse).toEqual(sparseConfig);
    });

    // 需要网络的测试，标记为 skip
    it.skip('should download multiple platforms in one call (requires network)', async () => {
      // 这个测试需要真正的网络连接和 codepac 命令
      // 仅在手动测试时启用
    });
  });

  describe('parameter edge cases', () => {
    it('should handle paths with spaces', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.install({
        configPath: '/path/with spaces/codepac-dep.json',
        targetDir: '/target/with spaces',
        platform: 'iOS',
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'codepac',
        [
          'install',
          '--configdir', '/path/with spaces',
          '--configfile', 'codepac-dep.json',
          '--targetdir', '/target/with spaces',
          '-p', 'iOS',
        ],
        expect.anything()
      );
    });

    it('should handle various platform values', async () => {
      const platforms = ['macOS', 'macOS-asan', 'Win', 'iOS', 'android', 'ubuntu', 'wasm', 'ohos'];

      for (const platform of platforms) {
        mockSpawn.mockReset();
        mockSpawn.mockReturnValue(createMockProcess(0));

        await codepac.install({
          configPath: '/tmp/config.json',
          targetDir: '/tmp/output',
          platform,
        });

        const args = mockSpawn.mock.calls[0][1] as string[];
        expect(args).toContain('-p');
        expect(args).toContain(platform);
      }
    });

    it('should handle Chinese characters in paths', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.install({
        configPath: '/Users/张三/项目/codepac-dep.json',
        targetDir: '/Users/张三/输出目录',
        platform: 'macOS',
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'codepac',
        [
          'install',
          '--configdir', '/Users/张三/项目',
          '--configfile', 'codepac-dep.json',
          '--targetdir', '/Users/张三/输出目录',
          '-p', 'macOS',
        ],
        expect.anything()
      );
    });

    it('should handle special characters in paths (parentheses)', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.install({
        configPath: '/path/to/project (v2)/codepac-dep.json',
        targetDir: '/output/libs (copy)',
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'codepac',
        [
          'install',
          '--configdir', '/path/to/project (v2)',
          '--configfile', 'codepac-dep.json',
          '--targetdir', '/output/libs (copy)',
        ],
        expect.anything()
      );
    });

    it('should handle paths with quotes in directory name', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.install({
        configPath: '/path/to/"quoted"/config.json',
        targetDir: "/output/'single'",
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'codepac',
        [
          'install',
          '--configdir', '/path/to/"quoted"',
          '--configfile', 'config.json',
          '--targetdir', "/output/'single'",
        ],
        expect.anything()
      );
    });

    it('should handle paths with ampersand and other shell special chars', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.install({
        configPath: '/path/R&D/project/config.json',
        targetDir: '/output/$HOME/libs',
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'codepac',
        [
          'install',
          '--configdir', '/path/R&D/project',
          '--configfile', 'config.json',
          '--targetdir', '/output/$HOME/libs',
        ],
        expect.anything()
      );
    });
  });
});
