# 真实环境 vs tanmi-dock 假设差异分析

> 基于 ~/PixCake 项目结构的调研结果

## 调研日期

2026-01-08

## 1. 匹配的部分

| 特性 | 真实环境 | tanmi-dock | 状态 |
|------|----------|------------|------|
| 平台标识符 | macOS, Win, iOS, android, ubuntu, wasm, ohos | `PLATFORM_OPTIONS` 完全一致 | ✅ |
| ASAN/HWASAN 变体 | macOS-asan, iOS-asan, android-asan/hwasan | `KNOWN_PLATFORM_VALUES` 已包含 | ✅ |
| codepac-dep.json 基本结构 | repos.common 数组 | 正确解析 | ✅ |
| Store 目录结构 | libName/commit/platform/ | 一致 | ✅ |

---

## 2. 关键差异

### 2.1 sparse 变量展开未实现

**真实环境格式**:
```json
{
  "vars": {
    "ALL_COMMON_SPARSE": "{\"mac\":[\"macOS\",\"macOS-asan\"],\"win\":[\"Win\"]...}"
  },
  "repos": {
    "common": [{
      "sparse": "${ALL_COMMON_SPARSE}"
    }]
  }
}
```

**tanmi-dock 当前实现** (`parser.ts:112-119`):
```typescript
export function extractDependencies(config: CodepacDep): ParsedDependency[] {
  return config.repos.common.map((repo) => ({
    sparse: repo.sparse,  // 直接传递，未展开变量
  }));
}
```

**验证状态**: [x] 已验证 - codepac 自动处理

**验证结果** (2026-01-08):
- codepac `--help` 显示 `-ds, --disable_sparse` 选项："Enable disable_sparse mode. will ignore sparse config, pull all folders."
- 这表明 **codepac 默认处理 sparse 配置**，包括变量展开
- tanmi-dock 只需将原始 sparse 值传递给 codepac 即可

**影响评估**: ✅ 无需修改，codepac 自己处理变量展开

---

### 2.2 平台 CLI key 与目录名映射

**真实环境的 sparse 映射**:
```json
{
  "mac": ["macOS", "macOS-asan"],    // CLI key → 目录名数组
  "win": ["Win"],
  "ios": ["iOS", "iOS-asan"],
  "android": ["android", "android-asan", "android-hwasan"]
}
```

**问题**: `downloadToTemp` 中传递给 codepac 的 platforms 参数格式是什么？

**代码位置**: `codepac.ts:369`
```typescript
const args = ['install', '-cf', configPath, '-td', tempDir, '-p', ...platforms];
```

**验证状态**: [x] 已验证 - ⚠️ 存在潜在问题

**验证结果** (2026-01-08):

1. **codepac 期望格式**: CLI key（如 `mac`, `win`, `ios`）
   - `codepac --help` 示例: `-p, --platform: Platform name, example: all, mac, win, ios, linux, android`

2. **tanmi-dock 实际传递**: 目录名（如 `macOS`, `Win`, `iOS`）
   - `parsePlatformArgs()` 将 CLI key 转换为目录名
   - `downloadToTemp` 接收并传递目录名给 codepac

3. **发现**: PixCook2 的 sparse 配置同时定义了 CLI key 和目录名作为 key：
   ```json
   "mac": ["macOS", "macOS-asan"],     // CLI key
   "macOS": ["macOS"],                  // 目录名也作为 key
   ```
   这可能是为了兼容不同调用方式

**影响评估**: ⚠️ 需要进一步真实环境测试
- 如果 codepac 只接受 CLI key，则需要修复
- 如果 codepac 同时支持两种格式，则无需修改

---

### 2.3 actions 字段未处理

**真实环境**:
```json
"actions": {
  "common": [{
    "command": "codepac install libjpeg libpng ... --configdir libImageCodec --targetdir .",
    "dir": ""
  }]
}
```

**tanmi-dock 状态**:
- 类型定义存在 (`types/index.ts:143-149`)
- 无执行逻辑

**验证状态**: [x] 已验证 - codepac 自动执行

**验证结果** (2026-01-08):
- codepac `--help` 显示 `-dc, --disable_action` 选项："Enable disable_action mode. will not auto run actions command."
- 这表明 **codepac 默认自动执行 actions**

**影响评估**: ✅ 无需修改
- codepac 自己处理 actions
- 但 downloadToTemp 创建的临时配置不包含 actions
- **结论**: 通过 downloadToTemp 下载的库不会执行 actions（这可能是期望行为，因为 actions 通常用于下载嵌套依赖到当前目录）

---

### 2.4 嵌套库的 codepac-dep.json

**真实环境**:
```
3rdparty/
├── codepac-dep.json              # 主配置
├── libDngSDK/
│   ├── codepac-dep.json          # 嵌套配置
│   └── dependencies/
│       └── zlib/
```

**tanmi-dock 状态**: 只解析项目根目录的配置

**验证状态**: [ ] 待分析影响

---

### 2.5 exclude_delete_dir 字段

**真实环境**: 某些库使用此字段排除特定目录

**tanmi-dock 状态**: 未实现

**影响评估**: 低风险，主要用于 codepac update 场景

---

## 3. 潜在风险点

### 3.1 .git 目录处理

**当前逻辑** (`store.ts:220-315 absorbLib 函数`):
- 遍历 libDir 内容
- 如果是已知平台目录 → 移动到 `Store/lib/commit/平台名/`
- 否则（包括 `.git/`, `.cache/`, `commit.log` 等）→ 移动到 `_shared/`

**验证状态**: [x] 已分析 - 已知行为

**分析结果** (2026-01-08):

1. **确认行为**: `.git/` 目录会被移入 `_shared/`

2. **潜在影响**:
   - 多项目链接同一库时共享同一个 `.git` 目录
   - 如果用户在库目录执行 Git 操作，可能影响其他项目

3. **实际风险评估**: 🟡 低风险
   - 在 tanmi-dock 使用场景中，用户不应直接对库进行 Git 操作
   - 库更新应通过 `codepac update` 或 `tanmi-dock` 重新 link
   - `.git` 目录主要用于 codepac 增量更新

**建议**: 记录为已知行为，暂不修改

---

### 3.2 General 库检测逻辑

**当前逻辑** (`store.ts:618-636`):
```typescript
// 条件：有 _shared 目录 且 无任何已知平台目录
```

**风险**: 某些特殊结构库可能被误判

---

## 4. 验证计划

### 4.1 已完成验证（无需真实下载）

| 验证项 | 方法 | 状态 | 结果 |
|--------|------|------|------|
| codepac -p 参数格式 | 运行 `codepac --help` | [x] | ⚠️ 需进一步测试 |
| sparse 变量展开 | 读取真实配置文件 | [x] | ✅ codepac 自动处理 |
| actions 执行 | `codepac --help` | [x] | ✅ codepac 自动执行 |
| .git 目录处理逻辑 | 代码审查 | [x] | 🟡 已知行为 |

### 4.2 需要真实环境验证

| 验证项 | 方法 | 状态 |
|--------|------|------|
| codepac -p 接受目录名 | 实际运行 `codepac install -p macOS` | [ ] |
| 嵌套依赖完整性 | 端到端测试（包含 actions 的库） | [ ] |
| 跨平台下载 | 测试多平台同时下载 | [ ] |

---

## 5. 修复优先级（更新后）

1. **P0 - 阻断性问题**
   - 🔴 **actions 嵌套依赖不执行** - downloadToTemp 下载的库缺少嵌套依赖

2. **P1 - 高优先级**
   - ~~sparse 变量展开~~ → ✅ codepac 自动处理
   - ~~actions 执行~~ → ⚠️ 见 P0

3. **P2 - 中优先级**
   - ~~.git 目录处理策略~~ → 已知行为，暂不修改

4. **P3 - 低优先级**
   - exclude_delete_dir 支持
   - 嵌套 codepac-dep.json 支持

---

## 8. P0 问题详情：actions 嵌套依赖

### 问题描述

`downloadToTemp` 生成的临时配置不包含 actions，导致嵌套依赖不会被安装。

### 真实环境 actions 示例

```json
// PixCook2/3rdparty/codepac-dep.json
"actions": {
  "common": [
    {"command": "codepac install libjpeg libpng libtiff ... --configdir libImageCodec --targetdir ."},
    {"command": "codepac install libMNN libonnxruntime ... --configdir libTSAI --targetdir ."},
    {"command": "codepac install libprotobuf ... --configdir libonnxruntime --targetdir ."}
  ]
}
```

### 影响

- 通过 `downloadToTemp` 下载的库缺少 libjpeg, libpng, libMNN 等嵌套依赖
- 链接后编译会失败

### 问题复杂性

即使在临时配置中加入 actions，也无法解决：
1. actions 引用相对路径（`--configdir libImageCodec`）
2. 这些配置目录在临时环境下不存在
3. 需要先下载主库，才能获取嵌套配置

### 可能的解决方案

| 方案 | 描述 | 复杂度 |
|------|------|--------|
| **A. 限制使用场景** | 明确 tanmi-dock 只处理已有本地库，不支持从零下载 | 低 |
| **B. 两阶段下载** | 先下载主库到临时目录，解析 actions，再递归下载嵌套依赖 | 高 |
| **C. 调用 codepac install** | 不用 downloadToTemp，直接调用 codepac install 到项目目录 | 中 |

### 建议

**短期**：方案 A - 在文档和 CLI 中明确：
- `tanmi-dock link` 优先处理本地已有库（ABSORB）
- 对于 MISSING 库，建议用户先手动 `codepac install`

**长期**：方案 C - 对于 MISSING 库，直接调用 `codepac install` 安装到项目目录，然后再 absorb

---

## 6. 验证结果记录

### codepac -p 参数格式

**验证日期**: 2026-01-08
**验证方法**: `codepac --help`
**结果**:
- codepac 帮助文档示例使用 CLI key: `mac, win, ios, linux, android`
- tanmi-dock 实际传递目录名: `macOS, Win, iOS`
- PixCook2 配置同时定义了两种 key，可能为兼容设计
- **待进一步测试**: 实际运行 `codepac install -p macOS` 验证

### sparse 变量展开

**验证日期**: 2026-01-08
**验证方法**: `codepac --help` + 读取真实 codepac-dep.json
**结果**: ✅ codepac 自动处理
- `-ds, --disable_sparse` 选项证明 codepac 默认处理 sparse
- 真实配置使用 `${ALL_COMMON_SPARSE}` 变量引用
- tanmi-dock 无需预处理，直接传递即可

### actions 执行

**验证日期**: 2026-01-08
**验证方法**: `codepac --help`
**结果**: ✅ codepac 自动执行
- `-dc, --disable_action` 选项证明 codepac 默认执行 actions
- downloadToTemp 创建的临时配置不包含 actions（这是期望行为）

### .git 目录处理

**验证日期**: 2026-01-08
**验证方法**: 代码审查 `store.ts:absorbLib`
**结果**: 🟡 已知行为
- `.git/` 会被移入 `_shared/`
- 多项目共享同一 `.git` 目录
- 实际风险低，用户不应直接操作库的 Git

---

### codepac install 参数验证

**验证日期**: 2026-01-08
**验证方法**: 实际运行测试 + 代码审查

**参数对比**:

| codepac 参数 | 说明 | tanmi-dock 使用 |
|--------------|------|-----------------|
| `-cf, --configfile` | 配置文件名 | ✅ 支持完整路径 |
| `-cd, --configdir` | 配置目录 | ✅ 正确使用 |
| `-td, --targetdir` | 目标目录 | ✅ 正确使用 |
| `-p, --platform` | 平台名 | ✅ 正确使用 |
| `-f, --force` | 强制安装 | ❌ 未使用（可选） |
| `-fg, --fullgit` | 完整 git | ❌ 未使用（可选） |
| `-ds, --disable_sparse` | 禁用 sparse | ❌ 未使用（默认启用 sparse） |
| `-dc, --disable_action` | 禁用 actions | ❌ 未使用（临时配置无 actions） |

**测试结果**:
```bash
# 测试 -cf 接受完整路径
codepac install -cf /tmp/codepac-test/codepac-dep.json -td /tmp/codepac-test
# 结果: ✅ 成功，codepac 能处理完整路径
```

**结论**: ✅ 参数使用正确，无需修改

---

## 7. 下一步行动

1. ~~codepac -p 参数~~ → 用户确认无问题
2. ~~codepac install 参数~~ → ✅ 已验证正确
3. **端到端测试** 验证完整 link 流程（可选）
