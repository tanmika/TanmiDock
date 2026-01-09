/**
 * TC-019: status 命令测试
 *
 * 测试场景:
 * - S-4.1.1: 已链接项目的状态显示
 * - S-4.1.2: 未链接项目的状态显示
 * - S-4.1.3: 链接失效检测
 * - S-4.2.1: --json 选项输出
 * - S-4.2.2: 多库状态统计
 *
 * v2.0: 调用 showStatus() 入口函数
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
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
import { isSymlink } from '../../src/core/linker.js';

/**
 * 创建测试项目配置文件
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

  // 创建配置文件
  await createProjectConfig(
    env,
    deps.map(d => ({ libName: d.libName, commit: d.commit }))
  );

  // 执行 link 命令
  await runCommand('link', { platform: linkPlatforms, yes: true }, env, env.projectDir);
}

/**
 * 运行 status 命令并捕获 JSON 输出
 */
async function runStatusAndGetJson(env: TestEnv): Promise<unknown> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runCommand('status', { json: true }, env, env.projectDir);
    // 获取最后一次 JSON 输出
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

describe('TC-019: status 命令测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('S-4.1.1: 已链接项目的状态显示', () => {
    it('should show linked status for linked project', async () => {
      env = await createTestEnv();

      const libName = 'libStatusLinked';
      const commit = 'statuslinked123456';

      // 创建并链接
      await createLinkedProject(
        env,
        [{ libName, commit, platforms: ['macOS'] }],
        ['macOS']
      );

      // 验证已链接
      const localPath = path.join(env.projectDir, '3rdparty', libName);
      expect(await isSymlink(path.join(localPath, 'macOS'))).toBe(true);

      // 执行 status 命令并获取 JSON 输出
      const jsonOutput = (await runStatusAndGetJson(env)) as {
        dependencies: { linked: number; broken: number; unlinked: number };
      };

      expect(jsonOutput.dependencies.linked).toBe(1);
      expect(jsonOutput.dependencies.broken).toBe(0);
      expect(jsonOutput.dependencies.unlinked).toBe(0);
    });

    it('should show project platforms and last linked time', async () => {
      env = await createTestEnv();

      const libName = 'libStatusInfo';
      const commit = 'statusinfo123456';

      // 创建并链接
      await createLinkedProject(
        env,
        [{ libName, commit, platforms: ['macOS', 'iOS'] }],
        ['macOS', 'iOS']
      );

      // 执行 status 命令
      const jsonOutput = (await runStatusAndGetJson(env)) as {
        platforms: string[];
        lastLinked: string | null;
      };

      expect(jsonOutput.platforms).toContain('macOS');
      expect(jsonOutput.platforms).toContain('iOS');
      expect(jsonOutput.lastLinked).not.toBeNull();
    });
  });

  describe('S-4.1.2: 未链接项目的状态显示', () => {
    it('should show unlinked status for new project', async () => {
      env = await createTestEnv();

      const libName = 'libStatusUnlinked';
      const commit = 'statusunlinked123456';

      // 只创建配置文件，不执行 link
      await createProjectConfig(env, [{ libName, commit }]);

      // 执行 status 命令
      const jsonOutput = (await runStatusAndGetJson(env)) as {
        dependencies: { linked: number; unlinked: number };
        lastLinked: string | null;
        unlinkedList: string[];
      };

      expect(jsonOutput.dependencies.linked).toBe(0);
      expect(jsonOutput.dependencies.unlinked).toBe(1);
      expect(jsonOutput.lastLinked).toBeNull();
      expect(jsonOutput.unlinkedList.length).toBe(1);
    });
  });

  describe('S-4.1.3: 链接失效检测', () => {
    it('should detect broken links when Store is removed', async () => {
      env = await createTestEnv();

      const libName = 'libStatusBroken';
      const commit = 'statusbroken123456';

      // 创建并链接
      await createLinkedProject(
        env,
        [{ libName, commit, platforms: ['macOS'] }],
        ['macOS']
      );

      // 删除 Store 中的目录（模拟链接失效）
      const storePlatformPath = path.join(env.storeDir, libName, commit, 'macOS');
      await fs.rm(storePlatformPath, { recursive: true, force: true });

      // 执行 status 命令
      const jsonOutput = (await runStatusAndGetJson(env)) as {
        dependencies: { broken: number };
        brokenList: string[];
      };

      expect(jsonOutput.dependencies.broken).toBe(1);
      expect(jsonOutput.brokenList.length).toBe(1);
    });
  });

  describe('S-4.2.1: --json 选项输出', () => {
    it('should output valid JSON with --json option', async () => {
      env = await createTestEnv();

      const libName = 'libStatusJson';
      const commit = 'statusjson123456';

      // 创建并链接
      await createLinkedProject(
        env,
        [{ libName, commit, platforms: ['macOS'] }],
        ['macOS']
      );

      // 执行 status 命令
      const jsonOutput = (await runStatusAndGetJson(env)) as Record<string, unknown>;

      // 验证 JSON 结构
      expect(jsonOutput).toHaveProperty('project');
      expect(jsonOutput).toHaveProperty('lastLinked');
      expect(jsonOutput).toHaveProperty('platforms');
      expect(jsonOutput).toHaveProperty('dependencies');
      expect(jsonOutput.dependencies).toHaveProperty('total');
      expect((jsonOutput.dependencies as Record<string, unknown>)).toHaveProperty('linked');
      expect((jsonOutput.dependencies as Record<string, unknown>)).toHaveProperty('broken');
      expect((jsonOutput.dependencies as Record<string, unknown>)).toHaveProperty('unlinked');
      expect(jsonOutput).toHaveProperty('brokenList');
      expect(jsonOutput).toHaveProperty('unlinkedList');
    });
  });

  describe('S-4.2.2: 多库状态统计', () => {
    it('should correctly count multiple libraries status', async () => {
      env = await createTestEnv();

      // 创建多个库的 Store 数据
      await createMockStoreDataV2(env, {
        libName: 'libA',
        commit: 'commitA123456789',
        platforms: ['macOS'],
        referencedBy: [],
      });

      await createMockStoreDataV2(env, {
        libName: 'libB',
        commit: 'commitB123456789',
        platforms: ['macOS'],
        referencedBy: [],
      });

      // 创建配置文件（3 个库，但只有 2 个在 Store 中）
      await createProjectConfig(env, [
        { libName: 'libA', commit: 'commitA123456789' },
        { libName: 'libB', commit: 'commitB123456789' },
        { libName: 'libC', commit: 'commitC123456789' }, // 不在 Store 中
      ]);

      // 执行 link 命令（libC 会被标记为 MISSING 但跳过下载）
      await runCommand('link', { platform: ['macOS'], yes: true, download: false }, env, env.projectDir);

      // 删除 libA 的 Store 目录（模拟链接失效）
      const storePathA = path.join(env.storeDir, 'libA', 'commitA123456789', 'macOS');
      await fs.rm(storePathA, { recursive: true, force: true });

      // 执行 status 命令
      const jsonOutput = (await runStatusAndGetJson(env)) as {
        dependencies: { total: number; linked: number; broken: number; unlinked: number };
      };

      expect(jsonOutput.dependencies.total).toBe(3);
      expect(jsonOutput.dependencies.linked).toBe(1); // libB
      expect(jsonOutput.dependencies.broken).toBe(1); // libA
      expect(jsonOutput.dependencies.unlinked).toBe(1); // libC
    });
  });

  describe('S-4.3: 边界情况', () => {
    it('should handle project with no dependencies', async () => {
      env = await createTestEnv();

      // 创建空的配置文件
      const thirdPartyDir = path.join(env.projectDir, '3rdparty');
      await fs.mkdir(thirdPartyDir, { recursive: true });
      const codepacDep = {
        version: '1.0.0',
        vars: {},
        repos: { common: [] },
      };
      await fs.writeFile(
        path.join(thirdPartyDir, 'codepac-dep.json'),
        JSON.stringify(codepacDep, null, 2),
        'utf-8'
      );

      // 执行 status 命令
      const jsonOutput = (await runStatusAndGetJson(env)) as {
        dependencies: { total: number };
      };

      expect(jsonOutput.dependencies.total).toBe(0);
    });

    it('should handle multi-platform links correctly', async () => {
      env = await createTestEnv();

      const libName = 'libStatusMulti';
      const commit = 'statusmulti123456';

      // 创建并链接多平台
      await createLinkedProject(
        env,
        [{ libName, commit, platforms: ['macOS', 'iOS', 'android'] }],
        ['macOS', 'iOS']
      );

      // 执行 status 命令
      const jsonOutput = (await runStatusAndGetJson(env)) as {
        dependencies: { linked: number; broken: number };
      };

      expect(jsonOutput.dependencies.linked).toBe(1);
      expect(jsonOutput.dependencies.broken).toBe(0);
    });
  });
});
