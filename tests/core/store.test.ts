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
    it('should return correct path with platform', async () => {
      const { getLibraryPath } = await import('../../src/core/store.js');
      const result = getLibraryPath('/store', 'mylib', 'abc123', 'macOS');

      expect(result).toBe(path.join('/store', 'mylib', 'abc123', 'macOS'));
    });

    it('should return correct path for different platforms', async () => {
      const { getLibraryPath } = await import('../../src/core/store.js');

      expect(getLibraryPath('/store', 'mylib', 'abc123', 'iOS')).toBe(
        path.join('/store', 'mylib', 'abc123', 'iOS')
      );
      expect(getLibraryPath('/store', 'mylib', 'abc123', 'android')).toBe(
        path.join('/store', 'mylib', 'abc123', 'android')
      );
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
      const result = await exists('mylib', 'abc123', 'macOS');

      expect(result).toBe(true);
      expect(fsMock.access).toHaveBeenCalledWith(path.join('/store', 'mylib', 'abc123', 'macOS'));
    });

    it('should return false when library does not exist', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.access.mockRejectedValue(new Error('ENOENT'));

      const { exists } = await import('../../src/core/store.js');
      const result = await exists('mylib', 'abc123', 'macOS');

      expect(result).toBe(false);
    });
  });

  describe('getPath', () => {
    it('should return path when library exists', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.access.mockResolvedValue(undefined);

      const { getPath } = await import('../../src/core/store.js');
      const result = await getPath('mylib', 'abc123', 'macOS');

      expect(result).toBe(path.join('/store', 'mylib', 'abc123', 'macOS'));
    });

    it('should return null when library does not exist', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.access.mockRejectedValue(new Error('ENOENT'));

      const { getPath } = await import('../../src/core/store.js');
      const result = await getPath('mylib', 'abc123', 'macOS');

      expect(result).toBeNull();
    });
  });

  describe('absorb', () => {
    it('should move directory to store with platform', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.rename.mockResolvedValue(undefined);

      const { absorb } = await import('../../src/core/store.js');
      const result = await absorb('/source/lib', 'mylib', 'abc123', 'macOS');

      expect(result).toBe(path.join('/store', 'mylib', 'abc123', 'macOS'));
      expect(fsMock.rename).toHaveBeenCalledWith(
        '/source/lib',
        path.join('/store', 'mylib', 'abc123', 'macOS')
      );
    });

    it('should throw when library already exists (ENOTEMPTY)', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      const err = new Error('ENOTEMPTY') as NodeJS.ErrnoException;
      err.code = 'ENOTEMPTY';
      fsMock.rename.mockRejectedValue(err);

      const { absorb } = await import('../../src/core/store.js');

      await expect(absorb('/source/lib', 'mylib', 'abc123', 'macOS')).rejects.toThrow('库已存在于 Store 中');
    });

    it('should throw when library already exists (EEXIST)', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      const err = new Error('EEXIST') as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      fsMock.rename.mockRejectedValue(err);

      const { absorb } = await import('../../src/core/store.js');

      await expect(absorb('/source/lib', 'mylib', 'abc123', 'macOS')).rejects.toThrow('库已存在于 Store 中');
    });

    it('should rethrow other errors', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      const err = new Error('Permission denied') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      fsMock.rename.mockRejectedValue(err);

      const { absorb } = await import('../../src/core/store.js');

      await expect(absorb('/source/lib', 'mylib', 'abc123', 'macOS')).rejects.toThrow('Permission denied');
    });
  });

  describe('remove', () => {
    it('should remove library directory with platform', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.rm.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue([]);
      fsMock.rmdir.mockResolvedValue(undefined);

      const { remove } = await import('../../src/core/store.js');
      await remove('mylib', 'abc123', 'macOS');

      expect(fsMock.rm).toHaveBeenCalledWith(
        path.join('/store', 'mylib', 'abc123', 'macOS'),
        { recursive: true, force: true }
      );
    });

    it('should not remove parent dir if not empty', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.rm.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue(['other-platform']);

      const { remove } = await import('../../src/core/store.js');
      await remove('mylib', 'abc123', 'macOS');

      expect(fsMock.rmdir).not.toHaveBeenCalled();
    });
  });

  describe('listLibraries', () => {
    it('should list all libraries in store with platform', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.readdir
        .mockResolvedValueOnce([
          { name: 'lib1', isDirectory: () => true },
          { name: 'lib2', isDirectory: () => true },
          { name: 'file.txt', isDirectory: () => false },
        ])
        .mockResolvedValueOnce([{ name: 'abc123', isDirectory: () => true }])
        .mockResolvedValueOnce([{ name: 'macOS', isDirectory: () => true }])
        .mockResolvedValueOnce([{ name: 'def456', isDirectory: () => true }])
        .mockResolvedValueOnce([{ name: 'iOS', isDirectory: () => true }]);

      const { listLibraries } = await import('../../src/core/store.js');
      const result = await listLibraries();

      expect(result).toHaveLength(2);
      expect(result[0].libName).toBe('lib1');
      expect(result[0].commit).toBe('abc123');
      expect(result[0].platform).toBe('macOS');
      expect(result[1].libName).toBe('lib2');
      expect(result[1].commit).toBe('def456');
      expect(result[1].platform).toBe('iOS');
    });

    it('should return empty array when store is empty', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.readdir.mockRejectedValue(new Error('ENOENT'));

      const { listLibraries } = await import('../../src/core/store.js');
      const result = await listLibraries();

      expect(result).toEqual([]);
    });

    it('should list same lib:commit with different platforms', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.readdir
        .mockResolvedValueOnce([{ name: 'lib1', isDirectory: () => true }])
        .mockResolvedValueOnce([{ name: 'abc123', isDirectory: () => true }])
        .mockResolvedValueOnce([
          { name: 'macOS', isDirectory: () => true },
          { name: 'iOS', isDirectory: () => true },
        ]);

      const { listLibraries } = await import('../../src/core/store.js');
      const result = await listLibraries();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        libName: 'lib1',
        commit: 'abc123',
        platform: 'macOS',
        path: path.join('/store', 'lib1', 'abc123', 'macOS'),
      });
      expect(result[1]).toEqual({
        libName: 'lib1',
        commit: 'abc123',
        platform: 'iOS',
        path: path.join('/store', 'lib1', 'abc123', 'iOS'),
      });
    });
  });

  describe('validatePlatform', () => {
    it('should return true when platform has content', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.access.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue(['macOS', 'dependencies', 'CMakeLists.txt']);

      const { validatePlatform } = await import('../../src/core/store.js');
      const result = await validatePlatform('mylib', 'abc123', 'macOS');

      expect(result).toBe(true);
    });

    it('should return false when platform is empty', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.access.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue([]);

      const { validatePlatform } = await import('../../src/core/store.js');
      const result = await validatePlatform('mylib', 'abc123', 'macOS');

      expect(result).toBe(false);
    });

    it('should return false when platform only has hidden files', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.access.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue(['.git', '.DS_Store']);

      const { validatePlatform } = await import('../../src/core/store.js');
      const result = await validatePlatform('mylib', 'abc123', 'macOS');

      expect(result).toBe(false);
    });

    it('should return false when platform does not exist', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.access.mockRejectedValue(new Error('ENOENT'));

      const { validatePlatform } = await import('../../src/core/store.js');
      const result = await validatePlatform('mylib', 'abc123', 'macOS');

      expect(result).toBe(false);
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
