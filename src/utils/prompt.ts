import {
  select,
  confirm,
  input,
  checkbox,
  Separator,
} from '@inquirer/prompts';
import {
  createPrompt,
  useState,
  useKeypress,
  usePrefix,
  usePagination,
  useMemo,
  isEnterKey,
  isUpKey,
  isDownKey,
  makeTheme,
  type Status,
} from '@inquirer/core';
import figures from '@inquirer/figures';
import { styleText } from 'node:util';
import { PLATFORM_OPTIONS } from '../core/platform.js';

// ============ ESC 取消支持 ============

/**
 * 表示用户按 ESC 取消操作
 */
export const PROMPT_CANCELLED = Symbol('PROMPT_CANCELLED');

/**
 * 检查是否为 ESC 键
 */
function isEscapeKey(key: { name?: string }): boolean {
  return key.name === 'escape';
}

// ============ 可取消的 Select ============

interface SelectChoice<T> {
  name: string;
  value: T;
  description?: string;
  disabled?: boolean | string;
}

interface SelectConfig<T> {
  message: string;
  choices: Array<SelectChoice<T> | typeof Separator.prototype>;
  default?: T;
  pageSize?: number;
  loop?: boolean;
}

const selectTheme = {
  icon: { cursor: figures.pointer },
  style: {
    disabled: (text: string) => styleText('dim', `- ${text}`),
    description: (text: string) => styleText('cyan', text),
    helpTip: (text: string) => styleText('dim', text),
  },
};

function isSelectable<T>(item: SelectChoice<T> | typeof Separator.prototype): item is SelectChoice<T> {
  return !Separator.isSeparator(item) && !item.disabled;
}

/**
 * 可取消的 select - 支持 ESC 返回
 */
export const selectWithCancel = createPrompt(
  <T,>(config: SelectConfig<T>, done: (value: T | typeof PROMPT_CANCELLED) => void) => {
    const { loop = true, pageSize = 7 } = config;
    const theme = makeTheme(selectTheme);
    const [status, setStatus] = useState<Status>('idle');
    const [cancelled, setCancelled] = useState(false);
    const prefix = usePrefix({ status, theme });

    const items = useMemo(
      () =>
        config.choices.map((choice) => {
          if (Separator.isSeparator(choice)) return choice;
          const name = choice.name ?? String(choice.value);
          return {
            value: choice.value,
            name,
            description: choice.description,
            disabled: choice.disabled ?? false,
          };
        }),
      [config.choices]
    );

    const bounds = useMemo(() => {
      const first = items.findIndex(isSelectable);
      // findLastIndex polyfill
      let last = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (isSelectable(items[i])) {
          last = i;
          break;
        }
      }
      return { first, last };
    }, [items]);

    const defaultIndex = useMemo(() => {
      if (!('default' in config)) return -1;
      return items.findIndex((item) => isSelectable(item) && item.value === config.default);
    }, [config.default, items]);

    const [active, setActive] = useState(defaultIndex === -1 ? bounds.first : defaultIndex);
    const selectedChoice = items[active] as SelectChoice<T>;

    useKeypress((key) => {
      if (isEscapeKey(key)) {
        setCancelled(true);
        setStatus('done');
        done(PROMPT_CANCELLED);
      } else if (isEnterKey(key)) {
        setStatus('done');
        done(selectedChoice.value);
      } else if (isUpKey(key) || isDownKey(key)) {
        if (
          loop ||
          (isUpKey(key) && active !== bounds.first) ||
          (isDownKey(key) && active !== bounds.last)
        ) {
          const offset = isUpKey(key) ? -1 : 1;
          let next = active;
          do {
            next = (next + offset + items.length) % items.length;
          } while (!isSelectable(items[next]));
          setActive(next);
        }
      }
    });

    const page = usePagination({
      items,
      active,
      renderItem: ({ item, index, isActive }) => {
        if (Separator.isSeparator(item)) {
          return ` ${item.separator}`;
        }

        const line = item.name;
        if (item.disabled) {
          const disabledLabel =
            typeof item.disabled === 'string' ? item.disabled : '(disabled)';
          return styleText('dim', `- ${line} ${disabledLabel}`);
        }

        const cursor = isActive ? figures.pointer : ' ';
        let output = isActive
          ? `${cursor} ${styleText('cyan', line)}`
          : `${cursor} ${line}`;

        if (item.description && isActive) {
          output += `\n   ${styleText('cyan', item.description)}`;
        }

        return output;
      },
      pageSize,
      loop,
    });

    if (status === 'done') {
      const displayText = cancelled ? '(已取消)' : selectedChoice?.name ?? '';
      return `${prefix} ${config.message} ${styleText('cyan', displayText)}`;
    }

    const helpTip = styleText(
      'dim',
      '↑↓ 选择 • ⏎ 确认 • esc 取消'
    );

    return `${prefix} ${styleText('bold', config.message)}\n${page}\n${helpTip}`;
  }
);

// ============ 可取消的 Checkbox ============

interface CheckboxChoice<T> {
  name: string;
  value: T;
  checked?: boolean;
  disabled?: boolean | string;
}

interface CheckboxConfig<T> {
  message: string;
  choices: Array<CheckboxChoice<T> | typeof Separator.prototype>;
  pageSize?: number;
  loop?: boolean;
  required?: boolean;
}

/**
 * 可取消的 checkbox - 支持 ESC 返回
 */
export const checkboxWithCancel = createPrompt(
  <T,>(config: CheckboxConfig<T>, done: (value: T[] | typeof PROMPT_CANCELLED) => void) => {
    const { pageSize = 7, loop = true, required = false } = config;
    const theme = makeTheme(selectTheme);
    const [status, setStatus] = useState<Status>('idle');
    const [cancelled, setCancelled] = useState(false);
    const prefix = usePrefix({ status, theme });

    type InternalChoice = {
      value: T;
      name: string;
      checked: boolean;
      disabled: boolean | string;
    };

    const [items, setItems] = useState<Array<InternalChoice | typeof Separator.prototype>>(() =>
      config.choices.map((choice) => {
        if (Separator.isSeparator(choice)) return choice;
        return {
          value: choice.value,
          name: choice.name ?? String(choice.value),
          checked: choice.checked ?? false,
          disabled: choice.disabled ?? false,
        };
      })
    );

    const bounds = useMemo(() => {
      const isSelectableItem = (item: InternalChoice | typeof Separator.prototype): boolean =>
        !Separator.isSeparator(item) && !item.disabled;
      const first = items.findIndex(isSelectableItem);
      // findLastIndex polyfill
      let last = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (isSelectableItem(items[i])) {
          last = i;
          break;
        }
      }
      return { first, last };
    }, [items]);

    const [active, setActive] = useState(bounds.first);

    useKeypress((key) => {
      if (isEscapeKey(key)) {
        setCancelled(true);
        setStatus('done');
        done(PROMPT_CANCELLED);
      } else if (isEnterKey(key)) {
        const selected = items
          .filter((item): item is InternalChoice => !Separator.isSeparator(item) && item.checked)
          .map((item) => item.value);

        if (required && selected.length === 0) {
          // 不允许空选择
          return;
        }

        setStatus('done');
        done(selected);
      } else if (key.name === 'space') {
        // 切换选中状态
        setItems(
          items.map((item, index) => {
            if (index === active && !Separator.isSeparator(item) && !item.disabled) {
              return { ...item, checked: !item.checked };
            }
            return item;
          })
        );
      } else if (isUpKey(key) || isDownKey(key)) {
        if (
          loop ||
          (isUpKey(key) && active !== bounds.first) ||
          (isDownKey(key) && active !== bounds.last)
        ) {
          const offset = isUpKey(key) ? -1 : 1;
          let next = active;
          do {
            next = (next + offset + items.length) % items.length;
          } while (Separator.isSeparator(items[next]) || (items[next] as InternalChoice).disabled);
          setActive(next);
        }
      } else if (key.name === 'a') {
        // 全选/全不选
        const allChecked = items.every(
          (item) => Separator.isSeparator(item) || item.disabled || item.checked
        );
        setItems(
          items.map((item) => {
            if (Separator.isSeparator(item) || item.disabled) return item;
            return { ...item, checked: !allChecked };
          })
        );
      }
    });

    const page = usePagination({
      items,
      active,
      renderItem: ({ item, index, isActive }) => {
        if (Separator.isSeparator(item)) {
          return ` ${item.separator}`;
        }

        const checkbox = item.checked ? figures.checkboxOn : figures.checkboxOff;
        const cursor = isActive ? figures.pointer : ' ';

        if (item.disabled) {
          return styleText('dim', `${cursor} ${checkbox} ${item.name}`);
        }

        if (isActive) {
          return `${cursor} ${styleText('cyan', `${checkbox} ${item.name}`)}`;
        }
        return `${cursor} ${checkbox} ${item.name}`;
      },
      pageSize,
      loop,
    });

    if (status === 'done') {
      if (cancelled) {
        return `${prefix} ${config.message} ${styleText('cyan', '(已取消)')}`;
      }
      const selected = items
        .filter((item): item is InternalChoice => !Separator.isSeparator(item) && item.checked)
        .map((item) => item.name);
      const summary = selected.length > 0 ? selected.join(', ') : '(none)';
      return `${prefix} ${config.message} ${styleText('cyan', summary)}`;
    }

    const helpTip = styleText(
      'dim',
      '↑↓ 移动 • space 选择 • a 全选 • ⏎ 确认 • esc 取消'
    );

    return `${prefix} ${styleText('bold', config.message)}\n${page}\n${helpTip}`;
  }
);

// ============ 可取消的 Confirm ============

interface ConfirmConfig {
  message: string;
  default?: boolean;
}

/**
 * 可取消的 confirm - 支持 ESC 返回
 */
export const confirmWithCancel = createPrompt(
  (config: ConfirmConfig, done: (value: boolean | typeof PROMPT_CANCELLED) => void) => {
    const { default: defaultValue = false } = config;
    const theme = makeTheme(selectTheme);
    const [status, setStatus] = useState<Status>('idle');
    const [cancelled, setCancelled] = useState(false);
    const [value, setValue] = useState<boolean | undefined>(undefined);
    const prefix = usePrefix({ status, theme });

    useKeypress((key) => {
      if (isEscapeKey(key)) {
        setCancelled(true);
        setStatus('done');
        done(PROMPT_CANCELLED);
      } else if (isEnterKey(key)) {
        setStatus('done');
        done(value ?? defaultValue);
      } else if (key.name === 'y' || key.name === 'Y') {
        setValue(true);
      } else if (key.name === 'n' || key.name === 'N') {
        setValue(false);
      }
    });

    const hint = defaultValue ? '(Y/n)' : '(y/N)';
    const displayValue =
      value === undefined ? '' : value ? styleText('green', 'Yes') : styleText('red', 'No');

    if (status === 'done') {
      if (cancelled) {
        return `${prefix} ${config.message} ${styleText('cyan', '(已取消)')}`;
      }
      const finalValue = value ?? defaultValue;
      return `${prefix} ${config.message} ${finalValue ? styleText('green', 'Yes') : styleText('red', 'No')}`;
    }

    const helpTip = styleText('dim', 'y/n 选择 • ⏎ 确认 • esc 取消');

    return `${prefix} ${styleText('bold', config.message)} ${hint} ${displayValue}\n${helpTip}`;
  }
);

// ============ 可取消的 Input ============

interface InputConfig {
  message: string;
  default?: string;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
}

/**
 * 可取消的 input - 支持 ESC 返回
 */
export const inputWithCancel = createPrompt(
  (config: InputConfig, done: (value: string | typeof PROMPT_CANCELLED) => void) => {
    const theme = makeTheme(selectTheme);
    const [status, setStatus] = useState<Status>('idle');
    const [value, setValue] = useState(config.default ?? '');
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [cancelled, setCancelled] = useState(false);
    const prefix = usePrefix({ status, theme });

    useKeypress(async (key, rl) => {
      if (isEscapeKey(key)) {
        setCancelled(true);
        setStatus('done');
        done(PROMPT_CANCELLED);
      } else if (isEnterKey(key)) {
        // 验证
        if (config.validate) {
          const result = await config.validate(value);
          if (result !== true) {
            setErrorMsg(typeof result === 'string' ? result : '输入无效');
            return;
          }
        }
        setStatus('done');
        done(value);
      } else {
        // 获取当前输入
        setValue(rl.line);
        setErrorMsg(null);
      }
    });

    if (status === 'done') {
      const displayText = cancelled ? '(已取消)' : value || '(empty)';
      return `${prefix} ${config.message} ${styleText('cyan', displayText)}`;
    }

    const defaultHint = config.default ? styleText('dim', ` (${config.default})`) : '';
    const errorDisplay = errorMsg ? `\n${styleText('red', `✖ ${errorMsg}`)}` : '';
    const helpTip = styleText('dim', '输入文本 • ⏎ 确认 • esc 取消');

    return `${prefix} ${styleText('bold', config.message)}${defaultHint}\n> ${value}${errorDisplay}\n${helpTip}`;
  }
);

// ============ 原有函数（支持 ESC 取消）============

export async function selectOption<T extends string>(
  message: string,
  choices: { name: string; value: T; description?: string }[]
): Promise<T | typeof PROMPT_CANCELLED> {
  const result = await selectWithCancel<T>({ message, choices });
  return result;
}

export async function confirmAction(
  message: string,
  defaultValue = false
): Promise<boolean | typeof PROMPT_CANCELLED> {
  return confirmWithCancel({ message, default: defaultValue });
}

export async function inputText(
  message: string,
  defaultValue?: string,
  validate?: (value: string) => boolean | string
): Promise<string | typeof PROMPT_CANCELLED> {
  return inputWithCancel({ message, default: defaultValue, validate });
}

export async function selectFromList<T>(
  message: string,
  items: T[],
  display: (item: T) => string
): Promise<T | typeof PROMPT_CANCELLED> {
  const choices = items.map((item, i) => ({
    name: display(item),
    value: i,
  }));
  const result = await selectWithCancel<number>({ message, choices });
  if (result === PROMPT_CANCELLED) {
    return PROMPT_CANCELLED;
  }
  return items[result];
}

// ============ 平台选择 ============

/**
 * 交互式选择平台
 * @param remembered 上次选择的平台 values，用于默认勾选
 * @returns 选中的平台 value 列表 (如 ['macOS', 'iOS', 'macOS-asan'])，或 PROMPT_CANCELLED 表示取消
 */
export async function selectPlatforms(remembered?: string[]): Promise<string[] | typeof PROMPT_CANCELLED> {
  const rememberedSet = new Set(remembered ?? []);

  // 构建选项列表 - 主平台 + asan 子选项
  type ChoiceItem = {
    name: string;
    value: string;
    checked?: boolean;
  };

  const choices: (ChoiceItem | typeof Separator.prototype)[] = [];

  for (const platform of PLATFORM_OPTIONS) {
    // 主平台选项
    choices.push({
      name: platform.key,
      value: platform.value,
      checked: rememberedSet.has(platform.value),
    });

    // ASAN 子选项
    if (platform.asan) {
      choices.push({
        name: `  └─ ${platform.key}-asan`,
        value: platform.asan,
        checked: rememberedSet.has(platform.asan),
      });
    }

    // HWASAN 子选项 (仅 android)
    if (platform.hwasan) {
      choices.push({
        name: `  └─ ${platform.key}-hwasan`,
        value: platform.hwasan,
        checked: rememberedSet.has(platform.hwasan),
      });
    }
  }

  // 分隔符
  choices.push(new Separator('──────────────'));

  // 自定义输入选项
  choices.push({
    name: '[+] 自定义输入...',
    value: '__CUSTOM__',
    checked: false,
  });

  // 选择 (使用支持 ESC 的版本)
  const selected = await checkboxWithCancel<string>({
    message: '请选择需要的平台:',
    choices: choices as Parameters<typeof checkboxWithCancel<string>>[0]['choices'],
    pageSize: 15,
  });

  // 检查取消
  if (selected === PROMPT_CANCELLED) {
    return PROMPT_CANCELLED;
  }

  // 处理结果
  const result: string[] = [];
  let needCustomInput = false;

  for (const value of selected) {
    if (value === '__CUSTOM__') {
      needCustomInput = true;
    } else {
      result.push(value);
    }
  }

  // 自定义输入
  if (needCustomInput) {
    const customInput = await inputWithCancel({
      message: '请输入自定义平台 (空格或逗号分隔):',
    });

    // 检查取消
    if (customInput === PROMPT_CANCELLED) {
      return PROMPT_CANCELLED;
    }

    if (customInput.trim()) {
      const customPlatforms = customInput
        .split(/[\s,]+/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      result.push(...customPlatforms);
    }
  }

  return result;
}

/**
 * 解析 CLI -p 参数为平台 values
 * 支持多种输入格式：
 *   - 基础 key: mac → macOS (同时包含 asan 变体，由 codepac 下载后清理)
 *   - asan key: mac-asan → macOS-asan
 *   - hwasan key: android-hwasan → android-hwasan
 *   - 直接 value: macOS / macOS-asan → 直通
 *
 * @param keys CLI 参数 (如 ['mac', 'mac-asan', 'ios'])
 * @returns 平台 values (如 ['macOS', 'macOS-asan', 'iOS'])
 */
export function parsePlatformArgs(keys: string[]): string[] {
  const result: string[] = [];

  for (const key of keys) {
    const lowerKey = key.toLowerCase();

    // 1. 检查是否为 asan/hwasan 后缀格式 (如 mac-asan, android-hwasan)
    if (lowerKey.endsWith('-asan')) {
      const baseKey = lowerKey.slice(0, -5); // 去掉 -asan
      const platform = PLATFORM_OPTIONS.find((p) => p.key === baseKey);
      if (platform?.asan) {
        result.push(platform.asan);
        continue;
      }
    }

    if (lowerKey.endsWith('-hwasan')) {
      const baseKey = lowerKey.slice(0, -7); // 去掉 -hwasan
      const platform = PLATFORM_OPTIONS.find((p) => p.key === baseKey);
      if (platform?.hwasan) {
        result.push(platform.hwasan);
        continue;
      }
    }

    // 2. 检查是否为基础 key (如 mac, ios)
    const platform = PLATFORM_OPTIONS.find((p) => p.key === lowerKey);
    if (platform) {
      result.push(platform.value);
      continue;
    }

    // 3. 检查是否为直接 value (如 macOS, macOS-asan)
    const directMatch = PLATFORM_OPTIONS.find(
      (p) => p.value === key || p.asan === key || p.hwasan === key
    );
    if (directMatch) {
      // 直接使用输入的 value
      result.push(key);
      continue;
    }

    // 4. 不认识的 key 直接作为 value 使用 (自定义平台)
    result.push(key);
  }

  // 去重：避免 ['mac', 'macOS'] 等情况产生重复
  return [...new Set(result)];
}

// ============ 通用多选 ============

/**
 * 通用多选框 (支持 ESC 取消)
 * @param message 提示信息
 * @param choices 选项列表
 * @returns 选中的值列表，或 PROMPT_CANCELLED 表示取消
 */
export async function checkboxSelect<T extends string>(
  message: string,
  choices: { name: string; value: T; checked?: boolean }[]
): Promise<T[] | typeof PROMPT_CANCELLED> {
  const result = await checkboxWithCancel<T>({
    message,
    choices: choices.map((c) => ({
      name: c.name,
      value: c.value,
      checked: c.checked ?? false,
    })),
    pageSize: 20,
  });
  return result;
}

// ============ 可选配置选择 ============

/**
 * 可选配置对象
 */
export interface OptionalConfig {
  name: string;
  path: string;
}

/**
 * selectOptionalConfigs 的选项
 */
export interface SelectOptionalConfigsOptions {
  isTTY: boolean;
  specifiedConfigs: string[];
}

/**
 * 选择可选配置文件
 *
 * @param configs 可选配置对象数组
 * @param options 选项，包含 isTTY 和 specifiedConfigs
 * @returns 选中的配置对象数组，TTY 模式下取消返回 PROMPT_CANCELLED
 * @throws 非 TTY 无 specifiedConfigs 时抛出错误
 * @throws specifiedConfigs 中的配置不存在时抛出错误
 */
export async function selectOptionalConfigs(
  configs: OptionalConfig[],
  options: SelectOptionalConfigsOptions
): Promise<OptionalConfig[] | typeof PROMPT_CANCELLED> {
  const { isTTY, specifiedConfigs } = options;

  // 非 TTY 模式：必须通过 --config 指定配置
  if (!isTTY) {
    if (specifiedConfigs.length === 0) {
      throw new Error('非交互模式下必须使用 --config 参数指定配置文件');
    }

    // 查找指定的配置
    const result: OptionalConfig[] = [];
    for (const specName of specifiedConfigs) {
      const found = configs.find((c) => c.name === specName);
      if (!found) {
        throw new Error(`找不到指定的配置文件: ${specName}`);
      }
      result.push(found);
    }
    return result;
  }

  // TTY 模式：交互式选择
  const specifiedSet = new Set(specifiedConfigs);

  // 构建选项列表
  const choices = configs.map((config) => ({
    name: config.name,
    value: config.name,
    checked: specifiedSet.has(config.name),
  }));

  // 使用支持 ESC 的 checkbox
  const selected = await checkboxWithCancel<string>({
    message: '是否使用额外可选配置? (回车跳过)',
    choices,
    pageSize: 15,
  });

  if (selected === PROMPT_CANCELLED) {
    return PROMPT_CANCELLED;
  }

  // 将选中的名称映射回配置对象
  const selectedSet = new Set(selected);
  return configs.filter((c) => selectedSet.has(c.name));
}
