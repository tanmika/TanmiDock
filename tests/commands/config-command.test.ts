import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/guard.js', () => ({
  ensureInitialized: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/config.js', () => ({
  isValidConfigKey: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  parseConfigValue: vi.fn(),
  load: vi.fn(),
}));

vi.mock('../../src/utils/logger.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  title: vi.fn(),
  blank: vi.fn(),
  colorize: vi.fn((value: string) => value),
}));

describe('config command', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('should register get and set subcommands for sharedSymlinkFolders usage', async () => {
    const { createConfigCommand } = await import('../../src/commands/config.js');

    const command = createConfigCommand();
    const subcommandNames = command.commands.map((subcommand) => subcommand.name());

    expect(subcommandNames).toContain('get');
    expect(subcommandNames).toContain('set');
    expect(command.description()).toBe('查看或修改配置');
  });

  it('should support get sharedSymlinkFolders', async () => {
    const config = await import('../../src/core/config.js');
    vi.mocked(config.isValidConfigKey).mockReturnValue(true);
    vi.mocked(config.get).mockResolvedValue(true);

    const logger = await import('../../src/utils/logger.js');
    const { createConfigCommand } = await import('../../src/commands/config.js');

    const command = createConfigCommand();
    await command.parseAsync(['node', 'config', 'get', 'sharedSymlinkFolders'], {
      from: 'node',
    });

    expect(config.get).toHaveBeenCalledWith('sharedSymlinkFolders');
    expect(logger.info).toHaveBeenCalledWith('true');
  });

  it('should support set sharedSymlinkFolders', async () => {
    const config = await import('../../src/core/config.js');
    vi.mocked(config.isValidConfigKey).mockReturnValue(true);
    vi.mocked(config.parseConfigValue).mockReturnValue(false);
    vi.mocked(config.set).mockResolvedValue(undefined);

    const logger = await import('../../src/utils/logger.js');
    const { createConfigCommand } = await import('../../src/commands/config.js');

    const command = createConfigCommand();
    await command.parseAsync(['node', 'config', 'set', 'sharedSymlinkFolders', 'false'], {
      from: 'node',
    });

    expect(config.parseConfigValue).toHaveBeenCalledWith('sharedSymlinkFolders', 'false');
    expect(config.set).toHaveBeenCalledWith('sharedSymlinkFolders', false);
    expect(logger.success).toHaveBeenCalledWith('配置已更新: sharedSymlinkFolders = false');
  });
});
