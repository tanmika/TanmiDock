import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsReal } from 'node:fs';

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

describe('fs-utils integrity functions', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsReal.mkdtemp(path.join(os.tmpdir(), 'fs-utils-integrity-'));
  });

  afterEach(async () => {
    await fsReal.rm(tmpDir, { recursive: true, force: true });
  });

  describe('countFiles', () => {
    it('should return 0 for empty directory', async () => {
      const { countFiles } = await import('../../src/utils/fs-utils.js');
      const count = await countFiles(tmpDir);
      expect(count).toBe(0);
    });

    it('should count files in directory and subdirectories', async () => {
      // 创建文件和子目录结构
      await fsReal.writeFile(path.join(tmpDir, 'file1.txt'), 'hello');
      await fsReal.writeFile(path.join(tmpDir, 'file2.txt'), 'world');
      const subDir = path.join(tmpDir, 'subdir');
      await fsReal.mkdir(subDir);
      await fsReal.writeFile(path.join(subDir, 'file3.txt'), 'nested');

      const { countFiles } = await import('../../src/utils/fs-utils.js');
      const count = await countFiles(tmpDir);
      expect(count).toBe(3);
    });

    it('should return 0 for non-existent path', async () => {
      const { countFiles } = await import('../../src/utils/fs-utils.js');
      const count = await countFiles(path.join(tmpDir, 'nonexistent'));
      expect(count).toBe(0);
    });

    it('should not count symlinks as files', async () => {
      // 创建真实文件
      await fsReal.writeFile(path.join(tmpDir, 'real.txt'), 'content');
      // 创建符号链接
      await fsReal.symlink(
        path.join(tmpDir, 'real.txt'),
        path.join(tmpDir, 'link.txt')
      );

      const { countFiles } = await import('../../src/utils/fs-utils.js');
      const count = await countFiles(tmpDir);
      // find -type f 不会计入符号链接，只有真实文件
      expect(count).toBe(1);
    });
  });

  describe('hashDirectory', () => {
    it('should return deterministic hash for same content', async () => {
      await fsReal.writeFile(path.join(tmpDir, 'file.txt'), 'deterministic content');

      const { hashDirectory } = await import('../../src/utils/fs-utils.js');
      const hash1 = await hashDirectory(tmpDir);
      const hash2 = await hashDirectory(tmpDir);
      expect(hash1).toBe(hash2);
    });

    it('should return different hash for different content', async () => {
      // 创建两个目录，内容不同
      const dir1 = await fsReal.mkdtemp(path.join(os.tmpdir(), 'hash-test-1-'));
      const dir2 = await fsReal.mkdtemp(path.join(os.tmpdir(), 'hash-test-2-'));

      try {
        await fsReal.writeFile(path.join(dir1, 'file.txt'), 'content A');
        await fsReal.writeFile(path.join(dir2, 'file.txt'), 'content B');

        const { hashDirectory } = await import('../../src/utils/fs-utils.js');
        const hash1 = await hashDirectory(dir1);
        const hash2 = await hashDirectory(dir2);
        expect(hash1).not.toBe(hash2);
      } finally {
        await fsReal.rm(dir1, { recursive: true, force: true });
        await fsReal.rm(dir2, { recursive: true, force: true });
      }
    });

    it('should return consistent hash for empty directory', async () => {
      const { hashDirectory } = await import('../../src/utils/fs-utils.js');
      const hash1 = await hashDirectory(tmpDir);
      const hash2 = await hashDirectory(tmpDir);
      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe('string');
      expect(hash1.length).toBeGreaterThan(0);
    });

    it('should produce deterministic hash for nested subdirectories', async () => {
      // 创建嵌套目录结构
      const subA = path.join(tmpDir, 'a');
      const subB = path.join(tmpDir, 'a', 'b');
      await fsReal.mkdir(subA);
      await fsReal.mkdir(subB);
      await fsReal.writeFile(path.join(tmpDir, 'root.txt'), 'root');
      await fsReal.writeFile(path.join(subA, 'mid.txt'), 'middle');
      await fsReal.writeFile(path.join(subB, 'deep.txt'), 'deep');

      const { hashDirectory } = await import('../../src/utils/fs-utils.js');
      const hash1 = await hashDirectory(tmpDir);
      const hash2 = await hashDirectory(tmpDir);
      expect(hash1).toBe(hash2);

      // 修改深层文件应该改变哈希
      await fsReal.writeFile(path.join(subB, 'deep.txt'), 'modified');
      const hash3 = await hashDirectory(tmpDir);
      expect(hash3).not.toBe(hash1);
    });
  });

  describe('getDirectoryIntegrity', () => {
    it('should return combined size, fileCount and contentHash', async () => {
      await fsReal.writeFile(path.join(tmpDir, 'file1.txt'), 'hello');
      await fsReal.writeFile(path.join(tmpDir, 'file2.txt'), 'world');

      const { getDirectoryIntegrity } = await import('../../src/utils/fs-utils.js');
      const result = await getDirectoryIntegrity(tmpDir);

      expect(result).toHaveProperty('size');
      expect(result).toHaveProperty('fileCount');
      expect(result).toHaveProperty('contentHash');
      expect(typeof result.size).toBe('number');
      expect(result.size).toBeGreaterThan(0);
      expect(result.fileCount).toBe(2);
      expect(typeof result.contentHash).toBe('string');
      expect(result.contentHash.length).toBeGreaterThan(0);
    });
  });
});
