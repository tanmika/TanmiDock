/**
 * TC-022: Store 完整性校验场景模拟测试
 *
 * 测试场景：
 * S-1: 升级场景 - 旧版 StoreEntry 无 fileCount/contentHash
 * S-2: 新增库 - absorb 后 StoreEntry 包含完整性元数据
 * S-3: 损坏检测 - link 时检测到 Store 文件丢失
 * S-4: check --integrity 回填旧数据
 * S-5: check --integrity 检测损坏
 * S-6: check --integrity 修复损坏
 * S-7: 混合场景 - 新旧数据并存
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import {
  createTestEnv,
  createMockStoreDataV2,
  loadRegistry,
  saveRegistry,
  runCommand,
  hashPath,
  type TestEnv,
} from './setup.js';

describe('TC-022: Store 完整性校验', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  // ============ 辅助函数 ============

  /**
   * 创建项目 codepac-dep.json 配置
   */
  async function createProjectConfig(
    testEnv: TestEnv,
    deps: Array<{ libName: string; commit: string; branch?: string; url?: string }>,
    projectPath?: string
  ): Promise<void> {
    const targetPath = projectPath ?? testEnv.projectDir;
    const thirdPartyDir = path.join(targetPath, '3rdparty');
    await fs.mkdir(thirdPartyDir, { recursive: true });

    const codepacDep = {
      version: '1.0.0',
      vars: {},
      repos: {
        common: deps.map((d) => ({
          url: d.url ?? `https://github.com/test/${d.libName}.git`,
          commit: d.commit,
          branch: d.branch ?? 'main',
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
   * 获取 StoreEntry（从 registry.json 文件）
   */
  async function getStoreEntry(
    testEnv: TestEnv,
    libName: string,
    commit: string,
    platform: string
  ): Promise<Record<string, unknown> | undefined> {
    const registry = await loadRegistry(testEnv);
    const storeKey = `${libName}:${commit}:${platform}`;
    return registry.stores[storeKey] as Record<string, unknown> | undefined;
  }

  // ============ S-1: 升级场景 ============

  describe('S-1: 升级场景 - 旧版 StoreEntry 无完整性字段', () => {
    it('link 时应跳过校验，正常工作', async () => {
      env = await createTestEnv();

      // 1. 创建 Store 数据（createMockStoreDataV2 默认不写 fileCount/contentHash）
      await createMockStoreDataV2(env, {
        libName: 'zlib',
        commit: 'abc1234567890123456789012345678901234567',
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 2. 确认 Registry 中无 fileCount/contentHash
      const entryBefore = await getStoreEntry(
        env,
        'zlib',
        'abc1234567890123456789012345678901234567',
        'macOS'
      );
      expect(entryBefore).toBeDefined();
      expect(entryBefore!.fileCount).toBeUndefined();
      expect(entryBefore!.contentHash).toBeUndefined();

      // 3. 创建项目配置
      await createProjectConfig(env, [
        { libName: 'zlib', commit: 'abc1234567890123456789012345678901234567' },
      ]);

      // 4. 运行 link
      await runCommand('link', { platform: ['macOS'] }, env, env.projectDir);

      // 5. 验证：link 成功（项目目录下有平台符号链接或根符号链接）
      const linkPath = path.join(env.projectDir, '3rdparty', 'zlib');
      const linkStat = await fs.lstat(linkPath);
      if (linkStat.isSymbolicLink()) {
        // General 库：根目录是符号链接
        expect(linkStat.isSymbolicLink()).toBe(true);
      } else {
        // 平台库：子目录是符号链接
        const platformLink = path.join(linkPath, 'macOS');
        const platformStat = await fs.lstat(platformLink);
        expect(platformStat.isSymbolicLink()).toBe(true);
      }

      // 6. 验证：LINK_NEW 不会重新采集完整性数据（旧 StoreEntry 保持原样）
      //    计划设计：升级后首次 link 跳过校验正常链接，完整性数据由 td check --integrity 回填
      const entryAfter = await getStoreEntry(
        env,
        'zlib',
        'abc1234567890123456789012345678901234567',
        'macOS'
      );
      expect(entryAfter).toBeDefined();
      // 旧 StoreEntry 仍然没有 fileCount/contentHash（这是正确行为）
      expect(entryAfter!.fileCount).toBeUndefined();
      expect(entryAfter!.contentHash).toBeUndefined();
    });

    it('旧数据 verifyExistingPlatforms 应视为合法', async () => {
      env = await createTestEnv();

      // 导入被测函数
      process.env.TANMI_DOCK_HOME = env.homeDir;
      const { resetRegistry, getRegistry } = await import('../../src/core/registry.js');
      resetRegistry();

      // 创建 Store 数据（无 fileCount）
      await createMockStoreDataV2(env, {
        libName: 'curl',
        commit: 'def1234567890123456789012345678901234567',
        platforms: ['macOS', 'iOS'],
      });

      // 加载 registry
      const registry = getRegistry();
      await registry.load();

      const { verifyExistingPlatforms } = await import('../../src/commands/link.js');
      const result = await verifyExistingPlatforms(
        'curl',
        'def1234567890123456789012345678901234567',
        ['macOS', 'iOS']
      );

      // 无 fileCount → 全部视为 valid
      expect(result.valid).toEqual(['macOS', 'iOS']);
      expect(result.corrupted).toEqual([]);
    });
  });

  // ============ S-2: 新增库带完整性数据 ============

  describe('S-2: 新增库 - absorb 后包含完整性数据', () => {
    it('absorb 本地目录后 StoreEntry 应包含 fileCount + contentHash', async () => {
      env = await createTestEnv();

      // 1. 创建项目配置
      await createProjectConfig(env, [
        { libName: 'openssl', commit: 'aaa1234567890123456789012345678901234567' },
      ]);

      // 2. 在项目 3rdparty 下创建本地目录（模拟 absorb 场景）
      const localLibDir = path.join(env.projectDir, '3rdparty', 'openssl');
      // 确保是目录而非链接
      await fs.rm(localLibDir, { recursive: true, force: true });
      const macOSDir = path.join(localLibDir, 'macOS');
      await fs.mkdir(macOSDir, { recursive: true });
      await fs.writeFile(path.join(macOSDir, 'libssl.a'), 'fake ssl library content');
      await fs.writeFile(path.join(macOSDir, 'libcrypto.a'), 'fake crypto library content');
      await fs.writeFile(path.join(macOSDir, 'openssl.h'), '#include <openssl/ssl.h>');

      // 创建 _shared 目录
      const sharedDir = path.join(localLibDir, '_shared');
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.writeFile(
        path.join(sharedDir, 'codepac-dep.json'),
        JSON.stringify({
          version: '1.0.0',
          vars: {},
          repos: {
            common: [{
              url: 'https://github.com/test/openssl.git',
              commit: 'aaa1234567890123456789012345678901234567',
              branch: 'main',
              dir: 'openssl',
            }],
          },
        }, null, 2)
      );

      // 3. 运行 link（unverifiedLocalStrategy=absorb，本地目录会被吸收到 Store）
      await runCommand('link', { platform: ['macOS'] }, env, env.projectDir);

      // 4. 检查 Registry 中 StoreEntry
      const entry = await getStoreEntry(
        env,
        'openssl',
        'aaa1234567890123456789012345678901234567',
        'macOS'
      );
      expect(entry).toBeDefined();
      expect(typeof entry!.fileCount).toBe('number');
      expect(typeof entry!.contentHash).toBe('string');
      expect((entry!.fileCount as number)).toBe(3); // libssl.a + libcrypto.a + openssl.h
      expect((entry!.contentHash as string).length).toBe(32); // MD5 hex is 32 chars
    });
  });

  // ============ S-3: 损坏检测 ============

  describe('S-3: link 时检测到 Store 数据损坏', () => {
    it('fileCount 不匹配时应标记为 corrupted', async () => {
      env = await createTestEnv();

      // 1. 创建 Store 数据
      await createMockStoreDataV2(env, {
        libName: 'zlib',
        commit: 'bbb1234567890123456789012345678901234567',
        platforms: ['macOS'],
      });

      // 2. 手动给 StoreEntry 加上 fileCount（模拟之前的正常 link）
      const registry = await loadRegistry(env);
      const storeKey = 'zlib:bbb1234567890123456789012345678901234567:macOS';
      registry.stores[storeKey] = {
        ...registry.stores[storeKey],
        fileCount: 10,  // 实际只有 2 个文件（lib.a + include.h），故意设为 10
        contentHash: 'fake_hash_that_wont_match',
      } as any;
      await saveRegistry(env, registry);

      // 3. 运行 verifyExistingPlatforms
      process.env.TANMI_DOCK_HOME = env.homeDir;
      const { resetRegistry, getRegistry } = await import('../../src/core/registry.js');
      resetRegistry();

      // 加载 registry
      const reg = getRegistry();
      await reg.load();

      const { verifyExistingPlatforms } = await import('../../src/commands/link.js');
      const result = await verifyExistingPlatforms(
        'zlib',
        'bbb1234567890123456789012345678901234567',
        ['macOS']
      );

      // fileCount 不匹配 → corrupted
      expect(result.corrupted).toContain('macOS');
      expect(result.valid).not.toContain('macOS');
    });

    it('Store 文件被删除后 link 应检测到并重新处理', async () => {
      env = await createTestEnv();

      // 1. 创建 Store 数据
      await createMockStoreDataV2(env, {
        libName: 'jpeg',
        commit: 'ccc1234567890123456789012345678901234567',
        platforms: ['macOS'],
      });

      // 2. 设置正确的 fileCount（通过实际计算）
      process.env.TANMI_DOCK_HOME = env.homeDir;
      const { resetRegistry } = await import('../../src/core/registry.js');
      resetRegistry();

      const storeMod = await import('../../src/core/store.js');
      const integrity = await storeMod.captureIntegrity(
        'jpeg',
        'ccc1234567890123456789012345678901234567',
        'macOS'
      );

      const registry = await loadRegistry(env);
      const storeKey = 'jpeg:ccc1234567890123456789012345678901234567:macOS';
      registry.stores[storeKey] = {
        ...registry.stores[storeKey],
        ...integrity,
      } as any;
      await saveRegistry(env, registry);

      // 3. 删除 Store 中的一个文件（模拟损坏）
      const platformDir = path.join(
        env.storeDir,
        'jpeg',
        'ccc1234567890123456789012345678901234567',
        'macOS'
      );
      await fs.unlink(path.join(platformDir, 'lib.a'));

      // 4. 运行 verifyExistingPlatforms
      resetRegistry();
      const { getRegistry } = await import('../../src/core/registry.js');
      const reg = getRegistry();
      await reg.load();

      const { verifyExistingPlatforms } = await import('../../src/commands/link.js');
      const result = await verifyExistingPlatforms(
        'jpeg',
        'ccc1234567890123456789012345678901234567',
        ['macOS']
      );

      // fileCount 不匹配 → corrupted
      expect(result.corrupted).toContain('macOS');
      expect(result.valid).toHaveLength(0);
    });
  });

  // ============ S-4: check --integrity 回填 ============

  describe('S-4: check --integrity 回填旧数据', () => {
    it('旧 StoreEntry 无 fileCount 时应自动回填', async () => {
      env = await createTestEnv();

      // 1. 创建 Store 数据（无 fileCount/contentHash）
      await createMockStoreDataV2(env, {
        libName: 'png',
        commit: 'ddd1234567890123456789012345678901234567',
        platforms: ['macOS'],
      });

      // 确认无 fileCount
      let entry = await getStoreEntry(
        env,
        'png',
        'ddd1234567890123456789012345678901234567',
        'macOS'
      );
      expect(entry!.fileCount).toBeUndefined();

      // 2. 运行 checkStoreIntegrity
      process.env.TANMI_DOCK_HOME = env.homeDir;
      const { resetRegistry } = await import('../../src/core/registry.js');
      resetRegistry();

      const { checkStoreIntegrity } = await import('../../src/commands/check.js');
      const corrupted = await checkStoreIntegrity();

      // 3. 不应报损坏（而是回填）
      expect(corrupted).toHaveLength(0);

      // 4. 验证回填结果
      entry = await getStoreEntry(
        env,
        'png',
        'ddd1234567890123456789012345678901234567',
        'macOS'
      );
      expect(typeof entry!.fileCount).toBe('number');
      expect(typeof entry!.contentHash).toBe('string');
      expect((entry!.fileCount as number)).toBeGreaterThan(0);
      expect((entry!.contentHash as string).length).toBe(32);
    });
  });

  // ============ S-5: check --integrity 检测损坏 ============

  describe('S-5: check --integrity 检测损坏数据', () => {
    it('文件被删除后应报告 corrupted', async () => {
      env = await createTestEnv();

      // 1. 创建 Store 数据并设置正确的完整性元数据
      await createMockStoreDataV2(env, {
        libName: 'tiff',
        commit: 'eee1234567890123456789012345678901234567',
        platforms: ['macOS'],
      });

      // 计算正确的完整性数据
      process.env.TANMI_DOCK_HOME = env.homeDir;
      const { resetRegistry } = await import('../../src/core/registry.js');
      resetRegistry();

      const storeMod = await import('../../src/core/store.js');
      const integrity = await storeMod.captureIntegrity(
        'tiff',
        'eee1234567890123456789012345678901234567',
        'macOS'
      );

      // 写入完整性数据到 registry
      const registry = await loadRegistry(env);
      const storeKey = 'tiff:eee1234567890123456789012345678901234567:macOS';
      registry.stores[storeKey] = {
        ...registry.stores[storeKey],
        ...integrity,
      } as any;
      await saveRegistry(env, registry);

      // 2. 删除 Store 中的文件（模拟损坏）
      const platformDir = path.join(
        env.storeDir,
        'tiff',
        'eee1234567890123456789012345678901234567',
        'macOS'
      );
      await fs.unlink(path.join(platformDir, 'lib.a'));

      // 3. 运行 checkStoreIntegrity
      resetRegistry();
      const { checkStoreIntegrity } = await import('../../src/commands/check.js');
      const corrupted = await checkStoreIntegrity();

      // 4. 应报告 1 个损坏
      expect(corrupted.length).toBe(1);
      expect(corrupted[0].libName).toBe('tiff');
      expect(corrupted[0].platform).toBe('macOS');
      expect(corrupted[0].reason).toContain('fileCount');
    });

    it('文件内容被篡改应报告 contentHash mismatch', async () => {
      env = await createTestEnv();

      // 1. 创建并设置完整性数据
      await createMockStoreDataV2(env, {
        libName: 'xml',
        commit: 'fff1234567890123456789012345678901234567',
        platforms: ['macOS'],
      });

      process.env.TANMI_DOCK_HOME = env.homeDir;
      const { resetRegistry } = await import('../../src/core/registry.js');
      resetRegistry();

      const storeMod = await import('../../src/core/store.js');
      const integrity = await storeMod.captureIntegrity(
        'xml',
        'fff1234567890123456789012345678901234567',
        'macOS'
      );

      const registry = await loadRegistry(env);
      const storeKey = 'xml:fff1234567890123456789012345678901234567:macOS';
      registry.stores[storeKey] = {
        ...registry.stores[storeKey],
        ...integrity,
      } as any;
      await saveRegistry(env, registry);

      // 2. 修改文件内容（但不改变文件数量）
      const platformDir = path.join(
        env.storeDir,
        'xml',
        'fff1234567890123456789012345678901234567',
        'macOS'
      );
      // 用相同长度的内容覆盖（保持 size 一致，但 hash 不同）
      const originalContent = await fs.readFile(path.join(platformDir, 'lib.a'), 'utf-8');
      await fs.writeFile(
        path.join(platformDir, 'lib.a'),
        'X'.repeat(originalContent.length),
        'utf-8'
      );

      // 3. 运行 checkStoreIntegrity
      resetRegistry();
      const { checkStoreIntegrity } = await import('../../src/commands/check.js');
      const corrupted = await checkStoreIntegrity();

      // 4. 应报告 contentHash mismatch（fileCount 和 size 一致但内容变了）
      expect(corrupted.length).toBe(1);
      expect(corrupted[0].reason).toContain('contentHash');
    });
  });

  // ============ S-6: fixCorruptedStores ============

  describe('S-6: fixCorruptedStores 修复损坏', () => {
    it('应清除损坏的 Store 目录和 Registry 记录', async () => {
      env = await createTestEnv();

      // 1. 创建 Store 数据
      await createMockStoreDataV2(env, {
        libName: 'bz2',
        commit: 'ggg1234567890123456789012345678901234567',
        platforms: ['macOS'],
      });

      // 确认 Store 目录存在
      const platformDir = path.join(
        env.storeDir,
        'bz2',
        'ggg1234567890123456789012345678901234567',
        'macOS'
      );
      const existsBefore = await fs.access(platformDir).then(() => true).catch(() => false);
      expect(existsBefore).toBe(true);

      // 2. 运行 fixCorruptedStores
      process.env.TANMI_DOCK_HOME = env.homeDir;
      const { resetRegistry } = await import('../../src/core/registry.js');
      resetRegistry();

      const { fixCorruptedStores } = await import('../../src/commands/check.js');
      await fixCorruptedStores([
        {
          libName: 'bz2',
          commit: 'ggg1234567890123456789012345678901234567',
          platform: 'macOS',
          reason: 'fileCount mismatch',
          expected: { fileCount: 10, size: 1024 },
          actual: { fileCount: 7, size: 800 },
        },
      ]);

      // 3. 验证：Store 目录被清除
      const existsAfter = await fs.access(platformDir).then(() => true).catch(() => false);
      expect(existsAfter).toBe(false);

      // 4. 验证：Registry 中记录被删除
      const entry = await getStoreEntry(
        env,
        'bz2',
        'ggg1234567890123456789012345678901234567',
        'macOS'
      );
      expect(entry).toBeUndefined();
    });
  });

  // ============ S-7: 混合场景 ============

  describe('S-7: 新旧数据混合场景', () => {
    it('多个库中只有损坏的被标记，旧数据和正常数据不受影响', async () => {
      env = await createTestEnv();

      // 1. 创建 3 个库
      // 库 A: 旧版无 fileCount
      await createMockStoreDataV2(env, {
        libName: 'libA',
        commit: 'hhh1234567890123456789012345678901234567',
        platforms: ['macOS'],
      });

      // 库 B: 有 fileCount 且完好
      await createMockStoreDataV2(env, {
        libName: 'libB',
        commit: 'iii1234567890123456789012345678901234567',
        platforms: ['macOS'],
      });

      // 库 C: 有 fileCount 但被损坏
      await createMockStoreDataV2(env, {
        libName: 'libC',
        commit: 'jjj1234567890123456789012345678901234567',
        platforms: ['macOS'],
      });

      // 2. 给 B 和 C 设置正确的完整性数据
      process.env.TANMI_DOCK_HOME = env.homeDir;
      const { resetRegistry } = await import('../../src/core/registry.js');
      resetRegistry();

      const storeMod = await import('../../src/core/store.js');

      const integrityB = await storeMod.captureIntegrity(
        'libB',
        'iii1234567890123456789012345678901234567',
        'macOS'
      );
      const integrityC = await storeMod.captureIntegrity(
        'libC',
        'jjj1234567890123456789012345678901234567',
        'macOS'
      );

      const registry = await loadRegistry(env);
      registry.stores['libB:iii1234567890123456789012345678901234567:macOS'] = {
        ...registry.stores['libB:iii1234567890123456789012345678901234567:macOS'],
        ...integrityB,
      } as any;
      registry.stores['libC:jjj1234567890123456789012345678901234567:macOS'] = {
        ...registry.stores['libC:jjj1234567890123456789012345678901234567:macOS'],
        ...integrityC,
      } as any;
      await saveRegistry(env, registry);

      // 3. 损坏库 C 的文件
      const libCDir = path.join(
        env.storeDir,
        'libC',
        'jjj1234567890123456789012345678901234567',
        'macOS'
      );
      await fs.unlink(path.join(libCDir, 'lib.a'));

      // 4. 运行 checkStoreIntegrity
      resetRegistry();
      const { checkStoreIntegrity } = await import('../../src/commands/check.js');
      const corrupted = await checkStoreIntegrity();

      // 5. 验证：只有 C 被报告损坏
      expect(corrupted.length).toBe(1);
      expect(corrupted[0].libName).toBe('libC');

      // 6. 验证：A 被回填了（读取更新后的 registry）
      const updatedEntry = await getStoreEntry(
        env,
        'libA',
        'hhh1234567890123456789012345678901234567',
        'macOS'
      );
      expect(typeof updatedEntry!.fileCount).toBe('number');
      expect(typeof updatedEntry!.contentHash).toBe('string');

      // 7. 验证：B 不受影响
      const entryB = await getStoreEntry(
        env,
        'libB',
        'iii1234567890123456789012345678901234567',
        'macOS'
      );
      expect(entryB!.fileCount).toBe(integrityB.fileCount);
      expect(entryB!.contentHash).toBe(integrityB.contentHash);
    });
  });

  // ============ S-8: quickVerify vs fullVerify 行为差异 ============

  describe('S-8: quickVerify 和 fullVerify 行为验证', () => {
    it('quickVerify 不检查 contentHash', async () => {
      env = await createTestEnv();

      // 创建 Store 数据
      await createMockStoreDataV2(env, {
        libName: 'quicktest',
        commit: 'kkk1234567890123456789012345678901234567',
        platforms: ['macOS'],
      });

      process.env.TANMI_DOCK_HOME = env.homeDir;
      const { resetRegistry } = await import('../../src/core/registry.js');
      resetRegistry();

      const storeMod = await import('../../src/core/store.js');
      const integrity = await storeMod.captureIntegrity(
        'quicktest',
        'kkk1234567890123456789012345678901234567',
        'macOS'
      );

      // 修改文件内容但不改变文件数量（保持 size 和 fileCount 相同）
      const platformDir = path.join(
        env.storeDir,
        'quicktest',
        'kkk1234567890123456789012345678901234567',
        'macOS'
      );
      const original = await fs.readFile(path.join(platformDir, 'lib.a'), 'utf-8');
      await fs.writeFile(path.join(platformDir, 'lib.a'), 'Z'.repeat(original.length));

      // quickVerify 应该通过（不检查 hash）
      const quickResult = await storeMod.quickVerify(
        'quicktest',
        'kkk1234567890123456789012345678901234567',
        'macOS',
        { size: integrity.size, fileCount: integrity.fileCount }
      );
      expect(quickResult.valid).toBe(true);

      // fullVerify 应该失败（检查 hash）
      const fullResult = await storeMod.fullVerify(
        'quicktest',
        'kkk1234567890123456789012345678901234567',
        'macOS',
        { size: integrity.size, fileCount: integrity.fileCount, contentHash: integrity.contentHash }
      );
      expect(fullResult.valid).toBe(false);
      expect(fullResult.reason).toContain('contentHash');
    });
  });

  // ============ S-9: Store 目录完全清空 ============

  describe('S-9: Store 平台目录完全清空', () => {
    it('所有文件被删除后 quickVerify 应检测到 fileCount=0', async () => {
      env = await createTestEnv();

      await createMockStoreDataV2(env, {
        libName: 'empty',
        commit: 'lll1234567890123456789012345678901234567',
        platforms: ['macOS'],
      });

      process.env.TANMI_DOCK_HOME = env.homeDir;
      const { resetRegistry } = await import('../../src/core/registry.js');
      resetRegistry();

      const storeMod = await import('../../src/core/store.js');
      const integrity = await storeMod.captureIntegrity(
        'empty',
        'lll1234567890123456789012345678901234567',
        'macOS'
      );

      // 删除所有平台文件
      const platformDir = path.join(
        env.storeDir,
        'empty',
        'lll1234567890123456789012345678901234567',
        'macOS'
      );
      const files = await fs.readdir(platformDir);
      for (const file of files) {
        await fs.unlink(path.join(platformDir, file));
      }

      // quickVerify 应失败
      const result = await storeMod.quickVerify(
        'empty',
        'lll1234567890123456789012345678901234567',
        'macOS',
        { size: integrity.size, fileCount: integrity.fileCount }
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('fileCount');
    });
  });
});
