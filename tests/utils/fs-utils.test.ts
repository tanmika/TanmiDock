import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    readdir: vi.fn(),
    copyFile: vi.fn(),
    stat: vi.fn(),
    readlink: vi.fn(),
    symlink: vi.fn(),
    rm: vi.fn(),
  },
}));

describe('fs-utils', () => {
  let fsMock: {
    mkdir: ReturnType<typeof vi.fn>;
    readdir: ReturnType<typeof vi.fn>;
    copyFile: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    readlink: ReturnType<typeof vi.fn>;
    symlink: ReturnType<typeof vi.fn>;
    rm: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetModules();
    const fs = await import('fs/promises');
    fsMock = fs.default as typeof fsMock;
    fsMock.mkdir.mockReset();
    fsMock.readdir.mockReset();
    fsMock.copyFile.mockReset();
    fsMock.stat.mockReset();
    fsMock.readlink.mockReset();
    fsMock.symlink.mockReset();
    fsMock.rm.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('copyDir', () => {
    it('should recursively copy directory', async () => {
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValueOnce([
        { name: 'file1.txt', isDirectory: () => false, isSymbolicLink: () => false },
        { name: 'subdir', isDirectory: () => true, isSymbolicLink: () => false },
      ]);
      fsMock.readdir.mockResolvedValueOnce([
        { name: 'file2.txt', isDirectory: () => false, isSymbolicLink: () => false },
      ]);
      fsMock.copyFile.mockResolvedValue(undefined);

      const { copyDir } = await import('../../src/utils/fs-utils.js');
      await copyDir('/src', '/dest');

      expect(fsMock.mkdir).toHaveBeenCalledWith('/dest', { recursive: true });
      expect(fsMock.copyFile).toHaveBeenCalledWith('/src/file1.txt', '/dest/file1.txt');
      expect(fsMock.copyFile).toHaveBeenCalledWith(
        path.join('/src', 'subdir', 'file2.txt'),
        path.join('/dest', 'subdir', 'file2.txt')
      );
    });

    it('should preserve symlinks when option is set', async () => {
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue([
        { name: 'link', isDirectory: () => false, isSymbolicLink: () => true },
      ]);
      fsMock.readlink.mockResolvedValue('/target');
      fsMock.symlink.mockResolvedValue(undefined);

      const { copyDir } = await import('../../src/utils/fs-utils.js');
      await copyDir('/src', '/dest', { preserveSymlinks: true });

      expect(fsMock.readlink).toHaveBeenCalledWith('/src/link');
      expect(fsMock.symlink).toHaveBeenCalledWith('/target', '/dest/link');
    });

    it('should copy symlink as file when preserveSymlinks is false', async () => {
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue([
        { name: 'link', isDirectory: () => false, isSymbolicLink: () => true },
      ]);
      fsMock.copyFile.mockResolvedValue(undefined);

      const { copyDir } = await import('../../src/utils/fs-utils.js');
      await copyDir('/src', '/dest', { preserveSymlinks: false });

      expect(fsMock.copyFile).toHaveBeenCalledWith('/src/link', '/dest/link');
      expect(fsMock.symlink).not.toHaveBeenCalled();
    });
  });

  describe('copyDirWithProgress', () => {
    it('should copy files and call progress callback', async () => {
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue([
        { name: 'file1.txt', isDirectory: () => false, isSymbolicLink: () => false },
        { name: 'file2.txt', isDirectory: () => false, isSymbolicLink: () => false },
      ]);
      fsMock.stat.mockResolvedValue({ size: 100 });
      fsMock.copyFile.mockResolvedValue(undefined);

      const onProgress = vi.fn();

      const { copyDirWithProgress } = await import('../../src/utils/fs-utils.js');
      await copyDirWithProgress('/src', '/dest', 200, onProgress);

      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenCalledWith(100, 200);
      expect(onProgress).toHaveBeenCalledWith(200, 200);
    });
  });

  describe('getDirSize', () => {
    it('should calculate directory size recursively', async () => {
      fsMock.readdir
        .mockResolvedValueOnce([
          { name: 'file1.txt', isDirectory: () => false, isFile: () => true },
          { name: 'subdir', isDirectory: () => true, isFile: () => false },
        ])
        .mockResolvedValueOnce([
          { name: 'file2.txt', isDirectory: () => false, isFile: () => true },
        ]);
      fsMock.stat.mockResolvedValue({ size: 100 });

      const { getDirSize } = await import('../../src/utils/fs-utils.js');
      const size = await getDirSize('/test');

      expect(size).toBe(200);
    });

    it('should return 0 for non-existent directory', async () => {
      fsMock.readdir.mockRejectedValue(new Error('ENOENT'));

      const { getDirSize } = await import('../../src/utils/fs-utils.js');
      const size = await getDirSize('/nonexistent');

      expect(size).toBe(0);
    });
  });

  describe('ensureDir', () => {
    it('should create directory recursively', async () => {
      fsMock.mkdir.mockResolvedValue(undefined);

      const { ensureDir } = await import('../../src/utils/fs-utils.js');
      await ensureDir('/test/nested/dir');

      expect(fsMock.mkdir).toHaveBeenCalledWith('/test/nested/dir', { recursive: true });
    });
  });

  describe('removeDir', () => {
    it('should remove directory recursively', async () => {
      fsMock.rm.mockResolvedValue(undefined);

      const { removeDir } = await import('../../src/utils/fs-utils.js');
      await removeDir('/test/dir');

      expect(fsMock.rm).toHaveBeenCalledWith('/test/dir', { recursive: true, force: true });
    });
  });
});
