import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import {
  getConfigDir,
  getConfigPath,
  getRegistryPath,
  getPlatform,
  isWindows,
  isMacOS,
  normalizePath,
  expandHome,
  shrinkHome,
  resolvePath,
  isAbsolutePath,
  joinPath,
} from '../../src/core/platform.js'

describe('platform', () => {
  const originalPlatform = process.platform
  const homeDir = os.homedir()

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  describe('getConfigDir', () => {
    it('should return path under home directory', () => {
      const configDir = getConfigDir()
      expect(configDir).toBe(path.join(homeDir, '.tanmi-dock'))
    })
  })

  describe('getConfigPath', () => {
    it('should return config.json path under config dir', () => {
      const configPath = getConfigPath()
      expect(configPath).toBe(path.join(homeDir, '.tanmi-dock', 'config.json'))
    })
  })

  describe('getRegistryPath', () => {
    it('should return registry.json path under config dir', () => {
      const registryPath = getRegistryPath()
      expect(registryPath).toBe(path.join(homeDir, '.tanmi-dock', 'registry.json'))
    })
  })

  describe('getPlatform', () => {
    it('should return "win" on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      expect(getPlatform()).toBe('win')
    })

    it('should return "mac" on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      expect(getPlatform()).toBe('mac')
    })

    it('should return "mac" on Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      expect(getPlatform()).toBe('mac')
    })
  })

  describe('isWindows', () => {
    it('should return true on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      expect(isWindows()).toBe(true)
    })

    it('should return false on non-Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      expect(isWindows()).toBe(false)
    })
  })

  describe('isMacOS', () => {
    it('should return true on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      expect(isMacOS()).toBe(true)
    })

    it('should return false on non-macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      expect(isMacOS()).toBe(false)
    })
  })

  describe('normalizePath', () => {
    it('should normalize path', () => {
      expect(normalizePath('/foo/bar/../baz')).toBe('/foo/baz')
      expect(normalizePath('/foo//bar')).toBe('/foo/bar')
    })
  })

  describe('expandHome', () => {
    it('should expand ~ to home directory', () => {
      expect(expandHome('~/test')).toBe(path.join(homeDir, 'test'))
      expect(expandHome('~/.config')).toBe(path.join(homeDir, '.config'))
    })

    it('should not change paths without ~', () => {
      expect(expandHome('/absolute/path')).toBe('/absolute/path')
      expect(expandHome('relative/path')).toBe('relative/path')
    })
  })

  describe('shrinkHome', () => {
    it('should replace home directory with ~', () => {
      expect(shrinkHome(path.join(homeDir, 'test'))).toBe('~/test')
      expect(shrinkHome(path.join(homeDir, '.config'))).toBe('~/.config')
    })

    it('should not change paths outside home', () => {
      expect(shrinkHome('/var/log')).toBe('/var/log')
    })
  })

  describe('resolvePath', () => {
    it('should resolve ~ paths to absolute', () => {
      const resolved = resolvePath('~/test')
      expect(path.isAbsolute(resolved)).toBe(true)
      expect(resolved).toBe(path.join(homeDir, 'test'))
    })

    it('should resolve relative paths to absolute', () => {
      const resolved = resolvePath('relative/path')
      expect(path.isAbsolute(resolved)).toBe(true)
    })
  })

  describe('isAbsolutePath', () => {
    it('should return true for absolute paths', () => {
      expect(isAbsolutePath('/absolute/path')).toBe(true)
    })

    it('should return false for relative paths', () => {
      expect(isAbsolutePath('relative/path')).toBe(false)
      expect(isAbsolutePath('./relative')).toBe(false)
    })
  })

  describe('joinPath', () => {
    it('should join path parts', () => {
      expect(joinPath('/foo', 'bar', 'baz')).toBe('/foo/bar/baz')
      expect(joinPath('a', 'b', 'c')).toBe('a/b/c')
    })
  })
})
