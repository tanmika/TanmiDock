import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import {
  isValidConfigKey,
  isValidCleanStrategy,
  parseConfigValue,
  getDefaultConfig,
} from '../../src/core/config.js'

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    access: vi.fn(),
  },
}))

// Mock lock utility - execute function immediately without actual locking
vi.mock('../../src/utils/lock.js', () => ({
  withFileLock: vi.fn(async (_path: string, fn: () => Promise<unknown>) => fn()),
}))

describe('config', () => {
  describe('isValidConfigKey', () => {
    it('should return true for valid config keys', () => {
      expect(isValidConfigKey('storePath')).toBe(true)
      expect(isValidConfigKey('cleanStrategy')).toBe(true)
      expect(isValidConfigKey('maxStoreSize')).toBe(true)
      expect(isValidConfigKey('autoDownload')).toBe(true)
      expect(isValidConfigKey('initialized')).toBe(true)
      expect(isValidConfigKey('version')).toBe(true)
    })

    it('should return false for invalid config keys', () => {
      expect(isValidConfigKey('invalidKey')).toBe(false)
      expect(isValidConfigKey('')).toBe(false)
      expect(isValidConfigKey('STOREPATH')).toBe(false)
    })
  })

  describe('isValidCleanStrategy', () => {
    it('should return true for valid strategies', () => {
      expect(isValidCleanStrategy('unreferenced')).toBe(true)
      expect(isValidCleanStrategy('lru')).toBe(true)
      expect(isValidCleanStrategy('manual')).toBe(true)
    })

    it('should return false for invalid strategies', () => {
      expect(isValidCleanStrategy('invalid')).toBe(false)
      expect(isValidCleanStrategy('')).toBe(false)
      expect(isValidCleanStrategy('LRU')).toBe(false)
    })
  })

  describe('parseConfigValue', () => {
    it('should parse boolean values correctly', () => {
      expect(parseConfigValue('autoDownload', 'true')).toBe(true)
      expect(parseConfigValue('autoDownload', 'false')).toBe(false)
      expect(parseConfigValue('initialized', 'true')).toBe(true)
    })

    it('should parse number values correctly', () => {
      expect(parseConfigValue('maxStoreSize', '100')).toBe(100)
      expect(parseConfigValue('maxStoreSize', '0')).toBe(0)
    })

    it('should parse cleanStrategy correctly', () => {
      expect(parseConfigValue('cleanStrategy', 'lru')).toBe('lru')
      expect(parseConfigValue('cleanStrategy', 'unreferenced')).toBe('unreferenced')
    })

    it('should throw for invalid cleanStrategy', () => {
      expect(() => parseConfigValue('cleanStrategy', 'invalid')).toThrow()
    })

    it('should return string values as-is for other keys', () => {
      expect(parseConfigValue('storePath', '/custom/path')).toBe('/custom/path')
      expect(parseConfigValue('version', '1.0.0')).toBe('1.0.0')
    })
  })

  describe('getDefaultConfig', () => {
    it('should return default config with specified storePath', () => {
      const config = getDefaultConfig('/test/store')
      expect(config.storePath).toBe('/test/store')
      expect(config.initialized).toBe(true)
      expect(config.version).toBe('1.0.0')
      expect(config.cleanStrategy).toBe('unreferenced')
      expect(config.autoDownload).toBe(true)
    })

    it('should expand ~ in storePath', () => {
      const config = getDefaultConfig('~/test/store')
      expect(config.storePath).toBe(path.join(os.homedir(), 'test/store'))
    })
  })
})

describe('config with fs mock', () => {
  let fsMock: {
    readFile: ReturnType<typeof vi.fn>
    writeFile: ReturnType<typeof vi.fn>
    mkdir: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    vi.resetModules()
    const fs = await import('fs/promises')
    fsMock = fs.default as typeof fsMock
    fsMock.readFile.mockReset()
    fsMock.writeFile.mockReset()
    fsMock.mkdir.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('load', () => {
    it('should return config when file exists', async () => {
      const mockConfig = {
        version: '1.0.0',
        initialized: true,
        storePath: '/test/store',
        cleanStrategy: 'unreferenced',
        autoDownload: true,
      }
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockConfig))

      const { load } = await import('../../src/core/config.js')
      const config = await load()

      expect(config).toEqual(mockConfig)
    })

    it('should return null when file does not exist', async () => {
      fsMock.readFile.mockRejectedValue(new Error('ENOENT'))

      const { load } = await import('../../src/core/config.js')
      const config = await load()

      expect(config).toBeNull()
    })
  })

  describe('save', () => {
    it('should write config to file', async () => {
      fsMock.mkdir.mockResolvedValue(undefined)
      fsMock.writeFile.mockResolvedValue(undefined)

      const { save } = await import('../../src/core/config.js')
      const config = {
        version: '1.0.0',
        initialized: true,
        storePath: '/test/store',
        cleanStrategy: 'unreferenced' as const,
        autoDownload: true,
      }
      await save(config)

      expect(fsMock.writeFile).toHaveBeenCalled()
      const writtenContent = fsMock.writeFile.mock.calls[0][1]
      expect(JSON.parse(writtenContent)).toEqual(config)
    })
  })

  describe('ensureConfigDir', () => {
    it('should create config directory', async () => {
      fsMock.mkdir.mockResolvedValue(undefined)

      const { ensureConfigDir } = await import('../../src/core/config.js')
      await ensureConfigDir()

      expect(fsMock.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('.tanmi-dock'),
        { recursive: true }
      )
    })
  })

  describe('get', () => {
    it('should return config value when exists', async () => {
      const mockConfig = {
        version: '1.0.0',
        initialized: true,
        storePath: '/test/store',
        cleanStrategy: 'unreferenced',
        autoDownload: true,
      }
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockConfig))

      const { get } = await import('../../src/core/config.js')
      const value = await get('storePath')

      expect(value).toBe('/test/store')
    })

    it('should return undefined when config not exists', async () => {
      fsMock.readFile.mockRejectedValue(new Error('ENOENT'))

      const { get } = await import('../../src/core/config.js')
      const value = await get('storePath')

      expect(value).toBeUndefined()
    })
  })

  describe('set', () => {
    it('should update config value and save', async () => {
      const mockConfig = {
        version: '1.0.0',
        initialized: true,
        storePath: '/test/store',
        cleanStrategy: 'unreferenced',
        autoDownload: true,
      }
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockConfig))
      fsMock.mkdir.mockResolvedValue(undefined)
      fsMock.writeFile.mockResolvedValue(undefined)

      const { set } = await import('../../src/core/config.js')
      await set('cleanStrategy', 'lru')

      expect(fsMock.writeFile).toHaveBeenCalled()
      const writtenContent = JSON.parse(fsMock.writeFile.mock.calls[0][1])
      expect(writtenContent.cleanStrategy).toBe('lru')
    })

    it('should throw when config not exists', async () => {
      fsMock.readFile.mockRejectedValue(new Error('ENOENT'))

      const { set } = await import('../../src/core/config.js')

      await expect(set('storePath', '/new/path')).rejects.toThrow('配置文件不存在')
    })
  })

  describe('getStorePath', () => {
    it('should return storePath from config', async () => {
      const mockConfig = {
        version: '1.0.0',
        initialized: true,
        storePath: '/test/store',
        cleanStrategy: 'unreferenced',
        autoDownload: true,
      }
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockConfig))

      const { getStorePath } = await import('../../src/core/config.js')
      const storePath = await getStorePath()

      expect(storePath).toBe('/test/store')
    })
  })

  describe('setStorePath', () => {
    it('should set storePath and expand ~', async () => {
      const mockConfig = {
        version: '1.0.0',
        initialized: true,
        storePath: '/old/store',
        cleanStrategy: 'unreferenced',
        autoDownload: true,
      }
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockConfig))
      fsMock.mkdir.mockResolvedValue(undefined)
      fsMock.writeFile.mockResolvedValue(undefined)

      const { setStorePath } = await import('../../src/core/config.js')
      await setStorePath('~/new/store')

      const writtenContent = JSON.parse(fsMock.writeFile.mock.calls[0][1])
      expect(writtenContent.storePath).toBe(path.join(os.homedir(), 'new/store'))
    })
  })
})
