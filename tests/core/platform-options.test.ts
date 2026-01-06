import { describe, it, expect } from 'vitest';
import {
  PLATFORM_OPTIONS,
  getPlatformOption,
  getPlatformOptionByValue,
  platformKeyToValue,
  getAllPlatformKeys,
} from '../../src/core/platform.js';

describe('platform options', () => {
  describe('PLATFORM_OPTIONS', () => {
    it('should have all required platforms', () => {
      const keys = PLATFORM_OPTIONS.map((p) => p.key);
      expect(keys).toContain('mac');
      expect(keys).toContain('win');
      expect(keys).toContain('ios');
      expect(keys).toContain('android');
      expect(keys).toContain('linux');
      expect(keys).toContain('wasm');
      expect(keys).toContain('ohos');
    });

    it('should have correct values for each platform', () => {
      const mac = PLATFORM_OPTIONS.find((p) => p.key === 'mac');
      expect(mac?.value).toBe('macOS');
      expect(mac?.asan).toBe('macOS-asan');

      const android = PLATFORM_OPTIONS.find((p) => p.key === 'android');
      expect(android?.value).toBe('android');
      expect(android?.asan).toBe('android-asan');
      expect(android?.hwasan).toBe('android-hwasan');

      const win = PLATFORM_OPTIONS.find((p) => p.key === 'win');
      expect(win?.value).toBe('Win');
      expect(win?.asan).toBeUndefined();
    });
  });

  describe('getPlatformOption', () => {
    it('should return platform option by key', () => {
      const mac = getPlatformOption('mac');
      expect(mac).toBeDefined();
      expect(mac?.value).toBe('macOS');
    });

    it('should return undefined for unknown key', () => {
      const unknown = getPlatformOption('unknown');
      expect(unknown).toBeUndefined();
    });
  });

  describe('getPlatformOptionByValue', () => {
    it('should find by main value', () => {
      const result = getPlatformOptionByValue('macOS');
      expect(result?.key).toBe('mac');
    });

    it('should find by asan value', () => {
      const result = getPlatformOptionByValue('macOS-asan');
      expect(result?.key).toBe('mac');
    });

    it('should find by hwasan value', () => {
      const result = getPlatformOptionByValue('android-hwasan');
      expect(result?.key).toBe('android');
    });

    it('should return undefined for unknown value', () => {
      const result = getPlatformOptionByValue('unknown');
      expect(result).toBeUndefined();
    });
  });

  describe('platformKeyToValue', () => {
    it('should convert mac to macOS', () => {
      expect(platformKeyToValue('mac')).toBe('macOS');
    });

    it('should convert ios to iOS', () => {
      expect(platformKeyToValue('ios')).toBe('iOS');
    });

    it('should return undefined for unknown key', () => {
      expect(platformKeyToValue('unknown')).toBeUndefined();
    });
  });

  describe('getAllPlatformKeys', () => {
    it('should return all platform keys', () => {
      const keys = getAllPlatformKeys();
      expect(keys).toHaveLength(PLATFORM_OPTIONS.length);
      expect(keys).toContain('mac');
      expect(keys).toContain('ios');
      expect(keys).toContain('android');
    });
  });
});
