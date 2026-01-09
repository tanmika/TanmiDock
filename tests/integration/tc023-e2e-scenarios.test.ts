/**
 * TC-023: E2E 端到端测试
 *
 * 测试场景:
 * - E2E-1: 完整 link -> status -> unlink 流程
 * - E2E-2: 多项目共享同一库
 * - E2E-3: 库版本升级流程
 * - E2E-4: 多平台库完整生命周期
 * - E2E-5: General 库完整生命周期
 * - E2E-6: 错误恢复场景（verify + repair）
 *
 * v2.0: 调用命令入口函数（linkProject, unlinkProject, showStatus 等）
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
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
import { isSymlink, isValidLink } from '../../src/core/linker.js';

/**
 * 创建项目配置文件
 */
async function createProjectConfig(
  env: TestEnv,
  deps: Array<{ libName: string; commit: string }>,
  projectPath?: string
): Promise<void> {
  const targetPath = projectPath ?? env.projectDir;
  const thirdPartyDir = path.join(targetPath, '3rdparty');
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
}

/**
 * 运行 status 命令并捕获 JSON 输出
 */
async function runStatusAndGetJson(env: TestEnv, projectPath?: string): Promise<unknown> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runCommand('status', { json: true }, env, projectPath ?? env.projectDir);
    const calls = spy.mock.calls;
    for (let i = calls.length - 1; i >= 0; i--) {
      const output = calls[i][0];
      if (typeof output === 'string' && output.startsWith('{')) {
        return JSON.parse(output);
      }
    }
    throw new Error('No JSON output found');
  } finally {
    spy.mockRestore();
  }
}

describe('TC-023: E2E 端到端测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('E2E-1: 完整 link -> status -> unlink 流程', () => {
    it('should complete full lifecycle of a library', async () => {
      env = await createTestEnv();

      const libName = 'libE2E1';
      const commit = 'e2e1commit12345678';
      const platforms = ['macOS', 'iOS'];

      // === Phase 1: Setup ===
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms,
        referencedBy: [],
      });
      await createProjectConfig(env, [{ libName, commit }]);

      // === Phase 2: Link ===
      await runCommand('link', { platform: platforms, yes: true }, env, env.projectDir);

      // 验证链接已创建
      const localPath = path.join(env.projectDir, '3rdparty', libName);
      expect(await isSymlink(path.join(localPath, 'macOS'))).toBe(true);
      expect(await isSymlink(path.join(localPath, 'iOS'))).toBe(true);
      expect(await isValidLink(path.join(localPath, 'macOS'))).toBe(true);

      // 验证 Registry 更新
      let registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      expect(registry.projects[projectHash]).toBeDefined();
      // 每个库一个 dependency 条目（使用 primaryPlatform），platforms 数组记录所有链接的平台
      expect(registry.projects[projectHash].dependencies.length).toBe(1);
      expect(registry.projects[projectHash].platforms).toContain('macOS');
      expect(registry.projects[projectHash].platforms).toContain('iOS');

      // === Phase 3: Status ===
      const statusOutput = (await runStatusAndGetJson(env)) as {
        dependencies: { total: number; linked: number; broken: number; unlinked: number };
      };
      expect(statusOutput.dependencies.linked).toBe(1);
      expect(statusOutput.dependencies.broken).toBe(0);
      expect(statusOutput.dependencies.unlinked).toBe(0);

      // === Phase 4: Unlink ===
      await runCommand('unlink', { remove: false }, env, env.projectDir);

      // 验证链接已还原为普通目录
      expect(await isSymlink(path.join(localPath, 'macOS'))).toBe(false);
      expect(await isSymlink(path.join(localPath, 'iOS'))).toBe(false);

      // 验证目录内容存在
      await verifyDirectoryExists(path.join(localPath, 'macOS'));
      await verifyDirectoryExists(path.join(localPath, 'iOS'));

      // 验证 Registry 更新
      registry = await loadRegistry(env);
      expect(registry.projects[projectHash]).toBeUndefined();

      // Store 仍存在（未使用 --remove）
      const libKey = `${libName}:${commit}`;
      expect(registry.libraries[libKey]).toBeDefined();
    });
  });

  describe('E2E-2: 多项目共享同一库', () => {
    it('should allow multiple projects to share same library', async () => {
      env = await createTestEnv();

      const libName = 'libSharedE2E';
      const commit = 'sharedcommit12345';
      const platform = 'macOS';

      // === Setup Store ===
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: [platform],
        referencedBy: [],
      });

      // === 创建两个项目 ===
      const project1 = path.join(env.tempDir, 'project1');
      const project2 = path.join(env.tempDir, 'project2');
      await fs.mkdir(project1, { recursive: true });
      await fs.mkdir(project2, { recursive: true });

      // 为两个项目创建配置
      await createProjectConfig(env, [{ libName, commit }], project1);
      await createProjectConfig(env, [{ libName, commit }], project2);

      // === 两个项目都链接同一个库 ===
      await runCommand('link', { platform: [platform], yes: true }, env, project1);
      await runCommand('link', { platform: [platform], yes: true }, env, project2);

      // 验证两个项目的链接都存在
      const localPath1 = path.join(project1, '3rdparty', libName, platform);
      const localPath2 = path.join(project2, '3rdparty', libName, platform);
      expect(await isSymlink(localPath1)).toBe(true);
      expect(await isSymlink(localPath2)).toBe(true);

      // 验证 Registry 记录
      let registry = await loadRegistry(env);
      const libKey = `${libName}:${commit}`;
      expect(registry.libraries[libKey].referencedBy.length).toBe(2);

      // === 项目 1 取消链接 ===
      await runCommand('unlink', { remove: false }, env, project1);

      // 验证项目 2 仍然正常
      expect(await isValidLink(localPath2)).toBe(true);

      // 验证 Store 仍存在（项目 2 还在用）
      registry = await loadRegistry(env);
      expect(registry.libraries[libKey]).toBeDefined();
      expect(registry.libraries[libKey].referencedBy.length).toBe(1);
    });

    it('should remove Store when last project unlinks with --remove', async () => {
      env = await createTestEnv();

      const libName = 'libRemoveE2E';
      const commit = 'removecommit12345';
      const platform = 'macOS';

      // Setup
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: [platform],
        referencedBy: [],
      });
      await createProjectConfig(env, [{ libName, commit }]);

      // Link
      await runCommand('link', { platform: [platform], yes: true }, env, env.projectDir);

      // 验证 Store 存在
      const storeCommitPath = path.join(env.storeDir, libName, commit);
      await verifyDirectoryExists(storeCommitPath);

      // Unlink with --remove
      await runCommand('unlink', { remove: true }, env, env.projectDir);

      // 验证 Store 已删除
      await verifyDirectoryDeleted(storeCommitPath);

      // 验证 Registry 已清理
      const registry = await loadRegistry(env);
      const libKey = `${libName}:${commit}`;
      expect(registry.libraries[libKey]).toBeUndefined();
    });
  });

  describe('E2E-3: 库版本升级流程', () => {
    it('should upgrade library version correctly', async () => {
      env = await createTestEnv();

      const libName = 'libUpgradeE2E';
      const oldCommit = 'oldversion123456';
      const newCommit = 'newversion123456';
      const platform = 'macOS';

      // === Setup: 创建两个版本 ===
      await createMockStoreDataV2(env, {
        libName,
        commit: oldCommit,
        platforms: [platform],
        referencedBy: [],
      });
      await createMockStoreDataV2(env, {
        libName,
        commit: newCommit,
        platforms: [platform],
        referencedBy: [],
      });

      // === 初始：链接旧版本 ===
      await createProjectConfig(env, [{ libName, commit: oldCommit }]);
      await runCommand('link', { platform: [platform], yes: true }, env, env.projectDir);

      // 验证链接到旧版本
      const localPath = path.join(env.projectDir, '3rdparty', libName, platform);
      const oldLink = await fs.readlink(localPath);
      expect(oldLink).toContain(oldCommit);

      // === 升级：更新配置并重新链接 ===
      await createProjectConfig(env, [{ libName, commit: newCommit }]);
      await runCommand('link', { platform: [platform], yes: true }, env, env.projectDir);

      // 验证链接到新版本
      const newLink = await fs.readlink(localPath);
      expect(newLink).toContain(newCommit);

      // 验证 Registry 状态
      const registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      expect(registry.projects[projectHash].dependencies[0].commit).toBe(newCommit);

      // 注意：link 命令在升级时不会自动清理旧库的 referencedBy
      // 旧版本的 referencedBy 会在 clean 命令运行时被清理
      // 这里只验证新版本已添加引用
      const newLibKey = `${libName}:${newCommit}`;
      expect(registry.libraries[newLibKey].referencedBy).toContain(projectHash);

      // 旧版本的 Store 引用（usedBy）应该被移除
      const oldStoreKey = `${libName}:${oldCommit}:${platform}`;
      expect(registry.stores[oldStoreKey].usedBy).not.toContain(projectHash);
    });
  });

  describe('E2E-4: 多平台库完整生命周期', () => {
    it('should handle multi-platform library correctly', async () => {
      env = await createTestEnv();

      const libName = 'libMultiPlatE2E';
      const commit = 'multiplat123456';
      const allPlatforms = ['macOS', 'iOS', 'android'];
      const linkPlatforms = ['macOS', 'iOS']; // 只链接部分平台

      // Setup
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: allPlatforms,
        referencedBy: [],
      });
      await createProjectConfig(env, [{ libName, commit }]);

      // === Link 部分平台 ===
      await runCommand('link', { platform: linkPlatforms, yes: true }, env, env.projectDir);

      const localPath = path.join(env.projectDir, '3rdparty', libName);

      // 验证链接的平台
      expect(await isSymlink(path.join(localPath, 'macOS'))).toBe(true);
      expect(await isSymlink(path.join(localPath, 'iOS'))).toBe(true);

      // 验证未链接的平台不存在
      const androidExists = await fs.access(path.join(localPath, 'android'))
        .then(() => true)
        .catch(() => false);
      expect(androidExists).toBe(false);

      // === Status 检查 ===
      const statusOutput = (await runStatusAndGetJson(env)) as {
        platforms: string[];
        dependencies: { linked: number };
      };
      expect(statusOutput.dependencies.linked).toBe(1);
      expect(statusOutput.platforms).toContain('macOS');
      expect(statusOutput.platforms).toContain('iOS');

      // === Unlink ===
      await runCommand('unlink', { remove: false }, env, env.projectDir);

      // 验证平台目录已还原
      expect(await isSymlink(path.join(localPath, 'macOS'))).toBe(false);
      expect(await isSymlink(path.join(localPath, 'iOS'))).toBe(false);
      await verifyDirectoryExists(path.join(localPath, 'macOS'));
      await verifyDirectoryExists(path.join(localPath, 'iOS'));
    });
  });

  describe('E2E-5: General 库完整生命周期', () => {
    it('should complete full lifecycle of General library', async () => {
      env = await createTestEnv();

      const libName = 'libGeneralE2E';
      const commit = 'generale2e123456';

      // === Setup: 创建 General 库（只有 _shared） ===
      await createMockGeneralStoreData(env, libName, commit);

      // 创建本地目录（有 _shared 触发 ABSORB）
      const thirdPartyDir = path.join(env.projectDir, '3rdparty');
      await fs.mkdir(thirdPartyDir, { recursive: true });
      const localPath = path.join(thirdPartyDir, libName);
      const localSharedPath = path.join(localPath, '_shared');
      await fs.mkdir(localSharedPath, { recursive: true });
      await fs.writeFile(path.join(localSharedPath, 'local.cmake'), '# local config', 'utf-8');

      // 创建配置
      await createProjectConfig(env, [{ libName, commit }]);

      // === Link ===
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // 验证是符号链接（指向 Store 的 _shared）
      expect(await isSymlink(localPath)).toBe(true);

      // === Status ===
      const statusOutput = (await runStatusAndGetJson(env)) as {
        dependencies: { linked: number };
      };
      expect(statusOutput.dependencies.linked).toBe(1);

      // === Unlink ===
      await runCommand('unlink', { remove: false }, env, env.projectDir);

      // 验证已还原为普通目录
      expect(await isSymlink(localPath)).toBe(false);
      const stat = await fs.stat(localPath);
      expect(stat.isDirectory()).toBe(true);

      // 验证内容存在（从 Store 复制回来）
      const entries = await fs.readdir(localPath);
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  describe('E2E-6: 错误恢复场景（verify + repair）', () => {
    it('should detect and repair orphan libraries', async () => {
      env = await createTestEnv();

      const libName = 'libOrphanE2E';
      const commit = 'orphane2e123456';

      // 直接在 Store 创建库（不创建 Registry 记录）
      const commitDir = path.join(env.storeDir, libName, commit);
      const platformDir = path.join(commitDir, 'macOS');
      await fs.mkdir(platformDir, { recursive: true });
      await fs.writeFile(path.join(platformDir, 'lib.a'), 'orphan content', 'utf-8');

      // 删除 Registry 中的记录（如果有）
      const registry = await loadRegistry(env);
      const libKey = `${libName}:${commit}`;
      delete registry.libraries[libKey];
      await saveRegistry(env, registry);

      // === Verify: 应该检测到孤立库 ===
      await runCommand('verify', {}, env);

      // === Repair: 应该登记孤立库 ===
      await runCommand('repair', { force: true, prune: false }, env);

      // 验证库已被登记
      const afterRegistry = await loadRegistry(env);
      expect(afterRegistry.libraries[libKey]).toBeDefined();
    });

    it('should detect and repair dangling links', async () => {
      env = await createTestEnv();

      const libName = 'libDanglingE2E';
      const commit = 'danglinge2e123456';
      const platform = 'macOS';

      // Setup 并 Link
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: [platform],
        referencedBy: [],
      });
      await createProjectConfig(env, [{ libName, commit }]);
      await runCommand('link', { platform: [platform], yes: true }, env, env.projectDir);

      // 验证链接有效
      const localPath = path.join(env.projectDir, '3rdparty', libName, platform);
      expect(await isValidLink(localPath)).toBe(true);

      // 模拟 Store 被意外删除
      const storePlatformPath = path.join(env.storeDir, libName, commit, platform);
      await fs.rm(storePlatformPath, { recursive: true, force: true });

      // 验证链接失效
      expect(await isSymlink(localPath)).toBe(true);
      expect(await isValidLink(localPath)).toBe(false);

      // === Repair: 应该移除悬挂链接 ===
      await runCommand('repair', { force: true }, env);

      // 验证悬挂链接已删除
      const linkExists = await fs.access(localPath).then(() => true).catch(() => false);
      expect(linkExists).toBe(false);
    });

    it('should clean stale project records', async () => {
      env = await createTestEnv();

      const libName = 'libStaleE2E';
      const commit = 'stalee2e123456';
      const platform = 'macOS';

      // Setup 并 Link
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: [platform],
        referencedBy: [],
      });
      await createProjectConfig(env, [{ libName, commit }]);
      await runCommand('link', { platform: [platform], yes: true }, env, env.projectDir);

      // 验证项目记录存在
      let registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      expect(registry.projects[projectHash]).toBeDefined();

      // 模拟项目目录被删除
      await fs.rm(env.projectDir, { recursive: true, force: true });

      // === Repair: 应该清理过期项目记录 ===
      await runCommand('repair', { force: true }, env);

      // 验证项目记录已删除
      registry = await loadRegistry(env);
      expect(registry.projects[projectHash]).toBeUndefined();
    });
  });
});
