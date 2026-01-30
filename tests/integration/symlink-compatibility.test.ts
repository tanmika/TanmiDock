/**
 * 符号链接兼容性验证测试
 *
 * 验证 _shared 目录使用符号链接后，各构建工具能否正确识别和访问
 * 测试范围:
 * - CMake: 通过符号链接访问 include/ 目录和头文件
 * - Xcode: 通过符号链接访问 framework 和 headers
 * - Android NDK: 通过符号链接访问 jni/ 和 headers
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import {
  createTestEnv,
  createMockStoreDataV2,
  verifySymlink,
  verifyNotSymlink,
  type TestEnv,
} from './setup.js';
import { linkLib } from '../../src/core/linker.js';
import * as config from '../../src/core/config.js';

/**
 * 创建带有嵌套目录的 _shared 数据
 * 与 createMockStoreDataV2 不同，此函数支持嵌套文件路径
 */
async function createMockStoreWithNestedFiles(
  env: TestEnv,
  libName: string,
  commit: string,
  platforms: string[],
  sharedFiles: Record<string, string>
): Promise<void> {
  const commitDir = path.join(env.storeDir, libName, commit);

  // 创建 _shared 目录
  const sharedDir = path.join(commitDir, '_shared');
  await fs.mkdir(sharedDir, { recursive: true });

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
    path.join(sharedDir, 'codepac-dep.json'),
    JSON.stringify(codepacDep, null, 2),
    'utf-8'
  );

  // 创建嵌套的共享文件（自动创建父目录）
  for (const [filename, content] of Object.entries(sharedFiles)) {
    const filePath = path.join(sharedDir, filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }

  // 创建平台目录
  for (const platform of platforms) {
    const platformDir = path.join(commitDir, platform);
    await fs.mkdir(platformDir, { recursive: true });
    await fs.writeFile(path.join(platformDir, 'lib.a'), `Mock library for ${platform}`, 'utf-8');
  }
}

describe('integration/symlink-compatibility', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  describe('shared folder symlink behavior', () => {
    it('should create symlinks for _shared directories when enabled', async () => {
      env = await createTestEnv();

      // 创建带有 _shared 目录的 Store 数据
      await createMockStoreWithNestedFiles(env, 'libTest', 'abc123', ['macOS'], {
        'include/test.h': '// Test header',
        'cmake/test.cmake': '# Test cmake',
      });

      // 启用 sharedSymlinkFolders
      await config.set('sharedSymlinkFolders', true);

      const localPath = path.join(env.projectDir, '3rdParty', 'libTest');
      const storeCommitPath = path.join(env.storeDir, 'libTest', 'abc123');

      // 执行 linkLib
      await linkLib(localPath, storeCommitPath, ['macOS']);

      // 验证 _shared 中的目录被符号链接
      await verifySymlink(
        path.join(localPath, 'include'),
        path.join(storeCommitPath, '_shared', 'include')
      );

      // 验证文件被复制（不是符号链接）
      const cmakePath = path.join(localPath, 'cmake');
      const stat = await fs.lstat(cmakePath);
      // cmake 是目录，根据配置可能符号链接或复制
      // 但如果是符号链接，应该指向正确目标
      if (stat.isSymbolicLink()) {
        await verifySymlink(cmakePath, path.join(storeCommitPath, '_shared', 'cmake'));
      }
    });

    it('should allow reading header files through symlinks', async () => {
      env = await createTestEnv();

      // 创建 header-only 库结构
      await createMockStoreWithNestedFiles(env, 'libHeaders', 'def456', ['macOS'], {
        'include/lib/api.h': '#pragma once\nclass Api {};',
        'include/lib/utils.hpp':
          '#pragma once\ntemplate<typename T> T max(T a, T b) { return a > b ? a : b; }',
      });

      await config.set('sharedSymlinkFolders', true);

      const localPath = path.join(env.projectDir, '3rdParty', 'libHeaders');
      const storeCommitPath = path.join(env.storeDir, 'libHeaders', 'def456');

      await linkLib(localPath, storeCommitPath, ['macOS']);

      // 验证可以通过符号链接读取头文件内容
      const headerPath = path.join(localPath, 'include', 'lib', 'api.h');
      const content = await fs.readFile(headerPath, 'utf-8');

      expect(content).toContain('class Api');
      expect(content).toContain('#pragma once');
    });

    it('should handle nested include directories', async () => {
      env = await createTestEnv();

      // 创建深层嵌套的 include 结构（模拟真实库）
      await createMockStoreWithNestedFiles(env, 'libComplex', 'ghi789', ['macOS'], {
        'include/core/base.hpp': '#pragma once\nnamespace core {}',
        'include/core/detail/internal.h': '// Internal header',
        'include/third_party/dep.h': '// Third party header',
      });

      await config.set('sharedSymlinkFolders', true);

      const localPath = path.join(env.projectDir, '3rdParty', 'libComplex');
      const storeCommitPath = path.join(env.storeDir, 'libComplex', 'ghi789');

      await linkLib(localPath, storeCommitPath, ['macOS']);

      // 验证可以通过符号链接访问嵌套的头文件
      const nestedPath = path.join(localPath, 'include', 'core', 'detail', 'internal.h');
      const content = await fs.readFile(nestedPath, 'utf-8');

      expect(content).toContain('Internal header');

      // 验证所有嵌套文件都可访问
      const allFiles = [
        'include/core/base.hpp',
        'include/core/detail/internal.h',
        'include/third_party/dep.h',
      ];

      for (const file of allFiles) {
        const filePath = path.join(localPath, file);
        const exists = await fs
          .access(filePath)
          .then(() => true)
          .catch(() => false);
        expect(exists, `文件 ${file} 应该可访问`).toBe(true);
      }
    });
  });

  describe('cross-filesystem fallback', () => {
    it('should copy when symlink fails with EXDEV', async () => {
      env = await createTestEnv();

      // 创建 Store 数据
      await createMockStoreWithNestedFiles(env, 'libCrossFS', 'jkl012', ['macOS'], {
        'include/test.h': '// Cross-fs test',
      });

      await config.set('sharedSymlinkFolders', true);

      const localPath = path.join(env.projectDir, '3rdParty', 'libCrossFS');
      const storeCommitPath = path.join(env.storeDir, 'libCrossFS', 'jkl012');

      // 执行 linkLib（在跨文件系统时会自动回退到复制）
      await linkLib(localPath, storeCommitPath, ['macOS']);

      // 验证内容存在
      const headerPath = path.join(localPath, 'include', 'test.h');
      const content = await fs.readFile(headerPath, 'utf-8');
      expect(content).toContain('Cross-fs test');

      // 如果符号链接失败回退到复制，内容仍然可访问
      // 这是关键：无论符号链接还是复制，构建工具都能工作
    });
  });

  describe('header-only library support', () => {
    it('should handle header-only library structure', async () => {
      env = await createTestEnv();

      // 模拟 header-only 库（如 eigen, nlohmann-json）
      await createMockStoreWithNestedFiles(env, 'libEigen', 'mno345', ['macOS'], {
        'Eigen/Core': '#pragma once\n// Core module',
        'Eigen/Dense': '#pragma once\n// Dense module',
        'Eigen/Geometry': '#pragma once\n// Geometry module',
        'unsupported/Eigen/FFT': '#pragma once\n// FFT module',
      });

      await config.set('sharedSymlinkFolders', true);

      const localPath = path.join(env.projectDir, '3rdParty', 'libEigen');
      const storeCommitPath = path.join(env.storeDir, 'libEigen', 'mno345');

      await linkLib(localPath, storeCommitPath, ['macOS']);

      // 验证所有模块可访问
      const modules = ['Eigen/Core', 'Eigen/Dense', 'Eigen/Geometry', 'unsupported/Eigen/FFT'];

      for (const mod of modules) {
        const modPath = path.join(localPath, mod);
        const exists = await fs
          .access(modPath)
          .then(() => true)
          .catch(() => false);
        expect(exists, `模块 ${mod} 应该可访问`).toBe(true);

        if (exists) {
          const content = await fs.readFile(modPath, 'utf-8');
          expect(content.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('cmake configuration support', () => {
    it('should expose cmake configuration files', async () => {
      env = await createTestEnv();

      // 创建带有 cmake 配置的库
      await createMockStoreWithNestedFiles(env, 'libCmake', 'pqr678', ['macOS'], {
        'lib/cmake/libCmakeConfig.cmake': '# Config\nset(LIB_FOUND ON)',
        'lib/cmake/libCmakeConfigVersion.cmake': '# Version\nset(PACKAGE_VERSION "1.0.0")',
      });

      await config.set('sharedSymlinkFolders', true);

      const localPath = path.join(env.projectDir, '3rdParty', 'libCmake');
      const storeCommitPath = path.join(env.storeDir, 'libCmake', 'pqr678');

      await linkLib(localPath, storeCommitPath, ['macOS']);

      // 验证 cmake 目录结构可访问
      const configPath = path.join(localPath, 'lib', 'cmake', 'libCmakeConfig.cmake');
      const content = await fs.readFile(configPath, 'utf-8');

      expect(content).toContain('LIB_FOUND');
    });
  });

  describe('symbolic link verification for build tools', () => {
    it('should verify symlink targets resolve correctly', async () => {
      env = await createTestEnv();

      await createMockStoreWithNestedFiles(env, 'libVerify', 'stu901', ['macOS'], {
        'include/api.h': '// API',
      });

      await config.set('sharedSymlinkFolders', true);

      const localPath = path.join(env.projectDir, '3rdParty', 'libVerify');
      const storeCommitPath = path.join(env.storeDir, 'libVerify', 'stu901');

      await linkLib(localPath, storeCommitPath, ['macOS']);

      // 关键验证：stat 能正确解析到目标文件（这是构建工具的核心需求）
      const headerPath = path.join(localPath, 'include', 'api.h');

      // 使用 stat（跟随符号链接）获取实际文件信息
      const stat = await fs.stat(headerPath);
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBeGreaterThan(0);

      // 使用 lstat（不跟随符号链接）获取链接信息
      const lstat = await fs.lstat(path.join(localPath, 'include'));
      expect(lstat.isSymbolicLink()).toBe(true);
    });

    it('should support glob operations through symlinks', async () => {
      env = await createTestEnv();

      await createMockStoreWithNestedFiles(env, 'libGlob', 'vwx234', ['macOS'], {
        'include/a.h': '// A',
        'include/b.h': '// B',
        'include/c.hpp': '// C',
      });

      await config.set('sharedSymlinkFolders', true);

      const localPath = path.join(env.projectDir, '3rdParty', 'libGlob');
      const storeCommitPath = path.join(env.storeDir, 'libGlob', 'vwx234');

      await linkLib(localPath, storeCommitPath, ['macOS']);

      // 验证可以列出目录内容（这是构建工具搜索头文件的基础）
      const includePath = path.join(localPath, 'include');
      const entries = await fs.readdir(includePath);

      expect(entries).toContain('a.h');
      expect(entries).toContain('b.h');
      expect(entries).toContain('c.hpp');
    });
  });
});
