import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn(),
    readFile: vi.fn(),
  },
}));

// Mock child_process
const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

// Mock logger
vi.mock('../../src/utils/logger.js', () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

describe('git', () => {
  let fsMock: {
    stat: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetModules();
    const fs = await import('fs/promises');
    fsMock = fs.default as typeof fsMock;
    Object.values(fsMock).forEach((fn) => fn.mockReset());
    mockExecFile.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('detectLocalCommit', () => {
    it('should return null when .git does not exist', async () => {
      fsMock.stat.mockRejectedValue(new Error('ENOENT'));

      const { detectLocalCommit } = await import('../../src/utils/git.js');
      const result = await detectLocalCommit('/path/to/lib');

      expect(result).toBeNull();
      expect(fsMock.stat).toHaveBeenCalledWith(path.join('/path/to/lib', '.git'));
    });

    it('should return hash from commit_hash file when valid', async () => {
      fsMock.stat.mockResolvedValue({ isDirectory: () => true, isFile: () => false });
      fsMock.readFile.mockResolvedValue('abc1234def5678\n');

      const { detectLocalCommit } = await import('../../src/utils/git.js');
      const result = await detectLocalCommit('/path/to/lib');

      expect(result).toBe('abc1234def5678');
    });

    it('should fall back to git rev-parse when commit_hash is invalid', async () => {
      fsMock.stat.mockResolvedValue({ isDirectory: () => true, isFile: () => false });
      fsMock.readFile.mockResolvedValue('not-a-hash\n');
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback?: Function) => {
        // promisify wraps execFile: the last arg is the callback
        if (typeof _opts === 'function') {
          _opts(null, { stdout: 'deadbeef1234567\n', stderr: '' });
        } else if (callback) {
          callback(null, { stdout: 'deadbeef1234567\n', stderr: '' });
        }
        return {};
      });

      const { detectLocalCommit } = await import('../../src/utils/git.js');
      const result = await detectLocalCommit('/path/to/lib');

      expect(result).toBe('deadbeef1234567');
    });

    it('should fall back to git rev-parse when commit_hash file is missing', async () => {
      fsMock.stat.mockResolvedValue({ isDirectory: () => true, isFile: () => false });
      fsMock.readFile.mockRejectedValue(new Error('ENOENT'));
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback?: Function) => {
        if (typeof _opts === 'function') {
          _opts(null, { stdout: 'abcdef1234567890\n', stderr: '' });
        } else if (callback) {
          callback(null, { stdout: 'abcdef1234567890\n', stderr: '' });
        }
        return {};
      });

      const { detectLocalCommit } = await import('../../src/utils/git.js');
      const result = await detectLocalCommit('/path/to/lib');

      expect(result).toBe('abcdef1234567890');
    });

    it('should return null when both commit_hash and git rev-parse fail', async () => {
      fsMock.stat.mockResolvedValue({ isDirectory: () => true, isFile: () => false });
      fsMock.readFile.mockRejectedValue(new Error('ENOENT'));
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback?: Function) => {
        if (typeof _opts === 'function') {
          _opts(new Error('not a git repository'), { stdout: '', stderr: '' });
        } else if (callback) {
          callback(new Error('not a git repository'), { stdout: '', stderr: '' });
        }
        return {};
      });

      const { detectLocalCommit } = await import('../../src/utils/git.js');
      const result = await detectLocalCommit('/path/to/lib');

      expect(result).toBeNull();
    });

    it('should return null when .git is neither directory nor file', async () => {
      fsMock.stat.mockResolvedValue({ isDirectory: () => false, isFile: () => false });

      const { detectLocalCommit } = await import('../../src/utils/git.js');
      const result = await detectLocalCommit('/path/to/lib');

      expect(result).toBeNull();
    });
  });

  describe('verifyLocalCommit uses detectLocalCommit', () => {
    it('should return match when commit matches', async () => {
      fsMock.stat.mockResolvedValue({ isDirectory: () => true, isFile: () => false });
      fsMock.readFile.mockResolvedValue('abc1234def5678901234567890abcdef12345678\n');

      const { verifyLocalCommit } = await import('../../src/utils/git.js');
      const result = await verifyLocalCommit('/path/to/lib', 'abc1234');

      expect(result.verified).toBe(true);
      expect(result.reason).toBe('match');
      expect(result.actualCommit).toBe('abc1234def5678901234567890abcdef12345678');
    });

    it('should return no_git when expectedCommit is too short', async () => {
      const { verifyLocalCommit } = await import('../../src/utils/git.js');
      const result = await verifyLocalCommit('/path/to/lib', 'abc');

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('no_git');
    });

    it('should return no_git when .git does not exist', async () => {
      fsMock.stat.mockRejectedValue(new Error('ENOENT'));

      const { verifyLocalCommit } = await import('../../src/utils/git.js');
      const result = await verifyLocalCommit('/path/to/lib', 'abc1234');

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('no_git');
    });

    it('should return mismatch when commit differs', async () => {
      fsMock.stat.mockResolvedValue({ isDirectory: () => true, isFile: () => false });
      fsMock.readFile.mockResolvedValue('1111111222222233333334444444555555566666\n');

      const { verifyLocalCommit } = await import('../../src/utils/git.js');
      const result = await verifyLocalCommit('/path/to/lib', 'abc1234');

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('mismatch');
      expect(result.actualCommit).toBe('1111111222222233333334444444555555566666');
    });
  });
});
