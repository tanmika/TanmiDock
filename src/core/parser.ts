/**
 * codepac-dep.json 解析器
 */
import fs from 'fs/promises';
import path from 'path';
import { resolvePath } from './platform.js';
import * as logger from '../utils/logger.js';
import type {
  CodepacDep,
  ParsedDependency,
  ActionConfig,
  ParsedAction,
  RepoConfig,
  CodepacPlatformGroups,
  RepoConfigSource,
  ActionExecutionPlan,
} from '../types/index.js';

/**
 * codepac 配置文件名
 */
const CONFIG_FILENAME = 'codepac-dep.json';

/**
 * 搜索配置文件的目录列表
 */
const SEARCH_DIRS = ['3rdparty', '.'];

/**
 * 可选配置文件信息
 */
export interface OptionalConfigInfo {
  /** 配置名称（从文件名提取，如 codepac-dep-inner.json -> inner） */
  name: string;
  /** 配置文件完整路径 */
  path: string;
}

/**
 * 配置文件发现结果
 */
export interface ConfigDiscoveryResult {
  /** 主配置文件路径 */
  mainConfig: string;
  /** 可选配置文件列表（不含主配置），按名称排序 */
  optionalConfigs: OptionalConfigInfo[];
}

/**
 * 依赖和 action 提取选项
 */
export interface CodepacExtractOptions {
  /** codepac 平台 key，例如 mac、ios、android */
  platforms?: string[];
  /** 日志中展示的配置来源 */
  configPath?: string;
}

export interface BuildActionExecutionPlanOptions {
  /** action 所在配置文件路径 */
  parentConfigPath: string;
  /** 父级目标目录，targetdir 相对该目录解析 */
  parentTargetDir: string;
  /** 父级传入的 codepac 平台 key */
  inheritedCodepacPlatforms?: string[];
}

interface PlatformFilterResult<T> {
  items: T[];
  matchedPlatforms: string[];
}

/**
 * 查找 codepac 配置文件
 * @param projectPath 项目路径
 * @returns 配置文件路径，不存在返回 null
 */
export async function findCodepacConfig(projectPath: string): Promise<string | null> {
  for (const dir of SEARCH_DIRS) {
    const configPath = path.join(projectPath, dir, CONFIG_FILENAME);
    try {
      await fs.access(configPath);
      return configPath;
    } catch {
      // 继续搜索
    }
  }
  return null;
}

/**
 * 规范化项目根目录
 * 确保项目始终登记在包含 3rdparty 的目录，而非 3rdparty 目录本身
 * @param inputPath 用户输入的项目路径
 * @param configPath 找到的配置文件路径
 * @returns 规范化后的项目根目录
 */
export function normalizeProjectRoot(inputPath: string, configPath: string): string {
  const configDir = path.dirname(configPath);

  // 如果配置文件在 3rdparty 目录下，项目根目录应该是其父目录
  if (path.basename(configDir) === '3rdparty') {
    return path.dirname(configDir);
  }
  return inputPath;
}

/**
 * 解析并规范化项目路径
 * 当输入路径是 3rdparty 目录时，统一返回项目根目录
 */
export async function resolveProjectRootPath(projectPath: string): Promise<{
  absolutePath: string;
  normalizedPath: string;
  configPath: string | null;
}> {
  const absolutePath = resolvePath(projectPath);
  const configPath = await findCodepacConfig(absolutePath);
  const normalizedPath = configPath
    ? normalizeProjectRoot(absolutePath, configPath)
    : absolutePath;

  return {
    absolutePath,
    normalizedPath,
    configPath,
  };
}

/**
 * 解析 codepac-dep.json 配置文件
 * @param configPath 配置文件路径
 * @returns 解析后的配置对象
 * @throws 文件不存在或格式错误时抛出异常
 */
export async function parseCodepacDep(configPath: string): Promise<CodepacDep> {
  let content: string;

  try {
    content = await fs.readFile(configPath, 'utf-8');
  } catch (_err) {
    throw new Error(`无法读取配置文件: ${configPath}`);
  }

  let config: unknown;
  try {
    config = JSON.parse(content);
  } catch {
    throw new Error(`配置文件格式错误 (JSON 解析失败): ${configPath}`);
  }

  // 验证配置结构
  validateCodepacDep(config, configPath);

  return config as CodepacDep;
}

/**
 * 验证 codepac-dep.json 配置结构
 */
function validateCodepacDep(config: unknown, configPath: string): asserts config is CodepacDep {
  if (!config || typeof config !== 'object') {
    throw new Error(`配置文件格式错误: 期望对象类型 (${configPath})`);
  }

  const obj = config as Record<string, unknown>;

  // 验证 version
  if (typeof obj.version !== 'string') {
    throw new Error(`配置文件格式错误: 缺少 version 字段 (${configPath})`);
  }

  // 验证 repos
  if (!obj.repos || typeof obj.repos !== 'object') {
    throw new Error(`配置文件格式错误: 缺少 repos 字段 (${configPath})`);
  }

  validateRepoGroups(obj.repos as Record<string, unknown>, configPath);

  if (obj.actions !== undefined) {
    if (!obj.actions || typeof obj.actions !== 'object' || Array.isArray(obj.actions)) {
      throw new Error(`配置文件格式错误: actions 必须是对象 (${configPath})`);
    }
    validateActionGroups(obj.actions as Record<string, unknown>, configPath);
  }
}

/**
 * 从配置中提取依赖列表
 * @param config 配置对象
 * @param options 平台筛选选项
 * @returns 依赖列表
 */
export function extractDependencies(
  config: CodepacDep,
  options: CodepacExtractOptions = {}
): ParsedDependency[] {
  const result = filterByPlatform(config.repos, options.platforms);
  const dependencies = result.items.map((repo) =>
    normalizeRepoConfig(repo, config.vars, options.configPath)
  );
  assertUniqueDependencies(dependencies, options.configPath);
  logger.debug(
    `CodePac 配置解析: repos 配置=${formatConfigPathForLog(options.configPath)}, 请求平台=${formatPlatformsForLog(options.platforms)}, 命中分组=${formatPlatformsForLog(result.matchedPlatforms)}, 输出依赖=${dependencies.length}`
  );
  return dependencies;
}

/**
 * 从配置中提取 actions 列表
 * @param config 配置对象
 * @param options 平台筛选选项
 * @returns actions 列表，如果没有则返回空数组
 */
export function extractActions(
  config: CodepacDep,
  options: CodepacExtractOptions = {}
): ActionConfig[] {
  const result = filterByPlatform(config.actions, options.platforms);
  const actions = result.items.map((action) => ({
    ...action,
    command: interpolateCodepacVars(action.command, config.vars),
    dir: action.dir ? interpolateCodepacVars(action.dir, config.vars) : action.dir,
    name: action.name ? interpolateCodepacVars(action.name, config.vars) : action.name,
  }));
  logger.debug(
    `CodePac 配置解析: actions 配置=${formatConfigPathForLog(options.configPath)}, 请求平台=${formatPlatformsForLog(options.platforms)}, 命中分组=${formatPlatformsForLog(result.matchedPlatforms)}, 输出动作=${actions.length}`
  );
  return actions;
}

function validateRepoGroups(repos: Record<string, unknown>, configPath: string): void {
  for (const [platform, items] of Object.entries(repos)) {
    if (!Array.isArray(items)) {
      throw new Error(`配置文件格式错误: repos.${platform} 必须是数组 (${configPath})`);
    }

    items.forEach((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`配置文件格式错误: repos.${platform}[${index}] 必须是对象 (${configPath})`);
      }

      const repo = item as Record<string, unknown>;
      const required = ['url', 'commit', 'branch', 'dir'];
      for (const field of required) {
        if (typeof repo[field] !== 'string') {
          throw new Error(
            `配置文件格式错误: repos.${platform}[${index}].${field} 必须是字符串 (${configPath})`
          );
        }
      }

      if (repo.name !== undefined && typeof repo.name !== 'string') {
        throw new Error(
          `配置文件格式错误: repos.${platform}[${index}].name 必须是字符串 (${configPath})`
        );
      }
      if (repo.source !== undefined && (!repo.source || typeof repo.source !== 'object' || Array.isArray(repo.source))) {
        throw new Error(
          `配置文件格式错误: repos.${platform}[${index}].source 必须是对象 (${configPath})`
        );
      }
    });
  }
}

function validateActionGroups(actions: Record<string, unknown>, configPath: string): void {
  for (const [platform, items] of Object.entries(actions)) {
    if (!Array.isArray(items)) {
      throw new Error(`配置文件格式错误: actions.${platform} 必须是数组 (${configPath})`);
    }

    items.forEach((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`配置文件格式错误: actions.${platform}[${index}] 必须是对象 (${configPath})`);
      }

      const action = item as Record<string, unknown>;
      if (typeof action.command !== 'string') {
        throw new Error(
          `配置文件格式错误: actions.${platform}[${index}].command 必须是字符串 (${configPath})`
        );
      }
      if (action.dir !== undefined && typeof action.dir !== 'string') {
        throw new Error(
          `配置文件格式错误: actions.${platform}[${index}].dir 必须是字符串 (${configPath})`
        );
      }
      if (action.name !== undefined && typeof action.name !== 'string') {
        throw new Error(
          `配置文件格式错误: actions.${platform}[${index}].name 必须是字符串 (${configPath})`
        );
      }
    });
  }
}

function filterByPlatform<T>(
  groups: CodepacPlatformGroups<T> | undefined,
  platforms?: string[]
): PlatformFilterResult<T> {
  if (!groups) return { items: [], matchedPlatforms: [] };

  const requestedPlatforms = platforms ?? [];
  const includeEveryPlatform = requestedPlatforms.includes('all');
  const selected: T[] = [];
  const matchedPlatforms: string[] = [];

  for (const [platform, items] of Object.entries(groups)) {
    if (!Array.isArray(items)) continue;

    if (
      requestedPlatforms.length === 0 ||
      platform === 'common' ||
      platform === 'all' ||
      includeEveryPlatform ||
      requestedPlatforms.includes(platform)
    ) {
      selected.push(...cloneConfigItems(items));
      matchedPlatforms.push(platform);
    }
  }

  return { items: selected, matchedPlatforms };
}

function cloneConfigItems<T>(items: T[]): T[] {
  return items.map((item) => JSON.parse(JSON.stringify(item)) as T);
}

function normalizeRepoConfig(
  repo: RepoConfig,
  vars?: Record<string, string>,
  configPath?: string
): ParsedDependency {
  const url = interpolateCodepacVars(repo.url, vars);
  const commit = interpolateCodepacVars(repo.commit, vars);
  const branch = interpolateCodepacVars(repo.branch, vars);
  const dir = interpolateCodepacVars(repo.dir, vars);
  const source = normalizeRepoSource(repo, { url, commit, branch, dir }, vars, configPath);
  const name = repo.name
    ? interpolateCodepacVars(repo.name, vars)
    : source.dir || dir;

  return {
    libName: name,
    name,
    dir,
    commit,
    branch,
    url,
    source: {
      ...source,
      name: source.name ? interpolateCodepacVars(source.name, vars) : name,
    },
    sparse: interpolateSparse(repo.sparse, vars, configPath),
  };
}

function normalizeRepoSource(
  repo: RepoConfig,
  resolved: Pick<ParsedDependency, 'url' | 'commit' | 'branch' | 'dir'>,
  vars?: Record<string, string>,
  configPath?: string
): RepoConfigSource {
  if (!repo.source) {
    return {
      url: resolved.url,
      commit: resolved.commit,
      branch: resolved.branch,
      dir: resolved.dir,
      name: repo.name ? interpolateCodepacVars(repo.name, vars) : resolved.dir,
      sparse: interpolateSparse(repo.sparse, vars, configPath),
    };
  }

  return {
    ...repo.source,
    url: repo.source.url ? interpolateCodepacVars(repo.source.url, vars) : repo.source.url,
    commit: repo.source.commit ? interpolateCodepacVars(repo.source.commit, vars) : repo.source.commit,
    branch: repo.source.branch ? interpolateCodepacVars(repo.source.branch, vars) : repo.source.branch,
    dir: interpolateCodepacVars(repo.source.dir, vars),
    name: repo.source.name ? interpolateCodepacVars(repo.source.name, vars) : repo.source.name,
    sparse: interpolateSparse(repo.source.sparse, vars, configPath),
  };
}

function interpolateSparse(
  sparse: object | string | undefined,
  vars?: Record<string, string>,
  configPath?: string
): object | undefined {
  if (typeof sparse === 'string') {
    const resolved = interpolateCodepacVars(sparse, vars);
    try {
      const parsed = JSON.parse(resolved);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('sparse 必须解析为对象');
      }
      return parsed as object;
    } catch (err) {
      const source = configPath ? ` (${configPath})` : '';
      throw new Error(
        `配置文件格式错误: sparse 字符串必须是可解析的 JSON 对象${source}: ${(err as Error).message}`
      );
    }
  }
  return sparse;
}

function interpolateCodepacVars(text: string, vars?: Record<string, string>): string {
  if (!vars) return text;

  return text.replace(/\$\{([^}]+)\}/g, (_match, key: string) => vars[key] ?? `\${${key}}`);
}

function assertUniqueDependencies(dependencies: ParsedDependency[], configPath?: string): void {
  const names = new Set<string>();
  const dirs = new Set<string>();
  const duplicateNames = new Set<string>();
  const duplicateDirs = new Set<string>();

  for (const dependency of dependencies) {
    if (names.has(dependency.name)) {
      duplicateNames.add(dependency.name);
    } else {
      names.add(dependency.name);
    }

    if (dirs.has(dependency.dir)) {
      duplicateDirs.add(dependency.dir);
    } else {
      dirs.add(dependency.dir);
    }
  }

  if (duplicateNames.size > 0 || duplicateDirs.size > 0) {
    const source = configPath ? ` (${configPath})` : '';
    const parts: string[] = [];
    if (duplicateDirs.size > 0) parts.push(`重复 dir: ${Array.from(duplicateDirs).join(', ')}`);
    if (duplicateNames.size > 0) parts.push(`重复 name: ${Array.from(duplicateNames).join(', ')}`);
    throw new Error(`配置文件格式错误: ${parts.join('；')}${source}`);
  }
}

function formatPlatformsForLog(platforms?: string[]): string {
  return platforms && platforms.length > 0 ? platforms.join(',') : 'common';
}

function formatConfigPathForLog(configPath?: string): string {
  return configPath ?? 'unknown';
}

/**
 * 解析 action 命令字符串
 * 支持两种格式:
 * - 新格式: codepac install lib1 lib2 --configdir xxx --targetdir . [--disable_action]
 * - 旧格式: codepac install --configdir xxx (targetdir 默认为 configdir，libraries 从配置文件读取)
 * @param command 命令字符串
 * @returns 解析后的 action 对象
 */
export function parseActionCommand(command: string): ParsedAction {
  const tokens = tokenizeActionCommand(command);

  // 检查是否以 codepac install 开头
  if (tokens[0] !== 'codepac' || tokens[1] !== 'install') {
    throw new Error(`无法解析 action 命令，期望 'codepac install' 开头: ${command}`);
  }

  const libraries: string[] = [];
  let configDir: string | undefined;
  let targetDir: string | undefined;
  let disableAction = false;
  let hasExplicitPlatform = false;
  const platforms: string[] = [];
  let hasExplicitFullGit = false;
  let hasExplicitUnshallow = false;
  let hasExplicitDisableSparse = false;

  for (let index = 2; index < tokens.length; index++) {
    const token = tokens[index];

    if (token === '--disable_action' || token === '-dc') {
      disableAction = true;
      continue;
    }

    if (token === '--platform' || token === '-p') {
      hasExplicitPlatform = true;
      const { values, nextIndex } = readActionVariadicOptionValues(tokens, index, token, command);
      platforms.push(...values);
      index = nextIndex;
      continue;
    }

    if (token === '--fullgit' || token === '-fg') {
      hasExplicitFullGit = true;
      continue;
    }

    if (token === '--unshallow' || token === '-us') {
      hasExplicitUnshallow = true;
      continue;
    }

    if (token === '--disable_sparse' || token === '-ds') {
      hasExplicitDisableSparse = true;
      continue;
    }

    if (token === '--configdir' || token === '-cd') {
      configDir = readActionOptionValue(tokens, index, token, command);
      index++;
      continue;
    }

    if (token === '--targetdir' || token === '-td') {
      targetDir = readActionOptionValue(tokens, index, token, command);
      index++;
      continue;
    }

    if (token.startsWith('--') || token.startsWith('-')) {
      const next = tokens[index + 1];
      if (next && !next.startsWith('-')) {
        index++;
      }
      continue;
    }

    libraries.push(token);
  }

  if (!configDir) {
    throw new Error(`无法解析 action 命令，缺少 --configdir 参数: ${command}`);
  }

  // 旧格式兼容：如果没有指定库名，libraries 为空数组
  // 调用方需要从 configDir 中读取 codepac-dep.json 来获取所有库
  return {
    libraries,
    configDir,
    targetDir: targetDir ?? configDir,
    disableAction,
    hasExplicitPlatform,
    platforms,
    hasExplicitFullGit,
    hasExplicitUnshallow,
    hasExplicitDisableSparse,
  };
}

function readActionOptionValue(tokens: string[], index: number, option: string, command: string): string {
  const value = tokens[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`无法解析 action 命令，${option} 缺少参数值: ${command}`);
  }
  return value;
}

function readActionVariadicOptionValues(
  tokens: string[],
  index: number,
  option: string,
  command: string
): { values: string[]; nextIndex: number } {
  const values: string[] = [];
  let nextIndex = index;

  for (let valueIndex = index + 1; valueIndex < tokens.length; valueIndex++) {
    const value = tokens[valueIndex];
    if (!value || value.startsWith('-')) break;
    values.push(value);
    nextIndex = valueIndex;
  }

  if (values.length === 0) {
    throw new Error(`无法解析 action 命令，${option} 缺少参数值: ${command}`);
  }

  return { values, nextIndex };
}

function tokenizeActionCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * 生成 action 递归执行计划
 * configdir 相对父配置目录解析，targetdir 相对父目标目录解析。
 */
export function buildActionExecutionPlan(
  action: ActionConfig,
  options: BuildActionExecutionPlanOptions
): ActionExecutionPlan {
  const parsed = parseActionCommand(action.command);
  const parentConfigDir = path.dirname(options.parentConfigPath);
  const inheritedPlatforms = options.inheritedCodepacPlatforms ?? [];
  const effectiveCodepacPlatforms = parsed.hasExplicitPlatform
    ? [...new Set(parsed.platforms)]
    : inheritedPlatforms;
  const nestedConfigDir = path.resolve(parentConfigDir, parsed.configDir);
  const nestedTargetDir = path.resolve(options.parentTargetDir, parsed.targetDir);

  return {
    actionName: action.name,
    command: action.command,
    parsed,
    configDir: parsed.configDir,
    targetDir: parsed.targetDir,
    nestedConfigPath: path.join(nestedConfigDir, CONFIG_FILENAME),
    nestedTargetDir,
    inheritedPlatforms,
    effectiveCodepacPlatforms,
    libraries: parsed.libraries,
  };
}

/**
 * 从嵌套配置中提取指定库的依赖
 * @param nestedConfigPath 嵌套配置文件路径
 * @param libraries 需要提取的库名列表
 * @returns 依赖列表、变量定义和嵌套 actions
 */
export async function extractNestedDependencies(
  nestedConfigPath: string,
  libraries: string[],
  options: CodepacExtractOptions = {}
): Promise<{
  dependencies: ParsedDependency[];
  vars?: Record<string, string>;
  nestedActions: ActionConfig[];
}> {
  const config = await parseCodepacDep(nestedConfigPath);

  // 提取库：如果指定了 libraries 则只提取指定的库，否则提取所有库（旧格式兼容）
  const allDependencies = extractDependencies(config, {
    ...options,
    configPath: options.configPath ?? nestedConfigPath,
  });
  const dependencies = allDependencies.filter((repo) => {
    return libraries.length === 0 || libraries.includes(repo.dir) || libraries.includes(repo.name);
  });

  // 提取嵌套的 actions（用于递归处理）
  const nestedActions = extractActions(config, {
    ...options,
    configPath: options.configPath ?? nestedConfigPath,
  });

  return {
    dependencies,
    vars: config.vars,
    nestedActions,
  };
}

/**
 * 解析项目依赖（便捷方法）
 * @param projectPath 项目路径
 * @returns 依赖列表、配置路径和变量定义
 * @throws 找不到配置文件或解析失败时抛出异常
 */
export async function parseProjectDependencies(
  projectPath: string,
  options: CodepacExtractOptions = {}
): Promise<{ dependencies: ParsedDependency[]; configPath: string; vars?: Record<string, string> }> {
  const configPath = await findCodepacConfig(projectPath);

  if (!configPath) {
    throw new Error(`找不到 codepac-dep.json 配置文件，已搜索: ${SEARCH_DIRS.join(', ')}`);
  }

  const config = await parseCodepacDep(configPath);
  const dependencies = extractDependencies(config, {
    ...options,
    configPath: options.configPath ?? configPath,
  });

  return { dependencies, configPath, vars: config.vars };
}

/**
 * 获取配置文件相对于项目的路径
 */
export function getRelativeConfigPath(projectPath: string, configPath: string): string {
  return path.relative(projectPath, configPath);
}

/**
 * 从文件名提取配置名称
 * 例如: codepac-dep-inner.json -> inner
 * @param filename 文件名
 * @returns 配置名称
 */
function extractConfigName(filename: string): string {
  // 移除前缀 "codepac-dep-" 和后缀 ".json"
  return filename.slice('codepac-dep-'.length, -'.json'.length);
}

/**
 * 发现项目下所有 codepac 配置文件
 * 扫描指定目录下的 codepac-dep.json 和 codepac-dep-*.json 文件
 * @param projectPath 项目路径（可以是项目根目录或 3rdparty 目录）
 * @returns 主配置和可选配置列表，无配置时返回 null
 */
export async function findAllCodepacConfigs(projectPath: string): Promise<ConfigDiscoveryResult | null> {
  // 确定搜索目录：如果传入的是项目根目录，则在 3rdparty 子目录中查找
  // 如果传入的已经是 3rdparty 目录，则直接在该目录查找
  let searchDir = projectPath;

  // 检查目录是否存在
  try {
    await fs.access(searchDir);
  } catch {
    // 目录不存在，返回 null
    return null;
  }

  // 读取目录内容
  let files: string[];
  try {
    files = await fs.readdir(searchDir);
  } catch (readdirErr) {
    // 目录存在但读取失败（权限问题等），记录警告
    logger.warn(`无法读取目录 ${searchDir}: ${(readdirErr as Error).message}`);
    return null;
  }

  // 检查主配置是否存在
  const mainConfigPath = path.join(searchDir, CONFIG_FILENAME);
  let mainExists = false;
  try {
    await fs.access(mainConfigPath);
    mainExists = true;
  } catch {
    // 主配置不存在
  }

  // 如果主配置不存在，返回 null
  if (!mainExists) {
    return null;
  }

  // 筛选可选配置文件：codepac-dep-*.json（排除主配置 codepac-dep.json）
  const optionalConfigs: OptionalConfigInfo[] = files
    .filter(file => {
      // 匹配 codepac-dep-*.json 模式，但不包括 codepac-dep.json
      return file.startsWith('codepac-dep-') && file.endsWith('.json');
    })
    .map(file => ({
      name: extractConfigName(file),
      path: path.join(searchDir, file),
    }))
    .filter(config => config.name.length > 0) // 过滤掉空名称（如 codepac-dep-.json）
    .sort((a, b) => a.name.localeCompare(b.name)); // 按名称排序

  return {
    mainConfig: mainConfigPath,
    optionalConfigs,
  };
}

export default {
  findCodepacConfig,
  normalizeProjectRoot,
  parseCodepacDep,
  extractDependencies,
  extractActions,
  parseActionCommand,
  buildActionExecutionPlan,
  extractNestedDependencies,
  parseProjectDependencies,
  getRelativeConfigPath,
  resolveProjectRootPath,
  findAllCodepacConfigs,
};
