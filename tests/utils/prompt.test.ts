import { describe, it, expect } from 'vitest';
import { parsePlatformArgs } from '../../src/utils/prompt.js';

describe('prompt', () => {
  describe('parsePlatformArgs', () => {
    it('should convert mac to macOS', () => {
      const result = parsePlatformArgs(['mac']);
      expect(result).toEqual(['macOS']);
    });

    it('should convert ios to iOS', () => {
      const result = parsePlatformArgs(['ios']);
      expect(result).toEqual(['iOS']);
    });

    it('should convert multiple keys', () => {
      const result = parsePlatformArgs(['mac', 'ios', 'android']);
      expect(result).toEqual(['macOS', 'iOS', 'android']);
    });

    it('should convert win to Win', () => {
      const result = parsePlatformArgs(['win']);
      expect(result).toEqual(['Win']);
    });

    it('should convert linux to ubuntu', () => {
      const result = parsePlatformArgs(['linux']);
      expect(result).toEqual(['ubuntu']);
    });

    it('should pass through unknown keys as custom platforms', () => {
      const result = parsePlatformArgs(['foo', 'bar']);
      expect(result).toEqual(['foo', 'bar']);
    });

    it('should handle mixed known and unknown keys', () => {
      const result = parsePlatformArgs(['mac', 'custom-platform', 'ios']);
      expect(result).toEqual(['macOS', 'custom-platform', 'iOS']);
    });

    it('should return empty array for empty input', () => {
      const result = parsePlatformArgs([]);
      expect(result).toEqual([]);
    });

    it('should handle all platform keys', () => {
      const result = parsePlatformArgs(['mac', 'win', 'ios', 'android', 'linux', 'wasm', 'ohos']);
      expect(result).toEqual(['macOS', 'Win', 'iOS', 'android', 'ubuntu', 'wasm', 'ohos']);
    });
  });
});
