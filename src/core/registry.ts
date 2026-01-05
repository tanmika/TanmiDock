/**
 * 注册表管理
 * 注册表文件位置: ~/.tanmi-dock/registry.json
 */
import fs from 'fs/promises';
import crypto from 'crypto';
import { getRegistryPath } from './platform.js';
import { ensureConfigDir } from './config.js';
import type { Registry, ProjectInfo, LibraryInfo, DependencyRef } from '../types/index.js';
import { EMPTY_REGISTRY } from '../types/index.js';

/**
 * 注册表管理器
 */
class RegistryManager {
  private static instance: RegistryManager;
  private registry: Registry = { ...EMPTY_REGISTRY };
  private loaded = false;

  private constructor() {}

  static getInstance(): RegistryManager {
    if (!RegistryManager.instance) {
      RegistryManager.instance = new RegistryManager();
    }
    return RegistryManager.instance;
  }

  /**
   * 加载注册表
   */
  async load(): Promise<void> {
    try {
      const registryPath = getRegistryPath();
      const content = await fs.readFile(registryPath, 'utf-8');
      this.registry = JSON.parse(content) as Registry;
    } catch {
      this.registry = { ...EMPTY_REGISTRY };
    }
    this.loaded = true;
  }

  /**
   * 保存注册表
   */
  async save(): Promise<void> {
    await ensureConfigDir();
    const registryPath = getRegistryPath();
    await fs.writeFile(registryPath, JSON.stringify(this.registry, null, 2), 'utf-8');
  }

  /**
   * 确保已加载
   */
  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error('Registry not loaded. Call load() first.');
    }
  }

  // ========== 项目管理 ==========

  /**
   * 获取项目信息
   */
  getProject(pathHash: string): ProjectInfo | undefined {
    this.ensureLoaded();
    return this.registry.projects[pathHash];
  }

  /**
   * 通过路径获取项目
   */
  getProjectByPath(path: string): ProjectInfo | undefined {
    const hash = this.hashPath(path);
    return this.getProject(hash);
  }

  /**
   * 添加项目
   */
  addProject(info: ProjectInfo): void {
    this.ensureLoaded();
    const hash = this.hashPath(info.path);
    this.registry.projects[hash] = info;
  }

  /**
   * 更新项目
   */
  updateProject(pathHash: string, updates: Partial<ProjectInfo>): void {
    this.ensureLoaded();
    const project = this.registry.projects[pathHash];
    if (project) {
      this.registry.projects[pathHash] = { ...project, ...updates };
    }
  }

  /**
   * 移除项目
   */
  removeProject(pathHash: string): void {
    this.ensureLoaded();
    const project = this.registry.projects[pathHash];
    if (project) {
      // 移除库的引用
      for (const dep of project.dependencies) {
        const libKey = this.getLibraryKey(dep.libName, dep.commit);
        this.removeReference(libKey, pathHash);
      }
      delete this.registry.projects[pathHash];
    }
  }

  /**
   * 列出所有项目
   */
  listProjects(): ProjectInfo[] {
    this.ensureLoaded();
    return Object.values(this.registry.projects);
  }

  // ========== 库管理 ==========

  /**
   * 获取库 key
   */
  getLibraryKey(libName: string, commit: string): string {
    return `${libName}:${commit}`;
  }

  /**
   * 获取库信息
   */
  getLibrary(key: string): LibraryInfo | undefined {
    this.ensureLoaded();
    return this.registry.libraries[key];
  }

  /**
   * 添加库
   */
  addLibrary(info: LibraryInfo): void {
    this.ensureLoaded();
    const key = this.getLibraryKey(info.libName, info.commit);
    this.registry.libraries[key] = info;
  }

  /**
   * 更新库
   */
  updateLibrary(key: string, updates: Partial<LibraryInfo>): void {
    this.ensureLoaded();
    const lib = this.registry.libraries[key];
    if (lib) {
      this.registry.libraries[key] = { ...lib, ...updates };
    }
  }

  /**
   * 移除库
   */
  removeLibrary(key: string): void {
    this.ensureLoaded();
    delete this.registry.libraries[key];
  }

  /**
   * 列出所有库
   */
  listLibraries(): LibraryInfo[] {
    this.ensureLoaded();
    return Object.values(this.registry.libraries);
  }

  /**
   * 获取无引用的库
   */
  getUnreferencedLibraries(): LibraryInfo[] {
    this.ensureLoaded();
    return this.listLibraries().filter(lib => lib.referencedBy.length === 0);
  }

  // ========== 引用关系管理 ==========

  /**
   * 添加引用
   */
  addReference(libKey: string, projectHash: string): void {
    this.ensureLoaded();
    const lib = this.registry.libraries[libKey];
    if (lib && !lib.referencedBy.includes(projectHash)) {
      lib.referencedBy.push(projectHash);
    }
  }

  /**
   * 移除引用
   */
  removeReference(libKey: string, projectHash: string): void {
    this.ensureLoaded();
    const lib = this.registry.libraries[libKey];
    if (lib) {
      lib.referencedBy = lib.referencedBy.filter(h => h !== projectHash);
    }
  }

  /**
   * 获取库的引用列表
   */
  getLibraryReferences(libKey: string): string[] {
    this.ensureLoaded();
    return this.registry.libraries[libKey]?.referencedBy ?? [];
  }

  // ========== 工具方法 ==========

  /**
   * 计算路径 hash
   */
  hashPath(path: string): string {
    return crypto.createHash('md5').update(path).digest('hex').slice(0, 12);
  }

  /**
   * 获取原始注册表对象
   */
  getRaw(): Registry {
    this.ensureLoaded();
    return this.registry;
  }

  /**
   * 清理过期项目（路径不存在的项目）
   */
  async cleanStaleProjects(): Promise<string[]> {
    this.ensureLoaded();
    const staleHashes: string[] = [];

    for (const [hash, project] of Object.entries(this.registry.projects)) {
      try {
        await fs.access(project.path);
      } catch {
        staleHashes.push(hash);
      }
    }

    for (const hash of staleHashes) {
      this.removeProject(hash);
    }

    return staleHashes;
  }
}

// 导出单例获取函数
export function getRegistry(): RegistryManager {
  return RegistryManager.getInstance();
}

export default RegistryManager;
