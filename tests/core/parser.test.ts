import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import {
  extractDependencies,
  getRelativeConfigPath,
  extractActions,
  parseActionCommand,
} from '../../src/core/parser.js';
import type { CodepacDep } from '../../src/types/index.js';

// Mock fs/promises for file system tests
vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn(),
    readFile: vi.fn(),
  },
}));

describe('parser', () => {
  describe('extractDependencies', () => {
    it('should extract dependencies from valid config', () => {
      const config: CodepacDep = {
        version: '1.0.0',
        repos: {
          common: [
            {
              url: 'https://github.com/example/lib1.git',
              commit: 'abc123',
              branch: 'main',
              dir: 'lib1',
            },
            {
              url: 'https://github.com/example/lib2.git',
              commit: 'def456',
              branch: 'develop',
              dir: 'lib2',
              sparse: ['src'],
            },
          ],
        },
      };

      const deps = extractDependencies(config);

      expect(deps).toHaveLength(2);
      expect(deps[0]).toEqual({
        libName: 'lib1',
        commit: 'abc123',
        branch: 'main',
        url: 'https://github.com/example/lib1.git',
        sparse: undefined,
      });
      expect(deps[1]).toEqual({
        libName: 'lib2',
        commit: 'def456',
        branch: 'develop',
        url: 'https://github.com/example/lib2.git',
        sparse: ['src'],
      });
    });

    it('should return empty array for config with no dependencies', () => {
      const config: CodepacDep = {
        version: '1.0.0',
        repos: {
          common: [],
        },
      };

      const deps = extractDependencies(config);
      expect(deps).toHaveLength(0);
    });
  });

  describe('getRelativeConfigPath', () => {
    it('should return relative path from project to config', () => {
      const projectPath = '/Users/test/project';
      const configPath = '/Users/test/project/3rdparty/codepac-dep.json';

      const relative = getRelativeConfigPath(projectPath, configPath);
      expect(relative).toBe(path.join('3rdparty', 'codepac-dep.json'));
    });

    it('should return filename when config is in project root', () => {
      const projectPath = '/Users/test/project';
      const configPath = '/Users/test/project/codepac-dep.json';

      const relative = getRelativeConfigPath(projectPath, configPath);
      expect(relative).toBe('codepac-dep.json');
    });
  });
});

describe('parser with fs mock', () => {
  let fsMock: {
    access: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetModules();
    const fs = await import('fs/promises');
    fsMock = fs.default as typeof fsMock;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('findCodepacConfig', () => {
    it('should find config in 3rdparty directory first', async () => {
      fsMock.access.mockResolvedValueOnce(undefined);

      const { findCodepacConfig } = await import('../../src/core/parser.js');
      const result = await findCodepacConfig('/project');

      expect(result).toBe('/project/3rdparty/codepac-dep.json');
      expect(fsMock.access).toHaveBeenCalledWith('/project/3rdparty/codepac-dep.json');
    });

    it('should find config in project root if not in 3rdparty', async () => {
      fsMock.access.mockRejectedValueOnce(new Error('not found')).mockResolvedValueOnce(undefined);

      const { findCodepacConfig } = await import('../../src/core/parser.js');
      const result = await findCodepacConfig('/project');

      expect(result).toBe('/project/codepac-dep.json');
    });

    it('should return null if config not found', async () => {
      fsMock.access.mockRejectedValue(new Error('not found'));

      const { findCodepacConfig } = await import('../../src/core/parser.js');
      const result = await findCodepacConfig('/project');

      expect(result).toBeNull();
    });
  });

  describe('parseCodepacDep', () => {
    it('should parse valid config file', async () => {
      const validConfig = {
        version: '1.0.0',
        repos: {
          common: [
            { url: 'https://example.com/lib.git', commit: 'abc', branch: 'main', dir: 'lib' },
          ],
        },
      };
      fsMock.readFile.mockResolvedValue(JSON.stringify(validConfig));

      const { parseCodepacDep } = await import('../../src/core/parser.js');
      const result = await parseCodepacDep('/path/to/config.json');

      expect(result).toEqual(validConfig);
    });

    it('should throw on file read error', async () => {
      fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

      const { parseCodepacDep } = await import('../../src/core/parser.js');

      await expect(parseCodepacDep('/nonexistent')).rejects.toThrow('无法读取配置文件');
    });

    it('should throw on invalid JSON', async () => {
      fsMock.readFile.mockResolvedValue('not valid json');

      const { parseCodepacDep } = await import('../../src/core/parser.js');

      await expect(parseCodepacDep('/path/to/config.json')).rejects.toThrow('JSON 解析失败');
    });

    it('should throw when missing version field', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ repos: { common: [] } }));

      const { parseCodepacDep } = await import('../../src/core/parser.js');

      await expect(parseCodepacDep('/path/to/config.json')).rejects.toThrow('缺少 version 字段');
    });

    it('should throw when missing repos field', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ version: '1.0.0' }));

      const { parseCodepacDep } = await import('../../src/core/parser.js');

      await expect(parseCodepacDep('/path/to/config.json')).rejects.toThrow('缺少 repos 字段');
    });

    it('should throw when repos.common is not array', async () => {
      fsMock.readFile.mockResolvedValue(
        JSON.stringify({ version: '1.0.0', repos: { common: 'not array' } })
      );

      const { parseCodepacDep } = await import('../../src/core/parser.js');

      await expect(parseCodepacDep('/path/to/config.json')).rejects.toThrow(
        'repos.common 必须是数组'
      );
    });

    it('should throw when repo item missing required fields', async () => {
      fsMock.readFile.mockResolvedValue(
        JSON.stringify({
          version: '1.0.0',
          repos: { common: [{ url: 'test' }] },
        })
      );

      const { parseCodepacDep } = await import('../../src/core/parser.js');

      await expect(parseCodepacDep('/path/to/config.json')).rejects.toThrow('commit 必须是字符串');
    });
  });

  describe('extractNestedDependencies', () => {
    it('should extract specified libraries from nested config', async () => {
      // Given: 配置文件包含多个库
      const nestedConfig = {
        version: '1.0.0',
        repos: {
          common: [
            { url: 'https://example.com/lib1.git', commit: 'abc', branch: 'main', dir: 'lib1' },
            { url: 'https://example.com/lib2.git', commit: 'def', branch: 'main', dir: 'lib2' },
            { url: 'https://example.com/lib3.git', commit: 'ghi', branch: 'main', dir: 'lib3' },
          ],
        },
      };
      fsMock.readFile.mockResolvedValue(JSON.stringify(nestedConfig));

      const { extractNestedDependencies } = await import('../../src/core/parser.js');

      // When: 只提取 lib1 和 lib3
      const result = await extractNestedDependencies('/path/to/config.json', ['lib1', 'lib3']);

      // Then: 只返回指定的库
      expect(result.dependencies).toHaveLength(2);
      expect(result.dependencies[0].libName).toBe('lib1');
      expect(result.dependencies[1].libName).toBe('lib3');
    });

    it('should extract all libraries when libraries array is empty', async () => {
      // Given: 配置文件包含多个库
      const nestedConfig = {
        version: '1.0.0',
        repos: {
          common: [
            { url: 'https://example.com/lib1.git', commit: 'abc', branch: 'main', dir: 'lib1' },
            { url: 'https://example.com/lib2.git', commit: 'def', branch: 'main', dir: 'lib2' },
          ],
        },
      };
      fsMock.readFile.mockResolvedValue(JSON.stringify(nestedConfig));

      const { extractNestedDependencies } = await import('../../src/core/parser.js');

      // When: 传入空数组（旧格式兼容）
      const result = await extractNestedDependencies('/path/to/config.json', []);

      // Then: 返回所有库
      expect(result.dependencies).toHaveLength(2);
    });

    it('should return nested actions from config', async () => {
      // Given: 配置文件包含 actions
      const nestedConfig = {
        version: '1.0.0',
        repos: {
          common: [
            { url: 'https://example.com/lib1.git', commit: 'abc', branch: 'main', dir: 'lib1' },
          ],
        },
        actions: {
          common: [
            { command: 'codepac install nestedLib --configdir lib1/dependencies' },
          ],
        },
      };
      fsMock.readFile.mockResolvedValue(JSON.stringify(nestedConfig));

      const { extractNestedDependencies } = await import('../../src/core/parser.js');

      // When: 提取嵌套依赖
      const result = await extractNestedDependencies('/path/to/config.json', []);

      // Then: 返回嵌套 actions
      expect(result.nestedActions).toHaveLength(1);
      expect(result.nestedActions[0].command).toContain('nestedLib');
    });
  });
});

describe('extractActions', () => {
  it('should extract actions array from config with actions', () => {
    // Given: 配置包含 actions
    const config: CodepacDep = {
      version: '1.0.0',
      repos: { common: [] },
      actions: {
        common: [
          { command: 'codepac install lib1 --configdir deps' },
          { command: 'codepac install lib2 --configdir deps2' },
        ],
      },
    };

    // When: 提取 actions
    const actions = extractActions(config);

    // Then: 返回 actions 数组
    expect(actions).toHaveLength(2);
    expect(actions[0].command).toContain('lib1');
    expect(actions[1].command).toContain('lib2');
  });

  it('should return empty array when config has no actions', () => {
    // Given: 配置没有 actions
    const config: CodepacDep = {
      version: '1.0.0',
      repos: { common: [] },
    };

    // When: 提取 actions
    const actions = extractActions(config);

    // Then: 返回空数组
    expect(actions).toHaveLength(0);
  });

  it('should return empty array when actions.common is undefined', () => {
    // Given: 配置有 actions 但没有 common
    const config = {
      version: '1.0.0',
      repos: { common: [] },
      actions: {},
    } as CodepacDep;

    // When: 提取 actions
    const actions = extractActions(config);

    // Then: 返回空数组
    expect(actions).toHaveLength(0);
  });
});

describe('parseActionCommand', () => {
  it('should parse new format command with libraries', () => {
    // Given: 新格式命令
    const command = 'codepac install lib1 lib2 --configdir deps --targetdir .';

    // When: 解析命令
    const result = parseActionCommand(command);

    // Then: 正确提取所有字段
    expect(result.libraries).toEqual(['lib1', 'lib2']);
    expect(result.configDir).toBe('deps');
    expect(result.targetDir).toBe('.');
    expect(result.disableAction).toBe(false);
  });

  it('should parse old format command without libraries', () => {
    // Given: 旧格式命令（无指定库）
    const command = 'codepac install --configdir deps';

    // When: 解析命令
    const result = parseActionCommand(command);

    // Then: libraries 为空，从 configDir 读取
    expect(result.libraries).toHaveLength(0);
    expect(result.configDir).toBe('deps');
    expect(result.targetDir).toBe('deps'); // 默认等于 configDir
  });

  it('should detect --disable_action flag', () => {
    // Given: 带 --disable_action 的命令
    const command = 'codepac install lib1 --configdir deps --disable_action';

    // When: 解析命令
    const result = parseActionCommand(command);

    // Then: disableAction 为 true
    expect(result.disableAction).toBe(true);
  });

  it('should use configDir as default targetDir when not specified', () => {
    // Given: 没有指定 --targetdir
    const command = 'codepac install lib1 --configdir myDeps';

    // When: 解析命令
    const result = parseActionCommand(command);

    // Then: targetDir 默认为 configDir
    expect(result.targetDir).toBe('myDeps');
  });

  it('should throw error when command does not start with codepac install', () => {
    // Given: 无效的命令开头
    const command = 'npm install lib1 --configdir deps';

    // When/Then: 抛出错误
    expect(() => parseActionCommand(command)).toThrow("期望 'codepac install' 开头");
  });

  it('should throw error when --configdir is missing', () => {
    // Given: 缺少 --configdir
    const command = 'codepac install lib1 --targetdir .';

    // When/Then: 抛出错误
    expect(() => parseActionCommand(command)).toThrow('缺少 --configdir 参数');
  });
});
