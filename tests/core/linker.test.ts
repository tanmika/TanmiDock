import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    lstat: vi.fn(),
    stat: vi.fn(),
    symlink: vi.fn(),
    readlink: vi.fn(),
    unlink: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    rename: vi.fn(),
    readdir: vi.fn(),
    access: vi.fn(),
  },
}));

// Mock platform
vi.mock('../../src/core/platform.js', () => ({
  isWindows: vi.fn(() => false),
  KNOWN_PLATFORM_VALUES: ['macOS', 'macOS-asan', 'Win', 'iOS', 'iOS-asan', 'android', 'android-asan', 'android-hwasan', 'ubuntu', 'wasm', 'ohos'],
}));

// Mock fs-utils
vi.mock('../../src/utils/fs-utils.js', () => ({
  copyDir: vi.fn(),
}));

describe('linker', () => {
  let fsMock: {
    lstat: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    symlink: ReturnType<typeof vi.fn>;
    readlink: ReturnType<typeof vi.fn>;
    unlink: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
    rm: ReturnType<typeof vi.fn>;
    rename: ReturnType<typeof vi.fn>;
    readdir: ReturnType<typeof vi.fn>;
    access: ReturnType<typeof vi.fn>;
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

  describe('linkLibrary', () => {
    it('should link single platform directly', async () => {
      const { linkLibrary } = await import('../../src/core/linker.js');

      // Mock: path doesn't exist
      fsMock.lstat.mockRejectedValue({ code: 'ENOENT' });
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.symlink.mockResolvedValue(undefined);

      await linkLibrary(
        '/project/3rdparty/mylib',
        '/store',
        'mylib',
        'abc123',
        ['macOS']
      );

      // Should create symlink to single platform
      expect(fsMock.symlink).toHaveBeenCalledWith(
        path.join('/store', 'mylib', 'abc123', 'macOS'),
        '/project/3rdparty/mylib',
        'dir'
      );
    });

    it('should throw error when no platforms provided', async () => {
      const { linkLibrary } = await import('../../src/core/linker.js');

      await expect(
        linkLibrary('/project/3rdparty/mylib', '/store', 'mylib', 'abc123', [])
      ).rejects.toThrow('至少需要一个平台');
    });

    it('should call linkMultiPlatform for multiple platforms', async () => {
      const { linkLibrary } = await import('../../src/core/linker.js');

      // Mock: setup for multi-platform linking
      fsMock.rm.mockResolvedValue(undefined);
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.symlink.mockResolvedValue(undefined);
      fsMock.lstat.mockRejectedValue({ code: 'ENOENT' }); // isSymlink returns false
      fsMock.access.mockResolvedValue(undefined);

      // Mock readdir to return platform dirs and shared content
      fsMock.readdir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'dependencies', isDirectory: () => true },
        { name: 'CMakeLists.txt', isDirectory: () => false },
      ]);

      await linkLibrary(
        '/project/3rdparty/mylib',
        '/store',
        'mylib',
        'abc123',
        ['macOS', 'iOS']
      );

      // Should create real directory and symlinks inside
      expect(fsMock.rm).toHaveBeenCalled();
      expect(fsMock.mkdir).toHaveBeenCalled();
      expect(fsMock.symlink).toHaveBeenCalled();
    });
  });

  describe('linkMultiPlatform', () => {
    it('should create directory with platform and shared content links', async () => {
      const { linkMultiPlatform } = await import('../../src/core/linker.js');

      fsMock.rm.mockResolvedValue(undefined);
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.symlink.mockResolvedValue(undefined);
      fsMock.lstat.mockRejectedValue({ code: 'ENOENT' });
      fsMock.access.mockResolvedValue(undefined);

      // Mock readdir to return platform dirs and shared content
      fsMock.readdir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'iOS', isDirectory: () => true },
        { name: 'dependencies', isDirectory: () => true },
        { name: 'CMakeLists.txt', isDirectory: () => false },
      ]);

      await linkMultiPlatform(
        '/project/3rdparty/mylib',
        '/store',
        'mylib',
        'abc123',
        ['macOS', 'iOS']
      );

      // Should have created multiple symlinks (macOS, iOS in primary, dependencies, CMakeLists.txt, iOS again from step 4)
      expect(fsMock.symlink.mock.calls.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('getPathStatus', () => {
    it('should return linked for correct symlink', async () => {
      const { getPathStatus } = await import('../../src/core/linker.js');

      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => true, isDirectory: () => false });
      fsMock.readlink.mockResolvedValue('/store/mylib/abc123/macOS');

      const status = await getPathStatus(
        '/project/3rdparty/mylib',
        '/store/mylib/abc123/macOS'
      );

      expect(status).toBe('linked');
    });

    it('should return wrong_link for incorrect symlink', async () => {
      const { getPathStatus } = await import('../../src/core/linker.js');

      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => true, isDirectory: () => false });
      fsMock.readlink.mockResolvedValue('/store/mylib/abc123/iOS');

      const status = await getPathStatus(
        '/project/3rdparty/mylib',
        '/store/mylib/abc123/macOS'
      );

      expect(status).toBe('wrong_link');
    });

    it('should return directory for regular directory', async () => {
      const { getPathStatus } = await import('../../src/core/linker.js');

      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => true });

      const status = await getPathStatus(
        '/project/3rdparty/mylib',
        '/store/mylib/abc123/macOS'
      );

      expect(status).toBe('directory');
    });

    it('should return missing for non-existent path', async () => {
      const { getPathStatus } = await import('../../src/core/linker.js');

      fsMock.lstat.mockRejectedValue({ code: 'ENOENT' });

      const status = await getPathStatus(
        '/project/3rdparty/mylib',
        '/store/mylib/abc123/macOS'
      );

      expect(status).toBe('missing');
    });
  });
});
