# TanmiDock CLI 交互文档

本文档详细描述 TanmiDock 的所有 CLI 命令、参数、交互流程和输出示例。

## 目录

- [全局选项](#全局选项)
- [init - 初始化](#init---初始化)
- [link - 链接依赖](#link---链接依赖)
- [status - 查看状态](#status---查看状态)
- [projects - 项目列表](#projects---项目列表)
- [clean - 清理库](#clean---清理库)
- [unlink - 取消链接](#unlink---取消链接)
- [config - 配置管理](#config---配置管理)
- [migrate - 迁移 Store](#migrate---迁移-store)
- [check - 健康检查](#check---健康检查)
- [退出码](#退出码)

---

## 全局选项

所有命令都支持以下全局选项：

```bash
tanmi-dock [command] [options]

选项:
  -v, --verbose    输出详细信息
  -V, --version    显示版本号
  -h, --help       显示帮助信息
```

---

## init - 初始化

首次使用前初始化 TanmiDock，设置 Store 存储路径。

### 语法

```bash
tanmi-dock init [options]
```

### 选项

| 选项 | 说明 |
|------|------|
| `--store-path <path>` | 直接指定存储路径（跳过交互） |
| `-y, --yes` | 使用默认设置 |

### 交互流程

#### 1. 完整交互模式

```bash
$ tanmi-dock init

╭─ TanmiDock 初始化 ─╮

磁盘空间:
  系统盘 (系统盘): 125.3 GB 可用
  Data (/Volumes/Data): 456.7 GB 可用

? 选择存储位置: (Use arrow keys)
❯ /Volumes/Data/.tanmi-dock/store (456.7 GB 可用) (推荐)
  ~/.tanmi-dock/store (125.3 GB 可用)
  自定义路径...

? 确认使用路径 '/Volumes/Data/.tanmi-dock/store'? (Y/n) y

[ok] 目录已创建: /Volumes/Data/.tanmi-dock/store
[ok] 配置已保存: ~/.tanmi-dock/config.json

────────────────────
[ok] 初始化完成
[hint] 运行 tanmi-dock link . 开始使用
```

#### 2. 使用默认设置

```bash
$ tanmi-dock init -y

╭─ TanmiDock 初始化 ─╮

[info] 使用默认路径: ~/.tanmi-dock/store
[ok] 目录已创建: ~/.tanmi-dock/store
[ok] 配置已保存: ~/.tanmi-dock/config.json

────────────────────
[ok] 初始化完成
[hint] 运行 tanmi-dock link . 开始使用
```

#### 3. 指定路径

```bash
$ tanmi-dock init --store-path ~/my-store

╭─ TanmiDock 初始化 ─╮

[ok] 目录已创建: ~/my-store
[ok] 配置已保存: ~/.tanmi-dock/config.json

────────────────────
[ok] 初始化完成
```

#### 4. 已初始化时

```bash
$ tanmi-dock init

[warn] TanmiDock 已初始化
[info] Store 路径: ~/.tanmi-dock/store
[hint] 使用 tanmi-dock config 查看或修改配置
```

---

## link - 链接依赖

解析项目的 `codepac-dep.json` 配置，将依赖库链接到中央 Store。

### 语法

```bash
tanmi-dock link [path] [options]
```

### 参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `path` | 项目路径 | `.`（当前目录） |

### 选项

| 选项 | 说明 |
|------|------|
| `-p, --platform <platforms...>` | 指定平台，可多选 (`mac`/`ios`/`android`/`win`/`linux`/`wasm`/`ohos`) |
| `-y, --yes` | 跳过确认提示 |
| `--no-download` | 不自动下载缺失库 |
| `--dry-run` | 只显示将要执行的操作 |
| `--no-submodules` | 不检测 git submodule 依赖 |

### 支持的平台

| CLI 参数 | Store 目录名 | ASAN 变体 | 说明 |
|----------|-------------|-----------|------|
| `mac` | `macOS` | `macOS-asan` | macOS 桌面 |
| `ios` | `iOS` | `iOS-asan` | iOS 移动端 |
| `android` | `android` | `android-asan`, `android-hwasan` | Android 移动端 |
| `win` | `Win` | - | Windows 桌面 |
| `linux` | `ubuntu` | - | Linux/Ubuntu |
| `wasm` | `wasm` | - | WebAssembly |
| `ohos` | `ohos` | - | OpenHarmony |

### 依赖状态

| 状态 | 说明 | 操作 |
|------|------|------|
| `LINKED` | 已正确链接 | 跳过 |
| `RELINK` | 链接目标错误 | 重建链接 |
| `REPLACE` | 本地是目录，Store 已有 | 删除目录，创建链接 |
| `ABSORB` | 本地有目录，Store 没有 | 移入 Store，创建链接 |
| `MISSING` | 都没有 | 下载到 Store，创建链接 |
| `LINK_NEW` | Store 有，本地没有 | 创建链接 |

### 交互流程

#### 0. 平台选择（交互模式）

未指定 `-p` 参数时，会显示平台选择界面：

```bash
$ tanmi-dock link

? 请选择需要的平台: (Press <space> to select, <a> to toggle all)
❯ ◯ macOS
  ◯   └─ macOS-asan
  ◯ Win
  ◯ iOS
  ◯   └─ iOS-asan
  ◯ android
  ◯   └─ android-asan
  ◯   └─ android-hwasan
  ◯ ubuntu
  ◯ wasm
  ◯ ohos
  ──────────────
  ◯ [+] 自定义输入...

# 选择后继续执行链接
[info] 分析 /Users/dev/my-project
[info] 找到 5 个依赖，平台: macOS, iOS
```

#### 1. 基本链接（指定平台）

```bash
$ tanmi-dock link -p mac

[info] 分析 /Users/dev/my-project
[info] 找到 5 个依赖，平台: macOS

[ok] opencv (a1b2c3d) - 创建链接
[ok] boost (e4f5g6h) - 创建链接
[hint] ffmpeg (i7j8k9l) - 本地已有，移入 Store
[ok] zlib (m0n1o2p) - Store 已有，创建链接

────────────────────
[info] 完成: 链接 4 个库
[info] 本次节省: 1.2 GB
[info] Store 总计: 5.6 GB
```

#### 2. 有缺失库需要下载（多平台）

```bash
$ tanmi-dock link -p mac ios

[info] 分析 /Users/dev/my-project
[info] 找到 3 个依赖，平台: macOS, iOS

[info] 发现 2 个缺失库需要下载:
  - newlib (x1y2z3a)
  - otherlib (b4c5d6e)

? 是否下载以上 2 个库? (Y/n) y

[info] 开始并行下载 2 个库 × 2 个平台 (最多 3 个并发)...

[info] 下载 newlib [macOS, iOS]...
[info] 下载 otherlib [macOS, iOS]...
[ok] newlib (x1y2z3a) - 下载完成 [macOS, iOS]
[ok] otherlib (b4c5d6e) - 下载完成 [macOS, iOS]

[info] 下载完成: 2/2 个库

────────────────────
[info] 完成: 链接 3 个库
[info] Store 总计: 8.2 GB
```

> **注意**: 多平台下载时，每个库会下载所有选中的平台。如果某个平台不可用，会跳过并提示。

#### 3. Dry-run 模式

```bash
$ tanmi-dock link --dry-run

[info] 分析 /Users/dev/my-project
[info] 找到 5 个依赖，平台: macOS

[dry-run] 以下操作将被执行:

  [跳过] opencv (a1b2c3d) - 已链接
  [重建] boost (e4f5g6h) - 链接错误
  [替换] ffmpeg (i7j8k9l) - Store 已有
  [吸收] zlib (m0n1o2p) - 移入 Store
  [缺失] newlib (x1y2z3a) - 需要下载

────────────────────
[info] 统计: 跳过 1, 重建 1, 替换 1, 吸收 1, 缺失 1, 新建 0
[hint] 移除 --dry-run 选项以执行实际操作
```

#### 4. 跳过下载

```bash
$ tanmi-dock link --no-download

[info] 分析 /Users/dev/my-project
[info] 找到 3 个依赖，平台: macOS

[ok] opencv (a1b2c3d) - 创建链接
[warn] newlib (x1y2z3a) - 缺失 (跳过下载)

────────────────────
[info] 完成: 链接 1 个库
```

#### 5. 事务恢复

```bash
$ tanmi-dock link

[warn] 发现未完成的事务 (a1b2c3d4)
[info] 正在尝试回滚...
[ok] 事务回滚完成

[info] 分析 /Users/dev/my-project
...
```

#### 6. Git Submodule 支持

`td link` 自动检测项目中的 git submodule，如果子模块也包含 `codepac-dep.json`，会提示一并链接：

```bash
$ tanmi-dock link -p mac

? 选择要一并链接的子模块: (按 a 全选/全不选)
  ◉ InstantSDK (6 个库)

[info] 链接主项目...
[info] 链接子模块: InstantSDK

────────────────────
[info] 主项目: 40 个库
[info] InstantSDK: 6 个库
[info] 完成: 共链接 46 个库
```

**检测机制**：

- 读取项目根目录的 `.gitmodules` 文件（纯文本解析，不依赖 git 命令）
- 检查每个 submodule 路径下是否存在 `codepac-dep.json`
- 支持递归嵌套（子模块中的子模块，最深 5 层）

**各模式行为**：

| 模式 | 行为 |
|------|------|
| TTY 交互 | 显示 checkbox 选择界面，支持 `a` 全选 |
| `--yes` | 自动包含所有 submodule |
| `--no-submodules` | 跳过 submodule 检测 |
| 非 TTY 无 `--yes` | 报错，提示使用 `--yes` 或 `--no-submodules` |

**与其他命令的交互**：

- `td status`：自动检测并分组显示子模块依赖状态
- `td unlink`：自动还原所有链接（包括子模块的链接路径）

---

## status - 查看状态

显示当前项目的链接状态。

### 语法

```bash
tanmi-dock status [path] [options]
```

### 参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `path` | 项目路径 | `.`（当前目录） |

### 选项

| 选项 | 说明 |
|------|------|
| `--json` | 输出 JSON 格式 |

### 交互流程

#### 1. 正常状态

```bash
$ tanmi-dock status

╭─ 项目: ~/my-project ─╮
最后链接: 2026-01-05 14:30
平台: macOS

依赖状态 (5 个):
  [ok] 已链接: 5
```

#### 2. 有问题的状态

```bash
$ tanmi-dock status

╭─ 项目: ~/my-project ─╮
最后链接: 2026-01-03 10:15
平台: macOS

依赖状态 (5 个):
  [ok] 已链接: 3
  [warn] 链接失效: 1
  [warn] 未链接: 1

链接失效的库:
  - boost (e4f5g6h)

未链接的库:
  - newlib (x1y2z3a) - 不存在

────────────────────
[hint] 运行 tanmi-dock link . 更新链接
```

#### 3. JSON 输出

```bash
$ tanmi-dock status --json

{
  "project": "/Users/dev/my-project",
  "lastLinked": "2026-01-05T06:30:00.000Z",
  "platform": "mac",
  "dependencies": {
    "total": 5,
    "linked": 3,
    "broken": 1,
    "unlinked": 1
  },
  "brokenList": ["boost (e4f5g6h)"],
  "unlinkedList": ["newlib (x1y2z3a) - 不存在"]
}
```

---

## projects - 项目列表

显示所有已跟踪的项目。

### 语法

```bash
tanmi-dock projects [options]
```

### 选项

| 选项 | 说明 |
|------|------|
| `--tree` | 树状展示库引用关系 |
| `--json` | JSON 格式输出 |

### 交互流程

#### 1. 列表视图

```bash
$ tanmi-dock projects

╭─ 已跟踪项目 (3 个): ─╮

  1. ~/project-a
     最后链接: 2026-01-05 14:30
     依赖: 5 个

  2. ~/project-b
     最后链接: 2026-01-04 09:15
     依赖: 3 个

  3. ~/old-project
     最后链接: 2025-12-20 16:45
     依赖: 2 个
     [warn] 路径不存在（项目可能已删除）
```

#### 2. 树状视图

```bash
$ tanmi-dock projects --tree

╭─ Store: 5.6 GB (8 个库) ─╮

├── opencv (a1b2c3d) - 1.2 GB
│   ├── ~/project-a
│   └── ~/project-b
├── boost (e4f5g6h) - 800.5 MB
│   └── ~/project-a
├── ffmpeg (i7j8k9l) - 2.1 GB
│   └── ~/project-b
└── [warn] zlib (m0n1o2p) - 50.3 MB
    (无项目引用)
```

#### 3. 无项目时

```bash
$ tanmi-dock projects

[info] 暂无已跟踪的项目

[info] 使用 tanmi-dock link <path> 链接项目
```

---

## clean - 清理库

清理无引用的库，释放磁盘空间。

### 语法

```bash
tanmi-dock clean [options]
```

### 选项

| 选项 | 说明 |
|------|------|
| `--dry-run` | 只显示将要清理的内容 |
| `--force` | 跳过确认提示 |

### 交互流程

#### 1. 正常清理

```bash
$ tanmi-dock clean

[info] 扫描 Store...
[info] 清理了 1 个无效项目引用

╭─ 将清理 (unreferenced 策略): ─╮
  - zlib/m0n1o2p (50.3 MB) - 无项目引用
  - oldlib/q3r4s5t (120.8 MB) - 无项目引用

[info] 总计释放: 171.1 MB

? 确认清理以上 2 个库 (171.1 MB)? (y/N) y

────────────────────
[info] 正在清理...

[ok] 清理完成: 删除 2 个库，释放 171.1 MB
```

#### 2. Dry-run 模式

```bash
$ tanmi-dock clean --dry-run

[info] 扫描 Store...

╭─ 将清理 (unreferenced 策略): ─╮
  - zlib/m0n1o2p (50.3 MB) - 无项目引用

[info] 总计释放: 50.3 MB

[hint] 运行 tanmi-dock clean 执行清理
```

#### 3. 无需清理

```bash
$ tanmi-dock clean

[info] 扫描 Store...
[ok] 没有需要清理的库
```

---

## unlink - 取消链接

取消项目的链接，将符号链接还原为普通目录。

### 语法

```bash
tanmi-dock unlink [path] [options]
```

### 参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `path` | 项目路径 | `.`（当前目录） |

### 选项

| 选项 | 说明 |
|------|------|
| `--remove` | 同时从 Store 删除无其他引用的库 |

### 交互流程

#### 1. 基本取消链接

```bash
$ tanmi-dock unlink

[info] 取消链接: ~/my-project

[ok] opencv (a1b2c3d) - 已还原
[ok] boost (e4f5g6h) - 已还原
[ok] ffmpeg (i7j8k9l) - 已还原

────────────────────
[ok] 完成: 还原 3 个链接
```

#### 2. 同时删除无引用库

```bash
$ tanmi-dock unlink --remove

[info] 取消链接: ~/my-project

[ok] opencv (a1b2c3d) - 已还原
[ok] boost (e4f5g6h) - 已还原
[hint] boost (e4f5g6h) - 已从 Store 删除

────────────────────
[ok] 完成: 还原 2 个链接
[info] 从 Store 删除 1 个库
```

---

## config - 配置管理

查看或修改配置。

### 语法

```bash
tanmi-dock config                  # 显示所有配置
tanmi-dock config get <key>        # 获取配置项
tanmi-dock config set <key> <value> # 设置配置项
```

### 配置项

| 配置项 | 类型 | 说明 | 可修改 |
|--------|------|------|--------|
| `version` | string | 配置版本 | 否 |
| `storePath` | string | Store 路径 | 是 |
| `cleanStrategy` | string | 清理策略 | 是 |
| `unusedDays` | number | 未使用天数阈值 | 是 |
| `unreferencedThreshold` | string | 无引用容量阈值，格式如 `10GB` | 是 |
| `maxStoreSize` | number | 最大存储大小，保留旧配置兼容 | 是 |
| `autoDownload` | boolean | 自动下载 | 是 |
| `gitLightweightDownload` | boolean | Git 非完整拉取，可有效降低空间消耗 | 是 |
| `sharedSymlinkFolders` | boolean | `_shared` 一级目录是否优先使用符号链接 | 是 |
| `concurrency` | number | 并发下载数 | 是 |
| `logLevel` | string | 日志级别 | 是 |
| `proxy` | object | HTTP/HTTPS 代理配置 | 是 |
| `unverifiedLocalStrategy` | string | 本地库无法验证 commit 时的处理策略 | 是 |

`sharedSymlinkFolders` 控制 `_shared` 一级目录的默认处理方式：
- 开启时，一级目录优先使用符号链接，普通文件继续复制
- 关闭时，`_shared` 内容统一复制到项目目录
- 主要用于排查构建工具对符号链接目录的兼容性问题

### cleanStrategy 值

- `unreferenced` - 清理无引用的库（默认）
- `unused` - 长期未使用时清理
- `capacity` - 占用空间超限时清理
- `manual` - 手动清理

### 交互流程

#### 1. 显示所有配置

```bash
$ tanmi-dock config

╭─ TanmiDock 配置: ─╮

  version: 1.2.0
  initialized: true
  storePath: ~/.tanmi-dock/store
  cleanStrategy: unreferenced
  unusedDays: 30
  autoDownload: true
  Git 轻量下载: 是
  共享目录符号链接: 是

配置文件: ~/.tanmi-dock/config.json
```

#### 2. 获取单个配置

```bash
$ tanmi-dock config get sharedSymlinkFolders

true
```

#### 3. 设置配置

```bash
$ tanmi-dock config set sharedSymlinkFolders false

[ok] 配置已更新: sharedSymlinkFolders = false
```

```bash
$ tanmi-dock config set gitLightweightDownload false

[ok] 配置已更新: gitLightweightDownload = false
```

#### 4. 无效配置项

```bash
$ tanmi-dock config get invalidKey

[err] 无效的配置项: invalidKey
[info] 有效的配置项: version, initialized, storePath, cleanStrategy, unusedDays, unreferencedThreshold, maxStoreSize, autoDownload, gitLightweightDownload, sharedSymlinkFolders, concurrency, logLevel, proxy, unverifiedLocalStrategy
```

---

## migrate - 迁移 Store

将 Store 迁移到新位置。

### 语法

```bash
tanmi-dock migrate <new-path> [options]
```

### 参数

| 参数 | 说明 |
|------|------|
| `new-path` | 新的存储路径 |

### 选项

| 选项 | 说明 |
|------|------|
| `--force` | 跳过确认提示 |
| `--keep-old` | 保留旧目录（默认删除） |

### 交互流程

#### 1. 预览迁移

```bash
$ tanmi-dock migrate /Volumes/Data/.tanmi-dock/store

╭─ 迁移 Store ─╮

[info] 当前位置: ~/.tanmi-dock/store (5.6 GB, 8 个库)
[info] 目标位置: /Volumes/Data/.tanmi-dock/store

检查:
  [ok] 目标路径可写
  [ok] 目标空间充足 (456.7 GB 可用)
  [info] 3 个项目的符号链接需要更新

[warn] 使用 --force 选项确认迁移
```

#### 2. 执行迁移

```bash
$ tanmi-dock migrate /Volumes/Data/.tanmi-dock/store --force

╭─ 迁移 Store ─╮

[info] 当前位置: ~/.tanmi-dock/store (5.6 GB, 8 个库)
[info] 目标位置: /Volumes/Data/.tanmi-dock/store

检查:
  [ok] 目标路径可写
  [ok] 目标空间充足 (456.7 GB 可用)
  [info] 3 个项目的符号链接需要更新

────────────────────
[1/3] 复制文件...
[████████████████████████████████████████] 100% | 5.6 GB / 5.6 GB

[2/3] 更新符号链接...
  [ok] ~/project-a (5 个链接)
  [ok] ~/project-b (3 个链接)
  [ok] ~/project-c (2 个链接)

[3/3] 清理旧目录...
  [ok] 已删除 ~/.tanmi-dock/store

[ok] 迁移完成
```

#### 3. 保留旧目录

```bash
$ tanmi-dock migrate /new/path --force --keep-old

...
[3/3] 保留旧目录

[ok] 迁移完成
```

---

## check - 健康检查

合并环境诊断、数据一致性验证和修复能力。

### 语法

```bash
tanmi-dock check [options]
```

### 选项

| 选项 | 说明 |
|------|------|
| `--json` | 输出 JSON 格式 |
| `--fix` | 直接修复所有可修复问题 |
| `--dry-run` | 只显示问题，不执行修复 |
| `--force` | 跳过确认 |
| `--integrity` | 校验 Store 文件完整性 |

### 检测项目

| 项目 | 说明 |
|------|------|
| codepac | 检查 CodePac 命令、Git 版本、Git LFS、`codepac --version` |
| 配置文件 | 检查配置是否存在 |
| Store目录 | 检查 Store 目录是否可访问 |
| 磁盘空间 | 检查可用空间是否充足 |
| 项目记录 | 检查 Registry 中登记项目是否仍存在 |
| 符号链接 | 检查项目依赖链接是否悬挂 |
| 孤立库 | 检查 Store 中未登记的库 |
| 缺失库 | 检查项目依赖对应 Store 内容是否缺失 |
| 引用关系 | 检查 Store 与项目引用是否一致 |
| Store 完整性 | 在 `--integrity` 下校验文件数量、大小和内容哈希 |

### 交互流程

#### 1. 正常状态

```bash
$ tanmi-dock check

TanmiDock 健康检查

环境状态
────────────────────
[✓] codepac    Version 2.0.56
[✓] 配置文件      已初始化
[✓] Store 目录    ~/.tanmi-dock/store
[✓] 磁盘空间      125.3 GB 可用

数据一致性
────────────────────
[✓] 项目记录      完整
[✓] 符号链接      完整
[✓] 孤立库       无
[✓] 缺失库       无
[✓] 引用关系      一致
[✓] Store 完整性  完整

[ok] 系统健康，无问题
```

#### 2. 有问题

```bash
$ tanmi-dock check

TanmiDock 健康检查

环境状态
────────────────────
[✗] codepac    Git 版本不足(2.21.0 < 2.22.0)；Git LFS 不可用
  - Git: Git 版本需不低于 2.22.0，当前 2.21.0
  - Git LFS: Git LFS 不可用
[✓] 配置文件      已初始化
[✓] Store 目录    ~/.tanmi-dock/store
[!] 磁盘空间      3.2 GB 可用 (建议 > 5GB)

数据一致性
────────────────────
[✓] 项目记录      完整
[✓] 符号链接      完整
[✓] 孤立库       无
[!] 缺失库       1 个 (需 td link 下载)
[✓] 引用关系      一致
[✓] Store 完整性  完整

[warn] 发现问题: 1 个环境错误, 1 个警告, 1 个数据问题
```

#### 3. JSON 输出

```bash
$ tanmi-dock check --json

{
  "environment": {
    "codepac": {
      "ok": true,
      "message": "Version 2.0.56",
      "details": {
        "codepacCommand": { "ok": true },
        "git": { "ok": true, "version": "2.40.0", "minimumVersion": "2.22.0" },
        "gitLfs": { "ok": true },
        "codepacVersion": { "ok": true, "version": "Version 2.0.56" }
      }
    }
  },
  "integrity": {
    "invalidProjects": [],
    "danglingLinks": [],
    "orphanLibraries": [],
    "missingLibraries": [],
    "staleReferences": [],
    "corruptedStores": []
  },
  "summary": { "envErrors": 0, "envWarnings": 0, "integrityIssues": 0, "reclaimableSize": 0 }
}
```

### 修复操作

| 问题类型 | 修复操作 |
|----------|----------|
| 过期项目 | 从 Registry 中清理 |
| 悬挂链接 | 移除符号链接，更新项目依赖 |
| 孤立库 | 删除无引用 Store 内容 |
| 失效引用 | 从 StoreEntry 中移除失效项目引用 |
| 损坏 Store | 删除损坏平台目录或整个损坏 commit 缓存 |

#### 4. Dry-run 模式

```bash
$ tanmi-dock check --dry-run

[warn] 发现问题: 2 个数据问题
[hint] 运行 td check --fix 修复问题
```

#### 5. 执行修复

```bash
$ tanmi-dock check --fix

────────────────────
[info] 正在修复...

[ok] 清理过期项目: ~/deleted-project
[ok] 移除悬挂链接: ~/project-a/3rdparty/oldlib
[ok] 清理孤立库: orphanlib/a1b2c3d

────────────────────
[ok] 修复完成: 3 个问题已解决
```

#### 6. 无问题

```bash
$ tanmi-dock check

[ok] 系统健康，无问题
```

---

## 退出码

TanmiDock 使用标准化退出码，便于脚本集成。

### 标准退出码

| 码 | 名称 | 说明 |
|----|------|------|
| 0 | SUCCESS | 成功 |
| 1 | GENERAL_ERROR | 一般错误 |
| 2 | MISUSE | 命令行参数错误 |

### 自定义退出码

| 码 | 名称 | 说明 |
|----|------|------|
| 10 | NOT_INITIALIZED | 未初始化 |
| 11 | LOCK_HELD | 锁被占用（另一个命令正在执行） |

### BSD sysexits.h 兼容

| 码 | 名称 | 说明 |
|----|------|------|
| 65 | DATAERR | 数据格式错误 |
| 66 | NOINPUT | 输入文件/路径不存在 |
| 74 | IOERR | IO 错误（如磁盘空间不足） |
| 77 | NOPERM | 权限不足 |
| 78 | CONFIG | 配置错误 |

### 信号退出码

| 码 | 名称 | 说明 |
|----|------|------|
| 130 | INTERRUPTED | 被 SIGINT (Ctrl+C) 中断 |
| 143 | TERMINATED | 被 SIGTERM 终止 |

### 脚本示例

```bash
#!/bin/bash

tanmi-dock link .
exit_code=$?

case $exit_code in
  0)   echo "链接成功" ;;
  10)  echo "请先运行 tanmi-dock init" ;;
  11)  echo "另一个命令正在执行，请稍后重试" ;;
  66)  echo "项目路径不存在" ;;
  74)  echo "磁盘空间不足" ;;
  130) echo "操作被用户取消" ;;
  *)   echo "发生错误: $exit_code" ;;
esac
```

---

## 信号处理

TanmiDock 支持优雅退出，收到中断信号时会自动回滚未完成的事务。

### SIGINT (Ctrl+C)

```bash
$ tanmi-dock link
[info] 下载 large-lib...
^C
[info] 收到 SIGINT 信号，正在清理...
[info] 正在回滚未完成事务...
[ok] 事务已回滚
```

### SIGTERM

进程被终止时同样会尝试回滚事务。

---

## 全局锁

TanmiDock 使用全局锁防止并发执行冲突。

```bash
# 终端 1
$ tanmi-dock link
[info] 下载中...

# 终端 2（同时执行）
$ tanmi-dock link
[err] 另一个 tanmi-dock 命令正在执行，请稍后重试
```

锁会在命令完成或异常退出后自动释放。如果进程异常退出，锁会在 60 秒后自动过期。
