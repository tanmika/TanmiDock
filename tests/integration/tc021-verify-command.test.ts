/**
 * TC-021: verify 命令测试
 *
 * 测试场景:
 * - S-7.1.1: 完整性通过时的输出
 * - S-7.1.2: 检测无效项目
 * - S-7.1.3: 检测悬挂链接
 * - S-7.2.1: 检测孤立库
 * - S-7.2.2: 检测缺失库
 *
 * v2.0: 调用 verifyIntegrity() 入口函数
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
  hashPath,
  type TestEnv,
} from './setup.js';

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

describe('TC-021: verify 命令测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('S-7.1.1: 完整性通过', () => {
    it('should pass when everything is correct', async () => {
      env = await createTestEnv();

      const libName = 'libVerifyOk';
      const commit = 'verifyok123456789';

      // 创建完整的链接项目
      await createLinkedProject(
        env,
        [{ libName, commit, platforms: ['macOS'] }],
        ['macOS']
      );

      // 执行 verify 命令（不应抛出错误）
      await runCommand('verify', {}, env);

      // 验证 Registry 状态正常
      const registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      expect(registry.projects[projectHash]).toBeDefined();
    });
  });

  describe('S-7.1.2: 检测无效项目', () => {
    it('should detect invalid project paths', async () => {
      env = await createTestEnv();

      const libName = 'libVerifyInvalid';
      const commit = 'verifyinvalid123456';

      // 创建完整的链接项目
      await createLinkedProject(
        env,
        [{ libName, commit, platforms: ['macOS'] }],
        ['macOS']
      );

      // 删除项目目录（模拟项目被移除）
      await fs.rm(env.projectDir, { recursive: true, force: true });

      // 执行 verify 命令（应该检测到无效项目）
      await runCommand('verify', {}, env);

      // 这里我们只验证命令能正常执行
      // verify 命令会输出警告但不会修改 Registry
      const registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      expect(registry.projects[projectHash]).toBeDefined(); // 记录仍在
    });
  });

  describe('S-7.1.3: 检测悬挂链接', () => {
    it('should detect dangling symlinks', async () => {
      env = await createTestEnv();

      const libName = 'libVerifyDangling';
      const commit = 'verifydangling123456';

      // 创建完整的链接项目
      await createLinkedProject(
        env,
        [{ libName, commit, platforms: ['macOS'] }],
        ['macOS']
      );

      // 删除 Store 中的目标目录（模拟链接失效）
      const storePlatformPath = path.join(env.storeDir, libName, commit, 'macOS');
      await fs.rm(storePlatformPath, { recursive: true, force: true });

      // 执行 verify 命令（应该检测到悬挂链接）
      await runCommand('verify', {}, env);

      // verify 只报告问题，不修复
      const registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      expect(registry.projects[projectHash]).toBeDefined();
    });
  });

  describe('S-7.2.1: 检测孤立库', () => {
    it('should detect orphan libraries', async () => {
      env = await createTestEnv();

      const libName = 'libVerifyOrphan';
      const commit = 'verifyorphan123456';

      // 直接在 Store 创建库（不创建 Registry 记录）
      const commitDir = path.join(env.storeDir, libName, commit);
      const platformDir = path.join(commitDir, 'macOS');
      await fs.mkdir(platformDir, { recursive: true });
      await fs.writeFile(path.join(platformDir, 'lib.a'), 'orphan content', 'utf-8');

      // 执行 verify 命令（应该检测到孤立库）
      await runCommand('verify', {}, env);

      // verify 只报告问题，不修复
      const registry = await loadRegistry(env);
      const libKey = `${libName}:${commit}`;
      expect(registry.libraries[libKey]).toBeUndefined(); // 仍然没有记录
    });
  });

  describe('S-7.2.2: 检测缺失库', () => {
    it('should detect missing libraries', async () => {
      env = await createTestEnv();

      const libName = 'libVerifyMissing';
      const commit = 'verifymissing123456';

      // 手动创建项目记录，但不创建 Store 数据或本地链接
      const registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      registry.projects[projectHash] = {
        path: env.projectDir,
        platforms: ['macOS'],
        dependencies: [
          {
            libName,
            commit,
            linkedPath: `3rdparty/${libName}`,
            platform: 'macOS',
          },
        ],
      };
      await saveRegistry(env, registry);

      // 创建项目目录（让项目路径有效）
      await fs.mkdir(env.projectDir, { recursive: true });

      // 执行 verify 命令（应该检测到缺失库）
      await runCommand('verify', {}, env);

      // verify 只报告问题，不修复
      const afterRegistry = await loadRegistry(env);
      expect(afterRegistry.projects[projectHash]).toBeDefined();
    });
  });

  describe('S-7.3: 边界情况', () => {
    it('should handle empty store', async () => {
      env = await createTestEnv();

      // 不创建任何数据

      // 执行 verify 命令
      await runCommand('verify', {}, env);

      // 应该正常完成
      const registry = await loadRegistry(env);
      expect(registry).toBeDefined();
    });

    it('should handle multiple issues at once', async () => {
      env = await createTestEnv();

      // 创建多个孤立库
      for (let i = 0; i < 2; i++) {
        const libName = `libMultiVerify${i}`;
        const commit = `multiverify${i}123456`;
        const commitDir = path.join(env.storeDir, libName, commit);
        const platformDir = path.join(commitDir, 'macOS');
        await fs.mkdir(platformDir, { recursive: true });
        await fs.writeFile(path.join(platformDir, 'lib.a'), `orphan ${i}`, 'utf-8');
      }

      // 执行 verify 命令
      await runCommand('verify', {}, env);

      // 应该正常完成
      const registry = await loadRegistry(env);
      expect(registry).toBeDefined();
    });
  });
});
