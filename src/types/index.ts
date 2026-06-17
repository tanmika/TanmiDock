/**
 * TanmiDock 核心类型定义
 */

// ============ 版本常量 ============

/** 当前配置版本 */
export const CURRENT_CONFIG_VERSION = '1.2.0';
/** 最低支持版本 */
export const MIN_SUPPORTED_VERSION = '1.0.0';

// ============ 配置相关 ============

/**
 * 全局配置
 */
export interface DockConfig {
  version: string;
  initialized: boolean;
  storePath: string;
  cleanStrategy: CleanStrategy;
  unusedDays: number; // unused 策略的天数阈值
  unreferencedThreshold?: number; // capacity 策略的容量阈值（字节）
  maxStoreSize?: number;
  autoDownload: boolean;
  // 新增配置项
  concurrency: number; // 并发下载数，默认 5
  logLevel: LogLevel; // 日志级别，默认 'info'
  proxy?: ProxyConfig; // 代理配置，可选
  unverifiedLocalStrategy: UnverifiedLocalStrategy; // 无法验证commit的本地库处理策略
  sharedSymlinkFolders?: boolean; // _shared目录是否使用符号链接，默认true
  gitLightweightDownload?: boolean; // Git 非完整拉取，默认 true，可降低临时下载空间消耗
}

export type CleanStrategy = 'unreferenced' | 'unused' | 'manual' | 'capacity';
export type LogLevel = 'debug' | 'verbose' | 'info' | 'warn' | 'error';
export type UnverifiedLocalStrategy = 'download' | 'absorb';

/**
 * 代理配置
 */
export interface ProxyConfig {
  http?: string; // HTTP 代理，如 http://127.0.0.1:7890
  https?: string; // HTTPS 代理，如 http://127.0.0.1:7890
  noProxy?: string[]; // 不走代理的域名列表
}

/**
 * 默认配置
 */
export const DEFAULT_CONFIG: Omit<DockConfig, 'storePath'> = {
  version: CURRENT_CONFIG_VERSION,
  initialized: false,
  cleanStrategy: 'unreferenced',
  unusedDays: 30,
  unreferencedThreshold: 10 * 1024 * 1024 * 1024, // 默认 10GB
  autoDownload: true,
  concurrency: 5,
  logLevel: 'info',
  unverifiedLocalStrategy: 'download',
  sharedSymlinkFolders: true,
  gitLightweightDownload: true,
};

// ============ 注册表相关 ============

/**
 * 注册表
 */
export interface Registry {
  version: string;
  projects: Record<string, ProjectInfo>;
  libraries: Record<string, LibraryInfo>; // 旧字段，兼容读取
  stores: Record<string, StoreEntry>; // 新字段，按平台存储
  manualUnavailablePlatforms: Record<string, string[]>;
}

/**
 * 项目信息
 */
export interface ProjectInfo {
  path: string;
  configPath: string;
  lastLinked: string;
  platforms: string[]; // 项目使用的平台列表 (macOS, iOS, android...)
  dependencies: DependencyRef[];
  optionalConfigs?: string[]; // 用户选择的可选配置文件名列表
  submodules?: string[]; // 上次选择的 submodule 相对路径列表（记忆用户选择）
  submoduleOptionalConfigs?: Record<string, string[]>; // 每个 submodule 上次选择的可选配置
}

/**
 * 依赖引用
 */
export interface DependencyRef {
  libName: string;
  commit: string;
  platform: string; // 该依赖对应的平台
  linkedPath: string;
  scope?: string; // submodule 相对路径，主项目为 undefined
}

/**
 * 库信息 (旧版，保留兼容)
 * @deprecated 使用 StoreEntry 替代
 */
export interface LibraryInfo {
  libName: string;
  commit: string;
  branch: string;
  url: string;
  platforms: string[];
  size: number;
  /** 是否确认为真正的 General 库；缺失时表示历史数据，需要结合 Store 结构推断 */
  isGeneral?: boolean;
  /**
   * 引用该库的项目 hash 列表
   * @deprecated 使用 StoreEntry.usedBy 替代
   */
  referencedBy: string[];
  createdAt: string;
  lastAccess: string;
  /** 已确认远程不存在的平台（避免重复下载尝试） */
  unavailablePlatforms?: string[];
}

/**
 * Store 条目 (新版，按平台存储)
 * key 格式: lib:commit:platform
 */
export interface StoreEntry {
  libName: string;
  commit: string;
  platform: string; // 平台目录名 (macOS, iOS, android...)
  branch: string;
  url: string;
  size: number;
  fileCount?: number;        // 平台目录下递归文件总数
  contentHash?: string;      // 平台目录内容 MD5
  usedBy: string[]; // 项目 hash 列表
  unlinkedAt?: number; // 变成无引用的时间戳
  createdAt: string;
  lastAccess: string;
}

/**
 * 空注册表
 */
export const EMPTY_REGISTRY: Registry = {
  version: '1.0.0',
  projects: {},
  libraries: {},
  stores: {},
  manualUnavailablePlatforms: {},
};

// ============ codepac 配置解析 ============

/**
 * codepac-dep.json 配置
 */
export interface CodepacDep {
  version: string;
  vars?: Record<string, string>;
  repos: CodepacPlatformGroups<RepoConfig>;
  actions?: CodepacPlatformGroups<ActionConfig>;
}

/**
 * codepac 按平台分组的配置集合
 * common 始终参与筛选。tanmi-dock 额外支持配置 all 分组，便于显式声明所有平台共享配置。
 */
export type CodepacPlatformGroups<T> = {
  common?: T[];
  all?: T[];
  [platform: string]: T[] | undefined;
};

/**
 * 仓库配置
 */
export interface RepoConfig {
  url: string;
  commit: string;
  branch: string;
  dir: string;
  name?: string;
  source?: RepoConfigSource;
  sparse?: object | string;
}

/**
 * codepac 用于记录仓库原始配置的 source 字段
 */
export interface RepoConfigSource {
  url?: string;
  commit?: string;
  branch?: string;
  dir: string;
  name?: string;
  sparse?: object | string;
}

/**
 * 动作配置
 */
export interface ActionConfig {
  command: string;
  dir?: string;
  name?: string;
}

/**
 * 解析后的依赖
 */
export interface ParsedDependency {
  libName: string;
  commit: string;
  branch: string;
  url: string;
  dir: string;
  name: string;
  source: RepoConfigSource;
  sparse?: object | string;
}

// ============ 依赖状态 ============

/**
 * 依赖分类状态
 */
export enum DependencyStatus {
  /** Store 有，项目链接正确 */
  LINKED = 'LINKED',
  /** Store 有，项目链接错误 */
  RELINK = 'RELINK',
  /** Store 有，项目是目录 */
  REPLACE = 'REPLACE',
  /** Store 没有，项目有目录 */
  ABSORB = 'ABSORB',
  /** Store 没有，项目也没有 */
  MISSING = 'MISSING',
  /** Store 有，项目没有 */
  LINK_NEW = 'LINK_NEW',
}

/**
 * 分类后的依赖
 */
export interface ClassifiedDependency {
  dependency: ParsedDependency;
  status: DependencyStatus;
  localPath: string;
  storePath: string;
}

// ============ 平台相关 ============

export type Platform = 'mac' | 'win';

// ============ 磁盘信息 ============

/**
 * 磁盘信息
 */
export interface DiskInfo {
  path: string;
  label?: string;
  total: number;
  free: number;
  isSystem: boolean;
}

// ============ 初始化状态 ============

/**
 * 初始化状态
 */
export interface InitStatus {
  initialized: boolean;
  configExists: boolean;
  storePathExists: boolean;
  storePath?: string;
}

// ============ 嵌套依赖处理 ============

/**
 * 解析后的 action 命令
 * 格式: codepac install lib1 lib2 --configdir xxx --targetdir . [--disable_action]
 */
export interface ParsedAction {
  /** 需要安装的库名列表 */
  libraries: string[];
  /** 配置目录（相对于当前 3rdparty 目录） */
  configDir: string;
  /** 目标目录 */
  targetDir: string;
  /** 是否禁用嵌套 actions 的递归处理 */
  disableAction: boolean;
  /** action 命令是否显式传入 platform 参数 */
  hasExplicitPlatform: boolean;
  /** action 命令显式传入的 codepac 平台列表 */
  platforms: string[];
  /** action 命令是否显式传入 fullgit 参数 */
  hasExplicitFullGit: boolean;
  /** action 命令是否显式传入 unshallow 参数 */
  hasExplicitUnshallow: boolean;
  /** action 命令是否显式传入 disable_sparse 参数 */
  hasExplicitDisableSparse: boolean;
}

/**
 * action 递归执行计划
 * 统一描述 action 命令解析后的配置路径、目标路径和继承平台。
 */
export interface ActionExecutionPlan {
  actionName?: string;
  command: string;
  parsed: ParsedAction;
  configDir: string;
  targetDir: string;
  nestedConfigPath: string;
  nestedTargetDir: string;
  inheritedPlatforms: string[];
  effectiveCodepacPlatforms: string[];
  libraries: string[];
}

/**
 * 嵌套依赖处理上下文
 */
export interface NestedContext {
  /** 嵌套深度（用于日志缩进和循环检测） */
  depth: number;
  /** 已处理的配置与目标目录组合（防止 action 循环依赖） */
  processedConfigs: Set<string>;
  /** 平台列表 */
  platforms: string[];
  /** codepac 配置分组使用的平台 key */
  codepacPlatforms?: string[];
  /** 配置变量 */
  vars?: Record<string, string>;
}
