import { select, confirm, input, checkbox, Separator } from '@inquirer/prompts';
import { PLATFORM_OPTIONS, type PlatformOption } from '../core/platform.js';

export async function selectOption<T extends string>(
  message: string,
  choices: { name: string; value: T; description?: string }[]
): Promise<T> {
  return select({ message, choices });
}

export async function confirmAction(
  message: string,
  defaultValue = false
): Promise<boolean> {
  return confirm({ message, default: defaultValue });
}

export async function inputText(
  message: string,
  defaultValue?: string,
  validate?: (value: string) => boolean | string
): Promise<string> {
  return input({ message, default: defaultValue, validate });
}

export async function selectFromList<T>(
  message: string,
  items: T[],
  display: (item: T) => string
): Promise<T> {
  const choices = items.map((item, i) => ({
    name: display(item),
    value: i,
  }));
  const index = await select({ message, choices });
  return items[index];
}

// ============ 平台选择 ============

/**
 * 交互式选择平台
 * @param remembered 上次选择的平台 values，用于默认勾选
 * @returns 选中的平台 value 列表 (如 ['macOS', 'iOS', 'macOS-asan'])
 */
export async function selectPlatforms(remembered?: string[]): Promise<string[]> {
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

  // 选择
  const selected = await checkbox<string>({
    message: '请选择需要的平台:',
    choices: choices as Parameters<typeof checkbox<string>>[0]['choices'],
    pageSize: 15,
  });

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
    const customInput = await input({
      message: '请输入自定义平台 (空格或逗号分隔):',
    });

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
 * @param keys CLI 参数 keys (如 ['mac', 'ios'])
 * @returns 平台 values (如 ['macOS', 'iOS'])
 */
export function parsePlatformArgs(keys: string[]): string[] {
  const result: string[] = [];

  for (const key of keys) {
    // 查找匹配的平台
    const platform = PLATFORM_OPTIONS.find((p) => p.key === key);
    if (platform) {
      result.push(platform.value);
    } else {
      // 不认识的 key 直接作为 value 使用 (自定义平台)
      result.push(key);
    }
  }

  return result;
}

// ============ 通用多选 ============

/**
 * 通用多选框
 * @param message 提示信息
 * @param choices 选项列表
 * @returns 选中的值列表
 */
export async function checkboxSelect<T extends string>(
  message: string,
  choices: { name: string; value: T; checked?: boolean }[]
): Promise<T[]> {
  return checkbox<T>({
    message,
    choices: choices.map((c) => ({
      name: c.name,
      value: c.value,
      checked: c.checked ?? false,
    })),
    pageSize: 20,
  });
}
