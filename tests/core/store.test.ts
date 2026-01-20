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
    lstat: vi.fn(),
    copyFile: vi.fn(),
  },
}));

// Mock logger
vi.mock('../../src/utils/logger.js', () => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
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
    lstat: ReturnType<typeof vi.fn>;
    copyFile: ReturnType<typeof vi.fn>;
  };
  let configMock: { getStorePath: ReturnType<typeof vi.fn> };
  let loggerMock: { warn: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.resetModules();
    const fs = await import('fs/promises');
    fsMock = fs.default as typeof fsMock;
    Object.values(fsMock).forEach((fn) => fn.mockReset());

    const config = await import('../../src/core/config.js');
    configMock = config as typeof configMock;
    configMock.getStorePath.mockReset();

    const logger = await import('../../src/utils/logger.js');
    loggerMock = logger as typeof loggerMock;
    loggerMock.warn.mockReset();
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

  describe('absorbLib', () => {
    it('should move platform directories to Store', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.rename.mockResolvedValue(undefined);
      // Mock access 抛出错误表示目录不存在
      fsMock.access.mockRejectedValue(new Error('ENOENT'));

      // Mock readdir 返回平台目录和共享文件
      fsMock.readdir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'Win', isDirectory: () => true },
        { name: 'CMakeLists.txt', isDirectory: () => false },
      ]);

      const { absorbLib } = await import('../../src/core/store.js');
      const result = await absorbLib('/tmp/libtest', ['macOS', 'Win'], 'libtest', 'abc123');

      // 验证平台目录移动
      expect(result.platformPaths['macOS']).toBe(path.join('/store', 'libtest', 'abc123', 'macOS'));
      expect(result.platformPaths['Win']).toBe(path.join('/store', 'libtest', 'abc123', 'Win'));
      expect(result.skippedPlatforms).toEqual([]);

      // 验证 rename 被调用
      expect(fsMock.rename).toHaveBeenCalledWith(
        '/tmp/libtest/macOS',
        path.join('/store', 'libtest', 'abc123', 'macOS')
      );
      expect(fsMock.rename).toHaveBeenCalledWith(
        '/tmp/libtest/Win',
        path.join('/store', 'libtest', 'abc123', 'Win')
      );
    });

    it('should move shared files to _shared directory', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.rename.mockResolvedValue(undefined);
      // Mock access 抛出错误表示目录/文件不存在
      fsMock.access.mockRejectedValue(new Error('ENOENT'));

      // Mock readdir 返回平台目录和共享文件
      fsMock.readdir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'CMakeLists.txt', isDirectory: () => false },
        { name: 'include', isDirectory: () => true },
        { name: 'README.md', isDirectory: () => false },
      ]);

      const { absorbLib } = await import('../../src/core/store.js');
      const result = await absorbLib('/tmp/libtest', ['macOS'], 'libtest', 'abc123');

      // 验证 sharedPath
      expect(result.sharedPath).toBe(path.join('/store', 'libtest', 'abc123', '_shared'));

      // 验证共享文件被移动到 _shared
      expect(fsMock.rename).toHaveBeenCalledWith(
        '/tmp/libtest/CMakeLists.txt',
        path.join('/store', 'libtest', 'abc123', '_shared', 'CMakeLists.txt')
      );
      expect(fsMock.rename).toHaveBeenCalledWith(
        '/tmp/libtest/include',
        path.join('/store', 'libtest', 'abc123', '_shared', 'include')
      );
      expect(fsMock.rename).toHaveBeenCalledWith(
        '/tmp/libtest/README.md',
        path.join('/store', 'libtest', 'abc123', '_shared', 'README.md')
      );
    });

    it('should only absorb selected platforms', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.rename.mockResolvedValue(undefined);
      // Mock access 抛出错误表示目录不存在
      fsMock.access.mockRejectedValue(new Error('ENOENT'));

      // Mock readdir 返回多个平台目录
      fsMock.readdir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'macOS-asan', isDirectory: () => true },
        { name: 'Win', isDirectory: () => true },
        { name: 'iOS', isDirectory: () => true },
      ]);

      const { absorbLib } = await import('../../src/core/store.js');
      const result = await absorbLib('/tmp/libtest', ['macOS'], 'libtest', 'abc123');

      // 验证只有选择的平台被吸收
      expect(result.platformPaths['macOS']).toBeDefined();
      expect(result.platformPaths['Win']).toBeUndefined();
      expect(result.platformPaths['iOS']).toBeUndefined();
      expect(result.platformPaths['macOS-asan']).toBeUndefined();

      // 验证只有选中的平台被移动（macOS）
      const platformRenameCalls = fsMock.rename.mock.calls.filter(
        (call: string[]) => !call[0].includes('_shared') && !call[1].includes('_shared')
      );
      expect(platformRenameCalls).toHaveLength(1);
    });

    it('should skip platform directory when already exists', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);

      fsMock.readdir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'Win', isDirectory: () => true },
      ]);

      // Mock access: macOS 已存在，Win 不存在
      fsMock.access.mockImplementation((targetPath: string) => {
        if (targetPath.endsWith('macOS')) {
          return Promise.resolve(); // 已存在
        }
        return Promise.reject(new Error('ENOENT')); // 不存在
      });
      fsMock.rename.mockResolvedValue(undefined);

      const { absorbLib } = await import('../../src/core/store.js');
      const result = await absorbLib('/tmp/libtest', ['macOS', 'Win'], 'libtest', 'abc123');

      // 验证 macOS 被跳过，Win 被移动
      expect(result.skippedPlatforms).toEqual(['macOS']);
      expect(result.platformPaths['macOS']).toBeUndefined();
      expect(result.platformPaths['Win']).toBeDefined();
    });

    it('should skip shared file when already exists', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);

      fsMock.readdir.mockResolvedValue([
        { name: 'README.md', isDirectory: () => false },
        { name: 'LICENSE', isDirectory: () => false },
      ]);

      // Mock access: README.md 已存在，LICENSE 不存在
      fsMock.access.mockImplementation((targetPath: string) => {
        if (targetPath.endsWith('README.md')) {
          return Promise.resolve(); // 已存在
        }
        return Promise.reject(new Error('ENOENT')); // 不存在
      });
      fsMock.rename.mockResolvedValue(undefined);

      const { absorbLib } = await import('../../src/core/store.js');
      await absorbLib('/tmp/libtest', [], 'libtest', 'abc123');

      // 验证只有 LICENSE 被移动（README.md 被跳过）
      expect(fsMock.rename).toHaveBeenCalledWith(
        '/tmp/libtest/LICENSE',
        path.join('/store', 'libtest', 'abc123', '_shared', 'LICENSE')
      );
      expect(fsMock.rename).not.toHaveBeenCalledWith(
        '/tmp/libtest/README.md',
        expect.anything()
      );
    });

    it('should create base directory and _shared directory', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.rename.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue([]);

      const { absorbLib } = await import('../../src/core/store.js');
      await absorbLib('/tmp/libtest', [], 'libtest', 'abc123');

      // 验证基础目录和 _shared 目录被创建
      expect(fsMock.mkdir).toHaveBeenCalledWith(
        path.join('/store', 'libtest', 'abc123'),
        { recursive: true }
      );
      expect(fsMock.mkdir).toHaveBeenCalledWith(
        path.join('/store', 'libtest', 'abc123', '_shared'),
        { recursive: true }
      );
    });

    it('should handle empty library directory (no shared files)', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.rename.mockResolvedValue(undefined);
      // Mock access 抛出错误表示目录不存在
      fsMock.access.mockRejectedValue(new Error('ENOENT'));
      fsMock.readdir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
      ]);

      const { absorbLib } = await import('../../src/core/store.js');
      const result = await absorbLib('/tmp/libtest', ['macOS'], 'libtest', 'abc123');

      // 验证 _shared 目录仍然存在（即使为空）
      expect(result.sharedPath).toBe(path.join('/store', 'libtest', 'abc123', '_shared'));
      expect(result.platformPaths['macOS']).toBeDefined();
      expect(result.skippedPlatforms).toEqual([]);
    });

    it('should rollback moved files on failure', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.access.mockRejectedValue(new Error('ENOENT')); // 目标不存在

      // 模拟目录内容：macOS, Win, shared.txt
      fsMock.readdir.mockResolvedValue([
        { name: 'macOS', isDirectory: () => true },
        { name: 'Win', isDirectory: () => true },
        { name: 'shared.txt', isDirectory: () => false },
      ]);

      // 跟踪 rename 调用
      const renameCalls: Array<{ from: string; to: string }> = [];
      fsMock.rename.mockImplementation(async (from: string, to: string) => {
        renameCalls.push({ from, to });
        // macOS 成功，Win 失败
        if (to.includes('Win')) {
          throw new Error('EACCES: permission denied');
        }
      });

      const { absorbLib } = await import('../../src/core/store.js');

      // 应该抛出错误
      await expect(absorbLib('/tmp/libtest', ['macOS', 'Win'], 'libtest', 'abc123'))
        .rejects.toThrow('EACCES');

      // 验证回滚被调用（macOS 被移回）
      const rollbackCall = renameCalls.find(
        c => c.from === path.join('/store', 'libtest', 'abc123', 'macOS') &&
             c.to === '/tmp/libtest/macOS'
      );
      expect(rollbackCall).toBeDefined();
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

    it('should remove commit dir when only _shared remains', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.rm.mockResolvedValue(undefined);
      // 删除平台目录后，只剩 _shared
      fsMock.readdir
        .mockResolvedValueOnce(['_shared'])  // commit 目录只剩 _shared
        .mockResolvedValueOnce([]);          // lib 目录为空

      const { remove } = await import('../../src/core/store.js');
      await remove('mylib', 'abc123', 'macOS');

      // 应该删除整个 commit 目录
      expect(fsMock.rm).toHaveBeenCalledWith(
        path.join('/store', 'mylib', 'abc123'),
        { recursive: true, force: true }
      );
    });

    it('should remove entire commit dir for general platform', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.rm.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue([]);  // lib 目录为空

      const { remove } = await import('../../src/core/store.js');
      await remove('mylib', 'abc123', 'general');

      // general 类型应该直接删除 commit 目录
      expect(fsMock.rm).toHaveBeenCalledWith(
        path.join('/store', 'mylib', 'abc123'),
        { recursive: true, force: true }
      );
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

  describe('getCommitPath', () => {
    it('should return correct commit path', async () => {
      const { getCommitPath } = await import('../../src/core/store.js');
      const result = getCommitPath('/store', 'mylib', 'abc123');

      expect(result).toBe(path.join('/store', 'mylib', 'abc123'));
    });
  });

  describe('detectStoreVersion', () => {
    it('should return v0.6 when _shared directory exists', async () => {
      fsMock.access.mockImplementation((p: string) => {
        // commitPath 存在
        if (p === '/store/mylib/abc123') return Promise.resolve();
        // _shared 存在
        if (p.endsWith('_shared')) return Promise.resolve();
        return Promise.reject(new Error('ENOENT'));
      });

      const { detectStoreVersion } = await import('../../src/core/store.js');
      const result = await detectStoreVersion('/store/mylib/abc123');

      expect(result).toBe('v0.6');
    });

    it('should return v0.5 when double-layer platform directory exists', async () => {
      fsMock.access.mockImplementation((p: string) => {
        // commitPath 存在
        if (p === '/store/mylib/abc123') return Promise.resolve();
        // _shared 不存在
        if (p.endsWith('_shared')) return Promise.reject(new Error('ENOENT'));
        // macOS/macOS 存在 (双层目录)
        if (p.endsWith(path.join('macOS', 'macOS'))) return Promise.resolve();
        return Promise.reject(new Error('ENOENT'));
      });

      const { detectStoreVersion } = await import('../../src/core/store.js');
      const result = await detectStoreVersion('/store/mylib/abc123');

      expect(result).toBe('v0.5');
    });

    it('should return unknown when commit directory does not exist', async () => {
      fsMock.access.mockRejectedValue(new Error('ENOENT'));

      const { detectStoreVersion } = await import('../../src/core/store.js');
      const result = await detectStoreVersion('/store/mylib/abc123');

      expect(result).toBe('unknown');
    });

    it('should return unknown when neither v0.5 nor v0.6 structure detected', async () => {
      fsMock.access.mockImplementation((p: string) => {
        // commitPath 存在
        if (p === '/store/mylib/abc123') return Promise.resolve();
        // 其他都不存在
        return Promise.reject(new Error('ENOENT'));
      });

      const { detectStoreVersion } = await import('../../src/core/store.js');
      const result = await detectStoreVersion('/store/mylib/abc123');

      expect(result).toBe('unknown');
    });
  });

  describe('ensureCompatibleStore', () => {
    it('should pass when commit directory does not exist', async () => {
      fsMock.access.mockRejectedValue(new Error('ENOENT'));

      const { ensureCompatibleStore } = await import('../../src/core/store.js');

      // 不应该抛出错误
      await expect(ensureCompatibleStore('/store', 'mylib', 'abc123')).resolves.toBeUndefined();
    });

    it('should pass when v0.6 structure detected', async () => {
      fsMock.access.mockImplementation((p: string) => {
        if (p.endsWith('_shared')) return Promise.resolve();
        return Promise.resolve(); // commit 目录存在
      });

      const { ensureCompatibleStore } = await import('../../src/core/store.js');

      await expect(ensureCompatibleStore('/store', 'mylib', 'abc123')).resolves.toBeUndefined();
    });

    it('should throw when v0.5 structure detected', async () => {
      fsMock.access.mockImplementation((p: string) => {
        // commit 目录存在
        if (p === path.join('/store', 'mylib', 'abc123')) return Promise.resolve();
        // _shared 不存在
        if (p.endsWith('_shared')) return Promise.reject(new Error('ENOENT'));
        // macOS/macOS 存在 (双层目录)
        if (p.endsWith(path.join('macOS', 'macOS'))) return Promise.resolve();
        return Promise.reject(new Error('ENOENT'));
      });

      const { ensureCompatibleStore } = await import('../../src/core/store.js');

      await expect(ensureCompatibleStore('/store', 'mylib', 'abc123')).rejects.toThrow('Store 结构不兼容');
    });

    it('should include delete command hint in error message', async () => {
      fsMock.access.mockImplementation((p: string) => {
        if (p === path.join('/store', 'mylib', 'abc123')) return Promise.resolve();
        if (p.endsWith('_shared')) return Promise.reject(new Error('ENOENT'));
        if (p.endsWith(path.join('macOS', 'macOS'))) return Promise.resolve();
        return Promise.reject(new Error('ENOENT'));
      });

      const { ensureCompatibleStore } = await import('../../src/core/store.js');

      try {
        await ensureCompatibleStore('/store', 'mylib', 'abc123');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as Error).message).toContain('rm -rf');
        expect((err as Error).message).toContain('tanmi-dock link');
      }
    });
  });

  describe('checkPlatformCompleteness', () => {
    it('should return existing platforms when they exist in Store', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      // Mock access: macOS 存在，Win 存在
      fsMock.access.mockResolvedValue(undefined);

      const { checkPlatformCompleteness } = await import('../../src/core/store.js');
      const result = await checkPlatformCompleteness('mylib', 'abc123', ['macOS', 'Win']);

      expect(result.existing).toEqual(['macOS', 'Win']);
      expect(result.missing).toEqual([]);
    });

    it('should return missing platforms when they do not exist in Store', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      // Mock access: 所有平台都不存在
      fsMock.access.mockRejectedValue(new Error('ENOENT'));

      const { checkPlatformCompleteness } = await import('../../src/core/store.js');
      const result = await checkPlatformCompleteness('mylib', 'abc123', ['macOS', 'Win']);

      expect(result.existing).toEqual([]);
      expect(result.missing).toEqual(['macOS', 'Win']);
    });

    it('should return empty arrays when platforms is empty', async () => {
      configMock.getStorePath.mockResolvedValue('/store');

      const { checkPlatformCompleteness } = await import('../../src/core/store.js');
      const result = await checkPlatformCompleteness('mylib', 'abc123', []);

      expect(result.existing).toEqual([]);
      expect(result.missing).toEqual([]);
      // access 不应该被调用
      expect(fsMock.access).not.toHaveBeenCalled();
    });

    it('should categorize mixed existing and missing platforms', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      // Mock access: macOS 存在，Win 不存在，iOS 存在
      fsMock.access.mockImplementation((targetPath: string) => {
        if (targetPath.endsWith('macOS') || targetPath.endsWith('iOS')) {
          return Promise.resolve();
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const { checkPlatformCompleteness } = await import('../../src/core/store.js');
      const result = await checkPlatformCompleteness('mylib', 'abc123', ['macOS', 'Win', 'iOS']);

      expect(result.existing).toEqual(['macOS', 'iOS']);
      expect(result.missing).toEqual(['Win']);
    });

    it('should return all missing when commit path does not exist', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      // 所有 access 都失败（commit 路径不存在）
      fsMock.access.mockRejectedValue(new Error('ENOENT'));

      const { checkPlatformCompleteness } = await import('../../src/core/store.js');
      const result = await checkPlatformCompleteness('nonexistent', 'abc123', ['macOS', 'Win']);

      expect(result.existing).toEqual([]);
      expect(result.missing).toEqual(['macOS', 'Win']);
    });
  });

  describe('absorbGeneral', () => {
    it('should move libDir to _shared in Store', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      // _shared 不存在
      fsMock.access.mockRejectedValue(new Error('ENOENT'));
      // libDir 没有嵌套 _shared
      fsMock.lstat.mockRejectedValue(new Error('ENOENT'));
      fsMock.rename.mockResolvedValue(undefined);

      const { absorbGeneral } = await import('../../src/core/store.js');
      const result = await absorbGeneral('/tmp/download/mylib', 'mylib', 'abc123');

      expect(result).toBe(path.join('/store', 'mylib', 'abc123', '_shared'));
      expect(fsMock.mkdir).toHaveBeenCalledWith(
        path.join('/store', 'mylib', 'abc123'),
        { recursive: true }
      );
      expect(fsMock.rename).toHaveBeenCalledWith(
        '/tmp/download/mylib',
        path.join('/store', 'mylib', 'abc123', '_shared')
      );
    });

    it('should skip when _shared already exists', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      // _shared 已存在
      fsMock.access.mockResolvedValue(undefined);

      const { absorbGeneral } = await import('../../src/core/store.js');
      const result = await absorbGeneral('/tmp/download/mylib', 'mylib', 'abc123');

      expect(result).toBe(path.join('/store', 'mylib', 'abc123', '_shared'));
      // 不应该调用 rename
      expect(fsMock.rename).not.toHaveBeenCalled();
    });

    it('should handle nested _shared to prevent double nesting', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      // _shared 不存在
      fsMock.access.mockRejectedValue(new Error('ENOENT'));
      // libDir 包含嵌套 _shared 子目录
      fsMock.lstat.mockResolvedValue({ isDirectory: () => true });
      fsMock.rename.mockResolvedValue(undefined);
      fsMock.rm.mockResolvedValue(undefined);

      const { absorbGeneral } = await import('../../src/core/store.js');
      const result = await absorbGeneral('/tmp/download/mylib', 'mylib', 'abc123');

      expect(result).toBe(path.join('/store', 'mylib', 'abc123', '_shared'));
      // 应该移动内层 _shared 而不是整个 libDir
      expect(fsMock.rename).toHaveBeenCalledWith(
        path.join('/tmp/download/mylib', '_shared'),
        path.join('/store', 'mylib', 'abc123', '_shared')
      );
      // 应该输出警告
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining('检测到源目录包含 _shared 子目录')
      );
      // 应该清理残留的空 libDir
      expect(fsMock.rm).toHaveBeenCalledWith(
        '/tmp/download/mylib',
        { recursive: true, force: true }
      );
    });

    it('should not treat file named _shared as nested directory', async () => {
      configMock.getStorePath.mockResolvedValue('/store');
      fsMock.mkdir.mockResolvedValue(undefined);
      // _shared 不存在
      fsMock.access.mockRejectedValue(new Error('ENOENT'));
      // libDir/_shared 是文件不是目录
      fsMock.lstat.mockResolvedValue({ isDirectory: () => false });
      fsMock.rename.mockResolvedValue(undefined);

      const { absorbGeneral } = await import('../../src/core/store.js');
      const result = await absorbGeneral('/tmp/download/mylib', 'mylib', 'abc123');

      expect(result).toBe(path.join('/store', 'mylib', 'abc123', '_shared'));
      // 应该移动整个 libDir（正常流程）
      expect(fsMock.rename).toHaveBeenCalledWith(
        '/tmp/download/mylib',
        path.join('/store', 'mylib', 'abc123', '_shared')
      );
      // 不应该输出嵌套警告
      expect(loggerMock.warn).not.toHaveBeenCalled();
    });
  });
});
