import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    access: vi.fn(),
  },
}));

// Mock logger to prevent console output
vi.mock('../../src/utils/logger.js', () => ({
  error: vi.fn(),
  hint: vi.fn(),
}));

describe('guard', () => {
  let fsMock: {
    readFile: ReturnType<typeof vi.fn>;
    access: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetModules();
    const fs = await import('fs/promises');
    fsMock = fs.default as typeof fsMock;
    fsMock.readFile.mockReset();
    fsMock.access.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('isInitialized', () => {
    it('should return true when config exists and initialized is true', async () => {
      const mockConfig = {
        version: '1.0.0',
        initialized: true,
        storePath: '/test/store',
      };
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockConfig));

      const { isInitialized } = await import('../../src/core/guard.js');
      const result = await isInitialized();

      expect(result).toBe(true);
    });

    it('should return false when config exists but initialized is false', async () => {
      const mockConfig = {
        version: '1.0.0',
        initialized: false,
        storePath: '/test/store',
      };
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockConfig));

      const { isInitialized } = await import('../../src/core/guard.js');
      const result = await isInitialized();

      expect(result).toBe(false);
    });

    it('should return false when config file does not exist', async () => {
      fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

      const { isInitialized } = await import('../../src/core/guard.js');
      const result = await isInitialized();

      expect(result).toBe(false);
    });
  });

  describe('getInitStatus', () => {
    it('should return full status when config exists and store path exists', async () => {
      const mockConfig = {
        version: '1.0.0',
        initialized: true,
        storePath: '/test/store',
      };
      fsMock.access.mockResolvedValue(undefined);
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockConfig));

      const { getInitStatus } = await import('../../src/core/guard.js');
      const status = await getInitStatus();

      expect(status.initialized).toBe(true);
      expect(status.configExists).toBe(true);
      expect(status.storePathExists).toBe(true);
      expect(status.storePath).toBe('/test/store');
    });

    it('should return configExists false when config does not exist', async () => {
      fsMock.access.mockRejectedValue(new Error('ENOENT'));

      const { getInitStatus } = await import('../../src/core/guard.js');
      const status = await getInitStatus();

      expect(status.initialized).toBe(false);
      expect(status.configExists).toBe(false);
      expect(status.storePathExists).toBe(false);
      expect(status.storePath).toBeUndefined();
    });

    it('should return storePathExists false when store path does not exist', async () => {
      const mockConfig = {
        version: '1.0.0',
        initialized: true,
        storePath: '/nonexistent/store',
      };
      fsMock.access
        .mockResolvedValueOnce(undefined) // config exists
        .mockRejectedValueOnce(new Error('ENOENT')); // store path doesn't exist
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockConfig));

      const { getInitStatus } = await import('../../src/core/guard.js');
      const status = await getInitStatus();

      expect(status.initialized).toBe(true);
      expect(status.configExists).toBe(true);
      expect(status.storePathExists).toBe(false);
      expect(status.storePath).toBe('/nonexistent/store');
    });
  });

  describe('configDirExists', () => {
    it('should return true when config dir exists', async () => {
      fsMock.access.mockResolvedValue(undefined);

      const { configDirExists } = await import('../../src/core/guard.js');
      const result = await configDirExists();

      expect(result).toBe(true);
    });

    it('should return false when config dir does not exist', async () => {
      fsMock.access.mockRejectedValue(new Error('ENOENT'));

      const { configDirExists } = await import('../../src/core/guard.js');
      const result = await configDirExists();

      expect(result).toBe(false);
    });
  });
});
