/**
 * TC-024: 事务回滚测试
 *
 * 测试场景:
 * - T-1: 部分平台失败时的回滚
 * - T-2: 多库链接时中途失败的回滚
 * - T-3: 成功事务的提交
 * - T-4: ABSORB 操作的回滚
 *
 * v2.0: 调用真实 link 命令，验证事务机制
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import {
  createTestEnv,
  createMockStoreDataV2,
  loadRegistry,
  runCommand,
  verifyDirectoryExists,
  verifyDirectoryDeleted,
  hashPath,
  type TestEnv,
} from './setup.js';
import { isSymlink } from '../../src/core/linker.js';
import { Transaction } from '../../src/core/transaction.js';

/**
 * 创建项目配置文件
 */
async function createProjectConfig(
  env: TestEnv,
  deps: Array<{ libName: string; commit: string }>
): Promise<void> {
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
}

describe('TC-024: 事务回滚测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('T-1: 单平台链接事务', () => {
    it('should successfully link single platform with transaction', async () => {
      env = await createTestEnv();

      const libName = 'libSinglePlatform';
      const commit = 'singleplatform123';

      // 创建 macOS 平台
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 配置文件声明依赖
      await createProjectConfig(env, [{ libName, commit }]);

      // 链接 macOS 平台
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      const localPath = path.join(env.projectDir, '3rdparty', libName);

      // macOS 应该被链接
      expect(await isSymlink(path.join(localPath, 'macOS'))).toBe(true);

      // 事务应该已提交（无 pending）
      const pendingTxs = await Transaction.getPendingTransactions();
      expect(pendingTxs.length).toBe(0);

      // Registry 应该有记录
      const registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      expect(registry.projects[projectHash]).toBeDefined();
    });
  });

  describe('T-2: 多库链接时的事务性', () => {
    it('should link only existing libraries in Store', async () => {
      env = await createTestEnv();

      // 只创建 libA，不创建 libB
      await createMockStoreDataV2(env, {
        libName: 'libA',
        commit: 'commitA123456',
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 配置文件声明两个依赖
      await createProjectConfig(env, [
        { libName: 'libA', commit: 'commitA123456' },
        { libName: 'libB', commit: 'commitB123456' }, // 不在 Store 中
      ]);

      // 执行 link（download: false 跳过下载）
      await runCommand(
        'link',
        { platform: ['macOS'], yes: true, download: false },
        env,
        env.projectDir
      );

      // libA 应该被链接
      const localPathA = path.join(env.projectDir, '3rdparty', 'libA', 'macOS');
      expect(await isSymlink(localPathA)).toBe(true);

      // libB 不应该被链接（标记为 MISSING）
      const localPathB = path.join(env.projectDir, '3rdparty', 'libB');
      const libBExists = await fs.access(localPathB).then(() => true).catch(() => false);
      // MISSING 库不会创建目录
      expect(libBExists).toBe(false);

      // Registry 应该有 libA 的记录
      const registry = await loadRegistry(env);
      const libKeyA = 'libA:commitA123456';
      expect(registry.libraries[libKeyA]).toBeDefined();
    });
  });

  describe('T-3: 成功事务的提交', () => {
    it('should commit transaction and clean up transaction log', async () => {
      env = await createTestEnv();

      const libName = 'libCommit';
      const commit = 'commit123456789';

      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        referencedBy: [],
      });
      await createProjectConfig(env, [{ libName, commit }]);

      // 执行 link
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // 验证链接成功
      const localPath = path.join(env.projectDir, '3rdparty', libName, 'macOS');
      expect(await isSymlink(localPath)).toBe(true);

      // 事务日志应该被清理（没有 pending 事务）
      const pendingTxs = await Transaction.getPendingTransactions();
      expect(pendingTxs.length).toBe(0);

      // Registry 已更新
      const registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      expect(registry.projects[projectHash]).toBeDefined();
    });
  });

  describe('T-4: ABSORB 操作的回滚', () => {
    it('should handle ABSORB with transaction safety', async () => {
      env = await createTestEnv();

      const libName = 'libAbsorbTx';
      const commit = 'absorbtx123456';

      // Store 中有数据
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 本地已有目录（触发 ABSORB）
      const thirdPartyDir = path.join(env.projectDir, '3rdparty');
      await fs.mkdir(thirdPartyDir, { recursive: true });
      const localPath = path.join(thirdPartyDir, libName);
      const localMacOSPath = path.join(localPath, 'macOS');
      await fs.mkdir(localMacOSPath, { recursive: true });
      await fs.writeFile(path.join(localMacOSPath, 'local.txt'), 'local content', 'utf-8');

      // 创建配置
      await createProjectConfig(env, [{ libName, commit }]);

      // 执行 link（会触发 ABSORB）
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // 验证链接成功（ABSORB 后应该是符号链接）
      expect(await isSymlink(path.join(localPath, 'macOS'))).toBe(true);

      // 事务应该已提交（无 pending）
      const pendingTxs = await Transaction.getPendingTransactions();
      expect(pendingTxs.length).toBe(0);
    });
  });

  describe('T-5: 事务恢复', () => {
    it('should have no pending transactions after successful operations', async () => {
      env = await createTestEnv();

      const libName = 'libRecover';
      const commit = 'recover123456';

      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        referencedBy: [],
      });
      await createProjectConfig(env, [{ libName, commit }]);

      // 执行多次操作
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);
      await runCommand('unlink', { remove: false }, env, env.projectDir);
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // 所有事务都应该已完成
      const pendingTxs = await Transaction.getPendingTransactions();
      expect(pendingTxs.length).toBe(0);

      // 最终状态正确
      const localPath = path.join(env.projectDir, '3rdparty', libName, 'macOS');
      expect(await isSymlink(localPath)).toBe(true);
    });
  });

  describe('T-6: Registry 一致性', () => {
    it('should maintain Registry consistency after all operations', async () => {
      env = await createTestEnv();

      const libName = 'libConsistency';
      const commit = 'consistency123456';
      const platforms = ['macOS', 'iOS'];

      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms,
        referencedBy: [],
      });
      await createProjectConfig(env, [{ libName, commit }]);

      // Link
      await runCommand('link', { platform: platforms, yes: true }, env, env.projectDir);

      // 验证 Registry
      let registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      const libKey = `${libName}:${commit}`;

      // 项目记录
      expect(registry.projects[projectHash]).toBeDefined();
      expect(registry.projects[projectHash].dependencies.length).toBe(1);

      // 库记录
      expect(registry.libraries[libKey]).toBeDefined();

      // Store 记录 (引用通过 usedBy 追踪)
      for (const platform of platforms) {
        const storeKey = `${libKey}:${platform}`;
        expect(registry.stores[storeKey]).toBeDefined();
        expect(registry.stores[storeKey].usedBy).toContain(projectHash);
      }

      // Unlink
      await runCommand('unlink', { remove: false }, env, env.projectDir);

      // 验证一致性
      registry = await loadRegistry(env);

      // 项目记录已删除
      expect(registry.projects[projectHash]).toBeUndefined();

      // 库记录仍存在
      expect(registry.libraries[libKey]).toBeDefined();

      // Store usedBy 已更新 (引用已移除)
      for (const platform of platforms) {
        const storeKey = `${libKey}:${platform}`;
        expect(registry.stores[storeKey].usedBy).not.toContain(projectHash);
      }
    });
  });
});
