/**
 * TC-020: repair 命令测试
 *
 * 测试场景:
 * - S-6.1.1: 检测并清理过期项目
 * - S-6.1.2: 检测并移除悬挂链接
 * - S-6.2.1: 登记孤立库
 * - S-6.2.2: --prune 选项删除孤立库
 * - S-6.3.1: --dry-run 模式
 * - S-6.3.2: 无问题时的输出
 *
 * v2.0: 调用 repairIssues() 入口函数
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import {
  createTestEnv,
  createMockStoreDataV2,
  loadRegistry,
  saveRegistry,
  runCommand,
  verifyDirectoryExists,
  verifyDirectoryDeleted,
  hashPath,
  type TestEnv,
} from './setup.js';
import { isSymlink } from '../../src/core/linker.js';

/**
 * 创建已链接的测试项目
 */
async function createLinkedProject(
  env: TestEnv,
  deps: Array<{ libName: string; commit: string; platforms: string[] }>,
  linkPlatforms: string[]
): Promise<void> {
  // 创建 Store 数据
  for (const dep of deps) {
    await createMockStoreDataV2(env, {
      libName: dep.libName,
      commit: dep.commit,
      platforms: dep.platforms,
      referencedBy: [],
    });
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

describe('TC-020: repair 命令测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('S-6.1.1: 检测并清理过期项目', () => {
    it('should clean stale project record when project path is removed', async () => {
      env = await createTestEnv();

      const libName = 'libStaleProject';
      const commit = 'staleproject123456';

      // 创建并链接项目
      await createLinkedProject(
        env,
        [{ libName, commit, platforms: ['macOS'] }],
        ['macOS']
      );

      // 验证项目记录存在
      let registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      expect(registry.projects[projectHash]).toBeDefined();

      // 删除项目目录（模拟项目被移除）
      await fs.rm(env.projectDir, { recursive: true, force: true });

      // 执行 repair 命令
      await runCommand('repair', { force: true }, env);

      // 验证项目记录已删除
      registry = await loadRegistry(env);
      expect(registry.projects[projectHash]).toBeUndefined();
    });
  });

  describe('S-6.1.2: 检测并移除悬挂链接', () => {
    it('should remove dangling symlinks', async () => {
      env = await createTestEnv();

      const libName = 'libDangling';
      const commit = 'dangling123456789';

      // 创建并链接项目
      await createLinkedProject(
        env,
        [{ libName, commit, platforms: ['macOS'] }],
        ['macOS']
      );

      const localPath = path.join(env.projectDir, '3rdparty', libName);

      // 验证链接存在
      expect(await isSymlink(path.join(localPath, 'macOS'))).toBe(true);

      // 删除 Store 中的目标目录（模拟链接失效）
      const storePlatformPath = path.join(env.storeDir, libName, commit, 'macOS');
      await fs.rm(storePlatformPath, { recursive: true, force: true });

      // 执行 repair 命令
      await runCommand('repair', { force: true }, env);

      // 验证悬挂链接已删除
      const exists = await fs
        .access(path.join(localPath, 'macOS'))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });
  });

  describe('S-6.2: 删除孤立库', () => {
    it('should delete orphan library (no longer registers)', async () => {
      env = await createTestEnv();

      const libName = 'libOrphan';
      const commit = 'orphan123456789';

      // 直接在 Store 创建库（不创建 Registry 记录）
      const commitDir = path.join(env.storeDir, libName, commit);
      const platformDir = path.join(commitDir, 'macOS');
      await fs.mkdir(platformDir, { recursive: true });
      await fs.writeFile(path.join(platformDir, 'lib.a'), 'orphan content', 'utf-8');

      // 验证 Registry 中没有记录
      let registry = await loadRegistry(env);
      const libKey = `${libName}:${commit}`;
      expect(registry.libraries[libKey]).toBeUndefined();

      // 验证目录存在
      await verifyDirectoryExists(commitDir);

      // 执行 repair 命令（孤立库会被直接删除）
      await runCommand('repair', { force: true }, env);

      // 验证目录已删除
      await verifyDirectoryDeleted(commitDir);

      // 验证 Registry 中仍然没有记录
      registry = await loadRegistry(env);
      expect(registry.libraries[libKey]).toBeUndefined();
    });
  });

  describe('S-6.3.1: --dry-run 模式', () => {
    it('should not make changes in dry-run mode', async () => {
      env = await createTestEnv();

      const libName = 'libDryRunRepair';
      const commit = 'dryrunrepair123456';

      // 直接在 Store 创建库（孤立库）
      const commitDir = path.join(env.storeDir, libName, commit);
      const platformDir = path.join(commitDir, 'macOS');
      await fs.mkdir(platformDir, { recursive: true });
      await fs.writeFile(path.join(platformDir, 'lib.a'), 'dry run content', 'utf-8');

      // 执行 repair 命令（dry-run 模式）
      await runCommand('repair', { dryRun: true, force: true }, env);

      // 验证目录仍存在
      await verifyDirectoryExists(commitDir);

      // 验证 Registry 中仍没有记录
      const registry = await loadRegistry(env);
      const libKey = `${libName}:${commit}`;
      expect(registry.libraries[libKey]).toBeUndefined();
    });
  });

  describe('S-6.3.2: 无问题时的输出', () => {
    it('should report no issues when everything is clean', async () => {
      env = await createTestEnv();

      // 不创建任何问题场景

      // 执行 repair 命令（应该报告无问题）
      await runCommand('repair', { force: true }, env);

      // 验证没有错误抛出
      const registry = await loadRegistry(env);
      expect(registry).toBeDefined();
    });
  });

  describe('S-6.4: 边界情况', () => {
    it('should handle multiple orphan libraries at once (delete them)', async () => {
      env = await createTestEnv();

      // 创建多个孤立库
      const orphanDirs: string[] = [];
      for (let i = 0; i < 3; i++) {
        const libName = `libMultiOrphan${i}`;
        const commit = `multiorphan${i}123456`;
        const commitDir = path.join(env.storeDir, libName, commit);
        const platformDir = path.join(commitDir, 'macOS');
        await fs.mkdir(platformDir, { recursive: true });
        await fs.writeFile(path.join(platformDir, 'lib.a'), `orphan ${i}`, 'utf-8');
        orphanDirs.push(commitDir);
      }

      // 验证 Registry 中没有记录
      let registry = await loadRegistry(env);
      expect(Object.keys(registry.libraries).length).toBe(0);

      // 验证文件存在
      for (const dir of orphanDirs) {
        await expect(fs.access(dir)).resolves.not.toThrow();
      }

      // 执行 repair 命令（孤立库会被删除）
      await runCommand('repair', { force: true }, env);

      // 验证所有孤立库都被删除
      for (const dir of orphanDirs) {
        await expect(fs.access(dir)).rejects.toThrow();
      }

      // Registry 中仍然没有记录
      registry = await loadRegistry(env);
      expect(Object.keys(registry.libraries).length).toBe(0);
    });
  });
});
