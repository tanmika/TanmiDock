import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import {
  createTestEnv,
  loadRegistry,
  runCommand,
  type TestEnv,
} from './setup.js';
import { collectProjectDependencyGraph } from '../../src/commands/link.js';

async function createProjectWithNestedDependencies(env: TestEnv): Promise<void> {
  const thirdPartyDir = path.join(env.projectDir, '3rdparty');
  const libTopDependenciesDir = path.join(thirdPartyDir, 'libTop', 'dependencies');

  await fs.mkdir(libTopDependenciesDir, { recursive: true });

  await fs.writeFile(
    path.join(thirdPartyDir, 'codepac-dep.json'),
    JSON.stringify({
      version: '1.0.0',
      vars: {},
      repos: {
        common: [
          {
            url: 'https://github.com/test/libTop.git',
            commit: 'topcommit123456',
            branch: 'main',
            dir: 'libTop',
          },
        ],
      },
      actions: {
        common: [
          {
            command: 'codepac install --configdir libTop/dependencies',
            dir: '',
          },
        ],
      },
    }, null, 2),
    'utf-8'
  );

  await fs.writeFile(
    path.join(libTopDependenciesDir, 'codepac-dep.json'),
    JSON.stringify({
      version: '1.0.0',
      vars: {},
      repos: {
        common: [
          {
            url: 'https://github.com/test/librocksdb.git',
            commit: 'rocksdb12345678',
            branch: 'main',
            dir: 'librocksdb',
          },
        ],
      },
    }, null, 2),
    'utf-8'
  );
}

describe('TC-026: unavailable 命令测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('should add a library-wide manual unavailable rule for nested dependency', async () => {
    env = await createTestEnv();
    await createProjectWithNestedDependencies(env);

    const dependencies = await collectProjectDependencyGraph(env.projectDir);
    const nestedDependency = dependencies.find((item) => item.libName === 'librocksdb');
    expect(nestedDependency).toBeDefined();

    await runCommand('unavailableAdd', {
      searchResult: nestedDependency,
      selectedPlatforms: ['wasm'],
      applyToAllCommits: true,
    }, env, env.projectDir);

    const registry = await loadRegistry(env);
    expect(registry.manualUnavailablePlatforms.librocksdb).toEqual(['wasm']);
  });

  it('should not expand child actions after disable_action', async () => {
    env = await createTestEnv();

    const thirdPartyDir = path.join(env.projectDir, '3rdparty');
    await fs.mkdir(path.join(thirdPartyDir, 'DisabledActionConfig', 'ChildActionConfig'), { recursive: true });
    await fs.writeFile(
      path.join(thirdPartyDir, 'codepac-dep.json'),
      JSON.stringify({
        version: '1.0.0',
        vars: {},
        repos: { common: [] },
        actions: {
          common: [
            {
              command: 'codepac install libDisabledParent --configdir DisabledActionConfig --targetdir . --disable_action',
            },
          ],
        },
      }, null, 2),
      'utf-8'
    );
    await fs.writeFile(
      path.join(thirdPartyDir, 'DisabledActionConfig', 'codepac-dep.json'),
      JSON.stringify({
        version: '1.0.0',
        vars: {},
        repos: {
          common: [
            {
              url: 'https://github.com/test/libDisabledParent.git',
              commit: 'disabledparent1',
              branch: 'main',
              dir: 'libDisabledParent',
            },
          ],
        },
        actions: {
          common: [
            {
              command: 'codepac install libDisabledChild --configdir ChildActionConfig --targetdir .',
            },
          ],
        },
      }, null, 2),
      'utf-8'
    );
    await fs.writeFile(
      path.join(thirdPartyDir, 'DisabledActionConfig', 'ChildActionConfig', 'codepac-dep.json'),
      JSON.stringify({
        version: '1.0.0',
        vars: {},
        repos: {
          common: [
            {
              url: 'https://github.com/test/libDisabledChild.git',
              commit: 'disabledchild12',
              branch: 'main',
              dir: 'libDisabledChild',
            },
          ],
        },
      }, null, 2),
      'utf-8'
    );

    const dependencies = await collectProjectDependencyGraph(env.projectDir);

    expect(dependencies.some((item) => item.libName === 'libDisabledParent')).toBe(true);
    expect(dependencies.some((item) => item.libName === 'libDisabledChild')).toBe(false);
  });

  it('should remove a manual unavailable rule', async () => {
    env = await createTestEnv();
    await createProjectWithNestedDependencies(env);

    const registry = await loadRegistry(env);
    registry.manualUnavailablePlatforms = registry.manualUnavailablePlatforms ?? {};
    registry.manualUnavailablePlatforms.librocksdb = ['wasm', 'ios'];
    await fs.writeFile(
      path.join(env.homeDir, 'registry.json'),
      JSON.stringify(registry, null, 2),
      'utf-8'
    );

    await runCommand('unavailableRemove', {
      searchResult: {
        key: 'librocksdb',
        libName: 'librocksdb',
        platforms: ['wasm', 'ios'],
      },
      selectedPlatforms: ['wasm'],
    }, env, env.projectDir);

    const nextRegistry = await loadRegistry(env);
    expect(nextRegistry.manualUnavailablePlatforms.librocksdb).toEqual(['ios']);
  });
});
