# TanmiDock

集中型第三方库链接管理工具 - 通过符号链接统一管理多项目共享的第三方依赖库。

## 特性

- **集中存储**: 所有第三方库统一存储在一个 Store 目录，避免重复下载
- **符号链接**: 通过 symlink 将 Store 中的库链接到项目目录，节省磁盘空间
- **跨平台**: 支持 macOS 和 Windows
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
  path                 项目路径（默认当前目录）

选项:
  -p, --platform <platform>  指定平台 (mac/win)
  -y, --yes                  跳过确认提示
  --no-download              不自动下载缺失库
  --dry-run                  只显示将要执行的操作
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
  -y, --yes     跳过确认提示
```

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
- macOS: `~/.config/tanmi-dock/config.json`
- Windows: `%APPDATA%\tanmi-dock\config.json`

配置项:
- `storePath`: Store 存储路径
- `cleanStrategy`: 清理策略 (`unreferenced` | `lru` | `manual`)
- `autoDownload`: 是否自动下载缺失库

## 目录结构

```
Store/
├── lib-name-1/
│   ├── abc1234/    # commit hash
│   │   └── ...     # 库内容
│   └── def5678/
└── lib-name-2/
    └── 1a2b3c4/
```

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
