/**
 * reset 命令 - 重置错误的库缓存与元数据
 */
import fs from 'fs/promises';
import path from 'path';
import { Command } from 'commander';
import { ensureInitialized } from '../core/guard.js';
import { getRegistry } from '../core/registry.js';
import { getStorePath } from '../core/config.js';
import { findCodepacConfig, parseCodepacDep, extractDependencies, extractActions, buildActionExecutionPlan, extractNestedDependencies, resolveProjectRootPath } from '../core/parser.js';
import { getBaseKeyForCodepac, shrinkHome } from '../core/platform.js';
import { isSymlink } from '../core/linker.js';
import { withGlobalLock } from '../utils/global-lock.js';
import { findSubmoduleConfigs } from '../utils/git.js';
import { confirmAction, PROMPT_CANCELLED } from '../utils/prompt.js';
import { info, warn, success, error, hint, blank, separator } from '../utils/logger.js';
import type { ProjectInfo } from '../types/index.js';

interface ResetOptions {
  global?: boolean;
  yes?: boolean;
}

interface ResetTarget {
  libName: string;
  commit: string;
}

interface ProjectMatch {
  projectHash: string;
  project: ProjectInfo;
  matchedDeps: ProjectInfo['dependencies'];
}

export function createResetCommand(): Command {
  return new Command('reset')
    .description('重置指定库的缓存与元数据，便于重新干净拉取')
    .argument('<lib>', '库名')
    .argument('[commit]', '指定 commit')
    .option('-g, --global', '重置该库所有 commit')
    .option('-y, --yes', '跳过确认提示')
    .addHelpText(
      'after',
      `
示例:
  td reset librocksdb
  td reset librocksdb 174b25b12221de748fbb96c6aca6db6584fd482e
  td reset librocksdb -g

说明:
  td reset <lib>       仅可在项目目录下使用，重置当前项目命中的该库 commit
  td reset <lib> <commit>  全局重置该库指定 commit
  td reset <lib> -g    全局重置该库所有 commit`
    )
    .action(async (libName: string, commit: string | undefined, options: ResetOptions) => {
      await ensureInitialized();
      try {
        await withGlobalLock(() => resetLibrary(libName, commit, options, process.cwd()));
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}

export async function resetLibrary(
  libName: string,
  commit: string | undefined,
  options: ResetOptions,
  currentPath: string
): Promise<void> {
  if (options.global && commit) {
    throw new Error('`-g` 与 `<commit>` 不能同时使用');
  }

  const registry = getRegistry();
  await registry.load();

  let projectRoot: string | null = null;
  let targets: ResetTarget[] = [];

  if (options.global) {
    targets = collectGlobalTargets(registry, libName);
  } else if (commit) {
    targets = [{ libName, commit }];
  } else {
    projectRoot = await resolveCurrentProjectRoot(currentPath);
    targets = await collectProjectTargets(registry, projectRoot, libName);
  }

  targets = dedupeTargets(targets);
  if (targets.length === 0) {
    throw new Error(`未找到需要重置的库: ${libName}`);
  }

  const projectMatches = collectProjectMatches(registry, targets);
  const affectedProjects = [...new Map(projectMatches.map((match) => [match.projectHash, match])).values()];

  renderResetSummary(projectRoot, targets, affectedProjects);

  const shouldProceed = await confirmReset(affectedProjects, options.yes ?? false);
  if (!shouldProceed) {
    info('已取消 reset');
    return;
  }

  const storePath = await getStorePath();
  if (!storePath) {
    throw new Error('Store 路径未配置，请先运行 tanmi-dock init');
  }

  await cleanupProjectLinks(affectedProjects);
  removeProjectDependencyMetadata(registry, targets, affectedProjects);
  await removeStoreAndRegistryData(registry, storePath, targets);
  await registry.save();

  blank();
  separator();
  success(`完成: 已重置 ${targets.length} 个 commit`);
}

function collectGlobalTargets(registry: ReturnType<typeof getRegistry>, libName: string): ResetTarget[] {
  const targets: ResetTarget[] = [];
  const seen = new Set<string>();

  for (const lib of registry.listLibraries()) {
    if (lib.libName !== libName) continue;
    const key = `${lib.libName}:${lib.commit}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push({ libName: lib.libName, commit: lib.commit });
    }
  }

  for (const store of registry.listStores()) {
    if (store.libName !== libName) continue;
    const key = `${store.libName}:${store.commit}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push({ libName: store.libName, commit: store.commit });
    }
  }

  return targets;
}

async function resolveCurrentProjectRoot(inputPath: string): Promise<string> {
  const { normalizedPath, configPath } = await resolveProjectRootPath(inputPath);
  if (!configPath) {
    throw new Error('`td reset <lib>` 只能在项目目录下使用');
  }
  return normalizedPath;
}

async function collectProjectTargets(
  registry: ReturnType<typeof getRegistry>,
  projectRoot: string,
  libName: string
): Promise<ResetTarget[]> {
  const projectHash = registry.hashPath(projectRoot);
  const project = registry.getProject(projectHash);
  if (project) {
    const registryTargets = project.dependencies
      .filter((dep) => dep.libName === libName)
      .map((dep) => ({ libName: dep.libName, commit: dep.commit }));
    if (registryTargets.length > 0) {
      return registryTargets;
    }
    return collectTargetsFromConfigs(projectRoot, libName, project.platforms ?? []);
  }

  return collectTargetsFromConfigs(projectRoot, libName);
}

async function collectTargetsFromConfigs(
  projectRoot: string,
  libName: string,
  platforms: string[] = []
): Promise<ResetTarget[]> {
  const configPath = await findCodepacConfig(projectRoot);
  if (!configPath) return [];
  const codepacPlatforms = [...new Set(platforms.map((platform) => getBaseKeyForCodepac(platform)))];

  const targets: ResetTarget[] = [];
  const visited = new Set<string>();
  const queue: Array<{ configPath: string; targetDir: string; codepacPlatforms: string[] }> = [
    { configPath, targetDir: path.dirname(configPath), codepacPlatforms },
  ];

  const submodules = await findSubmoduleConfigs(projectRoot, '', 0, codepacPlatforms);
  for (const submodule of submodules) {
    queue.push({
      configPath: submodule.configPath,
      targetDir: path.dirname(submodule.configPath),
      codepacPlatforms,
    });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentConfig = current.configPath;
    const visitKey = buildResetActionVisitKey(currentConfig, current.targetDir);
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    let parsed;
    try {
      parsed = await parseCodepacDep(currentConfig);
    } catch {
      continue;
    }

    const extractOptions = { platforms: current.codepacPlatforms, configPath: currentConfig };

    for (const dep of extractDependencies(parsed, extractOptions)) {
      if (dep.libName === libName) {
        targets.push({ libName: dep.libName, commit: dep.commit });
      }
    }

    for (const action of extractActions(parsed, extractOptions)) {
      let plan;
      try {
        plan = buildActionExecutionPlan(action, {
          parentConfigPath: currentConfig,
          parentTargetDir: current.targetDir,
          inheritedCodepacPlatforms: current.codepacPlatforms,
        });
      } catch {
        continue;
      }
      try {
        const nested = await extractNestedDependencies(plan.nestedConfigPath, plan.libraries, {
          platforms: plan.effectiveCodepacPlatforms,
          configPath: plan.nestedConfigPath,
        });
        for (const dep of nested.dependencies) {
          if (dep.libName === libName) {
            targets.push({ libName: dep.libName, commit: dep.commit });
          }
        }
        if (!plan.parsed.disableAction) {
          queue.push({
            configPath: plan.nestedConfigPath,
            targetDir: plan.nestedTargetDir,
            codepacPlatforms: plan.effectiveCodepacPlatforms,
          });
        }
      } catch {
        continue;
      }
    }
  }

  return targets;
}

function buildResetActionVisitKey(configPath: string, targetDir: string): string {
  return `${configPath}::${targetDir}`;
}

function dedupeTargets(targets: ResetTarget[]): ResetTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.libName}:${target.commit}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectProjectMatches(
  registry: ReturnType<typeof getRegistry>,
  targets: ResetTarget[]
): ProjectMatch[] {
  const targetSet = new Set(targets.map((target) => `${target.libName}:${target.commit}`));
  const matches: ProjectMatch[] = [];

  for (const [projectHash, project] of Object.entries(registry.getRaw().projects)) {
    const matchedDeps = project.dependencies.filter((dep) =>
      targetSet.has(`${dep.libName}:${dep.commit}`)
    );
    if (matchedDeps.length > 0) {
      matches.push({ projectHash, project, matchedDeps });
    }
  }

  return matches;
}

function renderResetSummary(
  projectRoot: string | null,
  targets: ResetTarget[],
  projectMatches: ProjectMatch[]
): void {
  if (projectRoot) {
    info(`项目范围重置: ${shrinkHome(projectRoot)}`);
  } else {
    info('全局范围重置');
  }
  info(`目标 commit: ${targets.map((target) => `${target.libName}@${target.commit.slice(0, 8)}`).join(', ')}`);

  if (projectMatches.length > 0) {
    blank();
    info('受影响项目:');
    for (const match of projectMatches) {
      const deps = match.matchedDeps.map((dep) => `${dep.libName}@${dep.commit.slice(0, 8)}`).join(', ');
      info(`  - ${shrinkHome(match.project.path)} -> ${deps}`);
    }
  }
}

async function confirmReset(projectMatches: ProjectMatch[], autoYes: boolean): Promise<boolean> {
  if (autoYes) return true;

  let message = `确认重置 ${projectMatches.length} 个项目引用涉及的缓存与元数据?`;
  if (projectMatches.length === 0) {
    message = '确认重置目标缓存与元数据?';
  }

  const confirmed = await confirmAction(message, false);
  if (confirmed === PROMPT_CANCELLED) return false;
  return confirmed;
}

async function cleanupProjectLinks(projectMatches: ProjectMatch[]): Promise<void> {
  const visitedPaths = new Set<string>();

  for (const match of projectMatches) {
    for (const dep of match.matchedDeps) {
      const localPath = path.join(match.project.path, dep.linkedPath);
      if (visitedPaths.has(localPath)) continue;
      visitedPaths.add(localPath);

      try {
        if (await isSymlink(localPath)) {
          await fs.unlink(localPath);
          info(`清理项目链接: ${shrinkHome(localPath)}`);
        }
      } catch (err) {
        warn(`清理项目链接失败: ${shrinkHome(localPath)} - ${(err as Error).message}`);
      }
    }
  }
}

function removeProjectDependencyMetadata(
  registry: ReturnType<typeof getRegistry>,
  targets: ResetTarget[],
  projectMatches: ProjectMatch[]
): void {
  const targetSet = new Set(targets.map((target) => `${target.libName}:${target.commit}`));

  for (const match of projectMatches) {
    const remaining = match.project.dependencies.filter(
      (dep) => !targetSet.has(`${dep.libName}:${dep.commit}`)
    );
    registry.updateProject(match.projectHash, { dependencies: remaining });
  }
}

async function removeStoreAndRegistryData(
  registry: ReturnType<typeof getRegistry>,
  storePath: string,
  targets: ResetTarget[]
): Promise<void> {
  for (const target of targets) {
    const storeKeys = registry.getLibraryStoreKeys(target.libName, target.commit);
    for (const storeKey of storeKeys) {
      registry.removeStore(storeKey);
    }

    const libKey = registry.getLibraryKey(target.libName, target.commit);
    registry.removeLibrary(libKey);

    const commitPath = path.join(storePath, target.libName, target.commit);
    await fs.rm(commitPath, { recursive: true, force: true }).catch(() => {});

    const libPath = path.join(storePath, target.libName);
    try {
      const entries = await fs.readdir(libPath);
      if (entries.length === 0) {
        await fs.rm(libPath, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}

export default createResetCommand;
