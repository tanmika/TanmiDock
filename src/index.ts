#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();

program
  .name('tanmi-dock')
  .description('集中型第三方库链接管理工具')
  .version('0.1.0');

// Commands will be added here
// - init
// - link
// - status
// - projects
// - clean
// - unlink
// - config
// - migrate

program.parse();
