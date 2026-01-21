/**
 * 多配置文件支持 - 单元测试
 *
 * 测试 findAllCodepacConfigs() 和 selectOptionalConfigs() 的核心逻辑
 *
 * 测试场景:
 * - S-1.1: 单配置场景 - 只有 codepac-dep.json
 * - S-1.2: 多配置场景 - 主配置 + codepac-dep-*.json
 * - S-1.3: 依赖合并去重
 * - S-1.4: 非 TTY 场景
 * - S-1.5: 记忆偏好
 *
 * 注意: 这些测试用于 TDD，功能尚未实现，预期测试会失败（红灯状态）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Mock fs/promises for file system tests
vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
  },
}));

describe('multi-config: findAllCodepacConfigs', () => {
  let fsMock: {
    access: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    readdir: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetModules();
    const fs = await import('fs/promises');
    fsMock = fs.default as typeof fsMock;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('S-1.1: 单配置场景', () => {
    it('should find only main config when no optional configs exist', async () => {
      // Given: 只有 codepac-dep.json，没有 codepac-dep-*.json
      fsMock.access.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue([
        'codepac-dep.json',
        'README.md',
        'lib1',
      ]);

      // When: 调用 findAllCodepacConfigs
      const { findAllCodepacConfigs } = await import('../../src/core/parser.js');
      const result = await findAllCodepacConfigs('/project/3rdparty');

      // Then: 只返回主配置
      expect(result.mainConfig).toBe('/project/3rdparty/codepac-dep.json');
      expect(result.optionalConfigs).toHaveLength(0);
    });

    it('should return null when no config exists', async () => {
      // Given: 目录中没有任何配置文件
      fsMock.access.mockRejectedValue(new Error('not found'));
      fsMock.readdir.mockResolvedValue(['README.md', 'lib1']);

      // When: 调用 findAllCodepacConfigs
      const { findAllCodepacConfigs } = await import('../../src/core/parser.js');
      const result = await findAllCodepacConfigs('/project/3rdparty');

      // Then: 返回 null
      expect(result).toBeNull();
    });
  });

  describe('S-1.2: 多配置场景', () => {
    it('should find main config and optional configs', async () => {
      // Given: 存在主配置和可选配置
      fsMock.access.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue([
        'codepac-dep.json',
        'codepac-dep-inner.json',
        'codepac-dep-testcase.json',
        'README.md',
      ]);

      // When: 调用 findAllCodepacConfigs
      const { findAllCodepacConfigs } = await import('../../src/core/parser.js');
      const result = await findAllCodepacConfigs('/project/3rdparty');

      // Then: 返回主配置和可选配置列表
      expect(result.mainConfig).toBe('/project/3rdparty/codepac-dep.json');
      expect(result.optionalConfigs).toHaveLength(2);
      expect(result.optionalConfigs).toContainEqual({
        name: 'inner',
        path: '/project/3rdparty/codepac-dep-inner.json',
      });
      expect(result.optionalConfigs).toContainEqual({
        name: 'testcase',
        path: '/project/3rdparty/codepac-dep-testcase.json',
      });
    });

    it('should extract config name from filename correctly', async () => {
      // Given: 各种命名格式的可选配置
      fsMock.access.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue([
        'codepac-dep.json',
        'codepac-dep-my-custom-name.json',
        'codepac-dep-123.json',
      ]);

      // When: 调用 findAllCodepacConfigs
      const { findAllCodepacConfigs } = await import('../../src/core/parser.js');
      const result = await findAllCodepacConfigs('/project/3rdparty');

      // Then: 正确提取配置名称
      expect(result.optionalConfigs).toContainEqual({
        name: 'my-custom-name',
        path: '/project/3rdparty/codepac-dep-my-custom-name.json',
      });
      expect(result.optionalConfigs).toContainEqual({
        name: '123',
        path: '/project/3rdparty/codepac-dep-123.json',
      });
    });

    it('should ignore non-json files with similar names', async () => {
      // Given: 存在类似名称但不是 json 的文件
      fsMock.access.mockResolvedValue(undefined);
      fsMock.readdir.mockResolvedValue([
        'codepac-dep.json',
        'codepac-dep-inner.json',
        'codepac-dep-backup.json.bak',
        'codepac-dep-old.txt',
      ]);

      // When: 调用 findAllCodepacConfigs
      const { findAllCodepacConfigs } = await import('../../src/core/parser.js');
      const result = await findAllCodepacConfigs('/project/3rdparty');

      // Then: 只返回 .json 文件
      expect(result.optionalConfigs).toHaveLength(1);
      expect(result.optionalConfigs[0].name).toBe('inner');
    });
  });

  // 注意：S-1.3 依赖合并去重测试已移除
  // mergeDependencies 函数为死代码已被删除
  // 依赖合并逻辑现在在 link.ts 的 mergeDepLists 函数中（内部函数）
});

describe('multi-config: selectOptionalConfigs', () => {
  let fsMock: {
    access: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    readdir: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetModules();
    const fs = await import('fs/promises');
    fsMock = fs.default as typeof fsMock;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('S-1.4: 非 TTY 场景', () => {
    it('should throw error when not TTY and no --config specified', async () => {
      // Given: 非 TTY 环境，没有指定 --config
      const originalIsTTY = process.stdout.isTTY;
      process.stdout.isTTY = false;

      try {
        // When: 调用 selectOptionalConfigs
        const { selectOptionalConfigs } = await import('../../src/utils/prompt.js');

        const configs = [
          { name: 'inner', path: '/project/3rdparty/codepac-dep-inner.json' },
        ];

        // Then: 应该抛出错误
        await expect(
          selectOptionalConfigs(configs, { isTTY: false, specifiedConfigs: [] })
        ).rejects.toThrow('非交互模式下必须使用 --config 参数指定配置文件');
      } finally {
        process.stdout.isTTY = originalIsTTY;
      }
    });

    it('should use specified configs in non-TTY mode', async () => {
      // Given: 非 TTY 环境，指定了 --config
      const originalIsTTY = process.stdout.isTTY;
      process.stdout.isTTY = false;

      try {
        // When: 调用 selectOptionalConfigs
        const { selectOptionalConfigs } = await import('../../src/utils/prompt.js');

        const configs = [
          { name: 'inner', path: '/project/3rdparty/codepac-dep-inner.json' },
          { name: 'testcase', path: '/project/3rdparty/codepac-dep-testcase.json' },
        ];

        const result = await selectOptionalConfigs(configs, {
          isTTY: false,
          specifiedConfigs: ['inner'],
        });

        // Then: 返回指定的配置
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('inner');
      } finally {
        process.stdout.isTTY = originalIsTTY;
      }
    });

    it('should throw error when specified config not found', async () => {
      // Given: 指定的配置名称不存在
      const { selectOptionalConfigs } = await import('../../src/utils/prompt.js');

      const configs = [
        { name: 'inner', path: '/project/3rdparty/codepac-dep-inner.json' },
      ];

      // Then: 应该抛出错误
      await expect(
        selectOptionalConfigs(configs, {
          isTTY: false,
          specifiedConfigs: ['nonexistent'],
        })
      ).rejects.toThrow('找不到指定的配置文件: nonexistent');
    });
  });

  // 注意：S-1.5 记忆偏好测试已移除
  // saveOptionalConfigPreference/loadOptionalConfigPreference 函数为死代码已被删除
  // 可选配置偏好现在通过 registry.addProject({optionalConfigs: [...]}) 保存
});
