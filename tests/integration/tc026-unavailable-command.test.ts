import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('should log the final deduplicated dependency graph', async () => {
    env = await createTestEnv();
    await createProjectWithNestedDependencies(env);
    const previousDebug = process.env.DEBUG;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      process.env.DEBUG = '1';
      await collectProjectDependencyGraph(env.projectDir);

      const finalSummary = logSpy.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('[dependency-graph] 收集完成'));
      expect(finalSummary).toContain('dependencies=2');
      expect(finalSummary).toContain('visitedConfigs=2');
      expect(finalSummary).toContain('libTop@topcommit123456:direct:');
      expect(finalSummary).toContain('librocksdb@rocksdb12345678:nested:');
    } finally {
      if (previousDebug === undefined) {
        delete process.env.DEBUG;
      } else {
        process.env.DEBUG = previousDebug;
      }
      logSpy.mockRestore();
    }
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

  it('should continue collecting child actions after an explicitly empty targetdir', async () => {
    env = await createTestEnv();

    const thirdPartyDir = path.join(env.projectDir, '3rdparty');
    const firstConfigDir = path.join(thirdPartyDir, 'GraphLevelOneCfg');
    const firstTargetDir = path.join(thirdPartyDir, 'GraphGeneratedRoot');
    const secondConfigDir = path.join(firstTargetDir, 'GraphLevelTwoCfg');
    await fs.mkdir(firstConfigDir, { recursive: true });
    await fs.mkdir(secondConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(thirdPartyDir, 'codepac-dep.json'),
      JSON.stringify({
        version: '2.0.56',
        repos: {},
        actions: {
          common: [{
            command: 'codepac install libGraphLevelOne --configdir GraphLevelOneCfg --targetdir GraphGeneratedRoot',
          }],
        },
      }, null, 2),
      'utf-8'
    );
    await fs.writeFile(
      path.join(firstConfigDir, 'codepac-dep.json'),
      JSON.stringify({
        version: '2.0.56',
        repos: {
          common: [{
            url: 'https://github.com/test/libGraphLevelOne.git',
            commit: 'graphlevelone123',
            branch: 'main',
            dir: 'libGraphLevelOne',
          }],
        },
        actions: {
          common: [{
            command: 'codepac install libGraphLevelTwo --configdir GraphLevelTwoCfg --targetdir ',
          }],
        },
      }, null, 2),
      'utf-8'
    );
    await fs.writeFile(
      path.join(secondConfigDir, 'codepac-dep.json'),
      JSON.stringify({
        version: '2.0.56',
        repos: {
          common: [{
            url: 'https://github.com/test/libGraphLevelTwo.git',
            commit: 'graphleveltwo123',
            branch: 'main',
            dir: 'libGraphLevelTwo',
          }],
        },
      }, null, 2),
      'utf-8'
    );

    const dependencies = await collectProjectDependencyGraph(env.projectDir);

    expect(dependencies.map((item) => item.libName)).toEqual(
      expect.arrayContaining(['libGraphLevelOne', 'libGraphLevelTwo'])
    );
  });

  it('should visit the same nested config independently for different target directories', async () => {
    env = await createTestEnv();

    const thirdPartyDir = path.join(env.projectDir, '3rdparty');
    const sharedConfigDir = path.join(thirdPartyDir, 'SharedGraphCfg');
    await fs.mkdir(sharedConfigDir, { recursive: true });
    await fs.mkdir(path.join(thirdPartyDir, 'GraphTargetA', 'ChildCfg'), { recursive: true });
    await fs.mkdir(path.join(thirdPartyDir, 'GraphTargetB', 'ChildCfg'), { recursive: true });
    await fs.writeFile(
      path.join(thirdPartyDir, 'codepac-dep.json'),
      JSON.stringify({
        version: '2.0.56',
        repos: {},
        actions: {
          common: [
            { command: 'codepac install --configdir SharedGraphCfg --targetdir GraphTargetA' },
            { command: 'codepac install --configdir SharedGraphCfg --targetdir GraphTargetB' },
          ],
        },
      }, null, 2),
      'utf-8'
    );
    await fs.writeFile(
      path.join(sharedConfigDir, 'codepac-dep.json'),
      JSON.stringify({
        version: '2.0.56',
        repos: {},
        actions: {
          common: [{ command: 'codepac install --configdir ChildCfg --targetdir ' }],
        },
      }, null, 2),
      'utf-8'
    );
    await fs.writeFile(
      path.join(thirdPartyDir, 'GraphTargetA', 'ChildCfg', 'codepac-dep.json'),
      JSON.stringify({
        version: '2.0.56',
        repos: {
          common: [{
            url: 'https://github.com/test/libGraphTargetA.git',
            commit: 'graphtargeta123',
            branch: 'main',
            dir: 'libGraphTargetA',
          }],
        },
      }, null, 2),
      'utf-8'
    );
    await fs.writeFile(
      path.join(thirdPartyDir, 'GraphTargetB', 'ChildCfg', 'codepac-dep.json'),
      JSON.stringify({
        version: '2.0.56',
        repos: {
          common: [{
            url: 'https://github.com/test/libGraphTargetB.git',
            commit: 'graphtargetb123',
            branch: 'main',
            dir: 'libGraphTargetB',
          }],
        },
      }, null, 2),
      'utf-8'
    );

    const dependencies = await collectProjectDependencyGraph(env.projectDir);

    expect(dependencies.map((item) => item.libName)).toEqual(
      expect.arrayContaining(['libGraphTargetA', 'libGraphTargetB'])
    );
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
