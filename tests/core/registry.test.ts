import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/promises and config
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    access: vi.fn(),
  },
}));

vi.mock('../../src/core/config.js', () => ({
  ensureConfigDir: vi.fn().mockResolvedValue(undefined),
}));

// Mock lock utility - execute function immediately without actual locking
vi.mock('../../src/utils/lock.js', () => ({
  withFileLock: vi.fn(async (_path: string, fn: () => Promise<unknown>) => fn()),
}));

describe('registry', () => {
  let fsMock: {
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
    access: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetModules();
    const fs = await import('fs/promises');
    fsMock = fs.default as typeof fsMock;
    fsMock.readFile.mockReset();
    fsMock.writeFile.mockReset();
    fsMock.mkdir.mockReset();
    fsMock.access.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('RegistryManager', () => {
    it('should be singleton', async () => {
      const { getRegistry } = await import('../../src/core/registry.js');
      const reg1 = getRegistry();
      const reg2 = getRegistry();
      expect(reg1).toBe(reg2);
    });

    it('should load empty registry when file not exists', async () => {
      fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

      const { getRegistry } = await import('../../src/core/registry.js');
      const registry = getRegistry();
      await registry.load();

      const raw = registry.getRaw();
      expect(raw.projects).toEqual({});
      expect(raw.libraries).toEqual({});
    });

    it('should load existing registry', async () => {
      const existingRegistry = {
        version: '1.0.0',
        projects: {
          abc123: {
            path: '/test',
            configPath: '/test/codepac-dep.json',
            lastLinked: '2026-01-01',
            platform: 'mac',
            dependencies: [],
          },
        },
        libraries: {},
      };
      fsMock.readFile.mockResolvedValue(JSON.stringify(existingRegistry));

      const { getRegistry } = await import('../../src/core/registry.js');
      const registry = getRegistry();
      await registry.load();

      expect(registry.listProjects()).toHaveLength(1);
    });

    it('should save registry', async () => {
      fsMock.readFile.mockRejectedValue(new Error('ENOENT'));
      fsMock.writeFile.mockResolvedValue(undefined);

      const { getRegistry } = await import('../../src/core/registry.js');
      const registry = getRegistry();
      await registry.load();
      await registry.save();

      expect(fsMock.writeFile).toHaveBeenCalled();
    });

    describe('hashPath', () => {
      it('should generate consistent hash for same path', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        const hash1 = registry.hashPath('/test/path');
        const hash2 = registry.hashPath('/test/path');
        expect(hash1).toBe(hash2);
      });

      it('should generate different hash for different paths', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        const hash1 = registry.hashPath('/path/a');
        const hash2 = registry.hashPath('/path/b');
        expect(hash1).not.toBe(hash2);
      });

      it('should return 12-char hash', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        const hash = registry.hashPath('/any/path');
        expect(hash).toHaveLength(12);
      });
    });

    describe('getLibraryKey', () => {
      it('should combine libName and commit', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        const key = registry.getLibraryKey('mylib', 'abc123');
        expect(key).toBe('mylib:abc123');
      });
    });

    describe('project operations', () => {
      it('should add and get project', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        const project = {
          path: '/test/project',
          configPath: '/test/project/codepac-dep.json',
          lastLinked: '2026-01-05',
          platform: 'mac' as const,
          dependencies: [],
        };
        registry.addProject(project);

        const hash = registry.hashPath('/test/project');
        const retrieved = registry.getProject(hash);
        expect(retrieved).toEqual(project);
      });

      it('should get project by path', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        const project = {
          path: '/test/project',
          configPath: '/test/project/codepac-dep.json',
          lastLinked: '2026-01-05',
          platform: 'mac' as const,
          dependencies: [],
        };
        registry.addProject(project);

        const retrieved = registry.getProjectByPath('/test/project');
        expect(retrieved).toEqual(project);
      });

      it('should update project', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        const project = {
          path: '/test/project',
          configPath: '/test/project/codepac-dep.json',
          lastLinked: '2026-01-05',
          platform: 'mac' as const,
          dependencies: [],
        };
        registry.addProject(project);

        const hash = registry.hashPath('/test/project');
        registry.updateProject(hash, { lastLinked: '2026-01-06' });

        const updated = registry.getProject(hash);
        expect(updated?.lastLinked).toBe('2026-01-06');
      });

      it('should list all projects', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        registry.addProject({
          path: '/test/project1',
          configPath: '/test/project1/codepac-dep.json',
          lastLinked: '2026-01-05',
          platform: 'mac',
          dependencies: [],
        });
        registry.addProject({
          path: '/test/project2',
          configPath: '/test/project2/codepac-dep.json',
          lastLinked: '2026-01-05',
          platform: 'mac',
          dependencies: [],
        });

        const projects = registry.listProjects();
        expect(projects).toHaveLength(2);
      });
    });

    describe('library operations', () => {
      it('should add and get library', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        const library = {
          libName: 'mylib',
          commit: 'abc123',
          branch: 'main',
          url: 'https://github.com/test/mylib.git',
          platforms: ['mac'],
          size: 1000,
          referencedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        };
        registry.addLibrary(library);

        const key = registry.getLibraryKey('mylib', 'abc123');
        const retrieved = registry.getLibrary(key);
        expect(retrieved).toEqual(library);
      });

      it('should update library', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        registry.addLibrary({
          libName: 'mylib',
          commit: 'abc123',
          branch: 'main',
          url: 'https://github.com/test/mylib.git',
          platforms: ['mac'],
          size: 1000,
          referencedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        const key = registry.getLibraryKey('mylib', 'abc123');
        registry.updateLibrary(key, { size: 2000 });

        const updated = registry.getLibrary(key);
        expect(updated?.size).toBe(2000);
      });

      it('should remove library', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        registry.addLibrary({
          libName: 'mylib',
          commit: 'abc123',
          branch: 'main',
          url: 'https://github.com/test/mylib.git',
          platforms: ['mac'],
          size: 1000,
          referencedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        const key = registry.getLibraryKey('mylib', 'abc123');
        registry.removeLibrary(key);

        expect(registry.getLibrary(key)).toBeUndefined();
      });

      it('should list all libraries', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        registry.addLibrary({
          libName: 'lib1',
          commit: 'abc',
          branch: 'main',
          url: 'https://github.com/test/lib1.git',
          platforms: ['mac'],
          size: 1000,
          referencedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });
        registry.addLibrary({
          libName: 'lib2',
          commit: 'def',
          branch: 'main',
          url: 'https://github.com/test/lib2.git',
          platforms: ['mac'],
          size: 2000,
          referencedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        const libs = registry.listLibraries();
        expect(libs).toHaveLength(2);
      });
    });

    describe('reference operations', () => {
      it('should add reference to library', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        registry.addLibrary({
          libName: 'mylib',
          commit: 'abc123',
          branch: 'main',
          url: 'https://github.com/test/mylib.git',
          platforms: ['mac'],
          size: 1000,
          referencedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        const libKey = registry.getLibraryKey('mylib', 'abc123');
        registry.addReference(libKey, 'project-hash-1');

        const refs = registry.getLibraryReferences(libKey);
        expect(refs).toContain('project-hash-1');
      });

      it('should not add duplicate reference', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        registry.addLibrary({
          libName: 'mylib',
          commit: 'abc123',
          branch: 'main',
          url: 'https://github.com/test/mylib.git',
          platforms: ['mac'],
          size: 1000,
          referencedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        const libKey = registry.getLibraryKey('mylib', 'abc123');
        registry.addReference(libKey, 'project-hash-1');
        registry.addReference(libKey, 'project-hash-1');

        const refs = registry.getLibraryReferences(libKey);
        expect(refs).toHaveLength(1);
      });

      it('should remove reference from library', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        registry.addLibrary({
          libName: 'mylib',
          commit: 'abc123',
          branch: 'main',
          url: 'https://github.com/test/mylib.git',
          platforms: ['mac'],
          size: 1000,
          referencedBy: ['project-hash-1'],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        const libKey = registry.getLibraryKey('mylib', 'abc123');
        registry.removeReference(libKey, 'project-hash-1');

        const refs = registry.getLibraryReferences(libKey);
        expect(refs).toHaveLength(0);
      });

      it('should get unreferenced libraries', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        registry.addLibrary({
          libName: 'referenced',
          commit: 'abc',
          branch: 'main',
          url: 'https://github.com/test/referenced.git',
          platforms: ['mac'],
          size: 1000,
          referencedBy: ['project-1'],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });
        registry.addLibrary({
          libName: 'unreferenced',
          commit: 'def',
          branch: 'main',
          url: 'https://github.com/test/unreferenced.git',
          platforms: ['mac'],
          size: 2000,
          referencedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        const unreferenced = registry.getUnreferencedLibraries();
        expect(unreferenced).toHaveLength(1);
        expect(unreferenced[0].libName).toBe('unreferenced');
      });
    });

    describe('removeProject', () => {
      it('should remove project and its references', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        // Add library
        registry.addLibrary({
          libName: 'mylib',
          commit: 'abc123',
          branch: 'main',
          url: 'https://github.com/test/mylib.git',
          platforms: ['mac'],
          size: 1000,
          referencedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        // Add project with dependency
        const project = {
          path: '/test/project',
          configPath: '/test/project/codepac-dep.json',
          lastLinked: '2026-01-05',
          platform: 'mac' as const,
          dependencies: [
            { libName: 'mylib', commit: 'abc123', linkedPath: '/test/project/3rdparty/mylib' },
          ],
        };
        registry.addProject(project);

        // Add reference
        const libKey = registry.getLibraryKey('mylib', 'abc123');
        const projectHash = registry.hashPath('/test/project');
        registry.addReference(libKey, projectHash);

        // Remove project
        registry.removeProject(projectHash);

        // Verify project removed
        expect(registry.getProject(projectHash)).toBeUndefined();
        // Verify reference removed
        expect(registry.getLibraryReferences(libKey)).not.toContain(projectHash);
      });
    });

    // ========== Store 操作测试 (新版，按平台) ==========

    describe('getStoreKey', () => {
      it('should combine libName, commit and platform', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        const key = registry.getStoreKey('mylib', 'abc123', 'macOS');
        expect(key).toBe('mylib:abc123:macOS');
      });
    });

    describe('store operations', () => {
      it('should add and get store entry', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        const entry = {
          libName: 'mylib',
          commit: 'abc123',
          platform: 'macOS',
          branch: 'main',
          url: 'https://github.com/test/mylib.git',
          size: 1000,
          usedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        };
        registry.addStore(entry);

        const key = registry.getStoreKey('mylib', 'abc123', 'macOS');
        const retrieved = registry.getStore(key);
        expect(retrieved).toEqual(entry);
      });

      it('should update store entry', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        registry.addStore({
          libName: 'mylib',
          commit: 'abc123',
          platform: 'macOS',
          branch: 'main',
          url: 'https://github.com/test/mylib.git',
          size: 1000,
          usedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        const key = registry.getStoreKey('mylib', 'abc123', 'macOS');
        registry.updateStore(key, { size: 2000 });

        const updated = registry.getStore(key);
        expect(updated?.size).toBe(2000);
      });

      it('should remove store entry', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        registry.addStore({
          libName: 'mylib',
          commit: 'abc123',
          platform: 'macOS',
          branch: 'main',
          url: 'https://github.com/test/mylib.git',
          size: 1000,
          usedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        const key = registry.getStoreKey('mylib', 'abc123', 'macOS');
        registry.removeStore(key);

        expect(registry.getStore(key)).toBeUndefined();
      });

      it('should list all store entries', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        registry.addStore({
          libName: 'lib1',
          commit: 'abc',
          platform: 'macOS',
          branch: 'main',
          url: 'https://github.com/test/lib1.git',
          size: 1000,
          usedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });
        registry.addStore({
          libName: 'lib1',
          commit: 'abc',
          platform: 'iOS',
          branch: 'main',
          url: 'https://github.com/test/lib1.git',
          size: 2000,
          usedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        const stores = registry.listStores();
        expect(stores).toHaveLength(2);
      });

      it('should get unreferenced store entries', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        registry.addStore({
          libName: 'referenced',
          commit: 'abc',
          platform: 'macOS',
          branch: 'main',
          url: 'https://github.com/test/referenced.git',
          size: 1000,
          usedBy: ['project-1'],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });
        registry.addStore({
          libName: 'unreferenced',
          commit: 'def',
          platform: 'macOS',
          branch: 'main',
          url: 'https://github.com/test/unreferenced.git',
          size: 2000,
          usedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        const unreferenced = registry.getUnreferencedStores();
        expect(unreferenced).toHaveLength(1);
        expect(unreferenced[0].libName).toBe('unreferenced');
      });
    });

    describe('store reference operations', () => {
      it('should add reference and clear unlinkedAt', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        registry.addStore({
          libName: 'mylib',
          commit: 'abc123',
          platform: 'macOS',
          branch: 'main',
          url: 'https://github.com/test/mylib.git',
          size: 1000,
          usedBy: [],
          unlinkedAt: Date.now() - 86400000,
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        const key = registry.getStoreKey('mylib', 'abc123', 'macOS');
        registry.addStoreReference(key, 'project-hash-1');

        const entry = registry.getStore(key);
        expect(entry?.usedBy).toContain('project-hash-1');
        expect(entry?.unlinkedAt).toBeUndefined();
      });

      it('should not add duplicate reference', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        registry.addStore({
          libName: 'mylib',
          commit: 'abc123',
          platform: 'macOS',
          branch: 'main',
          url: 'https://github.com/test/mylib.git',
          size: 1000,
          usedBy: [],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        const key = registry.getStoreKey('mylib', 'abc123', 'macOS');
        registry.addStoreReference(key, 'project-hash-1');
        registry.addStoreReference(key, 'project-hash-1');

        const entry = registry.getStore(key);
        expect(entry?.usedBy).toHaveLength(1);
      });

      it('should remove reference and set unlinkedAt when empty', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        registry.addStore({
          libName: 'mylib',
          commit: 'abc123',
          platform: 'macOS',
          branch: 'main',
          url: 'https://github.com/test/mylib.git',
          size: 1000,
          usedBy: ['project-hash-1'],
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        const key = registry.getStoreKey('mylib', 'abc123', 'macOS');
        registry.removeStoreReference(key, 'project-hash-1');

        const entry = registry.getStore(key);
        expect(entry?.usedBy).toHaveLength(0);
        expect(entry?.unlinkedAt).toBeDefined();
        expect(typeof entry?.unlinkedAt).toBe('number');
      });

      it('should not overwrite existing unlinkedAt', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

        const { getRegistry } = await import('../../src/core/registry.js');
        const registry = getRegistry();
        await registry.load();

        const existingUnlinkedAt = Date.now() - 86400000;
        registry.addStore({
          libName: 'mylib',
          commit: 'abc123',
          platform: 'macOS',
          branch: 'main',
          url: 'https://github.com/test/mylib.git',
          size: 1000,
          usedBy: [],
          unlinkedAt: existingUnlinkedAt,
          createdAt: '2026-01-05',
          lastAccess: '2026-01-05',
        });

        const key = registry.getStoreKey('mylib', 'abc123', 'macOS');
        registry.removeStoreReference(key, 'non-existent-project');

        const entry = registry.getStore(key);
        expect(entry?.unlinkedAt).toBe(existingUnlinkedAt);
      });
    });
  });
});
