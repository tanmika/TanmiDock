import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
    unlink: vi.fn(),
    lstat: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
    symlink: vi.fn(),
  },
}));

// Mock platform
vi.mock('../../src/core/platform.js', () => ({
  getConfigDir: vi.fn().mockReturnValue('/mock/.tanmi-dock'),
}));

describe('Transaction', () => {
  let fsMock: {
    mkdir: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    readdir: ReturnType<typeof vi.fn>;
    unlink: ReturnType<typeof vi.fn>;
    lstat: ReturnType<typeof vi.fn>;
    rename: ReturnType<typeof vi.fn>;
    rm: ReturnType<typeof vi.fn>;
    symlink: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetModules();
    const fs = await import('fs/promises');
    fsMock = fs.default as typeof fsMock;
    fsMock.mkdir.mockReset();
    fsMock.writeFile.mockReset();
    fsMock.readFile.mockReset();
    fsMock.readdir.mockReset();
    fsMock.unlink.mockReset();
    fsMock.lstat.mockReset();
    fsMock.rename.mockReset();
    fsMock.rm.mockReset();
    fsMock.symlink.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor and begin', () => {
    it('should create a new transaction with pending status', async () => {
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.writeFile.mockResolvedValue(undefined);

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = new Transaction('/test/project');

      expect(tx.id).toBeDefined();
      expect(tx.id).toHaveLength(16); // 8 bytes hex = 16 chars
    });

    it('should persist transaction log on begin', async () => {
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.writeFile.mockResolvedValue(undefined);

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = new Transaction('/test/project');
      await tx.begin();

      expect(fsMock.mkdir).toHaveBeenCalledWith(expect.stringContaining('transactions'), {
        recursive: true,
      });
      expect(fsMock.writeFile).toHaveBeenCalled();
      const writtenContent = JSON.parse(fsMock.writeFile.mock.calls[0][1]);
      expect(writtenContent.status).toBe('pending');
      expect(writtenContent.projectPath).toBe('/test/project');
    });
  });

  describe('static start', () => {
    it('should create and begin transaction in one call', async () => {
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.writeFile.mockResolvedValue(undefined);

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = await Transaction.start('/test/project');

      expect(tx.id).toBeDefined();
      expect(fsMock.writeFile).toHaveBeenCalled();
    });
  });

  describe('recordOp', () => {
    it('should record operation without persisting', async () => {
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.writeFile.mockResolvedValue(undefined);

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = new Transaction('/test/project');
      await tx.begin();

      fsMock.writeFile.mockClear();
      tx.recordOp('link', '/target/path', '/source/path');

      // recordOp doesn't persist immediately
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    it('should record multiple operations', async () => {
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.writeFile.mockResolvedValue(undefined);

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = new Transaction('/test/project');
      await tx.begin();

      tx.recordOp('unlink', '/path1');
      tx.recordOp('link', '/path2', '/source');
      tx.recordOp('absorb', '/path3', '/store/path');

      await tx.save();

      const writtenContent = JSON.parse(fsMock.writeFile.mock.calls.slice(-1)[0][1]);
      expect(writtenContent.operations).toHaveLength(3);
      expect(writtenContent.operations[0].type).toBe('unlink');
      expect(writtenContent.operations[1].type).toBe('link');
      expect(writtenContent.operations[2].type).toBe('absorb');
    });
  });

  describe('save', () => {
    it('should persist current state', async () => {
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.writeFile.mockResolvedValue(undefined);

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = new Transaction('/test/project');
      await tx.begin();

      tx.recordOp('link', '/target', '/source');
      await tx.save();

      expect(fsMock.writeFile).toHaveBeenCalledTimes(2); // begin + save
    });
  });

  describe('commit', () => {
    it('should delete transaction log on commit', async () => {
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.writeFile.mockResolvedValue(undefined);
      fsMock.unlink.mockResolvedValue(undefined);

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = new Transaction('/test/project');
      await tx.begin();
      await tx.commit();

      expect(fsMock.unlink).toHaveBeenCalled();
    });
  });

  describe('getPendingTransactions', () => {
    it('should return empty array when no transactions', async () => {
      fsMock.readdir.mockRejectedValue(new Error('ENOENT'));

      const { Transaction } = await import('../../src/core/transaction.js');
      const pending = await Transaction.getPendingTransactions();

      expect(pending).toEqual([]);
    });

    it('should return pending transactions', async () => {
      const mockLog = {
        id: 'test123',
        startTime: '2024-01-01T00:00:00Z',
        projectPath: '/test/project',
        operations: [],
        status: 'pending',
      };
      fsMock.readdir.mockResolvedValue(['test123.json']);
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockLog));

      const { Transaction } = await import('../../src/core/transaction.js');
      const pending = await Transaction.getPendingTransactions();

      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('test123');
    });

    it('should filter out committed transactions', async () => {
      const committedLog = {
        id: 'committed1',
        status: 'committed',
        operations: [],
        projectPath: '/test',
        startTime: '2024-01-01',
      };
      fsMock.readdir.mockResolvedValue(['committed1.json']);
      fsMock.readFile.mockResolvedValue(JSON.stringify(committedLog));

      const { Transaction } = await import('../../src/core/transaction.js');
      const pending = await Transaction.getPendingTransactions();

      expect(pending).toHaveLength(0);
    });
  });

  describe('findPending', () => {
    it('should return null when no pending transactions', async () => {
      fsMock.readdir.mockResolvedValue([]);

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = await Transaction.findPending();

      expect(tx).toBeNull();
    });

    it('should return first pending transaction', async () => {
      const mockLog = {
        id: 'pending1',
        startTime: '2024-01-01T00:00:00Z',
        projectPath: '/test/project',
        operations: [],
        status: 'pending',
      };
      fsMock.readdir.mockResolvedValue(['pending1.json']);
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockLog));

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = await Transaction.findPending();

      expect(tx).not.toBeNull();
      expect(tx!.id).toBe('pending1');
    });
  });

  describe('rollback', () => {
    it('should rollback link operation by removing symlink', async () => {
      const mockLog = {
        id: 'rollback1',
        startTime: '2024-01-01T00:00:00Z',
        projectPath: '/test/project',
        operations: [{ type: 'link', target: '/target/link', source: '/source', completed: true }],
        status: 'pending',
      };
      fsMock.readdir.mockResolvedValue(['rollback1.json']);
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockLog));
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => true });
      fsMock.unlink.mockResolvedValue(undefined);
      fsMock.writeFile.mockResolvedValue(undefined);

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = await Transaction.findPending();
      const errors = await tx!.rollback();

      expect(errors).toHaveLength(0);
      expect(fsMock.unlink).toHaveBeenCalledWith('/target/link');
    });

    it('should rollback unlink operation by recreating symlink', async () => {
      const mockLog = {
        id: 'rollback2',
        startTime: '2024-01-01T00:00:00Z',
        projectPath: '/test/project',
        operations: [
          { type: 'unlink', target: '/target/link', source: '/source', completed: true },
        ],
        status: 'pending',
      };
      fsMock.readdir.mockResolvedValue(['rollback2.json']);
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockLog));
      fsMock.symlink.mockResolvedValue(undefined);
      fsMock.writeFile.mockResolvedValue(undefined);
      fsMock.unlink.mockResolvedValue(undefined);

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = await Transaction.findPending();
      await tx!.rollback();

      expect(fsMock.symlink).toHaveBeenCalledWith('/source', '/target/link', 'dir');
    });

    it('should rollback absorb operation by moving back', async () => {
      const mockLog = {
        id: 'rollback3',
        startTime: '2024-01-01T00:00:00Z',
        projectPath: '/test/project',
        operations: [
          { type: 'absorb', target: '/store/lib', source: '/project/lib', completed: true },
        ],
        status: 'pending',
      };
      fsMock.readdir.mockResolvedValue(['rollback3.json']);
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockLog));
      fsMock.rename.mockResolvedValue(undefined);
      fsMock.writeFile.mockResolvedValue(undefined);
      fsMock.unlink.mockResolvedValue(undefined);

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = await Transaction.findPending();
      await tx!.rollback();

      expect(fsMock.rename).toHaveBeenCalledWith('/store/lib', '/project/lib');
    });

    it('should rollback download operation by removing directory', async () => {
      const mockLog = {
        id: 'rollback4',
        startTime: '2024-01-01T00:00:00Z',
        projectPath: '/test/project',
        operations: [{ type: 'download', target: '/store/newlib', completed: true }],
        status: 'pending',
      };
      fsMock.readdir.mockResolvedValue(['rollback4.json']);
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockLog));
      fsMock.rm.mockResolvedValue(undefined);
      fsMock.writeFile.mockResolvedValue(undefined);
      fsMock.unlink.mockResolvedValue(undefined);

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = await Transaction.findPending();
      await tx!.rollback();

      expect(fsMock.rm).toHaveBeenCalledWith('/store/newlib', { recursive: true, force: true });
    });

    it('should skip incomplete operations during rollback', async () => {
      const mockLog = {
        id: 'rollback5',
        startTime: '2024-01-01T00:00:00Z',
        projectPath: '/test/project',
        operations: [
          { type: 'link', target: '/completed', source: '/src', completed: true },
          { type: 'link', target: '/incomplete', source: '/src', completed: false },
        ],
        status: 'pending',
      };
      fsMock.readdir.mockResolvedValue(['rollback5.json']);
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockLog));
      fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => true });
      fsMock.unlink.mockResolvedValue(undefined);
      fsMock.writeFile.mockResolvedValue(undefined);

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = await Transaction.findPending();
      await tx!.rollback();

      // Only the completed operation should be rolled back
      expect(fsMock.unlink).toHaveBeenCalledTimes(2); // lstat unlink + final unlink
      expect(fsMock.unlink).toHaveBeenCalledWith('/completed');
    });
  });

  describe('recover', () => {
    it('should recover transaction from id', async () => {
      const mockLog = {
        id: 'recover1',
        startTime: '2024-01-01T00:00:00Z',
        projectPath: '/test/project',
        operations: [],
        status: 'pending',
      };
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockLog));

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = await Transaction.recover('recover1');

      expect(tx).not.toBeNull();
      expect(tx!.id).toBe('recover1');
    });

    it('should return null for non-existent transaction', async () => {
      fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

      const { Transaction } = await import('../../src/core/transaction.js');
      const tx = await Transaction.recover('nonexistent');

      expect(tx).toBeNull();
    });
  });
});
