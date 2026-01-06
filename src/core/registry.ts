/**
 * 注册表管理
 * 注册表文件位置: ~/.tanmi-dock/registry.json
 */
import fs from 'fs/promises';
import crypto from 'crypto';
import { getRegistryPath } from './platform.js';
import { ensureConfigDir } from './config.js';
import { withFileLock } from '../utils/lock.js';
import type { Registry, ProjectInfo, LibraryInfo, StoreEntry } from '../types/index.js';
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
   * 加载注册表（支持懒加载，多次调用只加载一次）
   */
  async load(): Promise<void> {
    // 避免重复加载
    if (this.loaded) return;

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
   * 强制重新加载（用于需要刷新数据的场景）
   */
  async reload(): Promise<void> {
    this.loaded = false;
    await this.load();
  }

  /**
   * 检查注册表文件是否存在（轻量级，不加载完整数据）
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(getRegistryPath());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取统计信息（轻量级，只读取必要数据）
   */
  async getStats(): Promise<{ projectCount: number; libraryCount: number; totalSize: number }> {
    // 如果已加载，直接计算
    if (this.loaded) {
      const totalSize = Object.values(this.registry.libraries).reduce(
        (sum, lib) => sum + lib.size,
        0
      );
      return {
        projectCount: Object.keys(this.registry.projects).length,
        libraryCount: Object.keys(this.registry.libraries).length,
        totalSize,
      };
    }

    // 未加载时，读取并解析
    try {
      const content = await fs.readFile(getRegistryPath(), 'utf-8');
      const data = JSON.parse(content) as Registry;
      const totalSize = Object.values(data.libraries).reduce((sum, lib) => sum + lib.size, 0);
      return {
        projectCount: Object.keys(data.projects).length,
        libraryCount: Object.keys(data.libraries).length,
        totalSize,
      };
    } catch {
      return { projectCount: 0, libraryCount: 0, totalSize: 0 };
    }
  }

  /**
   * 检查是否已加载
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * 保存注册表（带文件锁保护）
   */
  async save(): Promise<void> {
    await ensureConfigDir();
    const registryPath = getRegistryPath();
    await withFileLock(registryPath, async () => {
      await fs.writeFile(registryPath, JSON.stringify(this.registry, null, 2), 'utf-8');
    });
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
    return this.listLibraries().filter((lib) => lib.referencedBy.length === 0);
  }

  // ========== Store 管理 (新版，按平台) ==========

  /**
   * 获取 Store key (lib:commit:platform)
   */
  getStoreKey(libName: string, commit: string, platform: string): string {
    return `${libName}:${commit}:${platform}`;
  }

  /**
   * 获取 Store 条目
   */
  getStore(key: string): StoreEntry | undefined {
    this.ensureLoaded();
    return this.registry.stores[key];
  }

  /**
   * 添加 Store 条目
   */
  addStore(entry: StoreEntry): void {
    this.ensureLoaded();
    const key = this.getStoreKey(entry.libName, entry.commit, entry.platform);
    this.registry.stores[key] = entry;
  }

  /**
   * 更新 Store 条目
   */
  updateStore(key: string, updates: Partial<StoreEntry>): void {
    this.ensureLoaded();
    const entry = this.registry.stores[key];
    if (entry) {
      this.registry.stores[key] = { ...entry, ...updates };
    }
  }

  /**
   * 移除 Store 条目
   */
  removeStore(key: string): void {
    this.ensureLoaded();
    delete this.registry.stores[key];
  }

  /**
   * 列出所有 Store 条目
   */
  listStores(): StoreEntry[] {
    this.ensureLoaded();
    return Object.values(this.registry.stores);
  }

  /**
   * 获取无引用的 Store 条目
   */
  getUnreferencedStores(): StoreEntry[] {
    this.ensureLoaded();
    return this.listStores().filter((entry) => entry.usedBy.length === 0);
  }

  /**
   * 获取可清理的 unused 库（无引用超过指定天数）
   * @param unusedDays 无引用天数阈值
   */
  getUnusedStores(unusedDays: number): StoreEntry[] {
    this.ensureLoaded();
    const threshold = Date.now() - unusedDays * 24 * 60 * 60 * 1000;
    return this.listStores().filter(
      (entry) =>
        entry.usedBy.length === 0 &&
        entry.unlinkedAt !== undefined &&
        entry.unlinkedAt < threshold
    );
  }

  /**
   * 获取无引用但未过期的库（供 status 显示）
   * @param unusedDays 无引用天数阈值
   */
  getPendingUnusedStores(
    unusedDays: number
  ): Array<{ entry: StoreEntry; daysLeft: number }> {
    this.ensureLoaded();
    const threshold = Date.now() - unusedDays * 24 * 60 * 60 * 1000;
    return this.listStores()
      .filter(
        (e) =>
          e.usedBy.length === 0 &&
          e.unlinkedAt !== undefined &&
          e.unlinkedAt >= threshold
      )
      .map((entry) => ({
        entry,
        daysLeft: Math.ceil(
          (entry.unlinkedAt! + unusedDays * 86400000 - Date.now()) / 86400000
        ),
      }));
  }

  /**
   * 添加 Store 引用（清除 unlinkedAt）
   */
  addStoreReference(storeKey: string, projectHash: string): void {
    this.ensureLoaded();
    const entry = this.registry.stores[storeKey];
    if (entry) {
      if (!entry.usedBy.includes(projectHash)) {
        entry.usedBy.push(projectHash);
      }
      // 重新被引用，清除 unlinkedAt
      delete entry.unlinkedAt;
    }
  }

  /**
   * 移除 Store 引用（设置 unlinkedAt）
   */
  removeStoreReference(storeKey: string, projectHash: string): void {
    this.ensureLoaded();
    const entry = this.registry.stores[storeKey];
    if (entry) {
      entry.usedBy = entry.usedBy.filter((h) => h !== projectHash);
      // 如果变成无引用，记录时间
      if (entry.usedBy.length === 0 && !entry.unlinkedAt) {
        entry.unlinkedAt = Date.now();
      }
    }
  }

  /**
   * 获取项目的 Store keys
   */
  getProjectStoreKeys(projectHash: string): string[] {
    this.ensureLoaded();
    const project = this.registry.projects[projectHash];
    if (!project) return [];
    return project.dependencies.map((d) =>
      this.getStoreKey(d.libName, d.commit, d.platform)
    );
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
      lib.referencedBy = lib.referencedBy.filter((h) => h !== projectHash);
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

  /**
   * 清理失效的 Store 引用
   * 检查所有 StoreEntry.usedBy 中的项目是否还存在
   * @returns 被清理的引用数量
   */
  async cleanStaleReferences(): Promise<number> {
    this.ensureLoaded();
    let cleaned = 0;

    for (const entry of Object.values(this.registry.stores)) {
      const validRefs: string[] = [];

      for (const projectHash of entry.usedBy) {
        const project = this.registry.projects[projectHash];
        if (project) {
          // 检查项目路径是否存在
          try {
            await fs.access(project.path);
            validRefs.push(projectHash);
          } catch {
            cleaned++;
          }
        } else {
          cleaned++;
        }
      }

      // 更新引用列表
      if (validRefs.length !== entry.usedBy.length) {
        entry.usedBy = validRefs;
        // 如果变成无引用，设置 unlinkedAt
        if (validRefs.length === 0 && !entry.unlinkedAt) {
          entry.unlinkedAt = Date.now();
        }
      }
    }

    return cleaned;
  }
}

// 导出单例获取函数
export function getRegistry(): RegistryManager {
  return RegistryManager.getInstance();
}

export default RegistryManager;
