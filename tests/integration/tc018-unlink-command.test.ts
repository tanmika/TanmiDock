/**
 * TC-018: unlink 命令测试
 *
 * 测试场景:
 * - S-3.1.1: 单平台链接还原（General 库）
 * - S-3.1.2: 多平台链接还原
 * - S-3.2.1: 移除项目记录
 * - S-3.2.2: 更新 libraries/stores 引用关系
 * - S-3.3.1: --remove 选项删除无引用库
 * - S-3.3.2: --remove 选项保护有引用库
 * - S-3.4.1: 未跟踪项目报错
 *
 * v2.0: 调用 unlinkProject() 入口函数，不手动模拟
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import {
  createTestEnv,
  createMockStoreDataV2,
  createMockGeneralStoreData,
  loadRegistry,
  saveRegistry,
  runCommand,
  verifyDirectoryExists,
  verifyDirectoryDeleted,
  hashPath,
  type TestEnv,
} from './setup.js';
import { isSymlink, readLink } from '../../src/core/linker.js';

/**
 * 创建已链接的测试项目
 * 先创建 Store 数据，然后运行 link 命令
 */
async function createLinkedProject(
  env: TestEnv,
  deps: Array<{
    libName: string;
    commit: string;
    platforms: string[];
    isGeneral?: boolean;
  }>,
  linkPlatforms: string[]
): Promise<void> {
  // 创建 Store 数据
  for (const dep of deps) {
    if (dep.isGeneral) {
      await createMockGeneralStoreData(env, dep.libName, dep.commit);
    } else {
      await createMockStoreDataV2(env, {
        libName: dep.libName,
        commit: dep.commit,
        platforms: dep.platforms,
        referencedBy: [],
      });
    }
  }

  // 创建 codepac-dep.json
  const thirdPartyDir = path.join(env.projectDir, '3rdparty');
  await fs.mkdir(thirdPartyDir, { recursive: true });
  const codepacDep = {
    version: '1.0.0',
    vars: {},
    repos: {
      common: deps.map(d => ({
        url: `https://github.com/test/${d.libName}.git`,
        commit: d.commit,
        branch: 'main',
        dir: d.libName,
      })),
    },
  };
  await fs.writeFile(
    path.join(thirdPartyDir, 'codepac-dep.json'),
    JSON.stringify(codepacDep, null, 2),
    'utf-8'
  );

  // 执行 link 命令
  await runCommand('link', { platform: linkPlatforms, yes: true }, env, env.projectDir);
}

describe('TC-018: unlink 命令测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('S-3.1.1: General 库链接还原', () => {
    it('should restore General library from symlink to directory', async () => {
      env = await createTestEnv();

      const libName = 'libGeneralUnlink';
      const commit = 'generalunlink123456';

      // 创建并链接 General 库（需要本地有 _shared 目录触发 ABSORB）
      const thirdPartyDir = path.join(env.projectDir, '3rdparty');
      await fs.mkdir(thirdPartyDir, { recursive: true });

      // 创建 codepac-dep.json
      const codepacDep = {
        version: '1.0.0',
        vars: {},
        repos: {
          common: [
            {
              url: `https://github.com/test/${libName}.git`,
              commit,
              branch: 'main',
              dir: libName,
            },
          ],
        },
      };
      await fs.writeFile(
        path.join(thirdPartyDir, 'codepac-dep.json'),
        JSON.stringify(codepacDep, null, 2),
        'utf-8'
      );

      // 创建本地 General 库目录
      const localPath = path.join(thirdPartyDir, libName);
      const localSharedPath = path.join(localPath, '_shared');
      await fs.mkdir(localSharedPath, { recursive: true });
      await fs.writeFile(path.join(localSharedPath, 'config.cmake'), '# CMake config', 'utf-8');

      // 执行 link 命令
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // 验证是符号链接
      expect(await isSymlink(localPath)).toBe(true);

      // 执行 unlink 命令
      await runCommand('unlink', { remove: false }, env, env.projectDir);

      // 验证已还原为普通目录
      const stat = await fs.lstat(localPath);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isDirectory()).toBe(true);

      // 验证内容存在
      await verifyDirectoryExists(path.join(localPath, '_shared'));
    });
  });

  describe('S-3.1.2: 多平台链接还原', () => {
    it('should restore multi-platform links to directories', async () => {
      env = await createTestEnv();

      const libName = 'libMultiUnlink';
      const commit = 'multiunlink123456';

      // 创建并链接多平台库
      await createLinkedProject(
        env,
        [{ libName, commit, platforms: ['macOS', 'iOS'] }],
        ['macOS', 'iOS']
      );

      const localPath = path.join(env.projectDir, '3rdparty', libName);

      // 验证是多平台链接结构
      const topStat = await fs.lstat(localPath);
      expect(topStat.isDirectory()).toBe(true);
      expect(topStat.isSymbolicLink()).toBe(false);
      expect(await isSymlink(path.join(localPath, 'macOS'))).toBe(true);
      expect(await isSymlink(path.join(localPath, 'iOS'))).toBe(true);

      // 执行 unlink 命令
      await runCommand('unlink', { remove: false }, env, env.projectDir);

      // 验证平台目录已还原为普通目录
      expect(await isSymlink(path.join(localPath, 'macOS'))).toBe(false);
      expect(await isSymlink(path.join(localPath, 'iOS'))).toBe(false);

      // 验证内容存在
      await verifyDirectoryExists(path.join(localPath, 'macOS'));
      await verifyDirectoryExists(path.join(localPath, 'iOS'));
    });
  });

  describe('S-3.2.1: 移除项目记录', () => {
    it('should remove project record from registry', async () => {
      env = await createTestEnv();

      const libName = 'libProjectRecord';
      const commit = 'projectrecord123456';

      // 创建并链接
      await createLinkedProject(env, [{ libName, commit, platforms: ['macOS'] }], ['macOS']);

      // 验证项目记录存在
      let registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      expect(registry.projects[projectHash]).toBeDefined();

      // 执行 unlink 命令
      await runCommand('unlink', { remove: false }, env, env.projectDir);

      // 验证项目记录已删除
      registry = await loadRegistry(env);
      expect(registry.projects[projectHash]).toBeUndefined();
    });
  });

  describe('S-3.2.2: 更新引用关系', () => {
    it('should update libraries.referencedBy after unlink', async () => {
      env = await createTestEnv();

      const libName = 'libRefUpdate';
      const commit = 'refupdate123456';

      // 创建并链接
      await createLinkedProject(env, [{ libName, commit, platforms: ['macOS'] }], ['macOS']);

      // 验证有引用 (通过 StoreEntry.usedBy)
      let registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      const libKey = `${libName}:${commit}`;
      const storeKey = `${libName}:${commit}:macOS`;
      expect(registry.stores[storeKey].usedBy).toContain(projectHash);

      // 执行 unlink 命令
      await runCommand('unlink', { remove: false }, env, env.projectDir);

      // 验证引用已移除 (通过 StoreEntry.usedBy)
      registry = await loadRegistry(env);
      expect(registry.libraries[libKey]).toBeDefined();
      expect(registry.stores[storeKey].usedBy).not.toContain(projectHash);
    });

    it('should update stores.usedBy after unlink', async () => {
      env = await createTestEnv();

      const libName = 'libStoreRef';
      const commit = 'storeref123456';

      // 创建并链接
      await createLinkedProject(env, [{ libName, commit, platforms: ['macOS'] }], ['macOS']);

      // 验证有引用
      let registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      const storeKey = `${libName}:${commit}:macOS`;
      expect(registry.stores[storeKey].usedBy).toContain(projectHash);

      // 执行 unlink 命令
      await runCommand('unlink', { remove: false }, env, env.projectDir);

      // 验证引用已移除但 Store 记录还在
      registry = await loadRegistry(env);
      expect(registry.stores[storeKey]).toBeDefined();
      expect(registry.stores[storeKey].usedBy).not.toContain(projectHash);
    });
  });

  describe('S-3.3.1: --remove 选项删除无引用库', () => {
    it('should remove unreferenced library with --remove option', async () => {
      env = await createTestEnv();

      const libName = 'libRemove';
      const commit = 'remove123456789';

      // 创建并链接
      await createLinkedProject(env, [{ libName, commit, platforms: ['macOS'] }], ['macOS']);

      // 验证 Store 目录存在
      const storeCommitPath = path.join(env.storeDir, libName, commit);
      await verifyDirectoryExists(storeCommitPath);

      // 执行 unlink 命令（带 --remove）
      await runCommand('unlink', { remove: true }, env, env.projectDir);

      // 验证 Store 目录已删除
      await verifyDirectoryDeleted(storeCommitPath);

      // 验证 Registry 记录已删除
      const registry = await loadRegistry(env);
      const libKey = `${libName}:${commit}`;
      expect(registry.libraries[libKey]).toBeUndefined();
    });
  });

  describe('S-3.3.2: --remove 选项保护有引用库', () => {
    it('should not remove library if still referenced by other projects', async () => {
      env = await createTestEnv();

      const libName = 'libProtected';
      const commit = 'protected123456';
      const otherProjectPath = path.join(env.tempDir, 'other-project');

      // 创建另一个项目目录（使其成为有效引用）
      await fs.mkdir(otherProjectPath, { recursive: true });

      // 创建 Store 数据，设置有其他项目引用
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        referencedBy: [otherProjectPath], // 其他项目引用
      });

      // 为其他项目创建 Registry 记录（使引用有效）
      const registry = await loadRegistry(env);
      const otherProjectHash = hashPath(otherProjectPath);
      registry.projects[otherProjectHash] = {
        path: otherProjectPath,
        configPath: path.join(otherProjectPath, '3rdparty', 'codepac-dep.json'),
        lastLinked: new Date().toISOString(),
        platforms: ['macOS'],
        dependencies: [{
          libName,
          commit,
          platform: 'macOS',
          linkedPath: `3rdparty/${libName}/macOS`,
        }],
      };
      await saveRegistry(env, registry);

      // 创建 codepac-dep.json
      const thirdPartyDir = path.join(env.projectDir, '3rdparty');
      await fs.mkdir(thirdPartyDir, { recursive: true });
      const codepacDep = {
        version: '1.0.0',
        vars: {},
        repos: {
          common: [
            {
              url: `https://github.com/test/${libName}.git`,
              commit,
              branch: 'main',
              dir: libName,
            },
          ],
        },
      };
      await fs.writeFile(
        path.join(thirdPartyDir, 'codepac-dep.json'),
        JSON.stringify(codepacDep, null, 2),
        'utf-8'
      );

      // 执行 link 命令
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // 执行 unlink 命令（带 --remove）
      await runCommand('unlink', { remove: true }, env, env.projectDir);

      // 验证 Store 目录仍存在（因为还有其他引用）
      const storeCommitPath = path.join(env.storeDir, libName, commit);
      await verifyDirectoryExists(storeCommitPath);

      // 验证 Registry 记录仍存在
      const afterRegistry = await loadRegistry(env);
      const libKey = `${libName}:${commit}`;
      expect(afterRegistry.libraries[libKey]).toBeDefined();
    });
  });

  describe('S-3.4: 边界情况', () => {
    it('should handle multiple libraries in one unlink', async () => {
      env = await createTestEnv();

      // 创建并链接两个库（都支持相同平台）
      await createLinkedProject(
        env,
        [
          { libName: 'libUnlinkA', commit: 'unlinka123456789', platforms: ['macOS', 'iOS'] },
          { libName: 'libUnlinkB', commit: 'unlinkb123456789', platforms: ['macOS', 'iOS'] },
        ],
        ['macOS']
      );

      // 验证两个库都链接了
      const localPathA = path.join(env.projectDir, '3rdparty', 'libUnlinkA');
      const localPathB = path.join(env.projectDir, '3rdparty', 'libUnlinkB');
      expect(await isSymlink(path.join(localPathA, 'macOS'))).toBe(true);
      expect(await isSymlink(path.join(localPathB, 'macOS'))).toBe(true);

      // 执行 unlink 命令
      await runCommand('unlink', { remove: false }, env, env.projectDir);

      // 验证两个库都还原了
      expect(await isSymlink(path.join(localPathA, 'macOS'))).toBe(false);
      expect(await isSymlink(path.join(localPathB, 'macOS'))).toBe(false);

      // 验证项目记录已删除
      const registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      expect(registry.projects[projectHash]).toBeUndefined();
    });

    it('should preserve _shared files after unlink', async () => {
      env = await createTestEnv();

      const libName = 'libSharedPreserve';
      const commit = 'sharedpreserve123456';

      // 创建带 _shared 的库
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        sharedFiles: {
          'config.cmake': '# Important config',
          'version.txt': '1.0.0',
        },
        referencedBy: [],
      });

      // 创建 codepac-dep.json
      const thirdPartyDir = path.join(env.projectDir, '3rdparty');
      await fs.mkdir(thirdPartyDir, { recursive: true });
      const codepacDep = {
        version: '1.0.0',
        vars: {},
        repos: {
          common: [
            {
              url: `https://github.com/test/${libName}.git`,
              commit,
              branch: 'main',
              dir: libName,
            },
          ],
        },
      };
      await fs.writeFile(
        path.join(thirdPartyDir, 'codepac-dep.json'),
        JSON.stringify(codepacDep, null, 2),
        'utf-8'
      );

      // 执行 link 命令
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      const localPath = path.join(thirdPartyDir, libName);

      // 验证 _shared 文件被复制到本地
      const configPath = path.join(localPath, 'config.cmake');
      expect(await fs.readFile(configPath, 'utf-8')).toBe('# Important config');

      // 执行 unlink 命令
      await runCommand('unlink', { remove: false }, env, env.projectDir);

      // 验证 _shared 文件仍存在
      expect(await fs.readFile(configPath, 'utf-8')).toBe('# Important config');
    });
  });
});

/**
 * TC-018 回归测试: 嵌套依赖 unlink 验证
 *
 * 验证 unlink 命令正确处理嵌套依赖的 Registry 引用：
 * - unlink 后嵌套库的 usedBy 应正确移除项目引用
 * - 多项目共享嵌套库时，unlink 只移除当前项目的引用
 */
describe('TC-018: 嵌套依赖 unlink 回归测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  /**
   * 创建带嵌套依赖的本地库
   */
  async function createLocalLibWithNestedDeps(
    projectDir: string,
    mainLib: { name: string; commit: string },
    nestedLibs: Array<{ name: string; commit: string; platforms: string[] }>
  ): Promise<void> {
    const thirdPartyDir = path.join(projectDir, '3rdparty');
    const mainLibDir = path.join(thirdPartyDir, mainLib.name);
    await fs.mkdir(mainLibDir, { recursive: true });

    // 创建主库平台目录
    const mainPlatformDir = path.join(mainLibDir, 'macOS');
    await fs.mkdir(mainPlatformDir, { recursive: true });
    await fs.writeFile(path.join(mainPlatformDir, 'lib.a'), 'main lib content', 'utf-8');

    // 创建 dependencies 目录和嵌套库
    const depsDir = path.join(mainLibDir, 'dependencies');
    await fs.mkdir(depsDir, { recursive: true });

    for (const nested of nestedLibs) {
      const nestedLibDir = path.join(depsDir, nested.name);
      await fs.mkdir(nestedLibDir, { recursive: true });

      // 创建嵌套库的平台目录
      for (const platform of nested.platforms) {
        const nestedPlatformDir = path.join(nestedLibDir, platform);
        await fs.mkdir(nestedPlatformDir, { recursive: true });
        await fs.writeFile(
          path.join(nestedPlatformDir, 'nested.a'),
          `Nested lib ${nested.name} for ${platform}`,
          'utf-8'
        );
      }

      // 创建 .git/commit_hash 文件
      const gitDir = path.join(nestedLibDir, '.git');
      await fs.mkdir(gitDir, { recursive: true });
      await fs.writeFile(path.join(gitDir, 'commit_hash'), nested.commit, 'utf-8');
    }

    // 创建配置文件
    const codepacDep = {
      version: '1.0.0',
      repos: {
        common: [
          {
            url: `https://github.com/test/${mainLib.name}.git`,
            commit: mainLib.commit,
            branch: 'main',
            dir: mainLib.name,
          },
        ],
      },
    };
    await fs.writeFile(
      path.join(thirdPartyDir, 'codepac-dep.json'),
      JSON.stringify(codepacDep, null, 2),
      'utf-8'
    );
  }

  it('should register nested library in Registry after link', async () => {
    env = await createTestEnv();

    const mainLib = { name: 'libMainUnlink', commit: 'aaa1111111' };
    const nestedLib = { name: 'libNestedUnlink', commit: 'bbb2222222', platforms: ['macOS'] };

    // Given: 本地库带嵌套依赖
    await createLocalLibWithNestedDeps(env.projectDir, mainLib, [nestedLib]);

    // When: 执行 link（触发 ABSORB + registerNestedLibraries）
    await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

    // Then: 嵌套库在 Registry 中且有引用
    const registry = await loadRegistry(env);
    const projectHash = hashPath(env.projectDir);
    const nestedStoreKey = `${nestedLib.name}:${nestedLib.commit}:macOS`;
    const nestedLibKey = `${nestedLib.name}:${nestedLib.commit}`;

    // 【关键验证】嵌套库被注册到 Registry
    expect(registry.libraries[nestedLibKey]).toBeDefined();
    expect(registry.stores[nestedStoreKey]).toBeDefined();
    expect(registry.stores[nestedStoreKey].usedBy).toContain(projectHash);
  });

  it('should clean up nested library usedBy after unlink', async () => {
    env = await createTestEnv();

    const mainLib = { name: 'libMainCleanup', commit: 'eee1111111' };
    const nestedLib = { name: 'libNestedCleanup', commit: 'fff2222222', platforms: ['macOS'] };

    // Given: 本地库带嵌套依赖，已 link
    await createLocalLibWithNestedDeps(env.projectDir, mainLib, [nestedLib]);
    await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

    // 验证嵌套库已注册
    let registry = await loadRegistry(env);
    const projectHash = hashPath(env.projectDir);
    const nestedStoreKey = `${nestedLib.name}:${nestedLib.commit}:macOS`;
    expect(registry.stores[nestedStoreKey].usedBy).toContain(projectHash);

    // When: 执行 unlink
    await runCommand('unlink', { remove: false }, env, env.projectDir);

    // Then: 嵌套库的 usedBy 不再包含项目引用
    registry = await loadRegistry(env);
    expect(registry.stores[nestedStoreKey]).toBeDefined();
    expect(registry.stores[nestedStoreKey].usedBy).not.toContain(projectHash);
  });

  it('should register nested library with multiple project references', async () => {
    env = await createTestEnv();

    const mainLib = { name: 'libSharedMain', commit: 'ccc1111111' };
    const nestedLib = { name: 'libSharedNested', commit: 'ddd2222222', platforms: ['macOS'] };

    // Given: 第一个项目链接带嵌套依赖的库
    await createLocalLibWithNestedDeps(env.projectDir, mainLib, [nestedLib]);
    await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

    // 创建第二个项目并手动添加引用（模拟另一个项目也链接了同一嵌套库）
    const otherProjectPath = path.join(env.tempDir, 'other-project');
    await fs.mkdir(otherProjectPath, { recursive: true });

    let registry = await loadRegistry(env);
    const otherProjectHash = hashPath(otherProjectPath);
    const nestedStoreKey = `${nestedLib.name}:${nestedLib.commit}:macOS`;
    const nestedLibKey = `${nestedLib.name}:${nestedLib.commit}`;
    const projectHash = hashPath(env.projectDir);

    // 添加另一个项目的引用
    registry.projects[otherProjectHash] = {
      path: otherProjectPath,
      configPath: path.join(otherProjectPath, '3rdparty', 'codepac-dep.json'),
      lastLinked: new Date().toISOString(),
      platforms: ['macOS'],
      dependencies: [],
    };
    registry.stores[nestedStoreKey].usedBy.push(otherProjectHash);
    await saveRegistry(env, registry);

    // Then: 嵌套库被注册且有两个项目引用
    registry = await loadRegistry(env);
    expect(registry.libraries[nestedLibKey]).toBeDefined();
    expect(registry.stores[nestedStoreKey]).toBeDefined();
    expect(registry.stores[nestedStoreKey].usedBy).toContain(projectHash);
    expect(registry.stores[nestedStoreKey].usedBy).toContain(otherProjectHash);
  });

  it('should preserve other project references when unlink', async () => {
    env = await createTestEnv();

    const mainLib = { name: 'libSharedMain2', commit: 'aaa3333333' };
    const nestedLib = { name: 'libSharedNested2', commit: 'bbb4444444', platforms: ['macOS'] };

    // Given: 第一个项目链接带嵌套依赖的库
    await createLocalLibWithNestedDeps(env.projectDir, mainLib, [nestedLib]);
    await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

    // 创建第二个项目并手动添加引用
    const otherProjectPath = path.join(env.tempDir, 'other-project-2');
    await fs.mkdir(otherProjectPath, { recursive: true });

    let registry = await loadRegistry(env);
    const otherProjectHash = hashPath(otherProjectPath);
    const nestedStoreKey = `${nestedLib.name}:${nestedLib.commit}:macOS`;
    const nestedLibKey = `${nestedLib.name}:${nestedLib.commit}`;
    const projectHash = hashPath(env.projectDir);

    // 添加另一个项目的引用
    registry.projects[otherProjectHash] = {
      path: otherProjectPath,
      configPath: path.join(otherProjectPath, '3rdparty', 'codepac-dep.json'),
      lastLinked: new Date().toISOString(),
      platforms: ['macOS'],
      dependencies: [],
    };
    registry.stores[nestedStoreKey].usedBy.push(otherProjectHash);
    await saveRegistry(env, registry);

    // 验证两个项目都有引用
    registry = await loadRegistry(env);
    expect(registry.stores[nestedStoreKey].usedBy).toContain(projectHash);
    expect(registry.stores[nestedStoreKey].usedBy).toContain(otherProjectHash);

    // When: 第一个项目 unlink
    await runCommand('unlink', { remove: false }, env, env.projectDir);

    // Then: 嵌套库仍存在，只移除第一个项目的引用，保留第二个项目的引用
    registry = await loadRegistry(env);
    expect(registry.libraries[nestedLibKey]).toBeDefined();
    expect(registry.stores[nestedStoreKey]).toBeDefined();
    expect(registry.stores[nestedStoreKey].usedBy).not.toContain(projectHash);
    expect(registry.stores[nestedStoreKey].usedBy).toContain(otherProjectHash);
  });
});
