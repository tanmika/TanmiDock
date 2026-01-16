# TanmiDock

集中型第三方库链接管理工具 - 通过符号链接统一管理多项目共享的第三方依赖库。

## 为什么使用 TanmiDock？

当你有多个项目共享相同的第三方库（如 OpenCV、FFmpeg、Boost 等）时：

```
项目A/3rdparty/opencv/     →  500MB
项目B/3rdparty/opencv/     →  500MB  （相同内容！）
项目C/3rdparty/opencv/     →  500MB  （又重复了！）
```

使用 TanmiDock 后：

```
Store/opencv/abc123/       →  500MB  （唯一存储）
项目A/3rdparty/opencv/     →  符号链接
项目B/3rdparty/opencv/     →  符号链接
项目C/3rdparty/opencv/     →  符号链接
```

**节省磁盘空间 + 统一管理 + 快速切换**

## 特性

- **集中存储**: 所有第三方库统一存储在 Store 目录，避免重复下载
- **符号链接**: 通过 symlink 链接到项目，节省磁盘空间
- **多平台支持**: macOS / iOS / Android / Windows / Linux / WASM / OHOS
- **按平台下载**: 仅下载所需平台，节省带宽和存储
- **嵌套依赖**: 自动处理库的嵌套依赖
- **智能识别**: 自动识别本地已有库，支持吸收到 Store
- **平台记忆**: 记住上次选择的平台，下次自动应用
- **断链检测**: 自动检测并修复失效的符号链接
- **事务安全**: 操作支持回滚，中断后可恢复
- **自动清理**: 多种清理策略，容量超限时自动提示

## 安装

```bash
# npm 安装
npm install -g tanmi-dock

# 或从源码
git clone https://github.com/tanmika/TanmiDock.git
cd tanmi-dock && npm install && npm run build && npm link
```

## 快速开始

```bash
# 1. 初始化（首次使用）
td init

# 2. 在项目目录执行链接
cd your-project
td link

# 3. 查看状态
td status
```

## 命令速查

| 命令 | 说明 |
|------|------|
| `td init` | 初始化，设置 Store 路径 |
| `td link` | 链接项目依赖 |
| `td link -p mac ios` | 指定平台链接 |
| `td status` | 查看当前项目状态 |
| `td status -s` | 查看 Store 状态 |
| `td projects` | 列出所有已链接项目 |
| `td clean` | 清理无引用的库 |
| `td unlink` | 解除链接，恢复为目录 |
| `td config` | 交互式配置 |
| `td doctor` | 环境诊断 |
| `td verify` | 完整性验证 |
| `td repair` | 修复问题 |
| `td update` | 更新到最新版本 |
| `td migrate <path>` | 迁移 Store 位置 |

**别名**: `td` = `tanmidock` = `tanmi-dock`

## 平台参数

```bash
td link -p mac              # 仅 macOS
td link -p mac ios          # macOS + iOS
td link -p mac ios android  # 多平台
```

| 参数 | 平台 | ASAN 变体 |
|------|------|-----------|
| `mac` | macOS | macOS-asan |
| `win` | Windows | - |
| `ios` | iOS | iOS-asan |
| `android` | Android | android-asan, android-hwasan |
| `linux` | Linux/Ubuntu | - |
| `wasm` | WebAssembly | - |
| `ohos` | OpenHarmony | - |

## 配置

```bash
td config                    # 交互式配置界面
td config get <key>          # 获取配置
td config set <key> <value>  # 设置配置
```

### 配置项

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `storePath` | Store 存储路径 | `~/.tanmi-dock/store` |
| `cleanStrategy` | 清理策略 | `unreferenced` |
| `unreferencedThreshold` | 容量阈值 (capacity 策略) | `10GB` |
| `unusedDays` | 未使用天数 (unused 策略) | `30` |
| `autoDownload` | 自动下载缺失库 | `true` |
| `concurrency` | 并发下载数 | `3` |
| `logLevel` | 日志级别 | `info` |
| `proxy` | 代理设置 | - |

### 清理策略

| 策略 | 说明 |
|------|------|
| `unreferenced` | 清理无项目引用的库（默认） |
| `unused` | 清理超过 N 天未使用的库 |
| `capacity` | 无引用库超过阈值时提示清理 |
| `manual` | 不自动清理 |

## 工作原理

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   项目 A                    Store                           │
│   └── 3rdparty/            └── opencv/abc123/              │
│       └── opencv/ ─────────────→ macOS/                    │
│                                  iOS/                       │
│   项目 B                         _shared/                   │
│   └── 3rdparty/                                            │
│       └── opencv/ ─────────────→ (同上)                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

- **Store**: 中央存储，库的实际文件存放处
- **平台目录**: 符号链接到 Store，节省空间
- **_shared**: 共享文件（cmake、README 等）物理复制到项目

## 常见问题

### Store 占用太大？

```bash
td clean                     # 清理无引用的库
td config set cleanStrategy capacity
td config set unreferencedThreshold 5GB  # 设置阈值
```

### 切换分支后链接失效？

```bash
td link                      # 重新链接会自动修复
```

### 如何查看哪些库没被引用？

```bash
td projects --tree           # 树状显示库引用关系
```

### 如何迁移 Store 到其他磁盘？

```bash
td migrate /Volumes/Data/.tanmi-dock/store
```

## 更多文档

- [CLI 完整文档](docs/CLI.md) - 所有命令的详细参数和示例
- [API 文档](docs/API.md) - 开发者接口文档

## 许可

MIT
