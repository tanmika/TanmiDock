/**
 * codepac 模块测试
 * 主要验证参数构造的正确性
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock spawn 函数
const mockSpawn = vi.fn();

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, callback?: Function) => {
    if (callback) {
      callback(null, 'Version 2.0.56', '');
    }
    return { stdout: '', stderr: '' };
  }),
  spawn: (...args: unknown[]) => mockSpawn(...args),
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
  });

  describe('isCodepacInstalled', () => {
    it('should return true when codepac is available', async () => {
      const result = await codepac.isCodepacInstalled();
      expect(result).toBe(true);
    });
  });

  describe('getVersion', () => {
    // 注意：getVersion 使用 promisify(exec)，mock 行为可能不同
    // 这个测试验证函数不会抛出异常
    it('should not throw error', async () => {
      await expect(codepac.getVersion()).resolves.not.toThrow();
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
  });

  describe('installSingle', () => {
    // installSingle 涉及真实 fs 操作（写临时文件），在单元测试中跳过
    // 参数构造逻辑已在 install 测试中覆盖
    it.skip('should create temp config and call install', async () => {
      // 需要集成测试环境
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
  });
});
