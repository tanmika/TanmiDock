/**
 * dashboard - 工作台首页
 * 直接运行 tanmi-dock 不带参数时显示
 */
import { getRegistry } from '../core/registry.js';
import type RegistryManager from '../core/registry.js';
import * as config from '../core/config.js';
import * as store from '../core/store.js';
import { colorize, blank } from '../utils/logger.js';
import { shrinkHome } from '../core/platform.js';
import { formatBytes } from '../utils/progress.js';
import { createRequire } from 'module';
import type { DockConfig } from '../types/index.js';

// 读取 package.json 版本
const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

/**
 * Logo 上色：░ 保持默认色，实心字符用指定颜色
 */
function colorizeLogo(text: string, color: 'red' | 'cyan'): string {
  return text
    .split('')
    .map((char) => (char === '░' ? char : colorize(char, color)))
    .join('');
}

// Pagga 字体 LOGO
const LOGO_TANMI = [
  '░▀█▀░█▀█░█▀█░█▄█░▀█▀',
  '░░█░░█▀█░█░█░█░█░░█░',
  '░░▀░░▀░▀░▀░▀░▀░▀░▀▀▀',
];

const LOGO_DOCK = [
  '░█▀▄░█▀█░█▀▀░█░█',
  '░█░█░█░█░█░░░█▀▄',
  '░▀▀░░▀▀▀░▀▀▀░▀░▀',
];

/**
 * 显示工作台首页
 */
export async function showDashboard(): Promise<void> {
  const cfg = await config.load();
  const version = pkg.version;

  // 显示 LOGO
  blank();
  for (let i = 0; i < LOGO_TANMI.length; i++) {
    const tanmi = colorizeLogo(LOGO_TANMI[i], 'red');
    const dock = LOGO_DOCK[i];
    if (i === 0) {
      console.log(`${tanmi}${dock}  v${version}`);
    } else {
      console.log(`${tanmi}${dock}`);
    }
  }
  blank();

  // 检查是否已初始化
  if (!cfg) {
    console.log(colorize('  尚未初始化，请先运行: td init', 'yellow'));
    blank();
    showQuickStart();
    return;
  }

  // 获取 Store 状态
  let registry: RegistryManager | null = null;
  try {
    const reg = getRegistry();
    await reg.load();
    registry = reg;
  } catch {
    // Registry 不可用
  }

  await showStoreStatus(cfg, registry);
  blank();
  showReferenceStatus(registry);
  blank();
  showSystemHealth(registry);
  blank();
  showQuickCommands();
  blank();

  // 检查更新
  const { checkForUpdates } = await import('../utils/update-check.js');
  await checkForUpdates();
}

/**
 * Store 状态
 */
async function showStoreStatus(cfg: DockConfig, registry: RegistryManager | null): Promise<void> {
  console.log(colorize('Store 状态', 'bold'));

  const storePath = shrinkHome(cfg.storePath);
  console.log(`   路径        ${storePath}`);

  if (registry) {
    const stores = registry.listStores();
    const totalSize = await store.getTotalSize();
    const spaceStats = registry.getSpaceStats();
    console.log(`   库数量      ${colorize(String(stores.length), 'cyan')}`);
    console.log(`   占用空间    ${colorize(formatBytes(totalSize), 'cyan')}`);
    if (spaceStats.savedSize > 0) {
      console.log(`   节省空间    ${colorize(formatBytes(spaceStats.savedSize), 'green')}`);
    }
  } else {
    console.log(`   库数量      ${colorize('-', 'gray')}`);
    console.log(`   占用空间    ${colorize('-', 'gray')}`);
  }
}

/**
 * 引用状态
 */
function showReferenceStatus(registry: RegistryManager | null): void {
  console.log(colorize('引用状态', 'bold'));

  if (!registry) {
    console.log(`   注册项目    ${colorize('-', 'gray')}`);
    console.log(`   被引用库    ${colorize('-', 'gray')}`);
    console.log(`   无引用库    ${colorize('-', 'gray')}`);
    return;
  }

  const projects = registry.listProjects();
  const stores = registry.listStores();
  const referenced = stores.filter((s) => s.usedBy && s.usedBy.length > 0);
  const unreferenced = registry.getUnreferencedStores();
  const unreferencedSize = unreferenced.reduce((sum, s) => sum + s.size, 0);

  console.log(`   注册项目    ${colorize(String(projects.length), 'cyan')}`);
  console.log(`   被引用库    ${colorize(String(referenced.length), 'cyan')}`);

  if (unreferenced.length > 0) {
    console.log(
      `   无引用库    ${colorize(String(unreferenced.length), 'yellow')} ${colorize(`(${formatBytes(unreferencedSize)})`, 'yellow')}`
    );
  } else {
    console.log(`   无引用库    ${colorize('0', 'green')}`);
  }
}

/**
 * 系统健康状态
 */
function showSystemHealth(registry: RegistryManager | null): void {
  console.log(colorize('系统健康', 'bold'));

  if (!registry) {
    console.log(`   ${colorize('[warn]', 'yellow')} Registry 不可用，运行 td check 检查`);
    return;
  }

  // 简单健康检查
  const issues: string[] = [];

  // 检查无引用库数量
  const unreferenced = registry.getUnreferencedStores();
  if (unreferenced.length > 10) {
    issues.push(`${unreferenced.length} 个无引用库可清理`);
  }

  if (issues.length === 0) {
    console.log(`   ${colorize('[ok]', 'green')} 正常`);
  } else {
    console.log(`   ${colorize('[warn]', 'yellow')} ${issues.join(', ')}`);
  }
}

/**
 * 快捷操作
 */
function showQuickCommands(): void {
  console.log(colorize('快捷操作', 'bold'));
  console.log('   td link     链接当前项目     td status   查看链接状态');
  console.log('   td clean    清理无引用库     td config   修改配置');
}

/**
 * 快速上手（未初始化时）
 */
function showQuickStart(): void {
  console.log(colorize('快速上手', 'bold'));
  console.log('   td init     初始化配置');
  console.log('   td --help   查看帮助');
}
