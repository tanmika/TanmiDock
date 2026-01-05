import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import {
  extractDependencies,
  getRelativeConfigPath,
} from '../../src/core/parser.js'
import type { CodepacDep } from '../../src/types/index.js'

// Mock fs/promises for file system tests
vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn(),
    readFile: vi.fn(),
  },
}))

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
      }

      const deps = extractDependencies(config)

      expect(deps).toHaveLength(2)
      expect(deps[0]).toEqual({
        libName: 'lib1',
        commit: 'abc123',
        branch: 'main',
        url: 'https://github.com/example/lib1.git',
        sparse: undefined,
      })
      expect(deps[1]).toEqual({
        libName: 'lib2',
        commit: 'def456',
        branch: 'develop',
        url: 'https://github.com/example/lib2.git',
        sparse: ['src'],
      })
    })

    it('should return empty array for config with no dependencies', () => {
      const config: CodepacDep = {
        version: '1.0.0',
        repos: {
          common: [],
        },
      }

      const deps = extractDependencies(config)
      expect(deps).toHaveLength(0)
    })
  })

  describe('getRelativeConfigPath', () => {
    it('should return relative path from project to config', () => {
      const projectPath = '/Users/test/project'
      const configPath = '/Users/test/project/3rdparty/codepac-dep.json'

      const relative = getRelativeConfigPath(projectPath, configPath)
      expect(relative).toBe(path.join('3rdparty', 'codepac-dep.json'))
    })

    it('should return filename when config is in project root', () => {
      const projectPath = '/Users/test/project'
      const configPath = '/Users/test/project/codepac-dep.json'

      const relative = getRelativeConfigPath(projectPath, configPath)
      expect(relative).toBe('codepac-dep.json')
    })
  })
})

describe('parser with fs mock', () => {
  let fsMock: {
    access: ReturnType<typeof vi.fn>
    readFile: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    vi.resetModules()
    const fs = await import('fs/promises')
    fsMock = fs.default as typeof fsMock
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('findCodepacConfig', () => {
    it('should find config in 3rdparty directory first', async () => {
      fsMock.access.mockResolvedValueOnce(undefined)

      const { findCodepacConfig } = await import('../../src/core/parser.js')
      const result = await findCodepacConfig('/project')

      expect(result).toBe('/project/3rdparty/codepac-dep.json')
      expect(fsMock.access).toHaveBeenCalledWith('/project/3rdparty/codepac-dep.json')
    })

    it('should find config in project root if not in 3rdparty', async () => {
      fsMock.access
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValueOnce(undefined)

      const { findCodepacConfig } = await import('../../src/core/parser.js')
      const result = await findCodepacConfig('/project')

      expect(result).toBe('/project/codepac-dep.json')
    })

    it('should return null if config not found', async () => {
      fsMock.access.mockRejectedValue(new Error('not found'))

      const { findCodepacConfig } = await import('../../src/core/parser.js')
      const result = await findCodepacConfig('/project')

      expect(result).toBeNull()
    })
  })

  describe('parseCodepacDep', () => {
    it('should parse valid config file', async () => {
      const validConfig = {
        version: '1.0.0',
        repos: {
          common: [
            { url: 'https://example.com/lib.git', commit: 'abc', branch: 'main', dir: 'lib' },
          ],
        },
      }
      fsMock.readFile.mockResolvedValue(JSON.stringify(validConfig))

      const { parseCodepacDep } = await import('../../src/core/parser.js')
      const result = await parseCodepacDep('/path/to/config.json')

      expect(result).toEqual(validConfig)
    })

    it('should throw on file read error', async () => {
      fsMock.readFile.mockRejectedValue(new Error('ENOENT'))

      const { parseCodepacDep } = await import('../../src/core/parser.js')

      await expect(parseCodepacDep('/nonexistent')).rejects.toThrow('无法读取配置文件')
    })

    it('should throw on invalid JSON', async () => {
      fsMock.readFile.mockResolvedValue('not valid json')

      const { parseCodepacDep } = await import('../../src/core/parser.js')

      await expect(parseCodepacDep('/path/to/config.json')).rejects.toThrow('JSON 解析失败')
    })

    it('should throw when missing version field', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ repos: { common: [] } }))

      const { parseCodepacDep } = await import('../../src/core/parser.js')

      await expect(parseCodepacDep('/path/to/config.json')).rejects.toThrow('缺少 version 字段')
    })

    it('should throw when missing repos field', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ version: '1.0.0' }))

      const { parseCodepacDep } = await import('../../src/core/parser.js')

      await expect(parseCodepacDep('/path/to/config.json')).rejects.toThrow('缺少 repos 字段')
    })

    it('should throw when repos.common is not array', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ version: '1.0.0', repos: { common: 'not array' } }))

      const { parseCodepacDep } = await import('../../src/core/parser.js')

      await expect(parseCodepacDep('/path/to/config.json')).rejects.toThrow('repos.common 必须是数组')
    })

    it('should throw when repo item missing required fields', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({
        version: '1.0.0',
        repos: { common: [{ url: 'test' }] },
      }))

      const { parseCodepacDep } = await import('../../src/core/parser.js')

      await expect(parseCodepacDep('/path/to/config.json')).rejects.toThrow('commit 必须是字符串')
    })
  })
})
