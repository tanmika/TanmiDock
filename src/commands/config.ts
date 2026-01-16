/**
 * config 命令 - 查看/修改配置
 */
import { Command } from 'commander';
import { select, input, confirm } from '@inquirer/prompts';
import { ensureInitialized } from '../core/guard.js';
import * as config from '../core/config.js';
import { shrinkHome, expandHome } from '../core/platform.js';
import { info, error, success, title, blank, colorize } from '../utils/logger.js';
import type { DockConfig, CleanStrategy, LogLevel, ProxyConfig, UnverifiedLocalStrategy } from '../types/index.js';

/**
 * 创建 config 命令
 */
export function createConfigCommand(): Command {
  const cmd = new Command('config')
    .description('查看或修改配置')
    .addHelpText(
      'after',
      `
无参数时进入交互式配置界面，可视化查看和修改所有配置项。

配置项:
  storePath                存储路径，依赖库存放目录
  cleanStrategy            清理策略: unreferenced/unused/capacity/manual
  unusedDays               未使用天数阈值 (unused 策略时生效)
  unreferencedThreshold    无引用容量阈值 (capacity 策略时生效)，格式: 10GB
  autoDownload             缺失依赖时是否自动下载: true/false
  concurrency              并发下载数: 1/2/3/5/99(不限制)
  logLevel                 日志级别: debug/verbose/info/warn/error
  proxy                    代理地址，JSON 格式: {"http":"...","https":"..."}
  unverifiedLocalStrategy  本地库无法验证 commit 时的策略: download/absorb

示例:
  td config                              交互式配置
  td config get storePath                获取存储路径
  td config set concurrency 5            设置并发数
  td config set proxy '{"http":"http://127.0.0.1:7890"}'`
    );

  // 默认进入交互式配置
  cmd.action(async () => {
    await ensureInitialized();
    await showConfig();
  });

  // get 子命令
  cmd
    .command('get <key>')
    .description('获取配置项的值')
    .action(async (key: string) => {
      await ensureInitialized();
      await getConfigValue(key);
    });

  // set 子命令
  cmd
    .command('set <key> <value>')
    .description('设置配置项的值')
    .action(async (key: string, value: string) => {
      await ensureInitialized();
      await setConfigValue(key, value);
    });

  return cmd;
}

/**
 * 配置项元数据
 */
interface ConfigMeta {
  key: keyof DockConfig;
  label: string;
  description: string;
  editable: boolean;
  type: 'string' | 'number' | 'boolean' | 'select' | 'proxy';
  options?: { value: string; label: string }[];
  showWhen?: (cfg: DockConfig) => boolean; // 条件显示
}

const CONFIG_META: ConfigMeta[] = [
  { key: 'version', label: '版本', description: '配置文件版本', editable: false, type: 'string' },
  { key: 'storePath', label: '存储路径', description: '依赖库存放目录', editable: true, type: 'string' },
  {
    key: 'cleanStrategy',
    label: '清理策略',
    description: '自动清理未使用库的策略',
    editable: true,
    type: 'select',
    options: [
      { value: 'unreferenced', label: '无引用时清理' },
      { value: 'unused', label: '超期未使用时清理' },
      { value: 'capacity', label: '容量超限时清理' },
      { value: 'manual', label: '仅手动清理' },
    ],
  },
  {
    key: 'unusedDays',
    label: '未使用天数',
    description: 'unused 策略的天数阈值',
    editable: true,
    type: 'number',
    showWhen: (cfg) => cfg.cleanStrategy === 'unused',
  },
  {
    key: 'unreferencedThreshold',
    label: '无引用容量阈值',
    description: '无引用库超过此容量时触发清理 (GB)',
    editable: true,
    type: 'number',
    showWhen: (cfg) => cfg.cleanStrategy === 'capacity',
  },
  { key: 'autoDownload', label: '自动下载', description: '缺失依赖时自动下载', editable: true, type: 'boolean' },
  {
    key: 'concurrency',
    label: '并发数',
    description: '同时下载的最大数量',
    editable: true,
    type: 'select',
    options: [
      { value: '1', label: '1 个' },
      { value: '2', label: '2 个' },
      { value: '3', label: '3 个' },
      { value: '5', label: '5 个' },
      { value: '99', label: '不限制' },
    ],
  },
  {
    key: 'logLevel',
    label: '日志级别',
    description: '控制日志输出详细程度',
    editable: true,
    type: 'select',
    options: [
      { value: 'debug', label: '调试' },
      { value: 'verbose', label: '详细' },
      { value: 'info', label: '常规' },
      { value: 'warn', label: '警告' },
      { value: 'error', label: '错误' },
    ],
  },
  { key: 'proxy', label: '代理设置', description: 'HTTP/HTTPS 代理配置', editable: true, type: 'proxy' },
  {
    key: 'unverifiedLocalStrategy',
    label: '未验证本地库策略',
    description: '本地库 commit 无法验证时的处理策略',
    editable: true,
    type: 'select',
    options: [
      { value: 'download', label: '重新下载' },
      { value: 'absorb', label: '自动吸收' },
    ],
  },
];

/**
 * 清理策略汉化映射
 */
const CLEAN_STRATEGY_LABELS: Record<CleanStrategy, string> = {
  unreferenced: '无引用时清理',
  unused: '超期未使用时清理',
  capacity: '容量超限时清理',
  manual: '仅手动清理',
};

/**
 * 日志级别汉化映射
 */
const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  debug: '调试',
  verbose: '详细',
  info: '常规',
  warn: '警告',
  error: '错误',
};

/**
 * 未验证本地库策略汉化映射
 */
const UNVERIFIED_LOCAL_STRATEGY_LABELS: Record<UnverifiedLocalStrategy, string> = {
  download: '重新下载',
  absorb: '自动吸收',
};

/**
 * 格式化配置值用于显示
 */
function formatValue(key: keyof DockConfig, value: unknown): string {
  if (value === undefined || value === null) {
    return colorize('未设置', 'gray');
  }
  if (key === 'storePath' && typeof value === 'string') {
    return shrinkHome(value);
  }
  if (key === 'cleanStrategy') {
    const strategy = value as CleanStrategy;
    return CLEAN_STRATEGY_LABELS[strategy] || strategy;
  }
  if (key === 'logLevel') {
    const level = value as LogLevel;
    return LOG_LEVEL_LABELS[level] || level;
  }
  if (key === 'unverifiedLocalStrategy') {
    const strategy = value as UnverifiedLocalStrategy;
    return UNVERIFIED_LOCAL_STRATEGY_LABELS[strategy] || strategy;
  }
  if (key === 'concurrency') {
    const num = value as number;
    return num >= 99 ? '不限制' : `${num} 个`;
  }
  if (key === 'unreferencedThreshold') {
    const bytes = value as number;
    const gb = Math.round(bytes / (1024 * 1024 * 1024));
    return `${gb} GB`;
  }
  if (key === 'proxy') {
    const proxy = value as ProxyConfig;
    if (!proxy.http && !proxy.https) {
      return colorize('未设置', 'gray');
    }
    return proxy.http || proxy.https || '';
  }
  if (typeof value === 'boolean') {
    return value ? colorize('是', 'green') : colorize('否', 'yellow');
  }
  return String(value);
}

/**
 * 显示配置并进入交互式编辑
 */
async function showConfig(): Promise<void> {
  const cfg = await config.load();

  if (!cfg) {
    error('配置文件不存在');
    process.exit(1);
  }

  await interactiveConfig(cfg);
}

/**
 * 交互式配置界面
 */
async function interactiveConfig(cfg: DockConfig): Promise<void> {
  while (true) {
    console.clear();
    title('TanmiDock 配置');
    blank();

    // 显示当前配置（根据条件过滤）
    const visibleConfigs = CONFIG_META.filter((m) => !m.showWhen || m.showWhen(cfg));
    for (const meta of visibleConfigs) {
      const value = cfg[meta.key];
      const editMark = meta.editable ? '' : colorize(' (只读)', 'gray');
      console.log(`  ${colorize(meta.label.padEnd(10), 'cyan')} ${formatValue(meta.key, value)}${editMark}`);
    }

    blank();
    const { getConfigPath } = await import('../core/platform.js');
    info(`配置文件: ${shrinkHome(getConfigPath())}`);
    blank();

    // 选择操作（只显示可见且可编辑的配置项）
    const editableConfigs = visibleConfigs.filter((m) => m.editable);
    const choices = [
      ...editableConfigs.map((m) => ({
        value: m.key,
        name: `${m.label} - ${m.description}`,
      })),
      { value: '_exit' as const, name: colorize('退出', 'gray') },
    ];

    const selected = await select({
      message: '选择要修改的配置项:',
      choices,
    });

    if (selected === '_exit') {
      break;
    }

    // 编辑选中的配置项
    const meta = CONFIG_META.find((m) => m.key === selected)!;
    const newValue = await editConfigValue(meta, cfg[meta.key]);

    if (newValue !== undefined) {
      try {
        await config.set(meta.key, newValue as never);
        cfg[meta.key] = newValue as never;
        success(`已更新: ${meta.label}`);
        await sleep(800);
      } catch (err) {
        error((err as Error).message);
        await sleep(1500);
      }
    }
  }
}

/**
 * 编辑单个配置值
 */
async function editConfigValue(meta: ConfigMeta, currentValue: unknown): Promise<unknown> {
  blank();
  info(`当前值: ${formatValue(meta.key, currentValue)}`);
  blank();

  switch (meta.type) {
    case 'string': {
      const result = await input({
        message: `输入新的 ${meta.label}:`,
        default: currentValue as string | undefined,
      });
      if (meta.key === 'storePath') {
        return expandHome(result);
      }
      return result || undefined;
    }

    case 'number': {
      // unreferencedThreshold 使用 GB 单位编辑
      const isThreshold = meta.key === 'unreferencedThreshold';
      const defaultValue =
        currentValue !== undefined
          ? isThreshold
            ? String(Math.round((currentValue as number) / (1024 * 1024 * 1024)))
            : String(currentValue)
          : '';
      const result = await input({
        message: `输入新的 ${meta.label}${isThreshold ? ' (GB)' : ''}:`,
        default: defaultValue,
        validate: (val) => {
          if (!val) return true; // 允许清空
          const num = parseInt(val, 10);
          if (isNaN(num) || num < 1) return '请输入有效的正整数';
          return true;
        },
      });
      if (!result) return undefined;
      const num = parseInt(result, 10);
      // unreferencedThreshold 转换为字节存储
      return isThreshold ? num * 1024 * 1024 * 1024 : num;
    }

    case 'boolean': {
      return await confirm({
        message: `${meta.label}?`,
        default: currentValue as boolean,
      });
    }

    case 'select': {
      const result = await select({
        message: `选择 ${meta.label}:`,
        choices: meta.options!,
        default: meta.key === 'concurrency' ? String(currentValue) : (currentValue as string),
      });
      // concurrency 需要转为数字
      if (meta.key === 'concurrency') {
        return parseInt(result, 10);
      }
      return result;
    }

    case 'proxy': {
      return await editProxyConfig(currentValue as ProxyConfig | undefined);
    }

    default:
      return undefined;
  }
}

/**
 * 编辑代理配置
 */
async function editProxyConfig(current: ProxyConfig | undefined): Promise<ProxyConfig | undefined> {
  const action = await select({
    message: '代理设置:',
    choices: [
      { value: 'edit', name: '编辑' },
      { value: 'clear', name: '清除' },
      { value: 'cancel', name: colorize('取消', 'gray') },
    ],
  });

  if (action === 'cancel') {
    return undefined;
  }

  if (action === 'clear') {
    return {};
  }

  const http = await input({
    message: 'HTTP/HTTPS 代理 (如 http://127.0.0.1:7890):',
    default: current?.http || '',
  });

  if (!http) {
    return {};
  }

  return { http, https: http };
}

/**
 * 延时
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 获取配置项
 */
async function getConfigValue(key: string): Promise<void> {
  if (!config.isValidConfigKey(key)) {
    error(`无效的配置项: ${key}`);
    info('有效的配置项: storePath, cleanStrategy, unusedDays, autoDownload, concurrency, logLevel, proxy, unverifiedLocalStrategy');
    process.exit(1);
  }

  const value = await config.get(key as keyof import('../types/index.js').DockConfig);

  if (value === undefined) {
    error(`配置项 ${key} 未设置`);
    process.exit(1);
  }

  if (key === 'storePath' && typeof value === 'string') {
    info(shrinkHome(value));
  } else {
    info(String(value));
  }
}

/**
 * 设置配置项
 */
async function setConfigValue(key: string, value: string): Promise<void> {
  if (!config.isValidConfigKey(key)) {
    error(`无效的配置项: ${key}`);
    info('有效的配置项: storePath, cleanStrategy, unusedDays, autoDownload, concurrency, logLevel, proxy, unverifiedLocalStrategy');
    process.exit(1);
  }

  // 只读配置项
  if (key === 'version' || key === 'initialized') {
    error(`配置项 ${key} 为只读`);
    process.exit(1);
  }

  try {
    const parsedValue = config.parseConfigValue(
      key as keyof import('../types/index.js').DockConfig,
      value
    );
    await config.set(key as keyof import('../types/index.js').DockConfig, parsedValue as never);
    success(`配置已更新: ${key} = ${value}`);
  } catch (err) {
    error((err as Error).message);
    process.exit(1);
  }
}

export default createConfigCommand;
