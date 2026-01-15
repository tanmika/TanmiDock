/**
 * codepac-dep.json 解析器
 */
import fs from 'fs/promises';
import path from 'path';
import type { CodepacDep, ParsedDependency, ActionConfig, ParsedAction } from '../types/index.js';

/**
 * codepac 配置文件名
 */
const CONFIG_FILENAME = 'codepac-dep.json';

/**
 * 搜索配置文件的目录列表
 */
const SEARCH_DIRS = ['3rdparty', '.'];

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

  const repos = obj.repos as Record<string, unknown>;
  if (!Array.isArray(repos.common)) {
    throw new Error(`配置文件格式错误: repos.common 必须是数组 (${configPath})`);
  }

  // 验证每个 repo 配置
  for (let i = 0; i < repos.common.length; i++) {
    const repo = repos.common[i] as Record<string, unknown>;
    if (!repo || typeof repo !== 'object') {
      throw new Error(`配置文件格式错误: repos.common[${i}] 必须是对象 (${configPath})`);
    }

    const required = ['url', 'commit', 'branch', 'dir'];
    for (const field of required) {
      if (typeof repo[field] !== 'string') {
        throw new Error(
          `配置文件格式错误: repos.common[${i}].${field} 必须是字符串 (${configPath})`
        );
      }
    }
  }
}

/**
 * 从配置中提取依赖列表
 * @param config 配置对象
 * @returns 依赖列表
 */
export function extractDependencies(config: CodepacDep): ParsedDependency[] {
  return config.repos.common.map((repo) => ({
    libName: repo.dir,
    commit: repo.commit,
    branch: repo.branch,
    url: repo.url,
    sparse: repo.sparse,
  }));
}

/**
 * 从配置中提取 actions 列表
 * @param config 配置对象
 * @returns actions 列表，如果没有则返回空数组
 */
export function extractActions(config: CodepacDep): ActionConfig[] {
  return config.actions?.common ?? [];
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
  // 检查是否以 codepac install 开头
  if (!command.startsWith('codepac install ')) {
    throw new Error(`无法解析 action 命令，期望 'codepac install' 开头: ${command}`);
  }

  // 提取 --configdir 参数
  const configDirMatch = command.match(/--configdir\s+(\S+)/);
  if (!configDirMatch) {
    throw new Error(`无法解析 action 命令，缺少 --configdir 参数: ${command}`);
  }
  const configDir = configDirMatch[1];

  // 提取 --targetdir 参数（可选，默认为 configdir）
  const targetDirMatch = command.match(/--targetdir\s+(\S+)/);
  const targetDir = targetDirMatch ? targetDirMatch[1] : configDir;

  // 检查 --disable_action 标志
  const disableAction = command.includes('--disable_action');

  // 提取库名列表（在 'codepac install ' 后，--configdir 前的部分）
  const afterInstall = command.slice('codepac install '.length);
  const beforeConfigDir = afterInstall.split('--configdir')[0].trim();

  // 过滤掉任何以 -- 开头的参数
  const libraries = beforeConfigDir
    .split(/\s+/)
    .filter(lib => lib && !lib.startsWith('--'));

  // 旧格式兼容：如果没有指定库名，libraries 为空数组
  // 调用方需要从 configDir 中读取 codepac-dep.json 来获取所有库
  return {
    libraries,
    configDir,
    targetDir,
    disableAction,
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
  libraries: string[]
): Promise<{
  dependencies: ParsedDependency[];
  vars?: Record<string, string>;
  nestedActions: ActionConfig[];
}> {
  const config = await parseCodepacDep(nestedConfigPath);

  // 提取库：如果指定了 libraries 则只提取指定的库，否则提取所有库（旧格式兼容）
  const dependencies = config.repos.common
    .filter(repo => libraries.length === 0 || libraries.includes(repo.dir))
    .map(repo => ({
      libName: repo.dir,
      commit: repo.commit,
      branch: repo.branch,
      url: repo.url,
      sparse: repo.sparse,
    }));

  // 提取嵌套的 actions（用于递归处理）
  const nestedActions = extractActions(config);

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
  projectPath: string
): Promise<{ dependencies: ParsedDependency[]; configPath: string; vars?: Record<string, string> }> {
  const configPath = await findCodepacConfig(projectPath);

  if (!configPath) {
    throw new Error(`找不到 codepac-dep.json 配置文件，已搜索: ${SEARCH_DIRS.join(', ')}`);
  }

  const config = await parseCodepacDep(configPath);
  const dependencies = extractDependencies(config);

  return { dependencies, configPath, vars: config.vars };
}

/**
 * 获取配置文件相对于项目的路径
 */
export function getRelativeConfigPath(projectPath: string, configPath: string): string {
  return path.relative(projectPath, configPath);
}

export default {
  findCodepacConfig,
  parseCodepacDep,
  extractDependencies,
  extractActions,
  parseActionCommand,
  extractNestedDependencies,
  parseProjectDependencies,
  getRelativeConfigPath,
};
