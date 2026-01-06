# TanmiDock API 文档

本文档描述 TanmiDock 的核心模块 API。

## 目录

### 核心模块
- [config - 配置管理](#config---配置管理)
- [store - Store 存储操作](#store---store-存储操作)
- [linker - 符号链接操作](#linker---符号链接操作)
- [registry - 注册表管理](#registry---注册表管理)
- [parser - codepac 解析器](#parser---codepac-解析器)
- [platform - 跨平台适配](#platform---跨平台适配)
- [transaction - 事务管理](#transaction---事务管理)
- [guard - 初始化守卫](#guard---初始化守卫)

### 工具模块
- [disk - 磁盘工具](#disk---磁盘工具)
- [global-lock - 全局操作锁](#global-lock---全局操作锁)
- [fs-utils - 文件系统工具](#fs-utils---文件系统工具)
- [exit-codes - 退出码](#exit-codes---退出码)

### 类型定义
- [类型定义](#类型定义)

---

## config - 配置管理

配置文件位置:
- macOS/Linux: `~/.tanmi-dock/config.json`
- Windows: `%USERPROFILE%\.tanmi-dock\config.json`

### `load(): Promise<DockConfig | null>`

加载配置文件。文件不存在时返回 `null`。

### `save(config: DockConfig): Promise<void>`

保存配置（带文件锁保护）。

### `get<K>(key: K): Promise<DockConfig[K] | undefined>`

获取单个配置项。

```typescript
const storePath = await config.get('storePath');
```

### `set<K>(key: K, value: DockConfig[K]): Promise<void>`

设置单个配置项并保存（带文件锁保护）。

```typescript
await config.set('autoDownload', false);
```

### `getStorePath(): Promise<string | undefined>`

获取 Store 路径。

### `setStorePath(path: string): Promise<void>`

设置 Store 路径（支持 `~` 展开）。

### `getDefaultConfig(storePath: string): DockConfig`

获取带指定 storePath 的默认配置。

### `isValidConfigKey(key: string): boolean`

验证配置项名称是否有效。

### `isValidCleanStrategy(value: string): boolean`

验证 cleanStrategy 值是否有效。

### `parseConfigValue(key, value): DockConfig[K]`

解析字符串配置值为正确类型。

---

## store - Store 存储操作

Store 目录结构: `{storePath}/{libName}/{commit}/`

### `getStorePath(): Promise<string>`

获取当前配置的 Store 路径。未配置时抛出异常。

### `getLibraryPath(storePath, libName, commit): string`

获取库在 Store 中的完整路径。

```typescript
const libPath = store.getLibraryPath('/store', 'mylib', 'abc123');
// => '/store/mylib/abc123'
```

### `exists(libName, commit): Promise<boolean>`

检查库是否存在于 Store 中。

### `getPath(libName, commit): Promise<string | null>`

获取库的完整路径。不存在时返回 `null`。

### `absorb(sourcePath, libName, commit): Promise<string>`

将本地库目录移入 Store。使用原子重命名，避免 TOCTOU 竞态条件。

```typescript
const storePath = await store.absorb('/project/3rdparty/lib', 'lib', 'abc123');
// 源目录被移动到 Store，返回 Store 中的路径
```

### `copy(sourcePath, libName, commit): Promise<string>`

复制库到 Store（不删除源目录）。使用文件锁保护。

### `remove(libName, commit): Promise<void>`

从 Store 中删除库。如果库目录为空也会删除。

### `getSize(libName, commit): Promise<number>`

获取库占用空间（字节）。

### `getTotalSize(): Promise<number>`

获取 Store 总大小。

### `listLibraries(): Promise<Array<{libName, commit, path}>>`

列出 Store 中所有库。

### `getPlatforms(libName, commit): Promise<string[]>`

获取库的已下载平台目录列表。

### `ensureStoreDir(): Promise<void>`

确保 Store 目录存在。

---

## linker - 符号链接操作

- macOS: 使用 symlink
- Windows: 使用 junction (无需管理员权限)

### `link(target, linkPath): Promise<void>`

创建符号链接。

```typescript
await linker.link('/store/mylib/abc123', '/project/3rdparty/mylib');
```

### `unlink(linkPath): Promise<void>`

删除符号链接。

### `isSymlink(linkPath): Promise<boolean>`

检查路径是否为符号链接。

### `readLink(linkPath): Promise<string | null>`

读取符号链接目标。不是链接时返回 `null`。

### `isValidLink(linkPath): Promise<boolean>`

检查符号链接是否有效（链接存在且目标存在）。

### `isCorrectLink(linkPath, expectedTarget): Promise<boolean>`

检查符号链接是否指向正确的目标。

### `replaceWithLink(dirPath, target, backup?): Promise<string | null>`

将普通目录替换为符号链接。

- 如果已是正确链接，返回 `null`
- 如果是链接但指向错误，重建链接
- 如果是目录，根据 `backup` 参数决定备份或删除

```typescript
// 删除原目录，创建链接
await linker.replaceWithLink('/project/lib', '/store/lib/abc123');

// 备份原目录，返回备份路径
const backupPath = await linker.replaceWithLink('/project/lib', '/store/lib/abc123', true);
```

### `restoreFromLink(linkPath): Promise<void>`

将符号链接还原为普通目录（从目标复制内容）。

### `getPathStatus(localPath, expectedTarget): Promise<PathStatus>`

检查路径状态。

返回值:
- `'linked'`: 是正确的链接
- `'wrong_link'`: 是链接但指向错误
- `'directory'`: 是普通目录
- `'missing'`: 不存在

---

## registry - 注册表管理

注册表文件位置: `~/.tanmi-dock/registry.json`

### `getRegistry(): RegistryManager`

获取注册表管理器单例。

```typescript
const registry = getRegistry();
await registry.load();
```

### RegistryManager 类

#### 加载/保存

```typescript
await registry.load();   // 加载注册表
await registry.save();   // 保存注册表（带文件锁）
```

#### 项目管理

```typescript
// 获取项目
const project = registry.getProject(pathHash);
const project = registry.getProjectByPath('/path/to/project');

// 添加/更新/删除项目
registry.addProject(projectInfo);
registry.updateProject(pathHash, { lastLinked: new Date().toISOString() });
registry.removeProject(pathHash);

// 列出所有项目
const projects = registry.listProjects();
```

#### 库管理

```typescript
// 获取库
const libKey = registry.getLibraryKey('mylib', 'abc123'); // => 'mylib:abc123'
const lib = registry.getLibrary(libKey);

// 添加/更新/删除库
registry.addLibrary(libraryInfo);
registry.updateLibrary(libKey, { lastAccess: new Date().toISOString() });
registry.removeLibrary(libKey);

// 列出所有库
const libraries = registry.listLibraries();

// 获取无引用的库
const unreferenced = registry.getUnreferencedLibraries();
```

#### 引用关系

```typescript
// 添加/移除引用
registry.addReference(libKey, projectHash);
registry.removeReference(libKey, projectHash);

// 获取库的引用列表
const refs = registry.getLibraryReferences(libKey);
```

#### 工具方法

```typescript
// 计算路径 hash
const hash = registry.hashPath('/path/to/project'); // => '1a2b3c4d5e6f'

// 获取原始注册表对象
const raw = registry.getRaw();

// 清理过期项目（路径不存在的）
const staleHashes = await registry.cleanStaleProjects();
```

---

## parser - codepac 解析器

### `findCodepacConfig(projectPath): Promise<string | null>`

查找 codepac 配置文件。按顺序搜索: `3rdparty/codepac-dep.json`, `codepac-dep.json`。

### `parseCodepacDep(configPath): Promise<CodepacDep>`

解析 codepac-dep.json 配置文件。

### `extractDependencies(config): ParsedDependency[]`

从配置中提取依赖列表。

### `parseProjectDependencies(projectPath): Promise<{dependencies, configPath}>`

解析项目依赖（便捷方法）。

```typescript
const { dependencies, configPath } = await parseProjectDependencies('/my/project');
for (const dep of dependencies) {
  console.log(`${dep.libName}@${dep.commit}`);
}
```

### `getRelativeConfigPath(projectPath, configPath): string`

获取配置文件相对于项目的路径。

---

## 类型定义

### DockConfig

```typescript
interface DockConfig {
  version: string;
  initialized: boolean;
  storePath: string;
  cleanStrategy: 'unreferenced' | 'lru' | 'manual';
  maxStoreSize?: number;
  autoDownload: boolean;
}
```

### ProjectInfo

```typescript
interface ProjectInfo {
  path: string;
  configPath: string;
  lastLinked: string;
  platforms: string[];       // 链接的平台列表，如 ['macOS', 'iOS']
  dependencies: DependencyRef[];
}

interface DependencyRef {
  libName: string;
  commit: string;
  platform: string;          // 主平台
  linkedPath: string;
}
```

### LibraryInfo

```typescript
interface LibraryInfo {
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
```

### CodepacDep

```typescript
interface CodepacDep {
  version: string;
  vars?: Record<string, string>;
  repos: {
    common: RepoConfig[];
  };
  actions?: {
    common: ActionConfig[];
  };
}

interface RepoConfig {
  url: string;
  commit: string;
  branch: string;
  dir: string;
  sparse?: object | string;
}
```

### DependencyStatus

```typescript
enum DependencyStatus {
  LINKED = 'LINKED',       // Store 有，项目链接正确
  RELINK = 'RELINK',       // Store 有，项目链接错误
  REPLACE = 'REPLACE',     // Store 有，项目是目录
  ABSORB = 'ABSORB',       // Store 没有，项目有目录
  MISSING = 'MISSING',     // Store 没有，项目也没有
  LINK_NEW = 'LINK_NEW',   // Store 有，项目没有
}
```

---

## platform - 跨平台适配

### 平台选项

```typescript
interface PlatformOption {
  key: string;      // CLI 参数 (mac, ios, android...)
  value: string;    // Store 目录名 (macOS, iOS, android...)
  asan?: string;    // ASAN 变体目录名
  hwasan?: string;  // HWASAN 变体 (仅 android)
}

// 支持的平台列表
const PLATFORM_OPTIONS: PlatformOption[] = [
  { key: 'mac', value: 'macOS', asan: 'macOS-asan' },
  { key: 'win', value: 'Win' },
  { key: 'ios', value: 'iOS', asan: 'iOS-asan' },
  { key: 'android', value: 'android', asan: 'android-asan', hwasan: 'android-hwasan' },
  { key: 'linux', value: 'ubuntu' },
  { key: 'wasm', value: 'wasm' },
  { key: 'ohos', value: 'ohos' },
];

// 平台相关函数
getPlatformOption(key: string): PlatformOption | undefined
getPlatformOptionByValue(value: string): PlatformOption | undefined
platformKeyToValue(key: string): string | undefined
getAllPlatformKeys(): string[]
```

### 路径工具

```typescript
getConfigDir(): string           // 配置目录 (~/.tanmi-dock)
getConfigPath(): string          // 配置文件路径
getRegistryPath(): string        // 注册表文件路径
getPlatform(): 'mac' | 'win'     // 当前系统平台
isWindows(): boolean             // 是否 Windows
isMacOS(): boolean               // 是否 macOS
```

### 路径处理

```typescript
expandHome(p: string): string    // ~ 展开为用户目录
shrinkHome(p: string): string    // 用户目录收缩为 ~
resolvePath(p: string): string   // 解析为绝对路径
normalizePath(p: string): string // 规范化路径
joinPath(...parts: string[]): string
isAbsolutePath(p: string): boolean
```

### 路径安全验证

```typescript
interface PathSafetyResult {
  safe: boolean;
  reason?: string;
}

isPathSafe(p: string): PathSafetyResult   // 检查路径是否安全
ensurePathSafe(p: string): string         // 不安全时抛出错误
```

禁止的路径（防止误操作系统目录）:
- Unix: `/etc`, `/usr`, `/bin`, `/sbin`, `/var`, `/tmp`, `/root`, `/System`
- Windows: `C:\Windows`, `C:\Program Files`, `C:\ProgramData`

---

## transaction - 事务管理

支持 link 操作的原子性，中断后可恢复。

### Transaction 类

```typescript
// 创建并开始事务
const tx = new Transaction('link:/path/to/project');
await tx.begin();

// 记录操作（执行前）
tx.recordOp('link', '/local/path', '/store/path');
tx.recordOp('absorb', '/local/lib', '/store/lib');

// 保存事务进度
await tx.save();

// 提交（删除日志）
await tx.commit();

// 或回滚
const errors = await tx.rollback();
```

### 静态方法

```typescript
Transaction.start(projectPath): Promise<Transaction>  // 创建并开始
Transaction.findPending(): Promise<Transaction | null> // 查找未完成事务
Transaction.recover(id): Promise<Transaction | null>   // 恢复指定事务
Transaction.getPendingTransactions(): Promise<TransactionLog[]>
```

### 操作类型

```typescript
type OperationType = 'link' | 'unlink' | 'move' | 'absorb' | 'replace' | 'download';
```

---

## guard - 初始化守卫

未初始化时阻止命令执行。

```typescript
isInitialized(): Promise<boolean>        // 检查是否已初始化
ensureInitialized(): Promise<void>       // 未初始化时退出进程
getInitStatus(): Promise<InitStatus>     // 获取详细状态
configDirExists(): Promise<boolean>      // 配置目录是否存在
```

### InitStatus

```typescript
interface InitStatus {
  initialized: boolean;
  configExists: boolean;
  storePathExists: boolean;
  storePath?: string;
}
```

---

## disk - 磁盘工具

### 磁盘信息

```typescript
getDiskInfo(): Promise<DiskInfo[]>       // 获取所有磁盘信息
getFreeSpace(path): Promise<number>      // 获取可用空间 (bytes)
hasEnoughSpace(path, bytes): Promise<boolean>
```

### 大小格式化

```typescript
formatSize(bytes: number): string        // 1073741824 => "1.0 GB"
parseSize(str: string): number           // "1.0 GB" => 1073741824
```

### 空间检查

```typescript
interface DiskSpaceCheckResult {
  sufficient: boolean;
  available: number;
  required: number;
  safetyMargin: number;
}

checkDiskSpace(path, required, safetyGB?): Promise<DiskSpaceCheckResult>
```

### Store 路径建议

```typescript
getDefaultStorePaths(): Promise<Array<{
  path: string;
  label: string;
  free: number;
  recommended: boolean;
}>>
```

---

## global-lock - 全局操作锁

防止多个 tanmi-dock 命令同时执行。

```typescript
acquireGlobalLock(): Promise<boolean>    // 获取锁
releaseGlobalLock(): Promise<void>       // 释放锁
isGlobalLocked(): Promise<boolean>       // 检查锁状态

// 推荐：使用包装函数
withGlobalLock<T>(fn: () => Promise<T>): Promise<T>
```

锁配置:
- 位置: `~/.tanmi-dock/tanmi-dock.lock`
- 过期时间: 60 秒（防止进程异常退出后锁不释放）

---

## fs-utils - 文件系统工具

### 目录操作

```typescript
copyDir(src, dest, options?): Promise<void>
copyDirWithProgress(src, dest, totalSize, onProgress?): Promise<void>
getDirSize(dirPath): Promise<number>     // 递归计算大小
ensureDir(dirPath): Promise<void>        // 确保目录存在
removeDir(dirPath): Promise<void>        // 安全删除目录
```

### CopyDirOptions

```typescript
interface CopyDirOptions {
  preserveSymlinks?: boolean;  // 是否保留符号链接（默认 false）
}
```

---

## exit-codes - 退出码

兼容 BSD sysexits.h + 自定义扩展。

```typescript
import { EXIT_CODES, exit, getExitCodeFromError } from './utils/exit-codes.js';

// 带消息退出
exit(EXIT_CODES.NOINPUT, '文件不存在');

// 从错误推断退出码
const code = getExitCodeFromError(err);
```

### 退出码常量

| 码 | 名称 | 说明 |
|----|------|------|
| 0 | SUCCESS | 成功 |
| 1 | GENERAL_ERROR | 一般错误 |
| 2 | MISUSE | 命令行参数错误 |
| 10 | NOT_INITIALIZED | 未初始化 |
| 11 | LOCK_HELD | 锁被占用 |
| 65 | DATAERR | 数据格式错误 |
| 66 | NOINPUT | 输入文件不存在 |
| 74 | IOERR | IO 错误 |
| 77 | NOPERM | 权限不足 |
| 78 | CONFIG | 配置错误 |
| 130 | INTERRUPTED | 被 SIGINT 中断 |
| 143 | TERMINATED | 被 SIGTERM 终止 |
