import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import {
  extractDependencies,
  getRelativeConfigPath,
  extractActions,
  parseActionCommand,
  buildActionExecutionPlan,
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
        name: 'lib1',
        dir: 'lib1',
        commit: 'abc123',
        branch: 'main',
        url: 'https://github.com/example/lib1.git',
        source: {
          url: 'https://github.com/example/lib1.git',
          commit: 'abc123',
          branch: 'main',
          dir: 'lib1',
          name: 'lib1',
          sparse: undefined,
        },
        sparse: undefined,
      });
      expect(deps[1]).toEqual({
        libName: 'lib2',
        name: 'lib2',
        dir: 'lib2',
        commit: 'def456',
        branch: 'develop',
        url: 'https://github.com/example/lib2.git',
        source: {
          url: 'https://github.com/example/lib2.git',
          commit: 'def456',
          branch: 'develop',
          dir: 'lib2',
          name: 'lib2',
          sparse: ['src'],
        },
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

    it('should filter repos by common, requested platform and all', () => {
      const config: CodepacDep = {
        version: '1.0.0',
        repos: {
          common: [
            { url: 'https://example.com/common.git', commit: 'aaa', branch: 'main', dir: 'common-lib' },
          ],
          mac: [
            { url: 'https://example.com/mac.git', commit: 'bbb', branch: 'main', dir: 'mac-lib' },
          ],
          ios: [
            { url: 'https://example.com/ios.git', commit: 'ccc', branch: 'main', dir: 'ios-lib' },
          ],
          all: [
            { url: 'https://example.com/all.git', commit: 'ddd', branch: 'main', dir: 'all-lib' },
          ],
        },
      };

      const deps = extractDependencies(config, { platforms: ['mac'] });

      expect(deps.map((dep) => dep.libName)).toEqual(['common-lib', 'mac-lib', 'all-lib']);
    });

    it('should read every repo group when no platform is provided', () => {
      const config: CodepacDep = {
        version: '1.0.0',
        repos: {
          common: [
            { url: 'https://example.com/common.git', commit: 'aaa', branch: 'main', dir: 'common-lib' },
          ],
          mac: [
            { url: 'https://example.com/mac.git', commit: 'bbb', branch: 'main', dir: 'mac-lib' },
          ],
          all: [
            { url: 'https://example.com/all.git', commit: 'ccc', branch: 'main', dir: 'all-lib' },
          ],
        },
      };

      const deps = extractDependencies(config);

      expect(deps.map((dep) => dep.libName)).toEqual(['common-lib', 'mac-lib', 'all-lib']);
    });

    it('should read every action group when no platform is provided', () => {
      const config: CodepacDep = {
        version: '1.0.0',
        repos: { common: [] },
        actions: {
          common: [
            { command: 'codepac install common --configdir deps-common', dir: '.' },
          ],
          mac: [
            { command: 'codepac install mac --configdir deps-mac', dir: '.' },
          ],
          all: [
            { command: 'codepac install all --configdir deps-all', dir: '.' },
          ],
        },
      };

      const actions = extractActions(config);

      expect(actions.map((action) => action.command)).toEqual([
        'codepac install common --configdir deps-common',
        'codepac install mac --configdir deps-mac',
        'codepac install all --configdir deps-all',
      ]);
    });

    it('should include every platform group when platform all is requested', () => {
      const config: CodepacDep = {
        version: '1.0.0',
        repos: {
          common: [
            { url: 'https://example.com/common.git', commit: 'aaa', branch: 'main', dir: 'common-lib' },
          ],
          mac: [
            { url: 'https://example.com/mac.git', commit: 'bbb', branch: 'main', dir: 'mac-lib' },
          ],
          ios: [
            { url: 'https://example.com/ios.git', commit: 'ccc', branch: 'main', dir: 'ios-lib' },
          ],
        },
      };

      const deps = extractDependencies(config, { platforms: ['all'] });

      expect(deps.map((dep) => dep.libName)).toEqual(['common-lib', 'mac-lib', 'ios-lib']);
    });

    it('should replace vars in repo fields and sparse string', () => {
      const config: CodepacDep = {
        version: '1.0.0',
        vars: {
          HOST: 'https://example.com',
          COMMIT: 'abc123',
          BRANCH: 'main',
          DIR: 'lib-var',
          NAME: 'lib-name',
          SPARSE: '{"common":["include"],"mac":["macOS"]}',
        },
        repos: {
          common: [
            {
              url: '${HOST}/lib.git',
              commit: '${COMMIT}',
              branch: '${BRANCH}',
              dir: '${DIR}',
              name: '${NAME}',
              sparse: '${SPARSE}',
            },
          ],
        },
      };

      const deps = extractDependencies(config);

      expect(deps[0]).toMatchObject({
        libName: 'lib-name',
        name: 'lib-name',
        dir: 'lib-var',
        commit: 'abc123',
        branch: 'main',
        url: 'https://example.com/lib.git',
        sparse: { common: ['include'], mac: ['macOS'] },
      });
      expect(deps[0].source.dir).toBe('lib-var');
    });

    it('should report invalid sparse string after vars replacement', () => {
      const config: CodepacDep = {
        version: '1.0.0',
        vars: {
          BAD_SPARSE: 'not-json',
        },
        repos: {
          common: [
            {
              url: 'https://example.com/lib.git',
              commit: 'abc123',
              branch: 'main',
              dir: 'lib',
              sparse: '${BAD_SPARSE}',
            },
          ],
        },
      };

      expect(() => extractDependencies(config, { configPath: '/project/codepac-dep.json' }))
        .toThrow('sparse 字符串必须是可解析的 JSON 对象');
    });

    it('should use repo.name before source.dir and dir for dependency identity', () => {
      const config: CodepacDep = {
        version: '1.0.0',
        repos: {
          common: [
            {
              url: 'https://example.com/with-name.git',
              commit: 'aaa',
              branch: 'main',
              dir: 'actual-dir',
              name: 'configured-name',
              source: {
                dir: 'source-dir',
              },
            },
            {
              url: 'https://example.com/with-source.git',
              commit: 'bbb',
              branch: 'main',
              dir: 'actual-dir-2',
              source: {
                dir: 'source-name',
              },
            },
            {
              url: 'https://example.com/with-dir.git',
              commit: 'ccc',
              branch: 'main',
              dir: 'dir-name',
            },
          ],
        },
      };

      const deps = extractDependencies(config);

      expect(deps.map((dep) => dep.libName)).toEqual([
        'configured-name',
        'source-name',
        'dir-name',
      ]);
      expect(deps[0].dir).toBe('actual-dir');
      expect(deps[1].source.dir).toBe('source-name');
    });

    it('should throw when selected repos contain duplicate name or dir', () => {
      const config: CodepacDep = {
        version: '1.0.0',
        repos: {
          common: [
            { url: 'https://example.com/a.git', commit: 'aaa', branch: 'main', dir: 'same-dir', name: 'same-name' },
            { url: 'https://example.com/b.git', commit: 'bbb', branch: 'main', dir: 'same-dir', name: 'same-name' },
          ],
        },
      };

      expect(() => extractDependencies(config, { configPath: '/project/codepac-dep.json' }))
        .toThrow('重复 dir: same-dir；重复 name: same-name');
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

  describe('resolveProjectRootPath', () => {
    it('should normalize 3rdparty path to project root', async () => {
      fsMock.access.mockRejectedValueOnce(new Error('not found')).mockResolvedValueOnce(undefined);

      const { resolveProjectRootPath } = await import('../../src/core/parser.js');
      const result = await resolveProjectRootPath('/project/3rdparty');

      expect(result.absolutePath).toBe('/project/3rdparty');
      expect(result.configPath).toBe('/project/3rdparty/codepac-dep.json');
      expect(result.normalizedPath).toBe('/project');
    });

    it('should keep original path when config is in project root', async () => {
      fsMock.access.mockRejectedValueOnce(new Error('not found')).mockResolvedValueOnce(undefined);

      const { resolveProjectRootPath } = await import('../../src/core/parser.js');
      const result = await resolveProjectRootPath('/project');

      expect(result.configPath).toBe('/project/codepac-dep.json');
      expect(result.normalizedPath).toBe('/project');
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

    it('should parse platform repo and action groups', async () => {
      const validConfig = {
        version: '1.0.0',
        repos: {
          common: [],
          mac: [
            { url: 'https://example.com/mac.git', commit: 'abc', branch: 'main', dir: 'mac-lib' },
          ],
        },
        actions: {
          mac: [
            { command: 'codepac install lib --configdir deps', dir: '.' },
          ],
        },
      };
      fsMock.readFile.mockResolvedValue(JSON.stringify(validConfig));

      const { parseCodepacDep } = await import('../../src/core/parser.js');
      const result = await parseCodepacDep('/path/to/config.json');

      expect(result.repos.mac).toHaveLength(1);
      expect(result.actions?.mac).toHaveLength(1);
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

    it('should filter nested dependencies by platform and match libraries by name', async () => {
      const nestedConfig = {
        version: '1.0.0',
        repos: {
          common: [],
          mac: [
            {
              url: 'https://example.com/mac.git',
              commit: 'mac123',
              branch: 'main',
              dir: 'actual-mac-dir',
              name: 'named-mac-lib',
            },
          ],
          ios: [
            {
              url: 'https://example.com/ios.git',
              commit: 'ios123',
              branch: 'main',
              dir: 'actual-ios-dir',
              name: 'named-ios-lib',
            },
          ],
        },
        actions: {
          mac: [
            { command: 'codepac install child --configdir deps' },
          ],
          ios: [
            { command: 'codepac install ignored --configdir deps-ios' },
          ],
        },
      };
      fsMock.readFile.mockResolvedValue(JSON.stringify(nestedConfig));

      const { extractNestedDependencies } = await import('../../src/core/parser.js');
      const result = await extractNestedDependencies('/path/to/config.json', ['named-mac-lib'], {
        platforms: ['mac'],
      });

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].libName).toBe('named-mac-lib');
      expect(result.dependencies[0].dir).toBe('actual-mac-dir');
      expect(result.nestedActions.map((action) => action.command)).toEqual([
        'codepac install child --configdir deps',
      ]);
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

  it('should filter actions by common, requested platform and all', () => {
    const config: CodepacDep = {
      version: '1.0.0',
      repos: { common: [] },
      actions: {
        common: [
          { command: 'codepac install common --configdir deps-common', dir: '.' },
        ],
        mac: [
          { command: 'codepac install mac --configdir deps-mac', dir: '.' },
        ],
        ios: [
          { command: 'codepac install ios --configdir deps-ios', dir: '.' },
        ],
        all: [
          { command: 'codepac install all --configdir deps-all', dir: '.' },
        ],
      },
    };

    const actions = extractActions(config, { platforms: ['mac'] });

    expect(actions.map((action) => action.command)).toEqual([
      'codepac install common --configdir deps-common',
      'codepac install mac --configdir deps-mac',
      'codepac install all --configdir deps-all',
    ]);
  });

  it('should replace vars in action command, dir and name', () => {
    const config: CodepacDep = {
      version: '1.0.0',
      vars: {
        LIB: 'nested-lib',
        DIR: 'deps',
        ACTION: 'sync-nested',
      },
      repos: { common: [] },
      actions: {
        common: [
          {
            command: 'codepac install ${LIB} --configdir ${DIR}',
            dir: '${DIR}',
            name: '${ACTION}',
          },
        ],
      },
    };

    const actions = extractActions(config);

    expect(actions[0]).toEqual({
      command: 'codepac install nested-lib --configdir deps',
      dir: 'deps',
      name: 'sync-nested',
    });
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
    expect(result.targetDirMode).toBe('explicit');
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
    expect(result.targetDirMode).toBe('omitted');
  });

  it('should detect --disable_action flag', () => {
    // Given: 带 --disable_action 的命令
    const command = 'codepac install lib1 --configdir deps --disable_action';

    // When: 解析命令
    const result = parseActionCommand(command);

    // Then: disableAction 为 true
    expect(result.disableAction).toBe(true);
  });

  it('should parse action options regardless of argument order', () => {
    const command = 'codepac install lib1 --targetdir out --disable_action --configdir deps';

    const result = parseActionCommand(command);

    expect(result.libraries).toEqual(['lib1']);
    expect(result.configDir).toBe('deps');
    expect(result.targetDir).toBe('out');
    expect(result.targetDirMode).toBe('explicit');
    expect(result.disableAction).toBe(true);
  });

  it('should parse quoted config and target directories', () => {
    const command = 'codepac install lib1 lib2 --configdir "dir with space" --targetdir "out dir"';

    const result = parseActionCommand(command);

    expect(result.libraries).toEqual(['lib1', 'lib2']);
    expect(result.configDir).toBe('dir with space');
    expect(result.targetDir).toBe('out dir');
    expect(result.targetDirMode).toBe('explicit');
  });

  it('should parse short action option names', () => {
    const command = 'codepac install lib1 -td out -cd deps -dc';

    const result = parseActionCommand(command);

    expect(result.libraries).toEqual(['lib1']);
    expect(result.configDir).toBe('deps');
    expect(result.targetDir).toBe('out');
    expect(result.targetDirMode).toBe('explicit');
    expect(result.disableAction).toBe(true);
  });

  it('should parse explicit action inheritance flags', () => {
    const command = 'codepac install lib1 --configdir deps --platform mac ios --fullgit --unshallow --disable_sparse';

    const result = parseActionCommand(command);

    expect(result.libraries).toEqual(['lib1']);
    expect(result.hasExplicitPlatform).toBe(true);
    expect(result.platforms).toEqual(['mac', 'ios']);
    expect(result.hasExplicitFullGit).toBe(true);
    expect(result.hasExplicitUnshallow).toBe(true);
    expect(result.hasExplicitDisableSparse).toBe(true);
  });

  it('should parse short platform option in action command', () => {
    const command = 'codepac install lib1 -p mac --configdir deps';

    const result = parseActionCommand(command);

    expect(result.libraries).toEqual(['lib1']);
    expect(result.hasExplicitPlatform).toBe(true);
    expect(result.platforms).toEqual(['mac']);
  });

  it('should parse short action inheritance flags', () => {
    const command = 'codepac install lib1 --configdir deps -fg -us -ds';

    const result = parseActionCommand(command);

    expect(result.hasExplicitFullGit).toBe(true);
    expect(result.hasExplicitUnshallow).toBe(true);
    expect(result.hasExplicitDisableSparse).toBe(true);
  });

  it('should throw when action option value is missing', () => {
    const command = 'codepac install lib1 --configdir --targetdir out';

    expect(() => parseActionCommand(command)).toThrow('--configdir 缺少参数值');
  });

  it('should throw when platform option value is missing', () => {
    const command = 'codepac install lib1 --platform --configdir deps';

    expect(() => parseActionCommand(command)).toThrow('--platform 缺少参数值');
  });

  it('should use configDir as default targetDir when not specified', () => {
    // Given: 没有指定 --targetdir
    const command = 'codepac install lib1 --configdir myDeps';

    // When: 解析命令
    const result = parseActionCommand(command);

    // Then: targetDir 默认为 configDir
    expect(result.targetDir).toBe('myDeps');
    expect(result.targetDirMode).toBe('omitted');
  });

  it('should preserve an explicitly empty targetdir for parent target resolution', () => {
    const command = 'codepac install libMemoryPool --configdir libTSCoreBase --targetdir ';

    const result = parseActionCommand(command);

    expect(result.libraries).toEqual(['libMemoryPool']);
    expect(result.configDir).toBe('libTSCoreBase');
    expect(result.targetDir).toBe('');
    expect(result.targetDirMode).toBe('empty');
  });

  it.each(['""', "''"])('should preserve quoted empty targetdir %s and continue parsing libraries', (emptyValue) => {
    const command = `codepac install lib1 --targetdir ${emptyValue} lib2 --configdir deps`;

    const result = parseActionCommand(command);

    expect(result.libraries).toEqual(['lib1', 'lib2']);
    expect(result.configDir).toBe('deps');
    expect(result.targetDir).toBe('');
    expect(result.targetDirMode).toBe('empty');
  });

  it('should preserve an empty short targetdir before another option', () => {
    const command = 'codepac install lib1 -td -dc -cd deps';

    const result = parseActionCommand(command);

    expect(result.targetDir).toBe('');
    expect(result.targetDirMode).toBe('empty');
    expect(result.disableAction).toBe(true);
  });

  it('should use the last targetdir occurrence including an explicit empty value', () => {
    const command = 'codepac install lib1 --targetdir Generated --configdir deps --targetdir ';

    const result = parseActionCommand(command);

    expect(result.targetDir).toBe('');
    expect(result.targetDirMode).toBe('empty');
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

describe('buildActionExecutionPlan', () => {
  it('should resolve configdir and targetdir from parent target', () => {
    const plan = buildActionExecutionPlan(
      {
        name: 'installNested',
        command: 'codepac install libNested --configdir childCfg --targetdir childTarget',
      },
      {
        parentConfigPath: '/project/3rdparty/options/codepac-dep-inner.json',
        parentTargetDir: '/project/3rdparty/runtime',
        inheritedCodepacPlatforms: ['mac'],
      }
    );

    expect(plan.actionName).toBe('installNested');
    expect(plan.nestedConfigPath).toBe('/project/3rdparty/runtime/childCfg/codepac-dep.json');
    expect(plan.nestedTargetDir).toBe('/project/3rdparty/runtime/childTarget');
    expect(plan.effectiveCodepacPlatforms).toEqual(['mac']);
    expect(plan.libraries).toEqual(['libNested']);
  });

  it('should resolve nested action configdir from the previous action target directory', () => {
    const plan = buildActionExecutionPlan(
      {
        command: 'codepac install libffmpeg --configdir libTSMediaCodecV2 --targetdir ./',
      },
      {
        parentConfigPath: '/project/3rdparty/libPixPie/dependencies/libPixDonut/codepac-dep.json',
        parentTargetDir: '/project/3rdparty/libPixPie/dependencies',
        inheritedCodepacPlatforms: ['mac'],
      }
    );

    expect(plan.nestedConfigPath).toBe('/project/3rdparty/libPixPie/dependencies/libTSMediaCodecV2/codepac-dep.json');
    expect(plan.nestedTargetDir).toBe('/project/3rdparty/libPixPie/dependencies');
    expect(plan.libraries).toEqual(['libffmpeg']);
  });

  it('should resolve an explicitly empty targetdir to the parent target directory', () => {
    const plan = buildActionExecutionPlan(
      {
        command: 'codepac install libMemoryPool --configdir libTSCoreBase --targetdir ',
      },
      {
        parentConfigPath: '/project/3rdparty/codepac-dep.json',
        parentTargetDir: '/project/3rdparty',
        inheritedCodepacPlatforms: ['wasm'],
      }
    );

    expect(plan.nestedConfigPath).toBe('/project/3rdparty/libTSCoreBase/codepac-dep.json');
    expect(plan.nestedTargetDir).toBe('/project/3rdparty');
    expect(plan.parsed.targetDirMode).toBe('empty');
    expect(plan.effectiveCodepacPlatforms).toEqual(['wasm']);
    expect(plan.libraries).toEqual(['libMemoryPool']);
  });

  it('should use explicit action platforms instead of inherited platforms', () => {
    const plan = buildActionExecutionPlan(
      {
        command: 'codepac install libNested --configdir childCfg --platform ios ios',
      },
      {
        parentConfigPath: '/project/3rdparty/codepac-dep.json',
        parentTargetDir: '/project/3rdparty',
        inheritedCodepacPlatforms: ['mac'],
      }
    );

    expect(plan.inheritedPlatforms).toEqual(['mac']);
    expect(plan.effectiveCodepacPlatforms).toEqual(['ios']);
    expect(plan.nestedTargetDir).toBe('/project/3rdparty/childCfg');
    expect(plan.parsed.targetDirMode).toBe('omitted');
  });
});
