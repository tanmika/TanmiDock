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

  describe('parseGitmodules', () => {
    it('should parse standard .gitmodules format', async () => {
      const { parseGitmodules } = await import('../../src/utils/git.js');
      const content = `[submodule "InstantSDK"]
\tpath = InstantSDK
\turl = git@example.com:org/repo.git
\tbranch = develop`;

      const result = parseGitmodules(content);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'InstantSDK',
        path: 'InstantSDK',
        url: 'git@example.com:org/repo.git',
        branch: 'develop',
      });
    });

    it('should parse multiple submodules', async () => {
      const { parseGitmodules } = await import('../../src/utils/git.js');
      const content = `[submodule "ModuleA"]
\tpath = ModuleA
\turl = git@example.com:org/module-a.git
[submodule "ModuleB"]
\tpath = libs/ModuleB
\turl = git@example.com:org/module-b.git
\tbranch = main`;

      const result = parseGitmodules(content);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('ModuleA');
      expect(result[0].path).toBe('ModuleA');
      expect(result[0].branch).toBeUndefined();
      expect(result[1].name).toBe('ModuleB');
      expect(result[1].path).toBe('libs/ModuleB');
      expect(result[1].branch).toBe('main');
    });

    it('should skip entries missing path field', async () => {
      const { parseGitmodules } = await import('../../src/utils/git.js');
      const content = `[submodule "NoPath"]
\turl = git@example.com:org/repo.git
[submodule "HasPath"]
\tpath = HasPath
\turl = git@example.com:org/has-path.git`;

      const result = parseGitmodules(content);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('HasPath');
    });

    it('should skip entries missing url field', async () => {
      const { parseGitmodules } = await import('../../src/utils/git.js');
      const content = `[submodule "NoUrl"]
\tpath = NoUrl
[submodule "HasUrl"]
\tpath = HasUrl
\turl = git@example.com:org/has-url.git`;

      const result = parseGitmodules(content);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('HasUrl');
    });

    it('should handle empty content', async () => {
      const { parseGitmodules } = await import('../../src/utils/git.js');
      expect(parseGitmodules('')).toHaveLength(0);
    });

    it('should handle comment lines and blank lines', async () => {
      const { parseGitmodules } = await import('../../src/utils/git.js');
      const content = `# This is a comment
; Another comment

[submodule "MyLib"]

\tpath = MyLib
\t# inline comment? no, it's a data line starting with #
\turl = git@example.com:org/mylib.git
`;

      const result = parseGitmodules(content);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('MyLib');
    });

    it('should handle mixed tab and space indentation', async () => {
      const { parseGitmodules } = await import('../../src/utils/git.js');
      const content = `[submodule "Lib"]
    path = Lib
\t  url = git@example.com:org/lib.git`;

      const result = parseGitmodules(content);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('Lib');
      expect(result[0].url).toBe('git@example.com:org/lib.git');
    });
  });

  describe('findSubmoduleConfigs', () => {
    it('should return empty array when no .gitmodules exists', async () => {
      fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

      const { findSubmoduleConfigs } = await import('../../src/utils/git.js');
      const result = await findSubmoduleConfigs('/project');

      expect(result).toEqual([]);
    });

    it('should skip submodule when directory does not exist', async () => {
      // readFile for .gitmodules succeeds
      fsMock.readFile.mockResolvedValueOnce(`[submodule "NotInit"]
\tpath = NotInit
\turl = git@example.com:org/notinit.git`);
      // stat for submodule dir fails (not initialized)
      fsMock.stat.mockRejectedValue(new Error('ENOENT'));

      const { findSubmoduleConfigs } = await import('../../src/utils/git.js');
      const result = await findSubmoduleConfigs('/project');

      expect(result).toEqual([]);
    });
  });
});
