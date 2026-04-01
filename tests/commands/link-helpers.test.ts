import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock 所有 link.ts 的依赖
vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
    copyFile: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    symlink: vi.fn(),
    unlink: vi.fn(),
    readlink: vi.fn(),
  },
}));
vi.mock('../../src/core/guard.js', () => ({
  ensureInitialized: vi.fn(),
}));
vi.mock('../../src/core/config.js', () => ({
  getStorePath: vi.fn(),
  getConfig: vi.fn(() => ({
    storePath: '/store',
    concurrency: 5,
    logLevel: 'info',
    proxy: undefined,
    unverifiedLocalStrategy: 'download',
    sharedSymlinkFolders: true,
  })),
  updateConfig: vi.fn(),
}));
vi.mock('../../src/utils/logger.js', () => ({
  setLogLevel: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  hint: vi.fn(),
  blank: vi.fn(),
  separator: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../src/core/parser.js', () => ({
  parseProjectDependencies: vi.fn(),
  getRelativeConfigPath: vi.fn(),
  parseCodepacDep: vi.fn(),
  extractActions: vi.fn(),
  parseActionCommand: vi.fn(),
  extractNestedDependencies: vi.fn(),
  normalizeProjectRoot: vi.fn(),
  findAllCodepacConfigs: vi.fn(),
  extractDependencies: vi.fn(),
}));
vi.mock('../../src/core/registry.js', () => ({
  getRegistry: vi.fn(),
}));
vi.mock('../../src/core/store.js', () => ({
  getStorePath: vi.fn(),
  getSize: vi.fn(),
  absorbLib: vi.fn(),
  captureIntegrity: vi.fn(),
  quickVerify: vi.fn(),
}));
vi.mock('../../src/core/linker.js', () => ({
  linkLib: vi.fn(),
  getPathStatus: vi.fn(),
}));
vi.mock('../../src/core/codepac.js', () => ({
  default: { download: vi.fn() },
  setProxyConfig: vi.fn(),
}));
vi.mock('../../src/core/platform.js', () => ({
  resolvePath: vi.fn(),
  getPlatformHelpText: vi.fn(),
  GENERAL_PLATFORM: 'general',
  SHARED_PLATFORM: '_shared',
  pathsEqual: vi.fn(),
  isSparseOnlyCommon: vi.fn(),
}));
vi.mock('../../src/core/transaction.js', () => ({
  Transaction: vi.fn(),
}));
vi.mock('../../src/utils/disk.js', () => ({
  formatSize: vi.fn(),
  checkDiskSpace: vi.fn(),
}));
vi.mock('../../src/utils/fs-utils.js', () => ({
  getDirSize: vi.fn(),
  getDirectoryIntegrity: vi.fn(),
}));
vi.mock('../../src/utils/progress.js', () => ({
  ProgressTracker: vi.fn(),
  DownloadMonitor: vi.fn(),
  MultiBarManager: vi.fn(),
}));
vi.mock('../../src/utils/git.js', () => ({
  verifyLocalCommit: vi.fn(),
}));
vi.mock('../../src/utils/global-lock.js', () => ({
  withGlobalLock: vi.fn(async (_path: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../src/utils/prompt.js', () => ({
  confirmAction: vi.fn(),
  selectPlatforms: vi.fn(),
  parsePlatformArgs: vi.fn(),
  selectOption: vi.fn(),
  selectOptionalConfigs: vi.fn(),
  PROMPT_CANCELLED: Symbol('PROMPT_CANCELLED'),
}));
vi.mock('p-limit', () => ({
  default: vi.fn(() => vi.fn((fn: () => unknown) => fn())),
}));

describe('link helpers', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createStoreEntryWithIntegrity', () => {
    it('should return StoreEntry with integrity fields', async () => {
      const storeMock = await import('../../src/core/store.js') as {
        captureIntegrity: ReturnType<typeof vi.fn>;
      };
      storeMock.captureIntegrity.mockResolvedValue({
        size: 2048, fileCount: 15, contentHash: 'hash123',
      });

      const { createStoreEntryWithIntegrity } = await import('../../src/commands/link.js');
      const result = await createStoreEntryWithIntegrity({
        libName: 'mylib',
        commit: 'abc123',
        platform: 'macOS',
        branch: 'main',
        url: 'https://example.com/repo.git',
        size: 1024,
      });

      expect(result).toHaveProperty('libName', 'mylib');
      expect(result).toHaveProperty('commit', 'abc123');
      expect(result).toHaveProperty('platform', 'macOS');
      expect(result).toHaveProperty('size', 2048);
      expect(result).toHaveProperty('fileCount', 15);
      expect(result).toHaveProperty('contentHash', 'hash123');
      expect(result).toHaveProperty('usedBy');
      expect(result).toHaveProperty('createdAt');
      expect(result).toHaveProperty('lastAccess');
    });
  });

  describe('verifyExistingPlatforms', () => {
    it('should return all valid when no fileCount in entries', async () => {
      const registryMock = {
        getStoreKey: vi.fn((lib: string, commit: string, platform: string) => `${lib}:${commit}:${platform}`),
        getStore: vi.fn().mockReturnValue({ size: 1024 }), // 无 fileCount
      };
      const { getRegistry } = await import('../../src/core/registry.js') as {
        getRegistry: ReturnType<typeof vi.fn>;
      };
      (getRegistry as ReturnType<typeof vi.fn>).mockReturnValue(registryMock);

      const { verifyExistingPlatforms } = await import('../../src/commands/link.js');
      const result = await verifyExistingPlatforms('mylib', 'abc123', ['macOS', 'iOS']);

      expect(result.valid).toEqual(['macOS', 'iOS']);
      expect(result.corrupted).toEqual([]);
    });

    it('should mark corrupted when quickVerify fails', async () => {
      const registryMock = {
        getStoreKey: vi.fn((lib: string, commit: string, platform: string) => `${lib}:${commit}:${platform}`),
        getStore: vi.fn().mockReturnValue({ size: 1024, fileCount: 10 }),
      };
      const { getRegistry } = await import('../../src/core/registry.js') as {
        getRegistry: ReturnType<typeof vi.fn>;
      };
      (getRegistry as ReturnType<typeof vi.fn>).mockReturnValue(registryMock);

      const storeMock = await import('../../src/core/store.js') as {
        quickVerify: ReturnType<typeof vi.fn>;
      };
      storeMock.quickVerify.mockResolvedValue({ valid: false, reason: 'fileCount mismatch' });

      const { verifyExistingPlatforms } = await import('../../src/commands/link.js');
      const result = await verifyExistingPlatforms('mylib', 'abc123', ['macOS']);

      expect(result.valid).toEqual([]);
      expect(result.corrupted).toEqual(['macOS']);
    });

    it('should return valid when quickVerify passes', async () => {
      const registryMock = {
        getStoreKey: vi.fn((lib: string, commit: string, platform: string) => `${lib}:${commit}:${platform}`),
        getStore: vi.fn().mockReturnValue({ size: 1024, fileCount: 10 }),
      };
      const { getRegistry } = await import('../../src/core/registry.js') as {
        getRegistry: ReturnType<typeof vi.fn>;
      };
      (getRegistry as ReturnType<typeof vi.fn>).mockReturnValue(registryMock);

      const storeMock = await import('../../src/core/store.js') as {
        quickVerify: ReturnType<typeof vi.fn>;
      };
      storeMock.quickVerify.mockResolvedValue({ valid: true });

      const { verifyExistingPlatforms } = await import('../../src/commands/link.js');
      const result = await verifyExistingPlatforms('mylib', 'abc123', ['macOS', 'iOS']);

      expect(result.valid).toEqual(['macOS', 'iOS']);
      expect(result.corrupted).toEqual([]);
    });

    it('should handle empty platforms list', async () => {
      const { verifyExistingPlatforms } = await import('../../src/commands/link.js');
      const result = await verifyExistingPlatforms('mylib', 'abc123', []);

      expect(result.valid).toEqual([]);
      expect(result.corrupted).toEqual([]);
    });
  });

  describe('classifyLinkStatus', () => {
    let linkerMock: { getPathStatus: ReturnType<typeof vi.fn> };
    let fsMock: { lstat: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      const linker = await import('../../src/core/linker.js') as typeof linkerMock;
      linkerMock = linker;
      linkerMock.getPathStatus.mockReset();

      const fs = await import('fs/promises');
      fsMock = fs.default as typeof fsMock;
      fsMock.lstat.mockReset();
    });

    // --- General 库测试 ---

    it('should return linked for General lib with correct symlink', async () => {
      linkerMock.getPathStatus.mockResolvedValue('linked');

      const { classifyLinkStatus } = await import('../../src/commands/link.js');
      const result = await classifyLinkStatus(
        '/project/3rdParty/eigen', '/store/eigen/abc123', true, []
      );

      expect(result).toBe('linked');
      expect(linkerMock.getPathStatus).toHaveBeenCalledWith(
        '/project/3rdParty/eigen',
        '/store/eigen/abc123/_shared'
      );
    });

    it('should return relink for General lib with broken symlink', async () => {
      linkerMock.getPathStatus.mockResolvedValue('broken_link');

      const { classifyLinkStatus } = await import('../../src/commands/link.js');
      const result = await classifyLinkStatus(
        '/project/3rdParty/librocksdb', '/store/librocksdb/abc123', true, []
      );

      expect(result).toBe('relink');
    });

    it('should return relink for General lib with wrong symlink target', async () => {
      linkerMock.getPathStatus.mockResolvedValue('wrong_link');

      const { classifyLinkStatus } = await import('../../src/commands/link.js');
      const result = await classifyLinkStatus(
        '/project/3rdParty/eigen', '/store/eigen/abc123', true, []
      );

      expect(result).toBe('relink');
    });

    it('should return replace for General lib that is a directory', async () => {
      linkerMock.getPathStatus.mockResolvedValue('directory');

      const { classifyLinkStatus } = await import('../../src/commands/link.js');
      const result = await classifyLinkStatus(
        '/project/3rdParty/eigen', '/store/eigen/abc123', true, []
      );

      expect(result).toBe('replace');
    });

    it('should return link_new for General lib that is missing', async () => {
      linkerMock.getPathStatus.mockResolvedValue('missing');

      const { classifyLinkStatus } = await import('../../src/commands/link.js');
      const result = await classifyLinkStatus(
        '/project/3rdParty/eigen', '/store/eigen/abc123', true, []
      );

      expect(result).toBe('link_new');
    });

    // --- 平台库测试 ---

    it('should return linked when all platform sub-links are correct', async () => {
      linkerMock.getPathStatus.mockResolvedValue('linked');

      const { classifyLinkStatus } = await import('../../src/commands/link.js');
      const result = await classifyLinkStatus(
        '/project/3rdParty/libopencv', '/store/libopencv/abc123', false, ['macOS', 'iOS']
      );

      expect(result).toBe('linked');
      expect(linkerMock.getPathStatus).toHaveBeenCalledTimes(2);
    });

    it('should return relink when platform sub-link is broken', async () => {
      linkerMock.getPathStatus
        .mockResolvedValueOnce('linked')       // macOS ok
        .mockResolvedValueOnce('broken_link'); // iOS broken

      const { classifyLinkStatus } = await import('../../src/commands/link.js');
      const result = await classifyLinkStatus(
        '/project/3rdParty/libopencv', '/store/libopencv/abc123', false, ['macOS', 'iOS']
      );

      expect(result).toBe('relink');
    });

    it('should return relink when platform sub-link points to wrong target', async () => {
      linkerMock.getPathStatus.mockResolvedValue('wrong_link');

      const { classifyLinkStatus } = await import('../../src/commands/link.js');
      const result = await classifyLinkStatus(
        '/project/3rdParty/libopencv', '/store/libopencv/abc123', false, ['macOS']
      );

      expect(result).toBe('relink');
    });

    it('should return replace when local path exists but no platforms checked', async () => {
      // 无已有平台，但本地路径存在
      fsMock.lstat.mockResolvedValue({});

      const { classifyLinkStatus } = await import('../../src/commands/link.js');
      const result = await classifyLinkStatus(
        '/project/3rdParty/libopencv', '/store/libopencv/abc123', false, []
      );

      expect(result).toBe('replace');
    });

    it('should return link_new when local path does not exist and no platforms', async () => {
      fsMock.lstat.mockRejectedValue({ code: 'ENOENT' });

      const { classifyLinkStatus } = await import('../../src/commands/link.js');
      const result = await classifyLinkStatus(
        '/project/3rdParty/libopencv', '/store/libopencv/abc123', false, []
      );

      expect(result).toBe('link_new');
    });

    // --- 断链回归测试（复现 librocksdb 问题）---

    it('should detect broken General symlink instead of reporting as linked (librocksdb regression)', async () => {
      // 复现场景：librocksdb 是 General 库，symlink 存在但目标已被清理
      // 旧代码只做 readLink + 字符串匹配，会误报 "已链接"
      // 修复后通过 getPathStatus 检测断链
      linkerMock.getPathStatus.mockResolvedValue('broken_link');

      const { classifyLinkStatus } = await import('../../src/commands/link.js');
      const result = await classifyLinkStatus(
        '/project/3rdParty/libPixCook/dependencies/librocksdb',
        '/store/librocksdb/174b25b12221de748fbb96c6aca6db6584fd482e',
        true,
        []
      );

      // 必须返回 relink，不能返回 linked
      expect(result).toBe('relink');
      expect(result).not.toBe('linked');
    });
  });

  describe('assessDownloadResult', () => {
    it('should not classify as General when only unrequested platforms were downloaded', async () => {
      const { assessDownloadResult } = await import('../../src/commands/link.js');

      const result = assessDownloadResult(
        ['android'],
        undefined,
        {
          tempDir: '/tmp/tanmi-dock-1',
          libDir: '/tmp/tanmi-dock-1/librocksdb',
          allPlatformDirs: ['macOS', 'macOS-asan'],
          platformDirs: [],
          sharedFiles: ['README.md'],
          cleanedPlatforms: ['macOS', 'macOS-asan'],
        }
      );

      expect(result.isPureGeneral).toBe(false);
      expect(result.hasAnyPlatformArtifacts).toBe(true);
      expect(result.downloadedRequested).toEqual([]);
      expect(result.unavailableRequested).toEqual(['android']);
    });

    it('should classify as General only when download result has no platform artifacts', async () => {
      const { assessDownloadResult } = await import('../../src/commands/link.js');

      const result = assessDownloadResult(
        ['android'],
        undefined,
        {
          tempDir: '/tmp/tanmi-dock-2',
          libDir: '/tmp/tanmi-dock-2/libeigen',
          allPlatformDirs: [],
          platformDirs: [],
          sharedFiles: ['CMakeLists.txt', 'include'],
          cleanedPlatforms: [],
        }
      );

      expect(result.isPureGeneral).toBe(true);
      expect(result.hasAnyPlatformArtifacts).toBe(false);
      expect(result.downloadedRequested).toEqual([]);
      expect(result.unavailableRequested).toEqual(['android']);
    });
  });
});
