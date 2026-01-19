/**
 * TC-017: link 命令测试
 *
 * 测试场景:
 * - S-2.1.1: ABSORB - 本地目录吸收到 Store
 * - S-2.1.2: REPLACE - Store 已有时替换本地目录
 * - S-2.1.3: LINK_NEW - Store 有本地无，创建链接
 * - S-2.1.4: LINKED - 已正确链接，跳过
 * - S-2.2.1: 多平台链接结构验证
 * - S-2.2.2: General 类型库的整目录链接
 * - S-2.2.3: Registry 记录正确更新
 * - S-2.2.4: _shared 文件正确复制
 * - S-2.3.1: --dry-run 模式
 *
 * v2.0: 调用 linkProject() 入口函数，不手动模拟
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
  verifySymlink,
  verifyDirectoryExists,
  verifyFileExists,
  hashPath,
  type TestEnv,
} from './setup.js';
import { isSymlink, readLink } from '../../src/core/linker.js';

/**
 * 创建测试项目结构
 * - 创建 3rdparty/codepac-dep.json
 * - 可选创建本地库目录
 */
async function createTestProject(
  env: TestEnv,
  deps: Array<{
    libName: string;
    commit: string;
    branch?: string;
    url?: string;
    sparse?: string[];
    /** 是否创建本地目录 */
    createLocal?: boolean;
    /** 本地目录的平台列表 */
    localPlatforms?: string[];
  }>
): Promise<string> {
  const thirdPartyDir = path.join(env.projectDir, '3rdparty');
  await fs.mkdir(thirdPartyDir, { recursive: true });

  // 创建 codepac-dep.json
  const codepacDep = {
    version: '1.0.0',
    vars: {},
    repos: {
      common: deps.map(d => ({
        url: d.url ?? `https://github.com/test/${d.libName}.git`,
        commit: d.commit,
        branch: d.branch ?? 'main',
        dir: d.libName,
        sparse: d.sparse,
      })),
    },
  };
  const configPath = path.join(thirdPartyDir, 'codepac-dep.json');
  await fs.writeFile(configPath, JSON.stringify(codepacDep, null, 2), 'utf-8');

  // 创建本地库目录
  for (const dep of deps) {
    if (dep.createLocal && dep.localPlatforms) {
      const libDir = path.join(thirdPartyDir, dep.libName);
      for (const platform of dep.localPlatforms) {
        const platformDir = path.join(libDir, platform);
        await fs.mkdir(platformDir, { recursive: true });
        await fs.writeFile(
          path.join(platformDir, 'lib.a'),
          `Local library for ${platform}`,
          'utf-8'
        );
        await fs.writeFile(
          path.join(platformDir, 'include.h'),
          `// Local header for ${platform}`,
          'utf-8'
        );
      }
    }
  }

  return configPath;
}

/**
 * 验证链接结果
 */
async function verifyLinkResult(
  env: TestEnv,
  libName: string,
  commit: string,
  platforms: string[]
): Promise<void> {
  const localPath = path.join(env.projectDir, '3rdparty', libName);
  const storeCommitPath = path.join(env.storeDir, libName, commit);

  // 本地应该是普通目录（多平台结构）
  const stat = await fs.lstat(localPath);
  expect(stat.isDirectory()).toBe(true);
  expect(stat.isSymbolicLink()).toBe(false);

  // 各平台子目录应该是符号链接
  for (const platform of platforms) {
    const platformPath = path.join(localPath, platform);
    await verifySymlink(platformPath, path.join(storeCommitPath, platform));
  }
}

/**
 * 验证 Registry 项目记录
 */
async function verifyProjectRegistry(
  env: TestEnv,
  libName: string,
  commit: string,
  platforms: string[]
): Promise<void> {
  const registry = await loadRegistry(env);
  const projectHash = hashPath(env.projectDir);

  // 检查项目记录
  expect(registry.projects[projectHash]).toBeDefined();
  const project = registry.projects[projectHash];
  expect(project.path).toBe(env.projectDir);

  // 检查依赖记录
  const dep = project.dependencies?.find((d: { libName: string }) => d.libName === libName);
  expect(dep).toBeDefined();
  expect(dep.commit).toBe(commit);

  // 检查 libraries 记录
  const libKey = `${libName}:${commit}`;
  expect(registry.libraries[libKey]).toBeDefined();

  // 检查 stores 记录（引用通过 usedBy 追踪）
  for (const platform of platforms) {
    const storeKey = `${libName}:${commit}:${platform}`;
    expect(registry.stores[storeKey]).toBeDefined();
    expect(registry.stores[storeKey].usedBy).toContain(projectHash);
  }
}

describe('TC-017: link 命令测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('S-2.1.1: ABSORB - 本地目录吸收到 Store', () => {
    it('should absorb local directory to Store', async () => {
      env = await createTestEnv();

      const libName = 'libAbsorb';
      const commit = 'absorb123456789';

      // 创建测试项目，带有本地库目录
      await createTestProject(env, [
        {
          libName,
          commit,
          createLocal: true,
          localPlatforms: ['macOS'],
        },
      ]);

      // 验证本地目录存在且不是链接
      const localPath = path.join(env.projectDir, '3rdparty', libName);
      const localPlatformPath = path.join(localPath, 'macOS');
      await verifyDirectoryExists(localPlatformPath);
      expect(await isSymlink(localPlatformPath)).toBe(false);

      // 执行 link 命令
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // 验证 Store 目录已创建
      const storeCommitPath = path.join(env.storeDir, libName, commit);
      await verifyDirectoryExists(path.join(storeCommitPath, 'macOS'));

      // 验证本地变为链接结构
      await verifyLinkResult(env, libName, commit, ['macOS']);

      // 验证 Registry 记录
      await verifyProjectRegistry(env, libName, commit, ['macOS']);
    });

    it('should absorb multiple platforms from local directory', async () => {
      env = await createTestEnv();

      const libName = 'libMultiAbsorb';
      const commit = 'multiabsorb123456';

      // 创建包含多平台的本地目录
      await createTestProject(env, [
        {
          libName,
          commit,
          createLocal: true,
          localPlatforms: ['macOS', 'iOS'],
        },
      ]);

      // 执行 link 命令
      await runCommand('link', { platform: ['macOS', 'iOS'], yes: true }, env, env.projectDir);

      // 验证两个平台都被吸收并链接
      await verifyLinkResult(env, libName, commit, ['macOS', 'iOS']);
      await verifyProjectRegistry(env, libName, commit, ['macOS', 'iOS']);
    });
  });

  describe('S-2.1.2: REPLACE - Store 已有时替换本地目录', () => {
    it('should replace local directory with Store link', async () => {
      env = await createTestEnv();

      const libName = 'libReplace';
      const commit = 'replace123456789';

      // 先在 Store 创建库（无 registry 引用）
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 创建测试项目，本地有普通目录
      await createTestProject(env, [
        {
          libName,
          commit,
          createLocal: true,
          localPlatforms: ['macOS'],
        },
      ]);

      // 验证本地是普通目录
      const localPath = path.join(env.projectDir, '3rdparty', libName);
      expect(await isSymlink(path.join(localPath, 'macOS'))).toBe(false);

      // 执行 link 命令
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // 验证本地变为链接
      await verifyLinkResult(env, libName, commit, ['macOS']);
      await verifyProjectRegistry(env, libName, commit, ['macOS']);
    });
  });

  describe('S-2.1.3: LINK_NEW - Store 有本地无', () => {
    it('should create link when Store has library but local does not', async () => {
      env = await createTestEnv();

      const libName = 'libLinkNew';
      const commit = 'linknew123456789';

      // Store 已有库
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS', 'iOS'],
        referencedBy: [],
      });

      // 创建测试项目（不创建本地目录）
      await createTestProject(env, [
        {
          libName,
          commit,
          createLocal: false,
        },
      ]);

      // 执行 link 命令
      await runCommand('link', { platform: ['macOS', 'iOS'], yes: true }, env, env.projectDir);

      // 验证链接创建
      await verifyLinkResult(env, libName, commit, ['macOS', 'iOS']);
      await verifyProjectRegistry(env, libName, commit, ['macOS', 'iOS']);
    });
  });

  describe('S-2.1.4: LINKED - 已正确链接', () => {
    it('should skip when already correctly linked', async () => {
      env = await createTestEnv();

      const libName = 'libLinked';
      const commit = 'linked123456789';

      // Store 已有库
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 创建测试项目
      await createTestProject(env, [
        {
          libName,
          commit,
          createLocal: false,
        },
      ]);

      // 第一次 link
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // 记录链接信息
      const localPath = path.join(env.projectDir, '3rdparty', libName, 'macOS');
      const targetBefore = await readLink(localPath);

      // 第二次 link（应该跳过）
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // 验证链接未改变
      const targetAfter = await readLink(localPath);
      expect(targetAfter).toBe(targetBefore);
    });
  });

  describe('S-2.2.1: 多平台链接结构验证', () => {
    it('should create correct multi-platform link structure', async () => {
      env = await createTestEnv();

      const libName = 'libMultiPlatform';
      const commit = 'multiplatform123456';

      // Store 已有多平台库
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS', 'iOS', 'android'],
        referencedBy: [],
        sharedFiles: {
          'common.cmake': '# CMake config',
          'version.h': '#define VERSION "1.0.0"',
        },
      });

      // 创建测试项目
      await createTestProject(env, [
        {
          libName,
          commit,
          createLocal: false,
        },
      ]);

      // 执行 link 命令
      await runCommand(
        'link',
        { platform: ['macOS', 'iOS', 'android'], yes: true },
        env,
        env.projectDir
      );

      const localPath = path.join(env.projectDir, '3rdparty', libName);

      // 验证顶层是普通目录
      const stat = await fs.lstat(localPath);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isDirectory()).toBe(true);

      // 验证各平台子目录是符号链接
      for (const platform of ['macOS', 'iOS', 'android']) {
        const platformPath = path.join(localPath, platform);
        expect(await isSymlink(platformPath)).toBe(true);
      }

      // 验证 _shared 文件被复制（不是链接）
      const commonCmakePath = path.join(localPath, 'common.cmake');
      await verifyFileExists(commonCmakePath);
      expect(await isSymlink(commonCmakePath)).toBe(false);

      const versionHPath = path.join(localPath, 'version.h');
      await verifyFileExists(versionHPath);
    });
  });

  describe('S-2.2.2: General 类型库', () => {
    it('should absorb and link General library with only _shared directory', async () => {
      env = await createTestEnv();

      const libName = 'libGeneral';
      const commit = 'general123456789';

      // 创建测试项目（不创建 Store 数据）
      await createTestProject(env, [
        {
          libName,
          commit,
          createLocal: false,
        },
      ]);

      // 手动创建本地 General 库目录（只有 _shared 内容，无平台目录）
      const localPath = path.join(env.projectDir, '3rdparty', libName);
      const localSharedPath = path.join(localPath, '_shared');
      await fs.mkdir(localSharedPath, { recursive: true });
      await fs.writeFile(path.join(localSharedPath, 'config.cmake'), '# CMake config', 'utf-8');
      await fs.writeFile(path.join(localSharedPath, 'codepac-dep.json'), '{}', 'utf-8');

      // 执行 link 命令
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      const storeSharedPath = path.join(env.storeDir, libName, commit, '_shared');

      // General 库应该整目录是符号链接
      expect(await isSymlink(localPath)).toBe(true);
      await verifySymlink(localPath, storeSharedPath);

      // Store 中应该有 _shared 目录
      await verifyDirectoryExists(storeSharedPath);
    });

    it('should link existing General library from Store', async () => {
      env = await createTestEnv();

      const libName = 'libGeneralExist';
      const commit = 'generalexist123456';

      // 先在 Store 创建 General 库
      await createMockGeneralStoreData(env, libName, commit);

      // 创建测试项目，带有本地 _shared 目录（会被识别为 ABSORB 然后发现 Store 已有）
      await createTestProject(env, [
        {
          libName,
          commit,
          createLocal: false,
        },
      ]);

      // 手动创建本地 _shared 目录（模拟已有但未链接的 General 库）
      const localPath = path.join(env.projectDir, '3rdparty', libName);
      const localSharedPath = path.join(localPath, '_shared');
      await fs.mkdir(localSharedPath, { recursive: true });
      await fs.writeFile(path.join(localSharedPath, 'local.txt'), 'local content', 'utf-8');

      // 执行 link 命令
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // General 库应该整目录是符号链接
      const storeSharedPath = path.join(env.storeDir, libName, commit, '_shared');
      expect(await isSymlink(localPath)).toBe(true);
      await verifySymlink(localPath, storeSharedPath);
    });
  });

  describe('S-2.2.3: Registry 记录正确更新', () => {
    it('should update Registry libraries and stores correctly', async () => {
      env = await createTestEnv();

      const libName = 'libRegistryUpdate';
      const commit = 'registryupdate123456';

      // Store 已有库
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS', 'iOS'],
        referencedBy: [],
      });

      // 创建测试项目
      await createTestProject(env, [
        {
          libName,
          commit,
          createLocal: false,
        },
      ]);

      // 执行 link 命令
      await runCommand('link', { platform: ['macOS', 'iOS'], yes: true }, env, env.projectDir);

      // 验证 Registry
      const registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);

      // libraries 记录应存在
      const libKey = `${libName}:${commit}`;
      expect(registry.libraries[libKey]).toBeDefined();

      // stores 记录应包含引用（引用通过 usedBy 追踪）
      expect(registry.stores[`${libName}:${commit}:macOS`].usedBy).toContain(projectHash);
      expect(registry.stores[`${libName}:${commit}:iOS`].usedBy).toContain(projectHash);

      // projects 记录应存在
      expect(registry.projects[projectHash]).toBeDefined();
      expect(registry.projects[projectHash].dependencies).toHaveLength(1);
    });

    it('should update references when re-linking with different platforms', async () => {
      env = await createTestEnv();

      const libName = 'libRelinkPlatforms';
      const commit = 'relinkplatforms123456';

      // Store 已有多平台库
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS', 'iOS', 'android'],
        referencedBy: [],
      });

      // 创建测试项目
      await createTestProject(env, [
        {
          libName,
          commit,
          createLocal: false,
        },
      ]);

      // 第一次 link - macOS
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // 验证 macOS 引用
      let registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      expect(registry.stores[`${libName}:${commit}:macOS`].usedBy).toContain(projectHash);

      // 第二次 link - iOS + macOS（iOS 作为主平台）
      await runCommand('link', { platform: ['iOS', 'macOS'], yes: true }, env, env.projectDir);

      // 验证链接结构正确（两个平台目录都是链接）
      const localPath = path.join(env.projectDir, '3rdparty', libName);
      expect(await isSymlink(path.join(localPath, 'macOS'))).toBe(true);
      expect(await isSymlink(path.join(localPath, 'iOS'))).toBe(true);

      // 验证 Registry 项目记录的平台列表
      registry = await loadRegistry(env);
      expect(registry.projects[projectHash].platforms).toContain('iOS');
      expect(registry.projects[projectHash].platforms).toContain('macOS');
    });
  });

  describe('S-2.2.4: _shared 文件正确复制', () => {
    it('should copy _shared files to local directory', async () => {
      env = await createTestEnv();

      const libName = 'libSharedCopy';
      const commit = 'sharedcopy123456789';

      // Store 已有库，包含 _shared 文件
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        sharedFiles: {
          'config.cmake': '# CMake configuration',
          'codepac-dep.json': JSON.stringify({ version: '1.0.0', repos: { common: [] } }),
        },
        referencedBy: [],
      });

      // 创建测试项目
      await createTestProject(env, [
        {
          libName,
          commit,
          createLocal: false,
        },
      ]);

      // 执行 link 命令
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      const localPath = path.join(env.projectDir, '3rdparty', libName);

      // _shared 中的文件应该被复制（不是链接）
      const cmakePath = path.join(localPath, 'config.cmake');
      await verifyFileExists(cmakePath);
      expect(await isSymlink(cmakePath)).toBe(false);

      // 验证文件内容
      const content = await fs.readFile(cmakePath, 'utf-8');
      expect(content).toBe('# CMake configuration');
    });
  });

  describe('S-2.3.1: --dry-run 模式', () => {
    it('should not create links in dry-run mode', async () => {
      env = await createTestEnv();

      const libName = 'libDryRun';
      const commit = 'dryrun123456789';

      // Store 已有库
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 创建测试项目
      await createTestProject(env, [
        {
          libName,
          commit,
          createLocal: false,
        },
      ]);

      // 执行 link 命令（dry-run）
      await runCommand('link', { platform: ['macOS'], yes: true, dryRun: true }, env, env.projectDir);

      // 本地目录不应该被创建
      const localPath = path.join(env.projectDir, '3rdparty', libName);
      const exists = await fs
        .access(localPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);

      // Registry 不应该有项目记录
      const registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      expect(registry.projects[projectHash]).toBeUndefined();
    });
  });

  describe('S-2.4: 边界情况', () => {
    it('should handle multiple libraries in single project', async () => {
      env = await createTestEnv();

      // Store 有两个库
      await createMockStoreDataV2(env, {
        libName: 'libFirst',
        commit: 'first123456789',
        platforms: ['macOS'],
        referencedBy: [],
      });

      await createMockStoreDataV2(env, {
        libName: 'libSecond',
        commit: 'second123456789',
        platforms: ['macOS', 'iOS'],
        referencedBy: [],
      });

      // 创建包含两个依赖的项目
      await createTestProject(env, [
        { libName: 'libFirst', commit: 'first123456789', createLocal: false },
        { libName: 'libSecond', commit: 'second123456789', createLocal: false },
      ]);

      // 执行 link 命令
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // 验证两个库都被链接
      await verifyLinkResult(env, 'libFirst', 'first123456789', ['macOS']);
      await verifyLinkResult(env, 'libSecond', 'second123456789', ['macOS']);

      // 验证 Registry
      const registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      expect(registry.projects[projectHash].dependencies).toHaveLength(2);
    });

    it('should handle RELINK when link points to wrong commit', async () => {
      env = await createTestEnv();

      const libName = 'libRelink';
      const oldCommit = 'oldcommit123456';
      const newCommit = 'newcommit123456';

      // Store 有两个版本
      await createMockStoreDataV2(env, {
        libName,
        commit: oldCommit,
        platforms: ['macOS'],
        referencedBy: [],
      });

      await createMockStoreDataV2(env, {
        libName,
        commit: newCommit,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 创建指向旧版本的链接结构
      const localPath = path.join(env.projectDir, '3rdparty', libName);
      await fs.mkdir(localPath, { recursive: true });
      const oldTarget = path.join(env.storeDir, libName, oldCommit, 'macOS');
      await fs.symlink(oldTarget, path.join(localPath, 'macOS'));

      // 创建指向新版本的 codepac-dep.json
      await createTestProject(env, [
        {
          libName,
          commit: newCommit,
          createLocal: false,
        },
      ]);

      // 执行 link 命令
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // 验证链接指向新版本
      const newTarget = path.join(env.storeDir, libName, newCommit, 'macOS');
      await verifySymlink(path.join(localPath, 'macOS'), newTarget);
    });
  });
});
