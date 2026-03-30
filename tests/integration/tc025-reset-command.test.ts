import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  createTestEnv,
  createMockStoreDataV2,
  createMockProjectData,
  loadRegistry,
  saveRegistry,
  hashPath,
  runCommand,
  verifyDirectoryDeleted,
} from './setup.js';

describe('tc025 reset command', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  it('should reset project-scoped matched commits and keep unrelated commits', async () => {
    const env = await createTestEnv();
    cleanups.push(env.cleanup);

    const libName = 'librocksdb';
    const commitA = '174b25b12221de748fbb96c6aca6db6584fd482e';
    const commitB = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    await createMockStoreDataV2(env, { libName, commit: commitA, platforms: ['macOS'] });
    await createMockStoreDataV2(env, { libName, commit: commitB, platforms: ['macOS'] });

    const linkedTargetA = path.join(env.storeDir, libName, commitA, 'macOS');
    const linkedTargetB = path.join(env.storeDir, libName, commitB, 'macOS');
    await createMockProjectData(env, [
      { libName, linkedPath: linkedTargetA },
      { libName: `${libName}-alt`, linkedPath: '' },
    ]);

    const registry = await loadRegistry(env);
    const projectHash = hashPath(env.projectDir);
    registry.projects[projectHash] = {
      path: env.projectDir,
      configPath: path.join(env.projectDir, 'codepac-dep.json'),
      lastLinked: new Date().toISOString(),
      platforms: ['macOS'],
      dependencies: [
        {
          libName,
          commit: commitA,
          platform: 'macOS',
          linkedPath: path.join('3rdparty', libName),
        },
        {
          libName,
          commit: commitB,
          platform: 'macOS',
          linkedPath: path.join('3rdparty', `${libName}-nested`),
        },
      ],
    };
    registry.libraries[`${libName}:${commitA}`].referencedBy = [projectHash];
    registry.libraries[`${libName}:${commitB}`].referencedBy = [projectHash];
    registry.stores[`${libName}:${commitA}:macOS`].usedBy = [projectHash];
    registry.stores[`${libName}:${commitB}:macOS`].usedBy = [projectHash];

    const nestedPath = path.join(env.projectDir, '3rdparty', `${libName}-nested`);
    await fs.mkdir(path.dirname(nestedPath), { recursive: true });
    await fs.symlink(linkedTargetB, nestedPath);
    await saveRegistry(env, registry);

    await runCommand('reset', { libName, yes: true }, env, env.projectDir);

    const nextRegistry = await loadRegistry(env);
    expect(nextRegistry.libraries[`${libName}:${commitA}`]).toBeUndefined();
    expect(nextRegistry.libraries[`${libName}:${commitB}`]).toBeUndefined();
    expect(nextRegistry.stores[`${libName}:${commitA}:macOS`]).toBeUndefined();
    expect(nextRegistry.stores[`${libName}:${commitB}:macOS`]).toBeUndefined();
    expect(nextRegistry.projects[projectHash]?.dependencies).toEqual([]);

    await verifyDirectoryDeleted(path.join(env.storeDir, libName, commitA));
    await verifyDirectoryDeleted(path.join(env.storeDir, libName, commitB));

    await expect(fs.lstat(path.join(env.projectDir, '3rdparty', libName))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(nestedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should reset global single commit and keep regular directories untouched', async () => {
    const env = await createTestEnv();
    cleanups.push(env.cleanup);

    const libName = 'librocksdb';
    const commit = '174b25b12221de748fbb96c6aca6db6584fd482e';
    await createMockStoreDataV2(env, { libName, commit, platforms: ['macOS'] });

    const project2Dir = path.join(env.tempDir, 'project-2');
    await fs.mkdir(project2Dir, { recursive: true });
    await createMockProjectData(env, [{ libName, linkedPath: path.join(env.storeDir, libName, commit, 'macOS') }]);
    await fs.writeFile(path.join(project2Dir, 'codepac-dep.json'), JSON.stringify({
      version: '1.0.0',
      repos: { common: [{ url: 'https://github.com/test/librocksdb.git', commit, branch: 'main', dir: libName }] },
    }, null, 2), 'utf-8');
    await fs.mkdir(path.join(project2Dir, '3rdparty', libName), { recursive: true });
    await fs.writeFile(path.join(project2Dir, '3rdparty', libName, 'manual.txt'), 'keep', 'utf-8');

    const registry = await loadRegistry(env);
    const projectHash1 = hashPath(env.projectDir);
    const projectHash2 = hashPath(project2Dir);
    registry.projects[projectHash1] = {
      path: env.projectDir,
      configPath: path.join(env.projectDir, 'codepac-dep.json'),
      lastLinked: new Date().toISOString(),
      platforms: ['macOS'],
      dependencies: [
        { libName, commit, platform: 'macOS', linkedPath: path.join('3rdparty', libName) },
      ],
    };
    registry.projects[projectHash2] = {
      path: project2Dir,
      configPath: path.join(project2Dir, 'codepac-dep.json'),
      lastLinked: new Date().toISOString(),
      platforms: ['macOS'],
      dependencies: [
        { libName, commit, platform: 'macOS', linkedPath: path.join('3rdparty', libName) },
      ],
    };
    registry.libraries[`${libName}:${commit}`].referencedBy = [projectHash1, projectHash2];
    registry.stores[`${libName}:${commit}:macOS`].usedBy = [projectHash1, projectHash2];
    await saveRegistry(env, registry);

    await runCommand('reset', { libName, commit, yes: true }, env, env.tempDir);

    const nextRegistry = await loadRegistry(env);
    expect(nextRegistry.libraries[`${libName}:${commit}`]).toBeUndefined();
    expect(nextRegistry.stores[`${libName}:${commit}:macOS`]).toBeUndefined();
    expect(nextRegistry.projects[projectHash1]?.dependencies).toEqual([]);
    expect(nextRegistry.projects[projectHash2]?.dependencies).toEqual([]);

    await verifyDirectoryDeleted(path.join(env.storeDir, libName, commit));
    await expect(fs.lstat(path.join(env.projectDir, '3rdparty', libName))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(project2Dir, '3rdparty', libName, 'manual.txt'), 'utf-8')).resolves.toBe('keep');
  });
});
