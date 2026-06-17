import { Command } from 'commander';
import { ensureInitialized } from '../core/guard.js';
import { getBaseKeyForCodepac, KNOWN_PLATFORM_VALUES } from '../core/platform.js';
import { getRegistry } from '../core/registry.js';
import { resolveProjectRootPath } from '../core/parser.js';
import { collectProjectDependencyGraph } from './link.js';
import {
  PROMPT_CANCELLED,
  checkboxWithCancel,
  confirmWithCancel,
  searchSelectWithCancel,
} from '../utils/prompt.js';
import { blank, error, hint, info, success, title, warn } from '../utils/logger.js';

interface ManualRuleView {
  key: string;
  libName: string;
  commit?: string;
  platforms: string[];
}

function parseManualRuleKey(key: string): { libName: string; commit?: string } {
  const atIndex = key.lastIndexOf('@');
  if (atIndex === -1) {
    return { libName: key };
  }
  return {
    libName: key.slice(0, atIndex),
    commit: key.slice(atIndex + 1),
  };
}

async function resolveProjectRootOrThrow(): Promise<string> {
  const { normalizedPath, configPath } = await resolveProjectRootPath('.');
  if (!configPath) {
    throw new Error('`td unavailable` 只能在项目目录下使用');
  }
  return normalizedPath;
}

async function collectProjectDependencyChoices(projectRoot: string) {
  const registry = getRegistry();
  const projectInfo = registry.getProject(registry.hashPath(projectRoot));
  const codepacPlatforms = [
    ...new Set((projectInfo?.platforms ?? []).map((platform) => getBaseKeyForCodepac(platform))),
  ];
  const dependencies = await collectProjectDependencyGraph(projectRoot, codepacPlatforms);
  return dependencies
    .sort((a, b) => {
      const nameCompare = a.libName.localeCompare(b.libName);
      if (nameCompare !== 0) return nameCompare;
      return a.commit.localeCompare(b.commit);
    });
}

function collectRelevantRules(projectDependencies: Awaited<ReturnType<typeof collectProjectDependencyGraph>>) {
  const registry = getRegistry();
  const rules = registry.listManualUnavailableRules();
  const libNames = new Set(projectDependencies.map((dep) => dep.libName));
  const exactKeys = new Set(projectDependencies.map((dep) => `${dep.libName}@${dep.commit}`));

  return rules
    .filter((rule) => libNames.has(rule.key) || exactKeys.has(rule.key))
    .map((rule) => {
      const parsed = parseManualRuleKey(rule.key);
      return {
        key: rule.key,
        libName: parsed.libName,
        commit: parsed.commit,
        platforms: rule.platforms,
      } satisfies ManualRuleView;
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

export async function addUnavailableInteractive(): Promise<void> {
  await ensureInitialized();
  const projectRoot = await resolveProjectRootOrThrow();
  const registry = getRegistry();
  await registry.load();

  const dependencies = await collectProjectDependencyChoices(projectRoot);
  if (dependencies.length === 0) {
    warn('当前项目未解析到任何依赖');
    return;
  }

  const selectedDependency = await searchSelectWithCancel({
    message: '选择要屏蔽平台缺失的库:',
    choices: dependencies.map((dependency) => ({
      name: `${dependency.libName} @ ${dependency.commit.slice(0, 8)}`,
      value: dependency,
      description: dependency.scope
        ? `${dependency.source} · ${dependency.scope}`
        : dependency.source,
      searchText: `${dependency.libName} ${dependency.commit} ${dependency.scope ?? ''}`,
    })),
    pageSize: 12,
  });

  if (selectedDependency === PROMPT_CANCELLED) {
    info('已取消');
    return;
  }

  const selectedPlatforms = await checkboxWithCancel<string>({
    message: '选择要屏蔽的平台:',
    choices: KNOWN_PLATFORM_VALUES.map((platform) => ({
      name: platform,
      value: platform,
      checked: false,
    })),
    pageSize: 12,
    required: true,
  });

  if (selectedPlatforms === PROMPT_CANCELLED) {
    info('已取消');
    return;
  }

  if (selectedPlatforms.length === 0) {
    warn('至少需要选择一个平台');
    return;
  }

  const applyToAllCommits = await confirmWithCancel({
    message: `是否对 ${selectedDependency.libName} 的所有 commit 生效?`,
    default: false,
  });

  if (applyToAllCommits === PROMPT_CANCELLED) {
    info('已取消');
    return;
  }

  registry.addManualUnavailablePlatforms(
    selectedDependency.libName,
    selectedPlatforms,
    applyToAllCommits ? undefined : selectedDependency.commit
  );
  await registry.save();

  success(
    `已登记平台缺失: ${selectedDependency.libName}` +
    `${applyToAllCommits ? '' : `@${selectedDependency.commit.slice(0, 8)}`}` +
    ` -> [${selectedPlatforms.join(', ')}]`
  );
}

export async function removeUnavailableInteractive(): Promise<void> {
  await ensureInitialized();
  const projectRoot = await resolveProjectRootOrThrow();
  const registry = getRegistry();
  await registry.load();

  const dependencies = await collectProjectDependencyChoices(projectRoot);
  const rules = collectRelevantRules(dependencies);

  if (rules.length === 0) {
    warn('当前项目没有已登记的平台缺失规则');
    return;
  }

  const selectedRule = await searchSelectWithCancel({
    message: '选择要移除的规则:',
    choices: rules.map((rule) => ({
      name: rule.commit ? `${rule.libName} @ ${rule.commit.slice(0, 8)}` : `${rule.libName} (所有 commit)`,
      value: rule,
      description: `平台: ${rule.platforms.join(', ')}`,
      searchText: `${rule.libName} ${rule.commit ?? ''} ${rule.platforms.join(' ')}`,
    })),
    pageSize: 12,
  });

  if (selectedRule === PROMPT_CANCELLED) {
    info('已取消');
    return;
  }

  const selectedPlatforms = await checkboxWithCancel<string>({
    message: '选择要移除的平台:',
    choices: selectedRule.platforms.map((platform) => ({
      name: platform,
      value: platform,
      checked: true,
    })),
    pageSize: 10,
    required: true,
  });

  if (selectedPlatforms === PROMPT_CANCELLED) {
    info('已取消');
    return;
  }

  if (selectedPlatforms.length === 0) {
    warn('至少需要选择一个平台');
    return;
  }

  registry.removeManualUnavailablePlatforms(
    selectedRule.libName,
    selectedPlatforms,
    selectedRule.commit
  );
  await registry.save();

  success(
    `已移除规则: ${selectedRule.libName}` +
    `${selectedRule.commit ? `@${selectedRule.commit.slice(0, 8)}` : ''}` +
    ` -> [${selectedPlatforms.join(', ')}]`
  );
}

export async function listUnavailableRules(): Promise<void> {
  await ensureInitialized();
  const projectRoot = await resolveProjectRootOrThrow();
  const registry = getRegistry();
  await registry.load();

  const dependencies = await collectProjectDependencyChoices(projectRoot);
  const rules = collectRelevantRules(dependencies);

  title('平台缺失规则');
  if (rules.length === 0) {
    info('当前项目没有命中的手动规则');
    return;
  }

  for (const rule of rules) {
    info(
      `${rule.commit ? `${rule.libName}@${rule.commit.slice(0, 8)}` : `${rule.libName} (所有 commit)`}` +
      `: ${rule.platforms.join(', ')}`
    );
  }
}

export function createUnavailableCommand(): Command {
  const command = new Command('unavailable')
    .description('管理平台缺失规则');

  command
    .command('add')
    .description('交互式添加平台缺失规则')
    .action(async () => {
      await addUnavailableInteractive();
    });

  command
    .command('remove')
    .description('交互式移除平台缺失规则')
    .action(async () => {
      await removeUnavailableInteractive();
    });

  command
    .command('list')
    .description('查看当前项目命中的平台缺失规则')
    .action(async () => {
      await listUnavailableRules();
    });

  return command;
}

export default createUnavailableCommand;
