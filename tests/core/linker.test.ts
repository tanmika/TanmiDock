import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    symlink: vi.fn(),
    lstat: vi.fn(),
    stat: vi.fn(),
    readlink: vi.fn(),
    unlink: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
    readdir: vi.fn(),
    copyFile: vi.fn(),
  },
}));

// Mock platform
vi.mock('../../src/core/platform.js', () => ({
  isWindows: vi.fn(() => false),
}));

describe('linker', () => {
  let fsMock: {
    mkdir: ReturnType<typeof vi.fn>;
    symlink: ReturnType<typeof vi.fn>;
    lstat: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    readlink: ReturnType<typeof vi.fn>;
    unlink: ReturnType<typeof vi.fn>;
    rename: ReturnType<typeof vi.fn>;
    rm: ReturnType<typeof vi.fn>;
    readdir: ReturnType<typeof vi.fn>;
    copyFile: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetModules();
    const fs = await import('fs/promises');
    fsMock = fs.default as typeof fsMock;
    Object.values(fsMock).forEach((fn) => fn.mockReset());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('link', () => {
    it('should create symlink on macOS', async () => {
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.symlink.mockResolvedValue(undefined);

      const { link } = await import('../../src/core/linker.js');
      await link('/store/lib', '/project/lib');

      expect(fsMock.mkdir).toHaveBeenCalledWith('/project', { recursive: true });
      expect(fsMock.symlink).toHaveBeenCalledWith('/store/lib', '/project/lib', 'dir');
    });

    it('should create junction on Windows', async () => {
      const { isWindows } = await import('../../src/core/platform.js');
      vi.mocked(isWindows).mockReturnValue(true);

      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.symlink.mockResolvedValue(undefined);

      const { link } = await import('../../src/core/linker.js');
      await link('/store/lib', '/project/lib');

      expect(fsMock.symlink).toHaveBeenCalledWith('/store/lib', '/project/lib', 'junction');
    });
  });

  describe('isSymlink', () => {
    it('should return true for symlink', async () => {
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => true });

      const { isSymlink } = await import('../../src/core/linker.js');
      const result = await isSymlink('/some/link');

      expect(result).toBe(true);
    });

    it('should return false for regular directory', async () => {
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => false });

      const { isSymlink } = await import('../../src/core/linker.js');
      const result = await isSymlink('/some/dir');

      expect(result).toBe(false);
    });

    it('should return false when path does not exist', async () => {
      fsMock.lstat.mockRejectedValue(new Error('ENOENT'));

      const { isSymlink } = await import('../../src/core/linker.js');
      const result = await isSymlink('/nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('readLink', () => {
    it('should return target path for symlink', async () => {
      fsMock.readlink.mockResolvedValue('/target/path');

      const { readLink } = await import('../../src/core/linker.js');
      const result = await readLink('/some/link');

      expect(result).toBe('/target/path');
    });

    it('should return null when not a symlink', async () => {
      fsMock.readlink.mockRejectedValue(new Error('EINVAL'));

      const { readLink } = await import('../../src/core/linker.js');
      const result = await readLink('/some/dir');

      expect(result).toBeNull();
    });
  });

  describe('unlink', () => {
    it('should remove symlink', async () => {
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => true });
      fsMock.unlink.mockResolvedValue(undefined);

      const { unlink } = await import('../../src/core/linker.js');
      await unlink('/some/link');

      expect(fsMock.unlink).toHaveBeenCalledWith('/some/link');
    });

    it('should not remove non-symlink', async () => {
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => false });

      const { unlink } = await import('../../src/core/linker.js');
      await unlink('/some/dir');

      expect(fsMock.unlink).not.toHaveBeenCalled();
    });

    it('should ignore when path does not exist', async () => {
      fsMock.lstat.mockRejectedValue(new Error('ENOENT'));

      const { unlink } = await import('../../src/core/linker.js');
      await unlink('/nonexistent');

      expect(fsMock.unlink).not.toHaveBeenCalled();
    });
  });

  describe('isValidLink', () => {
    it('should return true for valid symlink', async () => {
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => true });
      fsMock.stat.mockResolvedValue({});

      const { isValidLink } = await import('../../src/core/linker.js');
      const result = await isValidLink('/valid/link');

      expect(result).toBe(true);
    });

    it('should return false for broken symlink', async () => {
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => true });
      fsMock.stat.mockRejectedValue(new Error('ENOENT'));

      const { isValidLink } = await import('../../src/core/linker.js');
      const result = await isValidLink('/broken/link');

      expect(result).toBe(false);
    });

    it('should return false for non-symlink', async () => {
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => false });

      const { isValidLink } = await import('../../src/core/linker.js');
      const result = await isValidLink('/regular/dir');

      expect(result).toBe(false);
    });
  });

  describe('isCorrectLink', () => {
    it('should return true when link points to expected target', async () => {
      fsMock.readlink.mockResolvedValue('/store/lib');

      const { isCorrectLink } = await import('../../src/core/linker.js');
      const result = await isCorrectLink('/project/lib', '/store/lib');

      expect(result).toBe(true);
    });

    it('should return false when link points to wrong target', async () => {
      fsMock.readlink.mockResolvedValue('/other/lib');

      const { isCorrectLink } = await import('../../src/core/linker.js');
      const result = await isCorrectLink('/project/lib', '/store/lib');

      expect(result).toBe(false);
    });

    it('should return false when not a symlink', async () => {
      fsMock.readlink.mockRejectedValue(new Error('EINVAL'));

      const { isCorrectLink } = await import('../../src/core/linker.js');
      const result = await isCorrectLink('/project/lib', '/store/lib');

      expect(result).toBe(false);
    });
  });

  describe('getPathStatus', () => {
    it('should return "linked" for correct symlink', async () => {
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => true, isDirectory: () => false });
      fsMock.readlink.mockResolvedValue('/store/lib');

      const { getPathStatus } = await import('../../src/core/linker.js');
      const result = await getPathStatus('/project/lib', '/store/lib');

      expect(result).toBe('linked');
    });

    it('should return "wrong_link" for incorrect symlink', async () => {
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => true, isDirectory: () => false });
      fsMock.readlink.mockResolvedValue('/other/lib');

      const { getPathStatus } = await import('../../src/core/linker.js');
      const result = await getPathStatus('/project/lib', '/store/lib');

      expect(result).toBe('wrong_link');
    });

    it('should return "directory" for regular directory', async () => {
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => true });

      const { getPathStatus } = await import('../../src/core/linker.js');
      const result = await getPathStatus('/project/lib', '/store/lib');

      expect(result).toBe('directory');
    });

    it('should return "missing" for non-existent path', async () => {
      fsMock.lstat.mockRejectedValue(new Error('ENOENT'));

      const { getPathStatus } = await import('../../src/core/linker.js');
      const result = await getPathStatus('/nonexistent', '/store/lib');

      expect(result).toBe('missing');
    });

    it('should return "missing" for non-directory non-symlink', async () => {
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => false });

      const { getPathStatus } = await import('../../src/core/linker.js');
      const result = await getPathStatus('/some/file', '/store/lib');

      expect(result).toBe('missing');
    });
  });

  describe('replaceWithLink', () => {
    it('should do nothing when already correctly linked', async () => {
      fsMock.readlink.mockResolvedValue('/store/lib');

      const { replaceWithLink } = await import('../../src/core/linker.js');
      const result = await replaceWithLink('/project/lib', '/store/lib');

      expect(result).toBeNull();
      expect(fsMock.symlink).not.toHaveBeenCalled();
    });

    it('should relink when pointing to wrong target', async () => {
      fsMock.readlink.mockResolvedValue('/wrong/lib');
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => true });
      fsMock.unlink.mockResolvedValue(undefined);
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.symlink.mockResolvedValue(undefined);

      const { replaceWithLink } = await import('../../src/core/linker.js');
      const result = await replaceWithLink('/project/lib', '/store/lib');

      expect(result).toBeNull();
      expect(fsMock.unlink).toHaveBeenCalled();
      expect(fsMock.symlink).toHaveBeenCalled();
    });

    it('should create link when directory does not exist', async () => {
      fsMock.readlink.mockRejectedValue(new Error('EINVAL'));
      fsMock.lstat
        .mockResolvedValueOnce({ isSymbolicLink: () => false }) // isSymlink check
        .mockRejectedValueOnce({ code: 'ENOENT' }); // directory check
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.symlink.mockResolvedValue(undefined);

      const { replaceWithLink } = await import('../../src/core/linker.js');
      const result = await replaceWithLink('/project/lib', '/store/lib');

      expect(result).toBeNull();
    });

    it('should delete directory and create link when not backup', async () => {
      fsMock.readlink.mockRejectedValue(new Error('EINVAL'));
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => true });
      fsMock.rm.mockResolvedValue(undefined);
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.symlink.mockResolvedValue(undefined);

      const { replaceWithLink } = await import('../../src/core/linker.js');
      const result = await replaceWithLink('/project/lib', '/store/lib', false);

      expect(fsMock.rm).toHaveBeenCalledWith('/project/lib', { recursive: true, force: true });
      expect(result).toBeNull();
    });

    it('should backup directory when backup is true', async () => {
      fsMock.readlink.mockRejectedValue(new Error('EINVAL'));
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => true });
      fsMock.rename.mockResolvedValue(undefined);
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.symlink.mockResolvedValue(undefined);

      const { replaceWithLink } = await import('../../src/core/linker.js');
      const result = await replaceWithLink('/project/lib', '/store/lib', true);

      expect(fsMock.rename).toHaveBeenCalled();
      expect(result).toMatch(/\/project\/lib\.backup\.\d+/);
    });

    it('should throw when path is not a directory', async () => {
      fsMock.readlink.mockRejectedValue(new Error('EINVAL'));
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => false });

      const { replaceWithLink } = await import('../../src/core/linker.js');

      await expect(replaceWithLink('/project/file', '/store/lib')).rejects.toThrow('路径不是目录');
    });
  });

  describe('restoreFromLink', () => {
    it('should copy contents from target and remove link', async () => {
      fsMock.readlink.mockResolvedValue('/store/lib');
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => true });
      fsMock.unlink.mockResolvedValue(undefined);
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue([
        { name: 'file.txt', isDirectory: () => false, isSymbolicLink: () => false },
      ]);
      fsMock.copyFile.mockResolvedValue(undefined);

      const { restoreFromLink } = await import('../../src/core/linker.js');
      await restoreFromLink('/project/lib');

      expect(fsMock.unlink).toHaveBeenCalledWith('/project/lib');
      expect(fsMock.copyFile).toHaveBeenCalled();
    });

    it('should throw when not a symlink', async () => {
      fsMock.readlink.mockRejectedValue(new Error('EINVAL'));

      const { restoreFromLink } = await import('../../src/core/linker.js');

      await expect(restoreFromLink('/project/lib')).rejects.toThrow('不是符号链接');
    });
  });
});
