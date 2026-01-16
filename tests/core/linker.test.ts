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
    copyFile: vi.fn(),
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

  describe('linkLib', () => {
    let copyDirMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const fsUtils = await import('../../src/utils/fs-utils.js');
      copyDirMock = fsUtils.copyDir as ReturnType<typeof vi.fn>;
      copyDirMock.mockReset();
    });

    it('should create symlinks for platform directories', async () => {
      const { linkLib } = await import('../../src/core/linker.js');

      fsMock.rm.mockResolvedValue(undefined);
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.access.mockResolvedValue(undefined);
      fsMock.symlink.mockResolvedValue(undefined);
      copyDirMock.mockResolvedValue(undefined);

      await linkLib(
        '/project/3rdParty/libtest',
        '/store/libtest/abc123',
        ['macOS', 'Win']
      );

      // 验证平台目录符号链接被创建
      expect(fsMock.symlink).toHaveBeenCalledWith(
        path.join('/store/libtest/abc123', 'macOS'),
        path.join('/project/3rdParty/libtest', 'macOS'),
        'dir'
      );
      expect(fsMock.symlink).toHaveBeenCalledWith(
        path.join('/store/libtest/abc123', 'Win'),
        path.join('/project/3rdParty/libtest', 'Win'),
        'dir'
      );
    });

    it('should copy shared files (not symlink) and symlink .git', async () => {
      const { linkLib } = await import('../../src/core/linker.js');

      fsMock.rm.mockResolvedValue(undefined);
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.access.mockResolvedValue(undefined);
      fsMock.symlink.mockResolvedValue(undefined);
      fsMock.copyFile.mockResolvedValue(undefined);
      copyDirMock.mockResolvedValue(undefined);
      // Mock readdir for _shared: 返回 .git 目录、其他目录和文件
      fsMock.readdir.mockResolvedValue([
        { name: '.git', isDirectory: () => true },
        { name: 'cmake', isDirectory: () => true },
        { name: 'config.json', isDirectory: () => false },
      ]);

      await linkLib(
        '/project/3rdParty/libtest',
        '/store/libtest/abc123',
        ['macOS']
      );

      // 验证 .git 目录被符号链接
      expect(fsMock.symlink).toHaveBeenCalledWith(
        path.join('/store/libtest/abc123', '_shared', '.git'),
        path.join('/project/3rdParty/libtest', '.git'),
        'dir'
      );
      // 验证其他目录被复制
      expect(copyDirMock).toHaveBeenCalledWith(
        path.join('/store/libtest/abc123', '_shared', 'cmake'),
        path.join('/project/3rdParty/libtest', 'cmake'),
        { preserveSymlinks: true }
      );
      // 验证文件被复制
      expect(fsMock.copyFile).toHaveBeenCalledWith(
        path.join('/store/libtest/abc123', '_shared', 'config.json'),
        path.join('/project/3rdParty/libtest', 'config.json')
      );
    });

    it('should skip non-existent platforms without error', async () => {
      const { linkLib } = await import('../../src/core/linker.js');

      fsMock.rm.mockResolvedValue(undefined);
      fsMock.mkdir.mockResolvedValue(undefined);
      // macOS 存在，Win 不存在
      fsMock.access
        .mockResolvedValueOnce(undefined) // macOS exists
        .mockRejectedValueOnce({ code: 'ENOENT' }) // Win doesn't exist
        .mockResolvedValueOnce(undefined); // _shared exists
      fsMock.symlink.mockResolvedValue(undefined);
      copyDirMock.mockResolvedValue(undefined);

      // 不应该抛出错误
      await expect(
        linkLib(
          '/project/3rdParty/libtest',
          '/store/libtest/abc123',
          ['macOS', 'Win']
        )
      ).resolves.not.toThrow();

      // 只有 macOS 被链接
      expect(fsMock.symlink).toHaveBeenCalledTimes(1);
      expect(fsMock.symlink).toHaveBeenCalledWith(
        path.join('/store/libtest/abc123', 'macOS'),
        path.join('/project/3rdParty/libtest', 'macOS'),
        'dir'
      );
    });

    it('should skip _shared copy when it does not exist', async () => {
      const { linkLib } = await import('../../src/core/linker.js');

      fsMock.rm.mockResolvedValue(undefined);
      fsMock.mkdir.mockResolvedValue(undefined);
      // 平台存在，_shared 不存在
      fsMock.access
        .mockResolvedValueOnce(undefined) // macOS exists
        .mockRejectedValueOnce({ code: 'ENOENT' }); // _shared doesn't exist
      fsMock.symlink.mockResolvedValue(undefined);
      copyDirMock.mockResolvedValue(undefined);

      await linkLib(
        '/project/3rdParty/libtest',
        '/store/libtest/abc123',
        ['macOS']
      );

      // _shared 不存在时不应调用 copyDir
      expect(copyDirMock).not.toHaveBeenCalled();
    });

    it('should clean up and recreate local directory', async () => {
      const { linkLib } = await import('../../src/core/linker.js');

      fsMock.rm.mockResolvedValue(undefined);
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.access.mockResolvedValue(undefined);
      fsMock.symlink.mockResolvedValue(undefined);
      copyDirMock.mockResolvedValue(undefined);

      await linkLib(
        '/project/3rdParty/libtest',
        '/store/libtest/abc123',
        ['macOS']
      );

      // 验证先删除再创建
      expect(fsMock.rm).toHaveBeenCalledWith(
        '/project/3rdParty/libtest',
        { recursive: true, force: true }
      );
      expect(fsMock.mkdir).toHaveBeenCalledWith(
        '/project/3rdParty/libtest',
        { recursive: true }
      );
    });

    it('should cleanup on symlink failure', async () => {
      const { linkLib } = await import('../../src/core/linker.js');

      fsMock.rm.mockResolvedValue(undefined);
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.access.mockResolvedValue(undefined);
      fsMock.symlink.mockRejectedValue(new Error('symlink failed'));
      copyDirMock.mockResolvedValue(undefined);

      await expect(
        linkLib(
          '/project/3rdParty/libtest',
          '/store/libtest/abc123',
          ['macOS']
        )
      ).rejects.toThrow('symlink failed');

      // 验证失败后清理
      expect(fsMock.rm).toHaveBeenCalledTimes(2);
      expect(fsMock.rm).toHaveBeenLastCalledWith(
        '/project/3rdParty/libtest',
        { recursive: true, force: true }
      );
    });

    it('should handle empty platforms array', async () => {
      const { linkLib } = await import('../../src/core/linker.js');

      fsMock.rm.mockResolvedValue(undefined);
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.access.mockResolvedValue(undefined);
      fsMock.symlink.mockResolvedValue(undefined);
      fsMock.copyFile.mockResolvedValue(undefined);
      copyDirMock.mockResolvedValue(undefined);
      // Mock readdir for _shared
      fsMock.readdir.mockResolvedValue([
        { name: 'config.json', isDirectory: () => false },
      ]);

      // 空平台列表应该正常执行（只处理 _shared）
      await expect(
        linkLib(
          '/project/3rdParty/libtest',
          '/store/libtest/abc123',
          []
        )
      ).resolves.not.toThrow();

      // 无平台，不创建平台符号链接（但 _shared 中的 .git 可能会创建）
      // 仍然处理 _shared 文件
      expect(fsMock.copyFile).toHaveBeenCalled();
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

  describe('linkGeneral', () => {
    it('should create symlink for entire directory', async () => {
      const { linkGeneral } = await import('../../src/core/linker.js');

      fsMock.rm.mockResolvedValue(undefined);
      fsMock.symlink.mockResolvedValue(undefined);

      await linkGeneral('/project/3rdparty/eigen', '/store/eigen/abc123/_shared');

      expect(fsMock.rm).toHaveBeenCalledWith(
        '/project/3rdparty/eigen',
        { recursive: true, force: true }
      );
      expect(fsMock.symlink).toHaveBeenCalledWith(
        '/store/eigen/abc123/_shared',
        '/project/3rdparty/eigen',
        'dir'
      );
    });

    it('should replace existing directory with symlink', async () => {
      const { linkGeneral } = await import('../../src/core/linker.js');

      fsMock.rm.mockResolvedValue(undefined);
      fsMock.symlink.mockResolvedValue(undefined);

      // 模拟已存在目录
      await linkGeneral('/project/3rdparty/eigen', '/store/eigen/abc123/_shared');

      // 应该先删除旧目录
      expect(fsMock.rm).toHaveBeenCalledWith(
        '/project/3rdparty/eigen',
        { recursive: true, force: true }
      );

      // 然后创建符号链接
      expect(fsMock.symlink).toHaveBeenCalledWith(
        '/store/eigen/abc123/_shared',
        '/project/3rdparty/eigen',
        'dir'
      );
    });

    it('should use junction on Windows', async () => {
      // 重新设置 mock 以使用 Windows
      vi.resetModules();

      // 临时修改 isWindows 返回值
      vi.doMock('../../src/core/platform.js', () => ({
        isWindows: vi.fn(() => true),
        KNOWN_PLATFORM_VALUES: ['macOS', 'macOS-asan', 'Win', 'iOS', 'iOS-asan', 'android', 'android-asan', 'android-hwasan', 'ubuntu', 'wasm', 'ohos'],
      }));

      const fs = await import('fs/promises');
      const fsMockWin = fs.default as typeof fsMock;
      fsMockWin.rm.mockResolvedValue(undefined);
      fsMockWin.symlink.mockResolvedValue(undefined);

      const { linkGeneral } = await import('../../src/core/linker.js');

      await linkGeneral('/project/3rdparty/eigen', '/store/eigen/abc123/_shared');

      expect(fsMockWin.symlink).toHaveBeenCalledWith(
        '/store/eigen/abc123/_shared',
        '/project/3rdparty/eigen',
        'junction'
      );
    });
  });
});
