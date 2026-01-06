# TanmiDock

集中型第三方库链接管理工具 - 通过符号链接统一管理多项目共享的第三方依赖库。

## 特性

- **集中存储**: 所有第三方库统一存储在一个 Store 目录，避免重复下载
- **符号链接**: 通过 symlink 将 Store 中的库链接到项目目录，节省磁盘空间
- **多平台支持**: 支持 macOS/iOS/Android/Windows/Linux/WASM/OHOS 等平台，可同时选择多个平台
- **按平台下载**: 仅下载所需平台的内容，节省带宽和存储空间
- **智能识别**: 自动识别已有库，支持吸收本地库到 Store
- **事务安全**: link 操作支持事务回滚，中断后可恢复
- **文件锁**: 防止并发操作导致数据损坏

## 安装

```bash
# 克隆仓库
git clone <repo-url>
cd tanmi-dock

# 安装依赖
npm install

# 构建
npm run build

# 全局安装（可选）
npm link
```

## 快速开始

```bash
# 1. 初始化（首次使用）
tanmi-dock init

# 2. 在项目目录执行链接
cd your-project
tanmi-dock link

# 3. 查看状态
tanmi-dock status
```

## 命令

### `init` - 初始化

首次使用前初始化 TanmiDock，设置 Store 存储路径。

```bash
tanmi-dock init [options]

选项:
  --store-path <path>  直接指定存储路径（跳过交互）
  -y, --yes            使用默认设置
```

### `link` - 链接依赖

解析项目的 `codepac-dep.json` 配置，将依赖库链接到项目。

```bash
tanmi-dock link [path] [options]

参数:
  path                       项目路径（默认当前目录）

选项:
  -p, --platform <platforms...>  指定平台，可多选 (mac/ios/android/win/linux/wasm/ohos)
  -y, --yes                      跳过确认提示
  --no-download                  不自动下载缺失库
  --dry-run                      只显示将要执行的操作

示例:
  tanmi-dock link                    # 交互式选择平台
  tanmi-dock link -p mac             # 仅 macOS
  tanmi-dock link -p mac ios         # macOS + iOS
  tanmi-dock link -p mac ios android # 多平台
```

依赖状态处理:
- **LINKED**: 已正确链接，跳过
- **RELINK**: 链接目标错误，重建链接
- **REPLACE**: 本地是目录但 Store 已有，替换为链接
- **ABSORB**: 本地有目录但 Store 没有，移入 Store 并创建链接
- **MISSING**: 本地和 Store 都没有，需要下载
- **LINK_NEW**: Store 有但本地没有，创建链接

### `status` - 查看状态

显示当前项目或 Store 的状态信息。

```bash
tanmi-dock status [options]

选项:
  -s, --store   显示 Store 状态
  -a, --all     显示所有详细信息
```

### `projects` - 项目管理

列出所有已注册的项目。

```bash
tanmi-dock projects [options]

选项:
  -a, --all     显示详细信息
```

### `clean` - 清理

清理未被引用的库，释放磁盘空间。

```bash
tanmi-dock clean [options]

选项:
  -y, --yes     跳过确认提示
  --dry-run     只显示将要清理的内容
```

### `unlink` - 解除链接

解除项目依赖的符号链接，恢复为普通目录。

```bash
tanmi-dock unlink [path] [options]

参数:
  path          项目路径（默认当前目录）

选项:
  -y, --yes     跳过确认提示
```

### `config` - 配置管理

查看或修改配置。

```bash
tanmi-dock config [key] [value]

参数:
  key           配置项名称
  value         配置值（不提供则显示当前值）

示例:
  tanmi-dock config              # 显示所有配置
  tanmi-dock config storePath    # 显示 storePath
  tanmi-dock config autoDownload false  # 设置 autoDownload
```

### `migrate` - 迁移 Store

将 Store 迁移到新位置。

```bash
tanmi-dock migrate <newPath> [options]

参数:
  newPath       新的 Store 路径

选项:
  --force       跳过确认提示
  --keep-old    保留旧目录（默认删除）
```

### `doctor` - 环境诊断

检测运行环境问题。

```bash
tanmi-dock doctor [options]

选项:
  --json        输出 JSON 格式
```

检测内容:
- codepac 是否已安装
- 配置文件是否存在
- Store 目录是否可访问
- 磁盘空间是否充足

### `verify` - 完整性验证

验证 Store 和 Registry 的完整性。

```bash
tanmi-dock verify
```

检测内容:
- **悬挂链接**: 符号链接指向的目标不存在
- **孤立库**: Store 中存在但 Registry 未记录的库
- **缺失库**: Registry 记录但 Store 中不存在的库
- **无效项目**: 已注册但路径不存在的项目

### `repair` - 修复问题

修复 verify 检测到的问题。

```bash
tanmi-dock repair [options]

选项:
  --dry-run     只显示将执行的操作
  --prune       删除孤立库（默认登记到 Registry）
  --force       跳过确认提示
```

修复操作:
- 清理过期项目记录
- 移除悬挂的符号链接
- 登记或删除孤立库

## 配置文件

### codepac-dep.json

项目依赖配置文件，定义需要链接的第三方库。

```json
{
  "version": "1.0.0",
  "vars": {
    "LIBS_ROOT": "../3rdparty"
  },
  "repos": {
    "common": [
      {
        "url": "https://github.com/user/repo.git",
        "commit": "abc1234",
        "branch": "main",
        "dir": "${LIBS_ROOT}/repo"
      }
    ]
  }
}
```

### 全局配置

配置文件位置:
- macOS/Linux: `~/.tanmi-dock/config.json`
- Windows: `%USERPROFILE%\.tanmi-dock\config.json`

配置项:
- `storePath`: Store 存储路径
- `cleanStrategy`: 清理策略 (`unreferenced` | `lru` | `manual`)
- `autoDownload`: 是否自动下载缺失库

## 目录结构

```
Store/
├── lib-name-1/
│   └── abc1234/           # commit hash
│       ├── macOS/         # macOS 平台内容
│       ├── iOS/           # iOS 平台内容
│       └── android/       # Android 平台内容
└── lib-name-2/
    └── def5678/
        ├── macOS/
        └── Win/
```

> **说明**: 每个库按 `库名/commit/平台` 的结构存储，支持同一库多平台共存。

## 开发

```bash
# 开发模式运行
npm run dev

# 运行测试
npm test

# 测试覆盖率
npm run test:coverage

# 代码检查
npm run lint

# 代码格式化
npm run format
```

## 技术栈

- TypeScript
- Commander.js (CLI 框架)
- Vitest (测试框架)
- ESLint + Prettier (代码质量)

## 许可

MIT
