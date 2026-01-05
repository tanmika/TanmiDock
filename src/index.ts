#!/usr/bin/env node
import { Command } from 'commander';
import { createInitCommand } from './commands/init.js';
import { createLinkCommand } from './commands/link.js';
import { createStatusCommand } from './commands/status.js';
import { createProjectsCommand } from './commands/projects.js';
import { createCleanCommand } from './commands/clean.js';
import { createUnlinkCommand } from './commands/unlink.js';
import { createConfigCommand } from './commands/config.js';
import { createMigrateCommand } from './commands/migrate.js';

const program = new Command();

program.name('tanmi-dock').description('集中型第三方库链接管理工具').version('0.1.0');

// 注册命令
program.addCommand(createInitCommand());
program.addCommand(createLinkCommand());
program.addCommand(createStatusCommand());
program.addCommand(createProjectsCommand());
program.addCommand(createCleanCommand());
program.addCommand(createUnlinkCommand());
program.addCommand(createConfigCommand());
program.addCommand(createMigrateCommand());

program.parse();
