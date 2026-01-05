import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
    rmdir: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    copyFile: vi.fn(),
  },
}));

// Mock config
vi.mock('../../src/core/config.js', () => ({
  getStorePath: vi.fn(),
}));

// Mock lock utility - execute function immediately without actual locking
vi.mock('../../src/utils/lock.js', () => ({
  withFileLock: vi.fn(async (_path: string, fn: () => Promise<unknown>) => fn()),
}));

describe('store', () => {
  let fsMock: {
    access: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
    rename: ReturnType<typeof vi.fn>;
    rm: ReturnType<typeof vi.fn>;
    rmdir: ReturnType<typeof vi.fn>;
    readdir: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    copyFile: ReturnType<typeof vi.fn>;
  };
  let configMock: { getStorePath: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.resetModules();
    const fs = await import('fs/promises');
    fsMock = fs.default as typeof fsMock;
    Object.values(fsMock).forEach((fn) => fn.mockReset());

    const config = await import('../../src/core/config.js');
    configMock = config as typeof configMock;
    configMock.getStorePath.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getLibraryPath', () => {
    it('should return correct path', async () => {
      const { getLibraryPath } = await import('../../src/core/store.js');
      const result = getLibraryPath('/store', 'mylib', 'abc123');

      expect(result).toBe(path.join('/store', 'mylib', 'abc123'));
    });
  });

  describe('getStorePath', () => {
    it('should return configured store path', async () => {
      configMock.getStorePath.mockResolvedValue('/configured/store');

      const { getStorePath } = await import('../../src/core/store.js');
      const result = await getStorePath();

      expect(result).toBe('/configured/store');
    });

    it('should throw when store path not configured', async () => {
      configMock.getStorePath.mockResolvedValue(undefined);

      const { getStorePath } = await import('../../src/core/store.js');

      await expect(getStorePath()).rejects.toThrow('Store 路径未配置');
    });
  });

  describe('exists', () => {
    it('should return true when library exists', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.access.mockResolvedValue(undefined);

      const { exists } = await import('../../src/core/store.js');
      const result = await exists('mylib', 'abc123');

      expect(result).toBe(true);
    });

    it('should return false when library does not exist', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.access.mockRejectedValue(new Error('ENOENT'));

      const { exists } = await import('../../src/core/store.js');
      const result = await exists('mylib', 'abc123');

      expect(result).toBe(false);
    });
  });

  describe('getPath', () => {
    it('should return path when library exists', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.access.mockResolvedValue(undefined);

      const { getPath } = await import('../../src/core/store.js');
      const result = await getPath('mylib', 'abc123');

      expect(result).toBe(path.join('/store', 'mylib', 'abc123'));
    });

    it('should return null when library does not exist', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.access.mockRejectedValue(new Error('ENOENT'));

      const { getPath } = await import('../../src/core/store.js');
      const result = await getPath('mylib', 'abc123');

      expect(result).toBeNull();
    });
  });

  describe('absorb', () => {
    it('should move directory to store', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.rename.mockResolvedValue(undefined);

      const { absorb } = await import('../../src/core/store.js');
      const result = await absorb('/source/lib', 'mylib', 'abc123');

      expect(result).toBe(path.join('/store', 'mylib', 'abc123'));
      expect(fsMock.rename).toHaveBeenCalledWith(
        '/source/lib',
        path.join('/store', 'mylib', 'abc123')
      );
    });

    it('should throw when library already exists (ENOTEMPTY)', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      const err = new Error('ENOTEMPTY') as NodeJS.ErrnoException;
      err.code = 'ENOTEMPTY';
      fsMock.rename.mockRejectedValue(err);

      const { absorb } = await import('../../src/core/store.js');

      await expect(absorb('/source/lib', 'mylib', 'abc123')).rejects.toThrow('库已存在于 Store 中');
    });

    it('should throw when library already exists (EEXIST)', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      const err = new Error('EEXIST') as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      fsMock.rename.mockRejectedValue(err);

      const { absorb } = await import('../../src/core/store.js');

      await expect(absorb('/source/lib', 'mylib', 'abc123')).rejects.toThrow('库已存在于 Store 中');
    });

    it('should rethrow other errors', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      const err = new Error('Permission denied') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      fsMock.rename.mockRejectedValue(err);

      const { absorb } = await import('../../src/core/store.js');

      await expect(absorb('/source/lib', 'mylib', 'abc123')).rejects.toThrow('Permission denied');
    });
  });

  describe('remove', () => {
    it('should remove library directory', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.rm.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue([]);
      fsMock.rmdir.mockResolvedValue(undefined);

      const { remove } = await import('../../src/core/store.js');
      await remove('mylib', 'abc123');

      expect(fsMock.rm).toHaveBeenCalled();
    });

    it('should not remove parent dir if not empty', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.rm.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue(['other-commit']);

      const { remove } = await import('../../src/core/store.js');
      await remove('mylib', 'abc123');

      expect(fsMock.rmdir).not.toHaveBeenCalled();
    });
  });

  describe('listLibraries', () => {
    it('should list all libraries in store', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.readdir
        .mockResolvedValueOnce([
          { name: 'lib1', isDirectory: () => true },
          { name: 'lib2', isDirectory: () => true },
          { name: 'file.txt', isDirectory: () => false },
        ])
        .mockResolvedValueOnce([{ name: 'abc123', isDirectory: () => true }])
        .mockResolvedValueOnce([{ name: 'def456', isDirectory: () => true }]);

      const { listLibraries } = await import('../../src/core/store.js');
      const result = await listLibraries();

      expect(result).toHaveLength(2);
      expect(result[0].libName).toBe('lib1');
      expect(result[1].libName).toBe('lib2');
    });

    it('should return empty array when store is empty', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.readdir.mockRejectedValue(new Error('ENOENT'));

      const { listLibraries } = await import('../../src/core/store.js');
      const result = await listLibraries();

      expect(result).toEqual([]);
    });
  });

  describe('getPlatforms', () => {
    it('should list platform directories', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.readdir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'android', isDirectory: () => true },
        { name: '.git', isDirectory: () => true },
        { name: 'README.md', isDirectory: () => false },
      ]);

      const { getPlatforms } = await import('../../src/core/store.js');
      const result = await getPlatforms('mylib', 'abc123');

      expect(result).toEqual(['macOS', 'android']);
    });

    it('should return empty array when library does not exist', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.readdir.mockRejectedValue(new Error('ENOENT'));

      const { getPlatforms } = await import('../../src/core/store.js');
      const result = await getPlatforms('mylib', 'abc123');

      expect(result).toEqual([]);
    });
  });

  describe('ensureStoreDir', () => {
    it('should create store directory', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);

      const { ensureStoreDir } = await import('../../src/core/store.js');
      await ensureStoreDir();

      expect(fsMock.mkdir).toHaveBeenCalledWith('/store', { recursive: true });
    });
  });
});
