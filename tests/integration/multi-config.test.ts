/**
 * 多配置文件支持 - 集成测试
 *
 * 测试完整的多配置文件工作流，从配置发现到依赖链接
 *
 * 测试场景:
 * - S-2.1: 单配置场景 - 传统行为不变
 * - S-2.2: 多配置场景 - 主配置 + 可选配置
 * - S-2.3: 依赖合并去重 - 相同库只保留一份
 * - S-2.4: 非 TTY 场景 - 必须传 --config 参数
 * - S-2.5: 记忆偏好 - 保存和读取 optionalConfigs
 *
 * 注意: 这些测试用于 TDD，功能尚未实现，预期测试会失败（红灯状态）
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
  verifySymlink,
  hashPath,
  type TestEnv,
} from './setup.js';

/**
 * 创建多配置测试项目
 * - 创建 3rdparty 目录
 * - 创建主配置 codepac-dep.json
 * - 创建可选配置 codepac-dep-{name}.json
 */
async function createMultiConfigProject(
  env: TestEnv,
  mainDeps: Array<{
    libName: string;
    commit: string;
    branch?: string;
    url?: string;
  }>,
  optionalConfigs: Array<{
    name: string;
    deps: Array<{
      libName: string;
      commit: string;
      branch?: string;
      url?: string;
    }>;
  }>
): Promise<string> {
  const thirdPartyDir = path.join(env.projectDir, '3rdparty');
  await fs.mkdir(thirdPartyDir, { recursive: true });

  // 创建主配置 codepac-dep.json
  const mainConfig = {
    version: '1.0.0',
    vars: {},
    repos: {
      common: mainDeps.map(d => ({
        url: d.url ?? `https://github.com/test/${d.libName}.git`,
        commit: d.commit,
        branch: d.branch ?? 'main',
        dir: d.libName,
      })),
    },
  };
  const mainConfigPath = path.join(thirdPartyDir, 'codepac-dep.json');
  await fs.writeFile(mainConfigPath, JSON.stringify(mainConfig, null, 2), 'utf-8');

  // 创建可选配置 codepac-dep-{name}.json
  for (const optConfig of optionalConfigs) {
    const config = {
      version: '1.0.0',
      vars: {},
      repos: {
        common: optConfig.deps.map(d => ({
          url: d.url ?? `https://github.com/test/${d.libName}.git`,
          commit: d.commit,
          branch: d.branch ?? 'main',
          dir: d.libName,
        })),
      },
    };
    const configPath = path.join(thirdPartyDir, `codepac-dep-${optConfig.name}.json`);
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  return mainConfigPath;
}

describe('TC-025: 多配置文件支持集成测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('S-2.1: 单配置场景 - 传统行为不变', () => {
    it('should work with only main config (backward compatibility)', async () => {
      env = await createTestEnv();

      const libName = 'libMain';
      const commit = 'main123456789';

      // 创建 Store 数据
      await createMockStoreDataV2(env, {
        libName,
        commit,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 创建只有主配置的项目
      await createMultiConfigProject(
        env,
        [{ libName, commit }],
        [] // 没有可选配置
      );

      // 执行 link 命令
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // 验证链接创建成功
      const localPath = path.join(env.projectDir, '3rdparty', libName, 'macOS');
      const storeTarget = path.join(env.storeDir, libName, commit, 'macOS');
      await verifySymlink(localPath, storeTarget);
    });
  });

  describe('S-2.2: 多配置场景 - 主配置 + 可选配置', () => {
    it('should discover and list optional configs', async () => {
      env = await createTestEnv();

      // 创建带可选配置的项目
      await createMultiConfigProject(
        env,
        [{ libName: 'libMain', commit: 'main123' }],
        [
          { name: 'inner', deps: [{ libName: 'libInner', commit: 'inner123' }] },
          { name: 'testcase', deps: [{ libName: 'libTest', commit: 'test123' }] },
        ]
      );

      // 导入并测试配置发现功能
      const { findAllCodepacConfigs } = await import('../../src/core/parser.js');
      const thirdPartyDir = path.join(env.projectDir, '3rdparty');
      const result = await findAllCodepacConfigs(thirdPartyDir);

      // 验证发现了主配置和可选配置
      expect(result).not.toBeNull();
      expect(result!.mainConfig).toBe(path.join(thirdPartyDir, 'codepac-dep.json'));
      expect(result!.optionalConfigs).toHaveLength(2);
      expect(result!.optionalConfigs.map(c => c.name).sort()).toEqual(['inner', 'testcase']);
    });

    it('should link dependencies from selected optional configs', async () => {
      env = await createTestEnv();

      const mainLib = { libName: 'libMain', commit: 'main123456789' };
      const innerLib = { libName: 'libInner', commit: 'inner123456789' };

      // 创建 Store 数据
      await createMockStoreDataV2(env, {
        ...mainLib,
        platforms: ['macOS'],
        referencedBy: [],
      });
      await createMockStoreDataV2(env, {
        ...innerLib,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 创建带可选配置的项目
      await createMultiConfigProject(
        env,
        [mainLib],
        [{ name: 'inner', deps: [innerLib] }]
      );

      // 执行 link 命令，指定使用 inner 配置
      // 注意: 这里假设 link 命令支持 --config 参数
      await runCommand(
        'link',
        { platform: ['macOS'], yes: true, config: ['inner'] } as Parameters<typeof runCommand>[1],
        env,
        env.projectDir
      );

      // 验证主配置和可选配置的依赖都被链接
      const mainLocalPath = path.join(env.projectDir, '3rdparty', mainLib.libName, 'macOS');
      const innerLocalPath = path.join(env.projectDir, '3rdparty', innerLib.libName, 'macOS');

      await verifySymlink(mainLocalPath, path.join(env.storeDir, mainLib.libName, mainLib.commit, 'macOS'));
      await verifySymlink(innerLocalPath, path.join(env.storeDir, innerLib.libName, innerLib.commit, 'macOS'));
    });
  });

  describe('S-2.3: 依赖合并去重 - 相同库只保留一份', () => {
    it('should deduplicate when same library in main and optional config', async () => {
      env = await createTestEnv();

      // 主配置和可选配置都有 libShared，但 commit 不同
      const mainLib = { libName: 'libShared', commit: 'maincommit123' };
      const innerLib = { libName: 'libShared', commit: 'innercommit123' };
      const uniqueLib = { libName: 'libUnique', commit: 'unique123456' };

      // 只创建 innerLib 的 Store 数据（因为可选配置会覆盖主配置）
      await createMockStoreDataV2(env, {
        ...innerLib,
        platforms: ['macOS'],
        referencedBy: [],
      });
      await createMockStoreDataV2(env, {
        ...uniqueLib,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 创建带可选配置的项目
      await createMultiConfigProject(
        env,
        [mainLib], // 主配置中的 libShared
        [{ name: 'inner', deps: [innerLib, uniqueLib] }] // 可选配置中的 libShared（不同 commit）+ libUnique
      );

      // 执行 link 命令
      await runCommand(
        'link',
        { platform: ['macOS'], yes: true, config: ['inner'] } as Parameters<typeof runCommand>[1],
        env,
        env.projectDir
      );

      // 验证 libShared 链接到 innerLib 的 commit（可选配置覆盖主配置）
      const sharedLocalPath = path.join(env.projectDir, '3rdparty', 'libShared', 'macOS');
      await verifySymlink(sharedLocalPath, path.join(env.storeDir, 'libShared', innerLib.commit, 'macOS'));

      // 验证 libUnique 也被链接
      const uniqueLocalPath = path.join(env.projectDir, '3rdparty', 'libUnique', 'macOS');
      await verifySymlink(uniqueLocalPath, path.join(env.storeDir, 'libUnique', uniqueLib.commit, 'macOS'));
    });

    it('should keep main config version when optional config not selected', async () => {
      env = await createTestEnv();

      const mainLib = { libName: 'libShared', commit: 'maincommit123' };
      const innerLib = { libName: 'libShared', commit: 'innercommit123' };

      // 创建 mainLib 的 Store 数据
      await createMockStoreDataV2(env, {
        ...mainLib,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 创建带可选配置的项目
      await createMultiConfigProject(
        env,
        [mainLib],
        [{ name: 'inner', deps: [innerLib] }]
      );

      // 执行 link 命令，不选择可选配置
      await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

      // 验证链接到主配置的 commit
      const localPath = path.join(env.projectDir, '3rdparty', 'libShared', 'macOS');
      await verifySymlink(localPath, path.join(env.storeDir, 'libShared', mainLib.commit, 'macOS'));
    });
  });

  describe('S-2.4: 非 TTY 场景 - 必须传 --config 参数', () => {
    it('should fail when not TTY and optional configs exist but not specified', async () => {
      env = await createTestEnv();

      // 创建带可选配置的项目
      await createMultiConfigProject(
        env,
        [{ libName: 'libMain', commit: 'main123' }],
        [{ name: 'inner', deps: [{ libName: 'libInner', commit: 'inner123' }] }]
      );

      // 模拟非 TTY 环境
      const originalIsTTY = process.stdout.isTTY;
      process.stdout.isTTY = false;

      try {
        // 执行 link 命令，不指定 --config，也不指定 --yes
        // 注意：runCommand 默认 yes: true，需要显式设为 false
        // 应该失败，因为非 TTY 模式下存在可选配置但未明确处理方式
        // Vitest 会将 process.exit 转换为错误
        await expect(
          runCommand('link', { platform: ['macOS'], yes: false }, env, env.projectDir)
        ).rejects.toThrow(/process\.exit/);
      } finally {
        process.stdout.isTTY = originalIsTTY;
      }
    });

    it('should work in non-TTY mode when --config is specified', async () => {
      env = await createTestEnv();

      const mainLib = { libName: 'libMain', commit: 'main123456789' };
      const innerLib = { libName: 'libInner', commit: 'inner123456789' };

      // 创建 Store 数据
      await createMockStoreDataV2(env, {
        ...mainLib,
        platforms: ['macOS'],
        referencedBy: [],
      });
      await createMockStoreDataV2(env, {
        ...innerLib,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 创建带可选配置的项目
      await createMultiConfigProject(
        env,
        [mainLib],
        [{ name: 'inner', deps: [innerLib] }]
      );

      // 模拟非 TTY 环境
      const originalIsTTY = process.stdout.isTTY;
      process.stdout.isTTY = false;

      try {
        // 执行 link 命令，指定 --config
        await runCommand(
          'link',
          { platform: ['macOS'], yes: true, config: ['inner'] } as Parameters<typeof runCommand>[1],
          env,
          env.projectDir
        );

        // 验证链接成功
        const mainLocalPath = path.join(env.projectDir, '3rdparty', mainLib.libName, 'macOS');
        const innerLocalPath = path.join(env.projectDir, '3rdparty', innerLib.libName, 'macOS');

        await verifySymlink(mainLocalPath, path.join(env.storeDir, mainLib.libName, mainLib.commit, 'macOS'));
        await verifySymlink(innerLocalPath, path.join(env.storeDir, innerLib.libName, innerLib.commit, 'macOS'));
      } finally {
        process.stdout.isTTY = originalIsTTY;
      }
    });

    it('should work in non-TTY mode with single config (no optional configs)', async () => {
      env = await createTestEnv();

      const mainLib = { libName: 'libMain', commit: 'main123456789' };

      // 创建 Store 数据
      await createMockStoreDataV2(env, {
        ...mainLib,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 创建只有主配置的项目（无可选配置）
      await createMultiConfigProject(env, [mainLib], []);

      // 模拟非 TTY 环境
      const originalIsTTY = process.stdout.isTTY;
      process.stdout.isTTY = false;

      try {
        // 执行 link 命令，不需要 --config 因为没有可选配置
        await runCommand('link', { platform: ['macOS'], yes: true }, env, env.projectDir);

        // 验证链接成功
        const localPath = path.join(env.projectDir, '3rdparty', mainLib.libName, 'macOS');
        await verifySymlink(localPath, path.join(env.storeDir, mainLib.libName, mainLib.commit, 'macOS'));
      } finally {
        process.stdout.isTTY = originalIsTTY;
      }
    });
  });

  describe('S-2.5: 记忆偏好 - 保存和读取 optionalConfigs', () => {
    it('should save selected optional configs to registry', async () => {
      env = await createTestEnv();

      const mainLib = { libName: 'libMain', commit: 'main123456789' };
      const innerLib = { libName: 'libInner', commit: 'inner123456789' };

      // 创建 Store 数据
      await createMockStoreDataV2(env, {
        ...mainLib,
        platforms: ['macOS'],
        referencedBy: [],
      });
      await createMockStoreDataV2(env, {
        ...innerLib,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 创建带可选配置的项目
      await createMultiConfigProject(
        env,
        [mainLib],
        [{ name: 'inner', deps: [innerLib] }]
      );

      // 执行 link 命令，选择 inner 配置
      await runCommand(
        'link',
        { platform: ['macOS'], yes: true, config: ['inner'] } as Parameters<typeof runCommand>[1],
        env,
        env.projectDir
      );

      // 验证 registry 中保存了 optionalConfigs
      const registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      const project = registry.projects[projectHash];

      expect(project).toBeDefined();
      expect((project as { optionalConfigs?: string[] }).optionalConfigs).toEqual(['inner']);
    });

    it('should use saved optional configs as default in interactive mode', async () => {
      env = await createTestEnv();

      const mainLib = { libName: 'libMain', commit: 'main123456789' };
      const innerLib = { libName: 'libInner', commit: 'inner123456789' };
      const testLib = { libName: 'libTest', commit: 'test123456789' };

      // 创建 Store 数据
      await createMockStoreDataV2(env, {
        ...mainLib,
        platforms: ['macOS'],
        referencedBy: [],
      });
      await createMockStoreDataV2(env, {
        ...innerLib,
        platforms: ['macOS'],
        referencedBy: [],
      });
      await createMockStoreDataV2(env, {
        ...testLib,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 创建带可选配置的项目
      await createMultiConfigProject(
        env,
        [mainLib],
        [
          { name: 'inner', deps: [innerLib] },
          { name: 'testcase', deps: [testLib] },
        ]
      );

      // 预先设置 registry 中的偏好
      const registry = await loadRegistry(env);
      const projectHash = hashPath(env.projectDir);
      registry.projects[projectHash] = {
        path: env.projectDir,
        configPath: path.join(env.projectDir, '3rdparty', 'codepac-dep.json'),
        lastLinked: new Date().toISOString(),
        platforms: ['macOS'],
        dependencies: [],
        optionalConfigs: ['inner'], // 保存的偏好
      } as typeof registry.projects[string] & { optionalConfigs: string[] };
      await saveRegistry(env, registry);

      // 重置 registry 单例，使其重新从文件加载
      const { resetRegistry } = await import('../../src/core/registry.js');
      resetRegistry();

      // 导入并测试加载偏好功能
      const { loadOptionalConfigPreference } = await import('../../src/core/parser.js');
      const savedPrefs = await loadOptionalConfigPreference(env.projectDir);

      // 验证返回保存的偏好
      expect(savedPrefs).toEqual(['inner']);
    });

    it('should clear saved preference when user selects different configs', async () => {
      env = await createTestEnv();

      const mainLib = { libName: 'libMain', commit: 'main123456789' };
      const innerLib = { libName: 'libInner', commit: 'inner123456789' };
      const testLib = { libName: 'libTest', commit: 'test123456789' };

      // 创建 Store 数据
      await createMockStoreDataV2(env, {
        ...mainLib,
        platforms: ['macOS'],
        referencedBy: [],
      });
      await createMockStoreDataV2(env, {
        ...innerLib,
        platforms: ['macOS'],
        referencedBy: [],
      });
      await createMockStoreDataV2(env, {
        ...testLib,
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 创建带可选配置的项目
      await createMultiConfigProject(
        env,
        [mainLib],
        [
          { name: 'inner', deps: [innerLib] },
          { name: 'testcase', deps: [testLib] },
        ]
      );

      // 第一次 link，选择 inner
      await runCommand(
        'link',
        { platform: ['macOS'], yes: true, config: ['inner'] } as Parameters<typeof runCommand>[1],
        env,
        env.projectDir
      );

      // 验证保存了 inner
      let registry = await loadRegistry(env);
      let projectHash = hashPath(env.projectDir);
      expect((registry.projects[projectHash] as { optionalConfigs?: string[] }).optionalConfigs).toEqual(['inner']);

      // 第二次 link，选择 testcase（不同的配置）
      await runCommand(
        'link',
        { platform: ['macOS'], yes: true, config: ['testcase'] } as Parameters<typeof runCommand>[1],
        env,
        env.projectDir
      );

      // 验证偏好更新为 testcase
      registry = await loadRegistry(env);
      projectHash = hashPath(env.projectDir);
      expect((registry.projects[projectHash] as { optionalConfigs?: string[] }).optionalConfigs).toEqual(['testcase']);
    });
  });
});
