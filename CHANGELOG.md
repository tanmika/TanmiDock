# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.2] - 2026-01-16

> 注: 0.6.1 发布时遗漏了 build 步骤，此版本为修正发布

## [0.6.1] - 2026-01-16 (已废弃)

### Changed

- **commit 验证优化**: 优先从 `.git/commit_hash` 文件读取 commit hash，避免依赖 git 命令（适用于 CI/CD 等场景）

### Fixed

- **平台不支持时的错误处理**: 当库不支持请求的平台时，正确警告并跳过，不再复制无用的 `_shared` 数据
  - 修复 LINK_NEW/ABSORB/REPLACE/RELINK 四种状态的处理
  - 避免 Store 有库但无请求平台时浪费磁盘空间

## [0.6.0] - 2026-01-16

### Added

- **`update` 命令**: 支持自动更新到最新版本 (`td update`)
- **`capacity` 清理策略**: 无引用库超过阈值时自动提示清理
- **交互式配置界面**: `td config` 无参数时进入可视化配置
- **本地库 commit 验证**: 检测本地库是否与配置匹配，避免链接错误版本
- **嵌套依赖支持**: 自动处理 actions 定义的子依赖
- **平台记忆功能**: 记住上次选择的平台，下次自动应用
- **自动补充缺失平台**: 检测 Store 中已有但未链接的平台，询问是否补充
- **断链检测**: 自动检测失效的符号链接并提示修复
- **进度条**: link 命令显示下载和链接进度
- **配置项扩展**:
  - `unreferencedThreshold`: 无引用容量阈值 (capacity 策略)
  - `concurrency`: 并发下载数 (1/2/3/5/99)
  - `logLevel`: 日志级别 (debug/verbose/info/warn/error)
  - `proxy`: 代理地址 (JSON 格式)
  - `unverifiedLocalStrategy`: 本地库无法验证时的策略
- **link 完成统计**: 显示无引用库总大小，方便决定是否清理
- **动态版本号**: 从 package.json 读取版本，避免硬编码

### Changed

- **命令别名**: `td` = `tanmidock` = `tanmi-dock`
- **config 命令重构**: 改为子命令模式 (`config get/set`)
- **status 命令改进**: 支持直接指定项目路径查看状态
- **帮助信息全中文化**: 所有命令帮助信息改为中文
- **link 后自动同步 cache**: 更新 Registry 中的 lastAccess 时间

### Fixed

- 嵌套依赖链接目录计算修复
- 嵌套依赖 commit 验证逻辑修复
- unlink 正确处理嵌套依赖
- codepac 平台参数转换修复 (CLI key → 目录名)
- General 库（无平台目录）下载处理修复
- 跨文件系统回滚安全性改进
- 进度条显示问题修复
- 重复 link 不再显示虚假节省空间
- 切换分支后平台库被错误识别为 General 库
- downloadToTemp 传递 vars 变量解决 sparse 解析失败
- General 库空 _shared 目录静默成功的问题
- 事务回滚 absorb 参数顺序修复

## [0.5.0-beta.3] - 2026-01-07

### Fixed

- **P0**: unlink 正确清理所有平台的 StoreEntry 引用（遍历 projectInfo.platforms）
- **P2**: MISSING 场景添加 checkPlatformCompleteness 检查，避免重复下载已存在平台

### Added

- `checkPlatformCompleteness()` - 检查 Store 中平台完整性
- `getPlatformHelpText()` - 生成平台帮助信息表格
- absorbLib 返回 `skippedPlatforms` 标识已存在而跳过的平台
- ABSORB 场景支持询问是否吸收额外平台
- registry 新增 `getProjectStoreKeys()` 方法

### Changed

- link 命令帮助信息显示平台映射表
- MISSING/LINK_NEW 场景使用 existing + missing 组合链接

### Tests

- 新增 store.checkPlatformCompleteness 测试用例
- 新增 registry StoreEntry 引用管理测试

## [0.5.0] - 2026-01-07

### Breaking Changes

- Store 结构变更，与 v0.4.x 不兼容
- 旧 Store 数据需删除后重新 link

### Changed

- Store 结构重构: 平台目录和共享文件分离存储
- codepac 调用优化: 一次下载多平台

### Added

- `downloadToTemp()` - 多平台一次性下载
- `absorbLib()` - 智能拆分平台/共享内容
- `linkLib()` - 统一链接逻辑
- Store 版本检测: 自动识别旧结构并提示

### Deprecated

- `installSingle()` → `downloadToTemp()`
- `linkMultiPlatform()` → `linkLib()`
- `linkLibrary()` → `linkLib()`

## [0.4.0] - 2026-01-06

### Added
- **Multi-platform support**: Support for macOS/iOS/Android/Windows/Linux/WASM/OHOS platforms
- **Per-platform download**: Download only required platforms, saving bandwidth and storage
- **Interactive platform selection**: Checkbox UI for selecting multiple platforms
- **Platform CLI options**: `-p mac ios android` for specifying multiple platforms
- `doctor` command - Environment diagnostics
- `verify` command - Store and registry integrity verification
- `repair` command - Auto-fix detected issues
- Interactive prompts using @inquirer/prompts
- `--verbose` option for detailed output
- `--json` option for machine-readable output
- Standardized exit codes (BSD sysexits.h compatible)
- Parallel download with concurrency limit (3)
- Registry lazy loading for better performance

### Changed
- `link -p` now accepts multiple platforms (`-p mac ios` instead of `-p mac`)
- Store structure changed to `lib/commit/platform/` for per-platform storage
- `clean` command supports platform-aware cleanup strategies
- Improved status display with platform information

### Fixed
- Hardcoded 'default' platform replaced with actual platform selection
- Multi-platform linking now uses `linkLibrary()` for proper symlink handling

## [0.3.0] - 2026-01-05

### Added
- SIGINT/SIGTERM signal handling with graceful shutdown
- Global exception handler with DEBUG mode support
- Configuration version checking and migration system
- Path security validation to prevent path traversal attacks
- Global operation lock to prevent concurrent command execution
- Disk space pre-check before download operations

### Changed
- Configuration version bumped to 1.1.0

## [0.2.0] - 2026-01-05

### Added
- Vitest testing framework with coverage support
- File lock mechanism using proper-lockfile
- Transaction system for atomic link operations
- TOCTOU race condition fixes
- fs-utils module for common file operations
- ESLint + Prettier configuration

### Changed
- Improved error handling throughout codebase
- Better code organization with extracted utilities

### Fixed
- Race conditions in concurrent file access
- Link operation atomicity issues

## [0.1.0] - 2026-01-04

### Added
- Initial release
- `init` command - Initialize TanmiDock configuration
- `link` command - Link project dependencies to central store
- `status` command - Show current project status
- `projects` command - List all tracked projects
- `clean` command - Clean unreferenced libraries
- `unlink` command - Remove symlinks from project
- `config` command - View/modify configuration
- `migrate` command - Migrate store to new location
- Central store with symlink-based dependency management
- Cross-platform support (macOS and Windows)
- codepac integration for dependency download

[Unreleased]: https://github.com/user/tanmi-dock/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/user/tanmi-dock/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/user/tanmi-dock/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/user/tanmi-dock/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/user/tanmi-dock/releases/tag/v0.1.0
