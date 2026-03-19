import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('cli-progress', () => {
  class MockSingleBar {
    start = vi.fn();
    update = vi.fn();
    stop = vi.fn();
  }

  class MockMultiBar {
    create = vi.fn(() => new MockSingleBar());
    log = vi.fn();
    stop = vi.fn();
    remove = vi.fn();
  }

  return {
    default: {
      SingleBar: MockSingleBar,
      MultiBar: MockMultiBar,
    },
  };
});

describe('progress monitor', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should ignore stop before start', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { DownloadMonitor } = await import('../../src/utils/progress.js');

    const monitor = new DownloadMonitor({
      name: 'libTSAI',
      getDirSize: vi.fn().mockResolvedValue(0),
    });

    await expect(monitor.stop()).resolves.toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('should not emit duplicate keepalive after unchanged progress log', async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { DownloadMonitor } = await import('../../src/utils/progress.js');

    const monitor = new DownloadMonitor({
      name: 'libTSAI',
      getDirSize: vi.fn().mockResolvedValue(0),
      logInterval: 1000,
    });

    monitor.start('/tmp/libTSAI');
    await vi.advanceTimersByTimeAsync(1000);
    (monitor as unknown as { updateProgress: (size: number) => void }).updateProgress(0);
    expect(logSpy).toHaveBeenCalledTimes(2);

    monitor.heartbeat();
    expect(logSpy).toHaveBeenCalledTimes(2);

    await monitor.stop();
    vi.useRealTimers();
  });
});
