import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock 所有 check.ts 的依赖
vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
    readlink: vi.fn(),
    rm: vi.fn(),
    unlink: vi.fn(),
  },
}));
vi.mock('../../src/core/codepac.js', () => ({
  isCodepacInstalled: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../src/utils/disk.js', () => ({
  getDiskInfo: vi.fn().mockResolvedValue([{ path: '/', total: 1e12, free: 1e11, isSystem: true }]),
  formatSize: vi.fn((n: number) => `${n}B`),
}));
vi.mock('../../src/core/config.js', () => ({
  load: vi.fn().mockResolvedValue({
    storePath: '/store',
    concurrency: 5,
    logLevel: 'info',
  }),
}));
vi.mock('../../src/core/registry.js', () => ({
  getRegistry: vi.fn(),
}));
vi.mock('../../src/core/store.js', () => ({
  getStorePath: vi.fn().mockResolvedValue('/store'),
  exists: vi.fn(),
  quickVerify: vi.fn(),
  fullVerify: vi.fn(),
  captureIntegrity: vi.fn(),
}));
vi.mock('../../src/utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  hint: vi.fn(),
  blank: vi.fn(),
  title: vi.fn(),
  separator: vi.fn(),
  colorize: vi.fn((s: string) => s),
  debug: vi.fn(),
}));
vi.mock('../../src/utils/prompt.js', () => ({
  selectWithCancel: vi.fn(),
  checkboxWithCancel: vi.fn(),
  confirmWithCancel: vi.fn(),
  PROMPT_CANCELLED: Symbol('PROMPT_CANCELLED'),
}));

describe('check --integrity', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('checkStoreIntegrity', () => {
    it('should return corrupted stores from fullVerify', async () => {
      const registryMock = {
        load: vi.fn(),
        listStores: vi.fn().mockReturnValue([
          { libName: 'mylib', commit: 'abc123', platform: 'macOS', size: 1024, fileCount: 10, contentHash: 'hash1' },
          { libName: 'otherlib', commit: 'def456', platform: 'iOS', size: 512, fileCount: 5, contentHash: 'hash2' },
        ]),
        getStoreKey: vi.fn((lib: string, commit: string, platform: string) => `${lib}:${commit}:${platform}`),
        updateStore: vi.fn(),
        save: vi.fn(),
      };
      const { getRegistry } = await import('../../src/core/registry.js') as {
        getRegistry: ReturnType<typeof vi.fn>;
      };
      (getRegistry as ReturnType<typeof vi.fn>).mockReturnValue(registryMock);

      const storeMock = await import('../../src/core/store.js') as {
        fullVerify: ReturnType<typeof vi.fn>;
      };
      storeMock.fullVerify
        .mockResolvedValueOnce({ valid: false, reason: 'fileCount mismatch', actual: { fileCount: 7, size: 800 } })
        .mockResolvedValueOnce({ valid: true });

      const { checkStoreIntegrity } = await import('../../src/commands/check.js');
      const corrupted = await checkStoreIntegrity();

      expect(corrupted).toHaveLength(1);
      expect(corrupted[0].libName).toBe('mylib');
      expect(corrupted[0].reason).toBe('fileCount mismatch');
    });

    it('should backfill entries without fileCount', async () => {
      const registryMock = {
        load: vi.fn(),
        listStores: vi.fn().mockReturnValue([
          { libName: 'mylib', commit: 'abc123', platform: 'macOS', size: 1024 },
        ]),
        getStoreKey: vi.fn((lib: string, commit: string, platform: string) => `${lib}:${commit}:${platform}`),
        updateStore: vi.fn(),
        save: vi.fn(),
      };
      const { getRegistry } = await import('../../src/core/registry.js') as {
        getRegistry: ReturnType<typeof vi.fn>;
      };
      (getRegistry as ReturnType<typeof vi.fn>).mockReturnValue(registryMock);

      const storeMock = await import('../../src/core/store.js') as {
        captureIntegrity: ReturnType<typeof vi.fn>;
      };
      storeMock.captureIntegrity.mockResolvedValue({ size: 2048, fileCount: 15, contentHash: 'newhash' });

      const { checkStoreIntegrity } = await import('../../src/commands/check.js');
      const corrupted = await checkStoreIntegrity();

      expect(corrupted).toHaveLength(0);
      expect(registryMock.updateStore).toHaveBeenCalledWith('mylib:abc123:macOS', {
        size: 2048, fileCount: 15, contentHash: 'newhash',
      });
    });

    it('should return empty array when registry fails to load', async () => {
      const { getRegistry } = await import('../../src/core/registry.js') as {
        getRegistry: ReturnType<typeof vi.fn>;
      };
      (getRegistry as ReturnType<typeof vi.fn>).mockReturnValue({
        load: vi.fn().mockRejectedValue(new Error('no config')),
      });

      const { checkStoreIntegrity } = await import('../../src/commands/check.js');
      const corrupted = await checkStoreIntegrity();

      expect(corrupted).toHaveLength(0);
    });

    it('should detect shared platform conflicts in store layout', async () => {
      const registryMock = {
        load: vi.fn(),
        listStores: vi.fn().mockReturnValue([
          { libName: 'libflatbuffers', commit: 'abc123', platform: 'wasm', size: 1024, fileCount: 10, contentHash: 'hash1' },
        ]),
        getStoreKey: vi.fn((lib: string, commit: string, platform: string) => `${lib}:${commit}:${platform}`),
        updateStore: vi.fn(),
        save: vi.fn(),
      };
      const { getRegistry } = await import('../../src/core/registry.js') as {
        getRegistry: ReturnType<typeof vi.fn>;
      };
      (getRegistry as ReturnType<typeof vi.fn>).mockReturnValue(registryMock);

      const fsMock = (await import('fs/promises')).default as {
        readdir: ReturnType<typeof vi.fn>;
      };
      fsMock.readdir.mockImplementation(async (targetPath: string, options?: { withFileTypes?: boolean }) => {
        if (targetPath === '/store/libflatbuffers/abc123/_shared' && options?.withFileTypes) {
          return [
            { name: 'wasm', isDirectory: () => true },
            { name: 'include', isDirectory: () => true },
          ];
        }
        return [];
      });

      const storeMock = await import('../../src/core/store.js') as {
        fullVerify: ReturnType<typeof vi.fn>;
      };
      storeMock.fullVerify.mockResolvedValue({ valid: true });

      const { checkStoreIntegrity } = await import('../../src/commands/check.js');
      const corrupted = await checkStoreIntegrity();

      expect(corrupted).toHaveLength(1);
      expect(corrupted[0].kind).toBe('shared_platform_conflict');
      expect(corrupted[0].platform).toBe('_shared');
      expect(corrupted[0].conflictPlatforms).toEqual(['wasm']);
    });
  });

  describe('fixCorruptedStores', () => {
    it('should remove corrupted entries from registry and filesystem', async () => {
      const registryMock = {
        load: vi.fn(),
        getStoreKey: vi.fn((lib: string, commit: string, platform: string) => `${lib}:${commit}:${platform}`),
        removeStore: vi.fn(),
        save: vi.fn(),
      };
      const { getRegistry } = await import('../../src/core/registry.js') as {
        getRegistry: ReturnType<typeof vi.fn>;
      };
      (getRegistry as ReturnType<typeof vi.fn>).mockReturnValue(registryMock);

      const fsMock = (await import('fs/promises')).default as {
        rm: ReturnType<typeof vi.fn>;
      };
      fsMock.rm.mockResolvedValue(undefined);

      const { fixCorruptedStores } = await import('../../src/commands/check.js');
      await fixCorruptedStores([
        {
          libName: 'mylib', commit: 'abc123', platform: 'macOS', reason: 'fileCount mismatch',
          expected: { fileCount: 10, size: 1024, contentHash: 'hash1' },
          actual: { fileCount: 7, size: 800 },
        },
      ]);

      expect(registryMock.removeStore).toHaveBeenCalledWith('mylib:abc123:macOS');
      expect(fsMock.rm).toHaveBeenCalled();
      expect(registryMock.save).toHaveBeenCalled();
    });

    it('should do nothing for empty array', async () => {
      const { fixCorruptedStores } = await import('../../src/commands/check.js');
      await fixCorruptedStores([]);
      // 不应该调用 getRegistry
    });

    it('should remove whole commit cache for shared platform conflicts', async () => {
      const registryMock = {
        load: vi.fn(),
        getStoreKey: vi.fn((lib: string, commit: string, platform: string) => `${lib}:${commit}:${platform}`),
        getLibraryStoreKeys: vi.fn().mockReturnValue([
          'libflatbuffers:abc123:wasm',
          'libflatbuffers:abc123:_shared',
        ]),
        removeStore: vi.fn(),
        save: vi.fn(),
      };
      const { getRegistry } = await import('../../src/core/registry.js') as {
        getRegistry: ReturnType<typeof vi.fn>;
      };
      (getRegistry as ReturnType<typeof vi.fn>).mockReturnValue(registryMock);

      const fsMock = (await import('fs/promises')).default as {
        rm: ReturnType<typeof vi.fn>;
      };
      fsMock.rm.mockResolvedValue(undefined);

      const { fixCorruptedStores } = await import('../../src/commands/check.js');
      await fixCorruptedStores([
        {
          libName: 'libflatbuffers',
          commit: 'abc123',
          platform: '_shared',
          kind: 'shared_platform_conflict',
          reason: '_shared 包含平台目录: wasm',
          conflictPlatforms: ['wasm'],
          expected: {},
          actual: { fileCount: 1, size: 0 },
        },
      ]);

      expect(registryMock.getLibraryStoreKeys).toHaveBeenCalledWith('libflatbuffers', 'abc123');
      expect(registryMock.removeStore).toHaveBeenCalledWith('libflatbuffers:abc123:wasm');
      expect(registryMock.removeStore).toHaveBeenCalledWith('libflatbuffers:abc123:_shared');
      expect(fsMock.rm).toHaveBeenCalledWith('/store/libflatbuffers/abc123', { recursive: true, force: true });
      expect(registryMock.save).toHaveBeenCalled();
    });
  });

  describe('IntegrityIssue.corruptedStores field', () => {
    it('should include corruptedStores in check results', async () => {
      const registryMock = {
        load: vi.fn(),
        listStores: vi.fn().mockReturnValue([
          { libName: 'mylib', commit: 'abc123', platform: 'macOS', size: 1024, fileCount: 10, contentHash: 'hash1' },
        ]),
        getStoreKey: vi.fn((lib: string, commit: string, platform: string) => `${lib}:${commit}:${platform}`),
        updateStore: vi.fn(),
        save: vi.fn(),
      };
      const { getRegistry } = await import('../../src/core/registry.js') as {
        getRegistry: ReturnType<typeof vi.fn>;
      };
      (getRegistry as ReturnType<typeof vi.fn>).mockReturnValue(registryMock);

      const storeMock = await import('../../src/core/store.js') as {
        fullVerify: ReturnType<typeof vi.fn>;
      };
      storeMock.fullVerify.mockResolvedValue({ valid: false, reason: 'hash mismatch', actual: { fileCount: 10, size: 1024, contentHash: 'wronghash' } });

      const { checkStoreIntegrity } = await import('../../src/commands/check.js');
      const corrupted = await checkStoreIntegrity();

      expect(corrupted).toHaveLength(1);
      expect(corrupted[0]).toHaveProperty('libName');
      expect(corrupted[0]).toHaveProperty('commit');
      expect(corrupted[0]).toHaveProperty('platform');
      expect(corrupted[0]).toHaveProperty('reason');
      expect(corrupted[0]).toHaveProperty('expected');
      expect(corrupted[0]).toHaveProperty('actual');
    });
  });

  describe('--integrity CLI option', () => {
    it('should be registered as a valid option', async () => {
      const { createCheckCommand } = await import('../../src/commands/check.js');
      const cmd = createCheckCommand();

      // 验证 --integrity 选项已注册
      const integrityOption = cmd.options.find(
        (opt) => opt.long === '--integrity'
      );
      expect(integrityOption).toBeDefined();
    });

    it('should have correct description', async () => {
      const { createCheckCommand } = await import('../../src/commands/check.js');
      const cmd = createCheckCommand();

      const integrityOption = cmd.options.find(
        (opt) => opt.long === '--integrity'
      );
      expect(integrityOption?.description).toContain('完整性');
    });
  });
});
