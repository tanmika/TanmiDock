/**
 * 日志输出工具
 * - 无 emoji，保持简洁
 * - 中文输出
 * - 状态标记：[ok] [warn] [err] [info]
 */

import type { LogLevel } from '../types/index.js';

// 日志级别优先级
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  verbose: 1,
  info: 2,
  warn: 3,
  error: 4,
};

// 当前日志级别（可通过 setLogLevel 修改）
let currentLogLevel: LogLevel = 'info';

/**
 * 设置日志级别
 */
export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

/**
 * 获取当前日志级别
 */
export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

/**
 * 检查是否应该输出该级别的日志
 */
function shouldLog(level: LogLevel): boolean {
  // 环境变量优先
  if (process.env.DEBUG === '1') return true;
  if (process.env.VERBOSE === '1' && LOG_LEVELS[level] >= LOG_LEVELS.verbose) return true;
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel];
}

// ANSI 颜色码
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

/**
 * 检测是否支持颜色
 */
function supportsColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY ?? false;
}

const useColor = supportsColor();

export function colorize(text: string, color: keyof typeof colors): string {
  if (!useColor) return text;
  return `${colors[color]}${text}${colors.reset}`;
}

/**
 * 普通信息
 */
export function info(message: string): void {
  console.log(message);
}

/**
 * 成功信息 - 绿色 [ok]
 */
export function success(message: string): void {
  console.log(`${colorize('[ok]', 'green')} ${message}`);
}

/**
 * 警告信息 - 黄色 [warn]
 */
export function warn(message: string): void {
  console.log(`${colorize('[warn]', 'yellow')} ${message}`);
}

/**
 * 错误信息 - 红色 [err]
 */
export function error(message: string): void {
  console.error(`${colorize('[err]', 'red')} ${message}`);
}

/**
 * 调试信息 - 灰色，根据日志级别输出
 */
export function debug(message: string): void {
  if (shouldLog('debug')) {
    console.log(`${colorize('[debug]', 'gray')} ${message}`);
  }
}

/**
 * 详细信息 - 灰色，根据日志级别输出
 */
export function verbose(message: string): void {
  if (shouldLog('verbose')) {
    console.log(`${colorize('[verbose]', 'gray')} ${message}`);
  }
}

/**
 * 详细 JSON 输出
 */
export function verboseJson(label: string, data: unknown): void {
  if (shouldLog('verbose')) {
    console.log(`${colorize('[verbose]', 'gray')} ${label}:`);
    console.log(JSON.stringify(data, null, 2));
  }
}

/**
 * 检查是否启用 verbose 模式
 */
export function isVerbose(): boolean {
  return shouldLog('verbose');
}

/**
 * 提示信息 - 蓝色 [info]
 */
export function hint(message: string): void {
  console.log(`${colorize('[info]', 'blue')} ${message}`);
}

/**
 * 进度显示
 */
export function progress(current: number, total: number, message: string): void {
  console.log(`[${current}/${total}] ${message}`);
}

/**
 * 进度条显示
 */
export function progressBar(current: number, total: number, width = 20): void {
  const percent = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  process.stdout.write(`\r  进度: ${bar} ${percent}%`);
  if (current >= total) {
    console.log(); // 换行
  }
}

/**
 * 树状结构项
 */
export interface TreeItem {
  label: string;
  children?: TreeItem[];
  warn?: boolean;
}

/**
 * 树状结构输出
 */
export function tree(items: TreeItem[], prefix = ''): void {
  items.forEach((item, index) => {
    const isLast = index === items.length - 1;
    const connector = isLast ? '+-- ' : '+-- ';
    const childPrefix = isLast ? '    ' : '|   ';

    let label = item.label;
    if (item.warn) {
      label = `${label} ${colorize('[warn]', 'yellow')}`;
    }

    console.log(`${prefix}${connector}${label}`);

    if (item.children && item.children.length > 0) {
      tree(item.children, prefix + childPrefix);
    }
  });
}

/**
 * 简单表格输出
 */
export function table(rows: string[][], padding = 2): void {
  if (rows.length === 0) return;

  // 计算每列最大宽度
  const colWidths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      colWidths[i] = Math.max(colWidths[i] || 0, cell.length);
    });
  }

  // 输出
  for (const row of rows) {
    const line = row.map((cell, i) => cell.padEnd(colWidths[i] + padding)).join('');
    console.log(line);
  }
}

/**
 * 分隔线
 */
export function separator(char = '-', length = 40): void {
  console.log(char.repeat(length));
}

/**
 * 空行
 */
export function blank(): void {
  console.log();
}

/**
 * 标题
 */
export function title(text: string): void {
  console.log(colorize(text, 'bold'));
}

export default {
  info,
  success,
  warn,
  error,
  debug,
  verbose,
  verboseJson,
  isVerbose,
  hint,
  progress,
  progressBar,
  tree,
  table,
  separator,
  blank,
  title,
  setLogLevel,
  getLogLevel,
  colorize,
};
