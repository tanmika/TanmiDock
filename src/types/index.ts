/**
 * TanmiDock 核心类型定义
 */

// ============ 配置相关 ============

/**
 * 全局配置
 */
export interface DockConfig {
  version: string;
  initialized: boolean;
  storePath: string;
  cleanStrategy: CleanStrategy;
  maxStoreSize?: number;
  autoDownload: boolean;
}

export type CleanStrategy = 'unreferenced' | 'lru' | 'manual';

/**
 * 默认配置
 */
export const DEFAULT_CONFIG: Omit<DockConfig, 'storePath'> = {
  version: '1.0.0',
  initialized: false,
  cleanStrategy: 'unreferenced',
  autoDownload: true,
};

// ============ 注册表相关 ============

/**
 * 注册表
 */
export interface Registry {
  version: string;
  projects: Record<string, ProjectInfo>;
  libraries: Record<string, LibraryInfo>;
}

/**
 * 项目信息
 */
export interface ProjectInfo {
  path: string;
  configPath: string;
  lastLinked: string;
  platform: Platform;
  dependencies: DependencyRef[];
}

/**
 * 依赖引用
 */
export interface DependencyRef {
  libName: string;
  commit: string;
  linkedPath: string;
}

/**
 * 库信息
 */
export interface LibraryInfo {
  libName: string;
  commit: string;
  branch: string;
  url: string;
  platforms: string[];
  size: number;
  referencedBy: string[];
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
};

// ============ codepac 配置解析 ============

/**
 * codepac-dep.json 配置
 */
export interface CodepacDep {
  version: string;
  vars?: Record<string, string>;
  repos: {
    common: RepoConfig[];
  };
  actions?: {
    common: ActionConfig[];
  };
}

/**
 * 仓库配置
 */
export interface RepoConfig {
  url: string;
  commit: string;
  branch: string;
  dir: string;
  sparse?: object | string;
}

/**
 * 动作配置
 */
export interface ActionConfig {
  command: string;
  dir: string;
}

/**
 * 解析后的依赖
 */
export interface ParsedDependency {
  libName: string;
  commit: string;
  branch: string;
  url: string;
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
