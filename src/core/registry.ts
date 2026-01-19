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
    // 标记为已加载，这样 migration 中调用的方法可以正常工作
    this.loaded = true;
    // 自动迁移旧版引用数据（如果有需要迁移的数据，会立即保存）
    await this.migrateReferences();
  }

  /**
   * 解析 libKey 为 libName 和 commit
   * 使用安全的方式处理可能包含冒号的 libName
   */
  private parseLibraryKey(libKey: string): { libName: string; commit: string } | null {
    const colonIndex = libKey.lastIndexOf(':');
    if (colonIndex === -1) return null;
    return {
      libName: libKey.slice(0, colonIndex),
      commit: libKey.slice(colonIndex + 1),
    };
  }

  /**
   * 迁移 LibraryInfo.referencedBy 到 StoreEntry.usedBy
   * 用于旧版数据兼容，迁移后立即保存避免数据丢失
   * 只迁移有效的引用（项目存在且路径有效）
   */
  private async migrateReferences(): Promise<void> {
    let migrated = false;

    for (const [libKey, lib] of Object.entries(this.registry.libraries)) {
      if (!lib.referencedBy || lib.referencedBy.length === 0) continue;

      const parsed = this.parseLibraryKey(libKey);
      if (!parsed) continue;

      const { libName, commit } = parsed;
      const storeKeys = this.getLibraryStoreKeys(libName, commit);

      // 保护：如果没有对应的 StoreEntry，保留 referencedBy 数据避免丢失
      if (storeKeys.length === 0) {
        // 无法迁移，保留原数据（可能是孤立的 LibraryInfo，会被 clean 命令处理）
        continue;
      }

      // 只迁移有效的引用（项目存在）
      const validRefs: string[] = [];
      for (const projectHash of lib.referencedBy) {
        const project = this.registry.projects[projectHash];
        if (project) {
          validRefs.push(projectHash);
        }
      }

      // 迁移到对应的 StoreEntry
      for (const storeKey of storeKeys) {
        const store = this.registry.stores[storeKey];
        if (store) {
          for (const projectHash of validRefs) {
            if (!store.usedBy.includes(projectHash)) {
              store.usedBy.push(projectHash);
              migrated = true;
            }
          }
          // 如果有引用，清除 unlinkedAt
          if (store.usedBy.length > 0) {
            delete store.unlinkedAt;
          }
        }
      }

      // 迁移成功后清空旧数据
      lib.referencedBy = [];
    }

    // 迁移后立即保存，避免重复迁移
    if (migrated) {
      await this.save();
    }
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
   * 注意：会移除该项目对所有相关 StoreEntry 的引用（包括所有平台）
   */
  removeProject(pathHash: string): void {
    this.ensureLoaded();
    const project = this.registry.projects[pathHash];
    if (project) {
      // 移除 StoreEntry 引用
      // 注意：dependencies 中只保存主平台，但实际可能链接了多个平台
      // 因此需要获取该库所有平台的 StoreEntry 并移除引用
      for (const dep of project.dependencies) {
        const storeKeys = this.getLibraryStoreKeys(dep.libName, dep.commit);
        for (const storeKey of storeKeys) {
          this.removeStoreReference(storeKey, pathHash);
        }
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
   * @deprecated 使用 getUnreferencedStores() 替代
   */
  getUnreferencedLibraries(): LibraryInfo[] {
    this.ensureLoaded();
    return this.listLibraries().filter((lib) => lib.referencedBy.length === 0);
  }

  /**
   * 获取孤立的 LibraryInfo 记录（没有对应的 StoreEntry）
   * 这种情况可能发生在：
   * 1. 所有平台的 StoreEntry 都被删除但 LibraryInfo 没有清理
   * 2. 数据损坏或手动修改导致的不一致
   */
  getOrphanLibraries(): LibraryInfo[] {
    this.ensureLoaded();
    return this.listLibraries().filter((lib) => {
      const storeKeys = this.getLibraryStoreKeys(lib.libName, lib.commit);
      return storeKeys.length === 0;
    });
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
   * 获取指定库的所有平台（从 StoreEntry 动态获取，比 LibraryInfo.platforms 更准确）
   * @param libName 库名
   * @param commit commit hash
   * @returns 平台列表
   */
  getLibraryPlatforms(libName: string, commit: string): string[] {
    const storeKeys = this.getLibraryStoreKeys(libName, commit);
    const prefix = `${libName}:${commit}:`;
    return storeKeys.map((key) => key.slice(prefix.length));
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
   * 获取用于清理一半容量的 Store 条目（LRU 策略）
   * 按 unlinkedAt 升序排序，累加到总容量的一半
   */
  getStoresForHalfClean(): StoreEntry[] {
    this.ensureLoaded();
    const unreferenced = this.getUnreferencedStores();
    if (unreferenced.length === 0) return [];

    const totalSize = unreferenced.reduce((sum, e) => sum + e.size, 0);
    const targetSize = totalSize / 2;

    // 按 unlinkedAt 升序排序（最早脱引用的优先清理）
    // 没有 unlinkedAt 的放最后
    unreferenced.sort((a, b) => {
      const aTime = a.unlinkedAt ?? Infinity;
      const bTime = b.unlinkedAt ?? Infinity;
      return aTime - bTime;
    });

    // 累加直到达到目标
    let accumulated = 0;
    const result: StoreEntry[] = [];
    for (const entry of unreferenced) {
      result.push(entry);
      accumulated += entry.size;
      if (accumulated >= targetSize) break;
    }
    return result;
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
   * 批量添加 Store 引用
   * @param projectHash 项目 hash
   * @param storeKeys Store key 列表
   */
  addProjectReferences(projectHash: string, storeKeys: string[]): void {
    this.ensureLoaded();
    for (const storeKey of storeKeys) {
      this.addStoreReference(storeKey, projectHash);
    }
  }

  /**
   * 批量移除 Store 引用
   * @param projectHash 项目 hash
   * @param storeKeys Store key 列表
   */
  removeProjectReferences(projectHash: string, storeKeys: string[]): void {
    this.ensureLoaded();
    for (const storeKey of storeKeys) {
      this.removeStoreReference(storeKey, projectHash);
    }
  }

  /**
   * 获取库的所有 Store keys
   * @param libName 库名
   * @param commit commit hash
   * @returns Store key 列表
   */
  getLibraryStoreKeys(libName: string, commit: string): string[] {
    this.ensureLoaded();
    const prefix = `${libName}:${commit}:`;
    const keys: string[] = [];
    for (const key of Object.keys(this.registry.stores)) {
      if (key.startsWith(prefix)) {
        keys.push(key);
      }
    }
    return keys;
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

  // ========== 引用关系管理 (deprecated, 仅保留读取) ==========

  /**
   * 获取库的引用列表
   * @deprecated 使用 StoreEntry.usedBy 替代
   */
  getLibraryReferences(libKey: string): string[] {
    this.ensureLoaded();
    return this.registry.libraries[libKey]?.referencedBy ?? [];
  }

  // ========== 统计方法 ==========

  /**
   * 获取空间统计信息
   * 计算实际占用、理论占用和节省的空间
   */
  getSpaceStats(): { actualSize: number; theoreticalSize: number; savedSize: number } {
    this.ensureLoaded();
    let actualSize = 0;
    let theoreticalSize = 0;

    for (const entry of Object.values(this.registry.stores)) {
      actualSize += entry.size;
      const refCount = entry.usedBy.length;
      // 理论空间：每个引用都存一份，无引用的也算一份
      theoreticalSize += entry.size * Math.max(refCount, 1);
    }

    return {
      actualSize,
      theoreticalSize,
      savedSize: theoreticalSize - actualSize,
    };
  }

  /**
   * 获取项目占用空间
   * @param projectHash 项目 hash
   * @returns 项目所有依赖的总大小
   */
  getProjectSize(projectHash: string): number {
    this.ensureLoaded();
    const project = this.registry.projects[projectHash];
    if (!project) return 0;

    let totalSize = 0;
    for (const dep of project.dependencies) {
      const storeKey = this.getStoreKey(dep.libName, dep.commit, dep.platform);
      const entry = this.registry.stores[storeKey];
      if (entry) {
        totalSize += entry.size;
      }
    }
    return totalSize;
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

    // 清理 stores.usedBy 中的失效引用
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

    // 清理 libraries.referencedBy 中的残留数据（迁移遗留）
    for (const lib of Object.values(this.registry.libraries)) {
      if (lib.referencedBy && lib.referencedBy.length > 0) {
        lib.referencedBy = [];
        // 不计入 cleaned，因为这是迁移遗留数据，不是真正的失效引用
      }
    }

    return cleaned;
  }
}

// 导出单例获取函数
export function getRegistry(): RegistryManager {
  return RegistryManager.getInstance();
}

/**
 * 重置 Registry 单例（仅用于测试）
 * 清除缓存的实例，下次 getRegistry() 将创建新实例
 */
export function resetRegistry(): void {
  (RegistryManager as unknown as { instance: RegistryManager | null }).instance = null as unknown as RegistryManager;
}

export default RegistryManager;
