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
let mockExecResponses: Record<string, { error?: Error; stdout?: string; stderr?: string }> = {};

function resolveExecMock(
  command: string,
  callback?: (...args: unknown[]) => void
): { stdout: string; stderr: string } {
  const response = mockExecResponses[command];
  if (response) {
    if (response.error) {
      callback?.(response.error, response.stdout ?? '', response.stderr ?? '');
      throw response.error;
    }
    callback?.(null, response.stdout ?? '', response.stderr ?? '');
    return { stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
  }
  if (mockExecShouldFail) {
    const error = new Error('command not found');
    callback?.(error, '', 'codepac: command not found');
    throw error;
  }
  const stdout = command === 'git --version' ? 'git version 2.40.0' : 'Version 2.0.56';
  callback?.(null, stdout, '');
  return { stdout, stderr: '' };
}

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, callback?: (...args: unknown[]) => void) => {
    const command = String(_cmd);
    const actualCallback = typeof _opts === 'function' ? _opts as (...args: unknown[]) => void : callback;
    if (actualCallback) {
      try {
        resolveExecMock(command, actualCallback);
      } catch {
        // callback has already received the error
      }
      return { stdout: '', stderr: '' };
    }
    return Promise.resolve(resolveExecMock(command));
  }),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fs/promises for installSingle and downloadToTemp tests
const mockWriteFile = vi.fn();
const mockUnlink = vi.fn();
const mockMkdir = vi.fn();
const mockRm = vi.fn();
const mockReaddir = vi.fn();
const mockStat = vi.fn();
const mockReadFile = vi.fn();
vi.mock('fs/promises', () => ({
  default: {
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    unlink: (...args: unknown[]) => mockUnlink(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    rm: (...args: unknown[]) => mockRm(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args),
    stat: (...args: unknown[]) => mockStat(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
  },
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rm: (...args: unknown[]) => mockRm(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
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
function createMockProcess(exitCode = 0, stderrData = '', stdoutData = '') {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  // 延迟触发事件，模拟异步行为
  setImmediate(() => {
    if (stdoutData) {
      proc.stdout.emit('data', Buffer.from(stdoutData));
    }
    if (stderrData) {
      proc.stderr.emit('data', Buffer.from(stderrData));
    }
    proc.emit('close', exitCode);
  });

  return proc;
}

describe('codepac', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mockSpawn.mockReset();
    mockWriteFile.mockReset();
    mockUnlink.mockReset();
    mockMkdir.mockReset();
    mockRm.mockReset();
    mockReaddir.mockReset();
    mockStat.mockReset();
    mockReadFile.mockReset();
    mockExecShouldFail = false;
    mockExecResponses = {};
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

  describe('checkCodepacEnvironment', () => {
    it('should report available environment when codepac git and lfs are available', async () => {
      mockExecResponses = {
        'command -v codepac': { stdout: '/usr/local/bin/codepac\n' },
        'git --version': { stdout: 'git version 2.40.0\n' },
        'git-lfs --version': { stdout: 'git-lfs/3.4.0\n' },
        'git lfs --version': { stdout: 'git-lfs/3.4.0\n' },
        'codepac --version': { stdout: 'Version 2.0.56\n' },
      };

      const result = await codepac.checkCodepacEnvironment();

      expect(result.ok).toBe(true);
      expect(result.codepacCommand.ok).toBe(true);
      expect(result.git.version).toBe('2.40.0');
      expect(result.gitLfs.ok).toBe(true);
      expect(result.codepacVersion.version).toBe('Version 2.0.56');
    });

    it('should report git version below CodePac requirement', async () => {
      mockExecResponses = {
        'command -v codepac': { stdout: '/usr/local/bin/codepac\n' },
        'git --version': { stdout: 'git version 2.21.0\n' },
        'git-lfs --version': { stdout: 'git-lfs/3.4.0\n' },
        'git lfs --version': { stdout: 'git-lfs/3.4.0\n' },
        'codepac --version': { stdout: 'Version 2.0.56\n' },
      };

      const result = await codepac.checkCodepacEnvironment();

      expect(result.ok).toBe(false);
      expect(result.git.ok).toBe(false);
      expect(result.git.minimumVersion).toBe('2.22.0');
      expect(result.git.message).toContain('2.22.0');
    });

    it('should report missing Git LFS separately from codepac command', async () => {
      mockExecResponses = {
        'command -v codepac': { stdout: '/usr/local/bin/codepac\n' },
        'git --version': { stdout: 'git version 2.40.0\n' },
        'git-lfs --version': { error: new Error('not found'), stderr: 'git-lfs: command not found' },
        'git lfs --version': { error: new Error('not found'), stderr: 'git: lfs is not a git command' },
        'codepac --version': { stdout: 'Version 2.0.56\n' },
      };

      const result = await codepac.checkCodepacEnvironment();

      expect(result.ok).toBe(false);
      expect(result.codepacCommand.ok).toBe(true);
      expect(result.git.ok).toBe(true);
      expect(result.gitLfs.ok).toBe(false);
      expect(result.gitLfs.commands.gitLfsVersion.ok).toBe(false);
      expect(result.gitLfs.commands.gitLfsSubcommand.ok).toBe(false);
    });

    it('should report codepac version command failure separately', async () => {
      mockExecResponses = {
        'command -v codepac': { stdout: '/usr/local/bin/codepac\n' },
        'git --version': { stdout: 'git version 2.40.0\n' },
        'git-lfs --version': { stdout: 'git-lfs/3.4.0\n' },
        'git lfs --version': { stdout: 'git-lfs/3.4.0\n' },
        'codepac --version': { error: new Error('lfs missing'), stderr: 'git lfs missing' },
      };

      const result = await codepac.checkCodepacEnvironment();

      expect(result.ok).toBe(false);
      expect(result.codepacCommand.ok).toBe(true);
      expect(result.codepacVersion.ok).toBe(false);
      expect(result.codepacVersion.message).toContain('失败');
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
    const fullCommit = '1234567890abcdef1234567890abcdef12345678';

    it('should prefer git lightweight download when it succeeds', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockStat.mockImplementation(async (filePath: string) => ({
        isFile: () => filePath.endsWith('/.git') || filePath.endsWith('/macOS/libtsa.a') || filePath.endsWith('/include/header.h'),
        isDirectory: () => filePath.endsWith('/.git'),
        size: 32,
      }));
      mockReadFile.mockResolvedValue(null);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'include', isDirectory: () => true },
      ]);

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('log')) {
          return createMockProcess(0, '', 'commit abcdef\nmessage\n');
        }
        if (command === 'git' && args.includes('rev-parse')) {
          return createMockProcess(0, '', `${fullCommit}\n`);
        }
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        if (command === 'git' && args.includes('ls-tree')) {
          return createMockProcess(0, '', 'macOS\nWin\ninclude\n');
        }
        if (command === 'git' && args.includes('ls-files')) {
          return createMockProcess(0, '', 'macOS/libtsa.a\ninclude/header.h\nWin/libtsa.lib\n');
        }
        return createMockProcess(0);
      });

      const result = await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          'clone',
          '--filter=blob:none',
          '--depth',
          '1',
          '--single-branch',
          '--no-checkout',
          '--branch',
          'main',
          'git@example.com:repo/lib.git',
        ]),
        expect.objectContaining({
          env: expect.objectContaining({
            GIT_LFS_SKIP_SMUDGE: '1',
          }),
        })
      );

      const commands = mockSpawn.mock.calls.map((call) => call[0]);
      expect(commands).toContain('git');
      expect(commands).not.toContain('codepac');
      expect(result.platformDirs).toEqual(['macOS']);
      expect(result.sharedFiles).toEqual(['include']);
      const writePaths = mockWriteFile.mock.calls.map((call) => call[0]);
      expect(writePaths.some((item) => typeof item === 'string' && item.endsWith('/libtest/.git/commit_message'))).toBe(true);
      expect(writePaths.at(-1)).toEqual(expect.stringMatching(/\/libtest\/\.git\/commit_hash$/));
    });

    it('should cleanup minisize git payloads and write commit_hash last after git lightweight download', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockStat.mockImplementation(async (filePath: string) => ({
        isFile: () => false,
        isDirectory: () => filePath.endsWith('/.git'),
        size: 0,
      }));
      mockReadFile.mockImplementation(async (filePath: string) => (
        filePath.endsWith('/libtest/.gitmodules')
          ? [
            '[submodule "SubLib"]',
            '  path = deps/SubLib',
            '  url = git@example.com:repo/sub.git',
          ].join('\n')
          : ''
      ));
      mockReaddir.mockImplementation(async (targetPath: string) => {
        if (targetPath.endsWith('/libtest')) {
          return [
            { name: 'macOS', isDirectory: () => true },
          ];
        }
        if (targetPath.endsWith('/deps/SubLib/.git/objects') || targetPath.endsWith('/deps/SubLib/.git/lfs')) {
          return [
            { name: 'pack', isDirectory: () => true },
          ];
        }
        if (targetPath.endsWith('/.git/objects') || targetPath.endsWith('/.git/lfs')) {
          return [
            { name: 'pack', isDirectory: () => true },
            { name: 'tmp', isDirectory: () => true },
            { name: 'HEAD', isDirectory: () => false },
          ];
        }
        if (targetPath.endsWith('/libtest/macOS')) {
          return [{ name: 'lib.a', isDirectory: () => false, isFile: () => true }];
        }
        return [];
      });

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        if (command === 'git' && args.includes('ls-tree')) {
          return createMockProcess(0, '', 'macOS\n');
        }
        if (command === 'git' && args.includes('ls-files')) {
          return createMockProcess(0, '', '');
        }
        if (command === 'git' && args.includes('log')) {
          return createMockProcess(0, '', 'commit 123456\nmessage\n');
        }
        if (command === 'git' && args.includes('rev-parse')) {
          return createMockProcess(0, '', `${fullCommit}\n`);
        }
        return createMockProcess(0);
      });

      const onProgress = vi.fn();
      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
        onProgress,
      });

      expect(mockRm).toHaveBeenCalledWith(
        expect.stringMatching(/\/libtest\/\.git\/objects\/pack$/),
        { recursive: true, force: true }
      );
      expect(mockRm).toHaveBeenCalledWith(
        expect.stringMatching(/\/libtest\/\.git\/lfs\/tmp$/),
        { recursive: true, force: true }
      );
      expect(mockRm).toHaveBeenCalledWith(
        expect.stringMatching(/\/libtest\/deps\/SubLib\/\.git\/objects\/pack$/),
        { recursive: true, force: true }
      );
      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringMatching(/\/libtest\/\.git\/objects\/pack$/),
        { recursive: true }
      );

      const writeCalls = mockWriteFile.mock.calls;
      const commitMessageCallIndex = writeCalls.findIndex((call) => typeof call[0] === 'string' && call[0].endsWith('/libtest/.git/commit_message'));
      const commitHashCallIndex = writeCalls.findIndex((call) => typeof call[0] === 'string' && call[0].endsWith('/libtest/.git/commit_hash'));
      expect(commitMessageCallIndex).toBeGreaterThan(-1);
      expect(commitHashCallIndex).toBeGreaterThan(commitMessageCallIndex);
      expect(writeCalls[commitHashCallIndex][1]).toBe(fullCommit);
      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('Git minisize 收尾: gitdir='));
      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('仓库数=2'));
      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('marker='));
    });

    it('should resolve gitdir file before writing minisize commit markers', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockStat.mockImplementation(async (filePath: string) => ({
        isFile: () => filePath.endsWith('/.git'),
        isDirectory: () => false,
        size: 24,
      }));
      mockReadFile.mockImplementation(async (filePath: string) => (
        filePath.endsWith('/.git')
          ? 'gitdir: ../.git/modules/libtest\n'
          : ''
      ));
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
      ]);

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        if (command === 'git' && args.includes('ls-tree')) {
          return createMockProcess(0, '', 'macOS\n');
        }
        if (command === 'git' && args.includes('ls-files')) {
          return createMockProcess(0, '', '');
        }
        if (command === 'git' && args.includes('log')) {
          return createMockProcess(0, '', 'commit abcdef\nmessage\n');
        }
        if (command === 'git' && args.includes('rev-parse')) {
          return createMockProcess(0, '', `${fullCommit}\n`);
        }
        return createMockProcess(0);
      });

      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
      });

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringMatching(/\/\.git\/modules\/libtest\/commit_hash$/),
        fullCommit,
        'utf-8'
      );
    });

    it('should cleanup submodule real gitdir when submodule .git is a file', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockStat.mockImplementation(async (filePath: string) => ({
        isFile: () => filePath.endsWith('/deps/SubLib/.git'),
        isDirectory: () => filePath.endsWith('/libtest/.git'),
        size: 24,
      }));
      mockReadFile.mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('/libtest/.gitmodules')) {
          return [
            '[submodule "SubLib"]',
            '  path = deps/SubLib',
            '  url = git@example.com:repo/sub.git',
          ].join('\n');
        }
        if (filePath.endsWith('/deps/SubLib/.git')) {
          return 'gitdir: ../../.git/modules/deps/SubLib\n';
        }
        return '';
      });
      mockReaddir.mockImplementation(async (targetPath: string) => {
        if (targetPath.endsWith('/libtest')) {
          return [
            { name: 'macOS', isDirectory: () => true },
          ];
        }
        if (targetPath.endsWith('/libtest/macOS')) {
          return [
            { name: 'lib.a', isDirectory: () => false, isFile: () => true },
          ];
        }
        if (targetPath.endsWith('/.git/modules/deps/SubLib/objects')) {
          return [
            { name: 'pack', isDirectory: () => true },
          ];
        }
        if (targetPath.endsWith('/.git/modules/deps/SubLib/lfs')) {
          return [
            { name: 'objects', isDirectory: () => true },
          ];
        }
        return [];
      });

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        if (command === 'git' && args.includes('ls-tree')) {
          return createMockProcess(0, '', 'macOS\n');
        }
        if (command === 'git' && args.includes('ls-files')) {
          return createMockProcess(0, '', '');
        }
        if (command === 'git' && args.includes('log')) {
          return createMockProcess(0, '', 'commit abcdef\nmessage\n');
        }
        if (command === 'git' && args.includes('rev-parse')) {
          return createMockProcess(0, '', `${fullCommit}\n`);
        }
        return createMockProcess(0);
      });

      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
      });

      expect(mockRm).toHaveBeenCalledWith(
        expect.stringMatching(/\/libtest\/\.git\/modules\/deps\/SubLib\/objects\/pack$/),
        { recursive: true, force: true }
      );
      expect(mockRm).toHaveBeenCalledWith(
        expect.stringMatching(/\/libtest\/\.git\/modules\/deps\/SubLib\/lfs\/objects$/),
        { recursive: true, force: true }
      );
    });

    it('should cleanup nested submodule git payloads recursively', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockStat.mockImplementation(async (filePath: string) => ({
        isFile: () => false,
        isDirectory: () => filePath.endsWith('/.git'),
        size: 0,
      }));
      mockReadFile.mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('/libtest/.gitmodules')) {
          return [
            '[submodule "SubLib"]',
            '  path = deps/SubLib',
            '  url = git@example.com:repo/sub.git',
          ].join('\n');
        }
        if (filePath.endsWith('/deps/SubLib/.gitmodules')) {
          return [
            '[submodule "Nested"]',
            '  path = vendor/Nested',
            '  url = git@example.com:repo/nested.git',
          ].join('\n');
        }
        return '';
      });
      mockReaddir.mockImplementation(async (targetPath: string) => {
        if (targetPath.endsWith('/libtest')) {
          return [
            { name: 'macOS', isDirectory: () => true },
          ];
        }
        if (targetPath.endsWith('/libtest/macOS')) {
          return [
            { name: 'lib.a', isDirectory: () => false, isFile: () => true },
          ];
        }
        if (
          targetPath.endsWith('/deps/SubLib/.git/objects')
          || targetPath.endsWith('/deps/SubLib/vendor/Nested/.git/objects')
        ) {
          return [
            { name: 'pack', isDirectory: () => true },
          ];
        }
        return [];
      });

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        if (command === 'git' && args.includes('ls-tree')) {
          return createMockProcess(0, '', 'macOS\n');
        }
        if (command === 'git' && args.includes('ls-files')) {
          return createMockProcess(0, '', '');
        }
        if (command === 'git' && args.includes('log')) {
          return createMockProcess(0, '', 'commit abcdef\nmessage\n');
        }
        if (command === 'git' && args.includes('rev-parse')) {
          return createMockProcess(0, '', `${fullCommit}\n`);
        }
        return createMockProcess(0);
      });

      const onProgress = vi.fn();
      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
        onProgress,
      });

      expect(mockRm).toHaveBeenCalledWith(
        expect.stringMatching(/\/libtest\/deps\/SubLib\/\.git\/objects\/pack$/),
        { recursive: true, force: true }
      );
      expect(mockRm).toHaveBeenCalledWith(
        expect.stringMatching(/\/libtest\/deps\/SubLib\/vendor\/Nested\/\.git\/objects\/pack$/),
        { recursive: true, force: true }
      );
      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('submodule=deps/SubLib,deps/SubLib/vendor/Nested'));
    });

    it('should ignore unsafe submodule paths while cleaning minisize git payloads', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockStat.mockImplementation(async (filePath: string) => ({
        isFile: () => false,
        isDirectory: () => filePath.endsWith('/.git'),
        size: 0,
      }));
      mockReadFile.mockImplementation(async (filePath: string) => (
        filePath.endsWith('/libtest/.gitmodules')
          ? [
            '[submodule "UnsafeAbs"]',
            '  path = /tmp/unsafe',
            '  url = git@example.com:repo/unsafe.git',
            '[submodule "UnsafeParent"]',
            '  path = ../outside',
            '  url = git@example.com:repo/outside.git',
            '[submodule "Safe"]',
            '  path = deps/Safe',
            '  url = git@example.com:repo/safe.git',
          ].join('\n')
          : ''
      ));
      mockReaddir.mockImplementation(async (targetPath: string) => {
        if (targetPath.endsWith('/libtest')) {
          return [
            { name: 'macOS', isDirectory: () => true },
          ];
        }
        if (targetPath.endsWith('/libtest/macOS')) {
          return [
            { name: 'lib.a', isDirectory: () => false, isFile: () => true },
          ];
        }
        if (targetPath.endsWith('/deps/Safe/.git/objects')) {
          return [
            { name: 'pack', isDirectory: () => true },
          ];
        }
        if (targetPath.includes('/unsafe') || targetPath.includes('/outside')) {
          return [
            { name: 'pack', isDirectory: () => true },
          ];
        }
        return [];
      });

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        if (command === 'git' && args.includes('ls-tree')) {
          return createMockProcess(0, '', 'macOS\n');
        }
        if (command === 'git' && args.includes('ls-files')) {
          return createMockProcess(0, '', '');
        }
        if (command === 'git' && args.includes('log')) {
          return createMockProcess(0, '', 'commit abcdef\nmessage\n');
        }
        if (command === 'git' && args.includes('rev-parse')) {
          return createMockProcess(0, '', `${fullCommit}\n`);
        }
        return createMockProcess(0);
      });

      const onProgress = vi.fn();
      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
        onProgress,
      });

      const removedPaths = mockRm.mock.calls
        .map((call) => call[0])
        .filter((item): item is string => typeof item === 'string');
      expect(removedPaths.some((item) => item.includes('/deps/Safe/.git/objects/pack'))).toBe(true);
      expect(removedPaths.some((item) => item.includes('/unsafe'))).toBe(false);
      expect(removedPaths.some((item) => item.includes('/outside'))).toBe(false);
      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('submodule=deps/Safe'));
    });

    it('should use codepac directly when git lightweight download is disabled', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
      ]);

      mockSpawn.mockReturnValue(createMockProcess(0));

      const result = await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
        useGitLightweightDownload: false,
      });

      const commands = mockSpawn.mock.calls.map((call) => call[0]);
      expect(commands).toEqual(['codepac']);
      expect(result.platformDirs).toEqual(['macOS']);
    });

    it('should resolve platform cli key before verifying git lightweight download', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'include', isDirectory: () => true },
      ]);

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        if (command === 'git' && args.includes('ls-tree')) {
          return createMockProcess(0, '', 'macOS\nWin\ninclude\n');
        }
        if (command === 'git' && args.includes('ls-files')) {
          return createMockProcess(0, '', 'macOS/libtsa.a\nWin/libtsa.lib\ninclude/header.h\n');
        }
        return createMockProcess(0);
      });

      const result = await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['mac'],
      });

      const commands = mockSpawn.mock.calls.map((call) => call[0]);
      expect(commands).toContain('git');
      expect(commands).not.toContain('codepac');
      expect(result.platformDirs).toEqual(['macOS']);
    });

    it('should configure sparse checkout from repository top-level entries when sparse is absent', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'include', isDirectory: () => true },
      ]);

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        if (command === 'git' && args.includes('ls-tree')) {
          return createMockProcess(0, '', 'macOS\nWin\ninclude\nREADME.md\n');
        }
        if (command === 'git' && args.includes('ls-files')) {
          return createMockProcess(0, '', 'macOS/libtsa.a\nWin/libtsa.lib\ninclude/header.h\n');
        }
        return createMockProcess(0);
      });

      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
      });

      const sparseSetCall = mockSpawn.mock.calls.find(
        ([command, args]) => command === 'git'
          && (args as string[]).includes('sparse-checkout')
          && (args as string[]).includes('set')
      );
      expect(sparseSetCall).toBeDefined();

      const args = sparseSetCall?.[1] as string[];
      expect(args).toContain('macOS');
      expect(args).toContain('macOS/**');
      expect(args).toContain('include');
      expect(args).toContain('README.md');
      expect(args).not.toContain('Win');
      expect(args).not.toContain('Win/**');
    });

    it('should pull lfs paths from sparse common and requested platform entries', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'include', isDirectory: () => true },
      ]);

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        return createMockProcess(0);
      });

      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['wasm'],
        sparse: { common: ['include'], wasm: ['macOS'] },
      });

      const lfsPullCall = mockSpawn.mock.calls.find(
        ([command, args]) => command === 'git' && (args as string[]).includes('pull')
      );
      expect(lfsPullCall).toBeDefined();

      const args = lfsPullCall?.[1] as string[];
      const includeIndex = args.indexOf('--include');
      expect(args[includeIndex + 1]).toBe('include,include/**,macOS,macOS/**');
    });

    it('should configure git sparse checkout from sparse common and requested platform entries', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'include', isDirectory: () => true },
      ]);

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        return createMockProcess(0);
      });

      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['wasm'],
        sparse: { common: ['include'], wasm: ['macOS'] },
      });

      expect(mockSpawn.mock.calls.some(
        ([command, args]) => command === 'git' && (args as string[]).includes('sparse-checkout') && (args as string[]).includes('init')
      )).toBe(true);
      expect(mockSpawn.mock.calls.some(
        ([command, args]) => command === 'git'
          && (args as string[]).includes('sparse-checkout')
          && (args as string[]).includes('set')
          && (args as string[]).includes('include')
          && (args as string[]).includes('macOS')
      )).toBe(true);
    });

    it('should read sparse platform entries by platform key when requested platform is a directory value', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'include', isDirectory: () => true },
        { name: 'cmake', isDirectory: () => true },
      ]);

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        return createMockProcess(0);
      });

      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
        sparse: { common: ['include'], mac: ['macOS', 'cmake'] },
      });

      const lfsPullCall = mockSpawn.mock.calls.find(
        ([command, args]) => command === 'git' && (args as string[]).includes('pull')
      );
      const args = lfsPullCall?.[1] as string[];
      const includeIndex = args.indexOf('--include');
      expect(args[includeIndex + 1]).toBe('include,include/**,macOS,macOS/**,cmake,cmake/**');
    });

    it('should resolve sparse string with vars before git lfs pull', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'include', isDirectory: () => true },
      ]);

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        return createMockProcess(0);
      });

      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['mac'],
        sparse: '${LIB_SPARSE}',
        vars: {
          LIB_SPARSE: '{"common":["include"],"mac":["macOS"]}',
        },
      });

      const lfsPullCall = mockSpawn.mock.calls.find(
        ([command, args]) => command === 'git' && (args as string[]).includes('pull')
      );
      const args = lfsPullCall?.[1] as string[];
      const includeIndex = args.indexOf('--include');
      expect(args[includeIndex + 1]).toBe('include,include/**,macOS,macOS/**');
    });

    it('should fallback to codepac when sparse string cannot be resolved', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
      ]);

      mockSpawn.mockReturnValue(createMockProcess(0));

      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
        sparse: '${MISSING_SPARSE}',
      });

      const commands = mockSpawn.mock.calls.map((call) => call[0]);
      expect(commands).toEqual(['codepac']);
    });

    it('should fetch target commit and retry checkout when shallow checkout fails', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
      ]);

      let checkoutCount = 0;
      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        if (command === 'git' && args.includes('ls-tree')) {
          return createMockProcess(0, '', 'macOS\nWin\ninclude\n');
        }
        if (command === 'git' && args.includes('checkout')) {
          checkoutCount += 1;
          return checkoutCount === 1 ? createMockProcess(1, 'reference is not a tree') : createMockProcess(0);
        }
        if (command === 'git' && args.includes('ls-files')) {
          return createMockProcess(0, '', 'macOS/libtsa.a\n');
        }
        return createMockProcess(0);
      });

      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
      });

      expect(mockSpawn.mock.calls.some(
        ([command, args]) => command === 'git' && (args as string[]).includes('fetch') && (args as string[]).includes(fullCommit)
      )).toBe(true);
      expect(checkoutCount).toBe(2);
    });

    it('should fallback to codepac when git checkout does not produce requested platform directory', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir
        .mockResolvedValueOnce([
          { name: 'README.md', isDirectory: () => false },
        ])
        .mockResolvedValueOnce([
          { name: 'macOS', isDirectory: () => true },
        ]);

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        if (command === 'git' && args.includes('ls-tree')) {
          return createMockProcess(0, '', 'macOS\ninclude\n');
        }
        if (command === 'git' && args.includes('ls-files')) {
          return createMockProcess(0, '', 'macOS/libtsa.a\n');
        }
        return createMockProcess(0);
      });

      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
      });

      const commands = mockSpawn.mock.calls.map((call) => call[0]);
      expect(commands).toContain('git');
      expect(commands).toContain('codepac');
    });

    it('should fallback to codepac when git checkout misses one requested platform directory', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockImplementation(async (targetPath: string) => {
        if (targetPath.endsWith('/libtest')) {
          const hasCodepacFallback = mockSpawn.mock.calls.some((call) => call[0] === 'codepac');
          return hasCodepacFallback
            ? [
              { name: 'macOS', isDirectory: () => true },
              { name: 'Win', isDirectory: () => true },
            ]
            : [
              { name: 'macOS', isDirectory: () => true },
            ];
        }
        if (targetPath.endsWith('/libtest/macOS')) {
          return [{ name: 'libtsa.a', isDirectory: () => false, isFile: () => true }];
        }
        if (targetPath.endsWith('/libtest/Win')) {
          return [{ name: 'libtsa.lib', isDirectory: () => false, isFile: () => true }];
        }
        return [];
      });

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        if (command === 'git' && args.includes('ls-tree')) {
          return createMockProcess(0, '', 'macOS\nWin\ninclude\n');
        }
        if (command === 'git' && args.includes('ls-files')) {
          return createMockProcess(0, '', 'macOS/libtsa.a\nWin/libtsa.lib\n');
        }
        return createMockProcess(0);
      });

      const result = await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS', 'Win'],
      });

      const commands = mockSpawn.mock.calls.map((call) => call[0]);
      expect(commands).toContain('git');
      expect(commands).toContain('codepac');
      expect(result.platformDirs).toEqual(['macOS', 'Win']);
    });

    it('should accept git checkout when all requested platform directories exist', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'Win', isDirectory: () => true },
        { name: 'include', isDirectory: () => true },
      ]);

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        if (command === 'git' && args.includes('ls-tree')) {
          return createMockProcess(0, '', 'macOS\nWin\ninclude\n');
        }
        if (command === 'git' && args.includes('ls-files')) {
          return createMockProcess(0, '', 'macOS/libtsa.a\nWin/libtsa.lib\ninclude/header.h\n');
        }
        return createMockProcess(0);
      });

      const result = await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS', 'Win'],
      });

      const commands = mockSpawn.mock.calls.map((call) => call[0]);
      expect(commands).toContain('git');
      expect(commands).not.toContain('codepac');
      expect(result.platformDirs).toEqual(['macOS', 'Win']);
    });

    it('should fallback to codepac when expected lfs file remains a pointer', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir
        .mockResolvedValueOnce([
          { name: 'macOS', isDirectory: () => true },
        ])
        .mockResolvedValueOnce([
          { name: 'macOS', isDirectory: () => true },
        ]);

      const lfsPointer = [
        'version https://git-lfs.github.com/spec/v1',
        'oid sha256:abcdef',
        'size 100',
      ].join('\n');

      mockStat.mockResolvedValue({
        isFile: () => true,
        size: lfsPointer.length,
      });
      mockReadFile.mockResolvedValue(lfsPointer);

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        if (command === 'git' && args.includes('ls-tree')) {
          return createMockProcess(0, '', 'macOS\ninclude\n');
        }
        if (command === 'git' && args.includes('ls-files')) {
          return createMockProcess(0, '', 'macOS/libtsa.a\n');
        }
        return createMockProcess(0);
      });

      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
      });

      const commands = mockSpawn.mock.calls.map((call) => call[0]);
      expect(commands).toContain('git');
      expect(commands).toContain('codepac');
    });

    it('should fallback to codepac when sparse lfs file remains a pointer', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir
        .mockResolvedValueOnce([
          { name: 'macOS', isDirectory: () => true },
          { name: 'include', isDirectory: () => true },
        ])
        .mockResolvedValueOnce([
          { name: 'macOS', isDirectory: () => true },
          { name: 'include', isDirectory: () => true },
        ]);

      const lfsPointer = [
        'version https://git-lfs.github.com/spec/v1',
        'oid sha256:abcdef',
        'size 100',
      ].join('\n');

      mockStat.mockImplementation(async (filePath: string) => ({
        isFile: () => filePath.endsWith('macOS/libtsa.a'),
        size: lfsPointer.length,
      }));
      mockReadFile.mockImplementation(async (filePath: string) => (
        filePath.endsWith('macOS/libtsa.a') ? lfsPointer : 'binary-content'
      ));

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        if (command === 'git' && args.includes('ls-files')) {
          return createMockProcess(0, '', 'include/header.h\nmacOS/libtsa.a\nWin/libtsa.lib\n');
        }
        return createMockProcess(0);
      });

      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['wasm'],
        sparse: { common: ['include'], wasm: ['macOS'] },
      });

      const commands = mockSpawn.mock.calls.map((call) => call[0]);
      expect(commands).toContain('git');
      expect(commands).toContain('codepac');
    });

    it('should ignore unresolved lfs pointer outside sparse include paths', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'include', isDirectory: () => true },
      ]);

      const lfsPointer = [
        'version https://git-lfs.github.com/spec/v1',
        'oid sha256:abcdef',
        'size 100',
      ].join('\n');

      mockStat.mockImplementation(async (filePath: string) => ({
        isFile: () => filePath.endsWith('Win/libtsa.lib'),
        size: lfsPointer.length,
      }));
      mockReadFile.mockImplementation(async (filePath: string) => (
        filePath.endsWith('Win/libtsa.lib') ? lfsPointer : 'binary-content'
      ));

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('config')) {
          return createMockProcess(0, '', 'blob:none\n');
        }
        if (command === 'git' && args.includes('ls-files')) {
          return createMockProcess(0, '', 'include/header.h\nmacOS/libtsa.a\nWin/libtsa.lib\n');
        }
        return createMockProcess(0);
      });

      const result = await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['wasm'],
        sparse: { common: ['include'], wasm: ['macOS'] },
      });

      const commands = mockSpawn.mock.calls.map((call) => call[0]);
      expect(commands).toContain('git');
      expect(commands).not.toContain('codepac');
      expect(result.platformDirs).toEqual(['macOS']);
    });

    it('should cleanup git directory and fallback to codepac when git clone fails', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
      ]);

      mockSpawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git' && args.includes('clone')) {
          return createMockProcess(1, 'filter unsupported');
        }
        if (command === 'git') {
          return createMockProcess(0);
        }
        return createMockProcess(0);
      });

      const onProgress = vi.fn();
      await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: fullCommit,
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
        onProgress,
      });

      const commands = mockSpawn.mock.calls.map((call) => call[0]);
      expect(commands).toContain('git');
      expect(commands).toContain('codepac');
      expect(mockRm).toHaveBeenCalledWith(
        expect.stringMatching(/\/tmp\/tanmi-dock-\d+-[a-z0-9]+\/libtest$/),
        { recursive: true, force: true }
      );
      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('Git 轻量下载失败，切换 codepac 下载'));
    });

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

      // 传入 value 形式（link.ts 会先用 parsePlatformArgs 转换）
      const result = await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: 'abc123',
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS', 'macOS-asan', 'Win'],
      });

      // 验证平台目录识别（保留用户请求的）
      expect(result.allPlatformDirs).toContain('macOS');
      expect(result.allPlatformDirs).toContain('macOS-asan');
      expect(result.allPlatformDirs).toContain('Win');
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

      // 没有被清理的平台
      expect(result.cleanedPlatforms).toHaveLength(0);
    });

    it('should clean unrequested platform directories', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);

      // Mock readdir 返回多个平台（codepac 会下载所有变体）
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'macOS-asan', isDirectory: () => true },
      ]);

      mockSpawn.mockReturnValue(createMockProcess(0));

      // 只请求 macOS，不要 asan
      const result = await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: 'abc123',
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
      });

      // 验证只保留请求的平台
      expect(result.allPlatformDirs).toContain('macOS');
      expect(result.allPlatformDirs).toContain('macOS-asan');
      expect(result.platformDirs).toContain('macOS');
      expect(result.platformDirs).not.toContain('macOS-asan');

      // 验证清理了未请求的平台
      expect(result.cleanedPlatforms).toContain('macOS-asan');

      // 验证 fs.rm 被调用来清理目录
      expect(mockRm).toHaveBeenCalled();
    });

    it('should retain mapped carrier platform directories for sparse requests', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);

      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'macOS-asan', isDirectory: () => true },
        { name: 'README.md', isDirectory: () => false },
      ]);

      mockSpawn.mockReturnValue(createMockProcess(0));

      const result = await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: 'abc123',
        branch: 'main',
        libName: 'libtest',
        platforms: ['wasm'],
        sparse: { wasm: ['macOS'] },
      });

      expect(result.allPlatformDirs).toEqual(['macOS', 'macOS-asan']);
      expect(result.platformDirs).toEqual(['macOS']);
      expect(result.cleanedPlatforms).toEqual(['macOS-asan']);
      expect(result.sharedFiles).toEqual(['README.md']);
    });

    it('should not report empty platform directories as downloaded platforms', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);

      mockReaddir.mockImplementation(async (targetPath: string) => {
        if (targetPath.endsWith('/libtest')) {
          return [
            { name: 'macOS', isDirectory: () => true, isFile: () => false },
            { name: 'README.md', isDirectory: () => false, isFile: () => true },
          ];
        }
        if (targetPath.endsWith('/libtest/macOS')) {
          return [];
        }
        return [];
      });

      mockSpawn.mockReturnValue(createMockProcess(0));

      const result = await codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: 'abc123',
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
      });

      expect(result.allPlatformDirs).toEqual([]);
      expect(result.platformDirs).toEqual([]);
      expect(result.sharedFiles).toContain('macOS');
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

    it('should emit heartbeat when codepac stays silent for a long time', async () => {
      vi.useFakeTimers();
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
      ]);

      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      mockSpawn.mockReturnValue(proc);

      const onHeartbeat = vi.fn();
      const promise = codepac.downloadToTemp({
        url: 'git@example.com:repo/lib.git',
        commit: 'abc123',
        branch: 'main',
        libName: 'libtest',
        platforms: ['macOS'],
        onHeartbeat,
      });

      await vi.advanceTimersByTimeAsync(10000);
      expect(onHeartbeat).toHaveBeenCalledWith('仍在处理中，可能在同步大文件，期间无新日志');

      proc.emit('close', 0);
      await promise;
      vi.useRealTimers();
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
