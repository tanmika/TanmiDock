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
});
