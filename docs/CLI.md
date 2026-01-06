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
- [doctor - 环境诊断](#doctor---环境诊断)
- [verify - 完整性验证](#verify---完整性验证)
- [repair - 修复问题](#repair---修复问题)
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
| `autoDownload` | boolean | 自动下载 | 是 |
| `maxStoreSize` | number | 最大存储大小 | 是 |

### cleanStrategy 值

- `unreferenced` - 清理无引用的库（默认）
- `lru` - 最近最少使用
- `manual` - 手动清理

### 交互流程

#### 1. 显示所有配置

```bash
$ tanmi-dock config

╭─ TanmiDock 配置: ─╮

  version: 1.1.0
  storePath: ~/.tanmi-dock/store
  cleanStrategy: unreferenced
  autoDownload: true

配置文件: ~/.tanmi-dock/config.json
```

#### 2. 获取单个配置

```bash
$ tanmi-dock config get storePath

~/.tanmi-dock/store
```

#### 3. 设置配置

```bash
$ tanmi-dock config set autoDownload false

[ok] 配置已更新: autoDownload = false
```

#### 4. 无效配置项

```bash
$ tanmi-dock config get invalidKey

[err] 无效的配置项: invalidKey
[info] 有效的配置项: version, storePath, cleanStrategy, maxStoreSize, autoDownload
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

## doctor - 环境诊断

检测运行环境问题。

### 语法

```bash
tanmi-dock doctor [options]
```

### 选项

| 选项 | 说明 |
|------|------|
| `--json` | 输出 JSON 格式 |

### 检测项目

| 项目 | 说明 |
|------|------|
| codepac | 检查 codepac 是否已安装 |
| 配置文件 | 检查配置是否存在 |
| Store目录 | 检查 Store 目录是否可访问 |
| 磁盘空间 | 检查可用空间是否充足 |

### 交互流程

#### 1. 正常状态

```bash
$ tanmi-dock doctor

╭─ TanmiDock 环境诊断 ─╮

[ok] codepac: 已安装
[ok] 配置文件: 已初始化
[ok] Store目录: ~/.tanmi-dock/store
[ok] 磁盘空间: 125.3 GB 可用

[ok] 环境正常
```

#### 2. 有问题

```bash
$ tanmi-dock doctor

╭─ TanmiDock 环境诊断 ─╮

[err] codepac: 未安装，无法下载库
[ok] 配置文件: 已初始化
[ok] Store目录: ~/.tanmi-dock/store
[warn] 磁盘空间: 3.2 GB 可用 (建议 > 5GB)

[err] 发现 1 个错误，1 个警告
```

#### 3. JSON 输出

```bash
$ tanmi-dock doctor --json

{
  "checks": [
    { "name": "codepac", "status": "ok", "message": "已安装" },
    { "name": "配置文件", "status": "ok", "message": "已初始化" },
    { "name": "Store目录", "status": "ok", "message": "~/.tanmi-dock/store" },
    { "name": "磁盘空间", "status": "ok", "message": "125.3 GB 可用" }
  ],
  "summary": { "total": 4, "errors": 0, "warnings": 0, "ok": 4 },
  "healthy": true
}
```

---

## verify - 完整性验证

验证 Store 和 Registry 的完整性。

### 语法

```bash
tanmi-dock verify
```

### 检测项目

| 项目 | 说明 |
|------|------|
| 悬挂链接 | 符号链接指向的目标不存在 |
| 孤立库 | Store 中有但 Registry 未记录 |
| 缺失库 | Registry 记录但 Store 中不存在 |
| 无效项目 | 已注册但路径不存在的项目 |

### 交互流程

#### 1. 正常状态

```bash
$ tanmi-dock verify

╭─ 验证 Store 完整性 ─╮

[info] 检查项目引用...
[info] 检查孤立库...

────────────────────
[ok] Registry 引用一致
[ok] 符号链接完整
[ok] 无孤立库

[ok] Store 完整性验证通过
```

#### 2. 有问题

```bash
$ tanmi-dock verify

╭─ 验证 Store 完整性 ─╮

[info] 检查项目引用...
[info] 检查孤立库...

────────────────────
[warn] 发现 1 个无效项目
  - ~/deleted-project -> 路径不存在

[warn] 发现 2 个悬挂链接
  - ~/project-a/3rdparty/oldlib -> 目标不存在

[warn] 发现 1 个孤立库 (120.5 MB)
  - orphanlib/a1b2c3d (120.5 MB)

[hint] 建议: 运行 tanmi-dock repair 修复问题
```

---

## repair - 修复问题

修复 verify 检测到的问题。

### 语法

```bash
tanmi-dock repair [options]
```

### 选项

| 选项 | 说明 |
|------|------|
| `--dry-run` | 只显示将执行的操作 |
| `--prune` | 删除孤立库（默认登记到 Registry） |
| `--force` | 跳过确认提示 |

### 修复操作

| 问题类型 | 修复操作 |
|----------|----------|
| 过期项目 | 从 Registry 中清理 |
| 悬挂链接 | 移除符号链接，更新项目依赖 |
| 孤立库 | 登记到 Registry 或删除（`--prune`） |

### 交互流程

#### 1. Dry-run 模式

```bash
$ tanmi-dock repair --dry-run

╭─ 修复 Store 问题 ─╮

[info] 扫描问题...

[info] 发现 4 个问题:
  - 1 个过期项目
  - 2 个悬挂链接
  - 1 个孤立库 (120.5 MB)

────────────────────
[dry-run] 将执行以下操作:

  清理过期项目: ~/deleted-project
  移除悬挂链接: ~/project-a/3rdparty/oldlib
  移除悬挂链接: ~/project-a/3rdparty/another
  登记孤立库: orphanlib/a1b2c3d

[hint] 移除 --dry-run 选项以执行修复
```

#### 2. 执行修复

```bash
$ tanmi-dock repair

╭─ 修复 Store 问题 ─╮

[info] 扫描问题...

[info] 发现 4 个问题:
  - 1 个过期项目
  - 2 个悬挂链接
  - 1 个孤立库 (120.5 MB)

? 确认修复以上 4 个问题? (y/N) y

────────────────────
[info] 正在修复...

[ok] 清理过期项目: ~/deleted-project
[ok] 移除悬挂链接: ~/project-a/3rdparty/oldlib
[ok] 移除悬挂链接: ~/project-a/3rdparty/another
[ok] 登记孤立库: orphanlib/a1b2c3d

────────────────────
[ok] 修复完成: 4 个问题已解决
```

#### 3. 删除孤立库

```bash
$ tanmi-dock repair --prune --force

╭─ 修复 Store 问题 ─╮

[info] 扫描问题...

[info] 发现 1 个问题:
  - 1 个孤立库 (120.5 MB)

────────────────────
[info] 正在修复...

[ok] 删除孤立库: orphanlib/a1b2c3d

────────────────────
[ok] 修复完成: 1 个问题已解决
```

#### 4. 无问题

```bash
$ tanmi-dock repair

╭─ 修复 Store 问题 ─╮

[info] 扫描问题...
[ok] 没有发现需要修复的问题
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
