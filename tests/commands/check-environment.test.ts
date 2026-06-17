import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const makeEnvironment = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  codepacCommand: { ok: true, command: 'command -v codepac', path: '/usr/local/bin/codepac', message: '已找到: /usr/local/bin/codepac' },
  git: { ok: true, command: 'git --version', minimumVersion: '2.22.0', version: '2.40.0', raw: 'git version 2.40.0', message: '2.40.0 可用' },
  gitLfs: {
    ok: true,
    commands: {
      gitLfsVersion: { ok: true, command: 'git-lfs --version', stdout: 'git-lfs/3.0.0', stderr: '' },
      gitLfsSubcommand: { ok: true, command: 'git lfs --version', stdout: 'git-lfs/3.0.0', stderr: '' },
    },
    message: '已安装',
  },
  codepacVersion: { ok: true, command: 'codepac --version', version: 'Version 2.0.56', raw: 'Version 2.0.56', message: 'Version 2.0.56' },
  ...overrides,
});

const mockCheckCodepacEnvironment = vi.fn();

vi.mock('../../src/core/codepac.js', () => ({
  checkCodepacEnvironment: mockCheckCodepacEnvironment,
}));

vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
    readlink: vi.fn(),
    rm: vi.fn(),
    unlink: vi.fn(),
  },
}));

vi.mock('../../src/utils/disk.js', () => ({
  getDiskInfo: vi.fn().mockResolvedValue([{ path: '/', total: 1e12, free: 1e11, isSystem: true }]),
  formatSize: vi.fn((n: number) => `${n}B`),
}));

vi.mock('../../src/core/config.js', () => ({
  load: vi.fn().mockResolvedValue({
    storePath: '/store',
    concurrency: 5,
    logLevel: 'info',
  }),
}));

vi.mock('../../src/core/registry.js', () => ({
  getRegistry: vi.fn().mockReturnValue({
    load: vi.fn(),
    listProjects: vi.fn().mockReturnValue([]),
    listLibraries: vi.fn().mockReturnValue([]),
    listStores: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock('../../src/core/store.js', () => ({
  getStorePath: vi.fn().mockResolvedValue('/store'),
  exists: vi.fn(),
  quickVerify: vi.fn(),
  fullVerify: vi.fn(),
  captureIntegrity: vi.fn(),
}));

vi.mock('../../src/utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  hint: vi.fn(),
  blank: vi.fn(),
  title: vi.fn(),
  separator: vi.fn(),
  colorize: vi.fn((s: string) => s),
  debug: vi.fn(),
}));

vi.mock('../../src/utils/prompt.js', () => ({
  selectWithCancel: vi.fn(),
  checkboxWithCancel: vi.fn(),
  confirmWithCancel: vi.fn(),
  PROMPT_CANCELLED: Symbol('PROMPT_CANCELLED'),
}));

describe('check environment', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCheckCodepacEnvironment.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should expose structured CodePac environment details in check result', async () => {
    mockCheckCodepacEnvironment.mockResolvedValue(makeEnvironment());
    const fsMock = (await import('fs/promises')).default as { access: ReturnType<typeof vi.fn> };
    fsMock.access.mockResolvedValue(undefined);

    const { collectCheckResultForTest } = await import('../../src/commands/check.js');
    const result = await collectCheckResultForTest();

    expect(result.environment.codepac.ok).toBe(true);
    expect(result.environment.codepac.details.git.version).toBe('2.40.0');
    expect(result.environment.codepac.details.gitLfs.ok).toBe(true);
    expect(result.summary.envErrors).toBe(0);
  });

  it('should count CodePac environment as one environment error even when nested checks fail', async () => {
    mockCheckCodepacEnvironment.mockResolvedValue(makeEnvironment({
      ok: false,
      git: { ok: false, command: 'git --version', minimumVersion: '2.22.0', version: '2.21.0', raw: 'git version 2.21.0', message: 'Git 版本需不低于 2.22.0，当前 2.21.0' },
      gitLfs: {
        ok: false,
        commands: {
          gitLfsVersion: { ok: false, command: 'git-lfs --version', stdout: '', stderr: 'not found', error: 'not found' },
          gitLfsSubcommand: { ok: false, command: 'git lfs --version', stdout: '', stderr: 'not found', error: 'not found' },
        },
        message: 'Git LFS 不可用',
      },
    }));
    const fsMock = (await import('fs/promises')).default as { access: ReturnType<typeof vi.fn> };
    fsMock.access.mockResolvedValue(undefined);

    const { collectCheckResultForTest } = await import('../../src/commands/check.js');
    const result = await collectCheckResultForTest();

    expect(result.environment.codepac.ok).toBe(false);
    expect(result.environment.codepac.message).toContain('Git 版本不足');
    expect(result.environment.codepac.message).toContain('Git LFS 不可用');
    expect(result.summary.envErrors).toBe(1);
  });
});
