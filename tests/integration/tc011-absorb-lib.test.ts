/**
 * TC-011: absorbLib 集成测试
 *
 * 验证场景：
 * - 真实文件移动（非 mock）
 * - 平台目录移动到 Store
 * - _shared 共享内容处理
 * - 已存在平台跳过
 * - 失败时回滚
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { createTestEnv, type TestEnv } from './setup.js';
import { absorbLib, getStorePath } from '../../src/core/store.js';

describe('TC-011: absorbLib 集成测试', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  /**
   * 创建模拟的本地库目录（用于吸收测试）
   * 结构:
   * libDir/
   * ├── macOS/
   * │   └── lib.a
   * ├── android/
   * │   └── lib.so
   * ├── codepac-dep.json  (共享)
   * └── common.h          (共享)
   */
  async function createLocalLib(
    baseDir: string,
    libName: string,
    platforms: string[]
  ): Promise<string> {
    const libDir = path.join(baseDir, libName);
    await fs.mkdir(libDir, { recursive: true });

    // 创建平台目录
    for (const platform of platforms) {
      const platformDir = path.join(libDir, platform);
      await fs.mkdir(platformDir, { recursive: true });

      const ext = platform === 'android' ? '.so' : '.a';
      await fs.writeFile(
        path.join(platformDir, `lib${ext}`),
        `Library content for ${platform}`,
        'utf-8'
      );
    }

    // 创建共享文件
    await fs.writeFile(
      path.join(libDir, 'codepac-dep.json'),
      JSON.stringify({ version: '1.0.0', name: libName }),
      'utf-8'
    );
    await fs.writeFile(
      path.join(libDir, 'common.h'),
      `// Common header for ${libName}`,
      'utf-8'
    );

    return libDir;
  }

  it('should move platform directories to Store', async () => {
    env = await createTestEnv();

    const libName = 'libAbsorb';
    const commit = 'absorb123';
    const platforms = ['macOS', 'android'];

    // Given: 本地库目录
    const localLibDir = await createLocalLib(env.tempDir, libName, platforms);

    // 验证源文件存在
    await expect(fs.access(path.join(localLibDir, 'macOS', 'lib.a'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(localLibDir, 'android', 'lib.so'))).resolves.toBeUndefined();

    // When: 执行 absorbLib
    const result = await absorbLib(localLibDir, platforms, libName, commit);

    // Then: 平台目录已移动到 Store
    const storePath = await getStorePath();
    const storeLibDir = path.join(storePath, libName, commit);

    // 验证 Store 中平台目录存在
    for (const platform of platforms) {
      const storePlatformPath = path.join(storeLibDir, platform);
      await expect(fs.access(storePlatformPath)).resolves.toBeUndefined();
    }

    // 验证 Store 中平台目录有文件
    await expect(fs.access(path.join(storeLibDir, 'macOS', 'lib.a'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(storeLibDir, 'android', 'lib.so'))).resolves.toBeUndefined();

    // 验证返回值
    expect(result.platformPaths['macOS']).toBe(path.join(storeLibDir, 'macOS'));
    expect(result.platformPaths['android']).toBe(path.join(storeLibDir, 'android'));
    expect(result.skippedPlatforms).toHaveLength(0);

    // 验证源目录中平台目录已被移走
    await expect(fs.access(path.join(localLibDir, 'macOS'))).rejects.toThrow();
    await expect(fs.access(path.join(localLibDir, 'android'))).rejects.toThrow();
  });

  it('should move shared files to _shared directory', async () => {
    env = await createTestEnv();

    const libName = 'libShared';
    const commit = 'shared456';
    const platforms = ['macOS'];

    // Given: 本地库目录（含共享文件）
    const localLibDir = await createLocalLib(env.tempDir, libName, platforms);

    // 验证共享文件存在
    await expect(fs.access(path.join(localLibDir, 'codepac-dep.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(localLibDir, 'common.h'))).resolves.toBeUndefined();

    // When: 执行 absorbLib
    const result = await absorbLib(localLibDir, platforms, libName, commit);

    // Then: 共享文件已移动到 _shared
    const storePath = await getStorePath();
    const sharedDir = path.join(storePath, libName, commit, '_shared');

    await expect(fs.access(path.join(sharedDir, 'codepac-dep.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(sharedDir, 'common.h'))).resolves.toBeUndefined();

    // 验证内容正确
    const codepacContent = JSON.parse(await fs.readFile(path.join(sharedDir, 'codepac-dep.json'), 'utf-8'));
    expect(codepacContent.name).toBe(libName);

    // 验证返回值
    expect(result.sharedPath).toBe(sharedDir);

    // 验证源目录中共享文件已被移走
    await expect(fs.access(path.join(localLibDir, 'codepac-dep.json'))).rejects.toThrow();
    await expect(fs.access(path.join(localLibDir, 'common.h'))).rejects.toThrow();
  });

  it('should skip already existing platforms', async () => {
    env = await createTestEnv();

    const libName = 'libSkip';
    const commit = 'skip789';
    const platforms = ['macOS', 'android'];

    // Given: Store 中已有 macOS 平台
    const storePath = await getStorePath();
    const existingPlatformDir = path.join(storePath, libName, commit, 'macOS');
    await fs.mkdir(existingPlatformDir, { recursive: true });
    await fs.writeFile(
      path.join(existingPlatformDir, 'existing.a'),
      'existing content',
      'utf-8'
    );

    // 创建本地库目录
    const localLibDir = await createLocalLib(env.tempDir, libName, platforms);

    // When: 执行 absorbLib
    const result = await absorbLib(localLibDir, platforms, libName, commit);

    // Then: macOS 被跳过，android 被移动
    expect(result.skippedPlatforms).toContain('macOS');
    expect(result.platformPaths['android']).toBeDefined();
    expect(result.platformPaths['macOS']).toBeUndefined();

    // 验证原有的 macOS 内容未被覆盖
    const existingContent = await fs.readFile(path.join(existingPlatformDir, 'existing.a'), 'utf-8');
    expect(existingContent).toBe('existing content');

    // 验证 android 已移动
    await expect(fs.access(path.join(storePath, libName, commit, 'android', 'lib.so'))).resolves.toBeUndefined();
  });

  it('should only absorb selected platforms', async () => {
    env = await createTestEnv();

    const libName = 'libPartial';
    const commit = 'partial123';
    const allPlatforms = ['macOS', 'android', 'Win'];
    const selectedPlatforms = ['macOS', 'android'];

    // Given: 本地库包含 3 个平台
    const localLibDir = await createLocalLib(env.tempDir, libName, allPlatforms);

    // When: 只选择 2 个平台吸收
    const result = await absorbLib(localLibDir, selectedPlatforms, libName, commit);

    // Then: 只有选中的平台被移动
    const storePath = await getStorePath();
    const storeLibDir = path.join(storePath, libName, commit);

    await expect(fs.access(path.join(storeLibDir, 'macOS'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(storeLibDir, 'android'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(storeLibDir, 'Win'))).rejects.toThrow();

    // 未选中的平台仍在本地
    await expect(fs.access(path.join(localLibDir, 'Win'))).resolves.toBeUndefined();

    // 验证返回值
    expect(Object.keys(result.platformPaths)).toHaveLength(2);
    expect(result.platformPaths['Win']).toBeUndefined();
  });

  // Note: rollback 逻辑已在单元测试 (store.test.ts) 中通过 mock 覆盖
  // 集成测试难以可靠触发错误条件（需要权限控制，跨平台不一致）
  // 因此这里只验证正常流程，rollback 验证依赖单元测试
  it.skip('should rollback on failure (covered by unit test)', async () => {
    // 此测试已在 tests/core/store.test.ts 中覆盖
    // "should rollback moved files on failure"
  });

  it('should handle empty platforms array', async () => {
    env = await createTestEnv();

    const libName = 'libEmpty';
    const commit = 'empty123';

    // Given: 本地库目录（有平台目录和共享文件）
    const localLibDir = await createLocalLib(env.tempDir, libName, ['macOS']);

    // When: 传入空平台数组
    const result = await absorbLib(localLibDir, [], libName, commit);

    // Then: 只移动共享文件，不移动平台
    expect(Object.keys(result.platformPaths)).toHaveLength(0);
    expect(result.skippedPlatforms).toHaveLength(0);

    // 平台目录仍在本地
    await expect(fs.access(path.join(localLibDir, 'macOS'))).resolves.toBeUndefined();

    // 共享文件已移动
    const storePath = await getStorePath();
    await expect(
      fs.access(path.join(storePath, libName, commit, '_shared', 'codepac-dep.json'))
    ).resolves.toBeUndefined();
  });
});
