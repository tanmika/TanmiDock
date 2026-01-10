# 真实测试库数据

> 所有集成测试必须使用这些真实库数据，不再使用模拟数据。

## Git 服务器

- **内部 GitLab**: `git@git.inner.truesightai.com`
- **Source 仓库前缀**: `TSPublicSource/`
- **Binary 仓库前缀**: `TSPublicBinary/`

---

## 测试库清单

### 1. eigen - General 库 (源码型)

| 属性 | 值 |
|------|-----|
| **类型** | General (纯 _shared，无平台目录) |
| **仓库** | `git@git.inner.truesightai.com:TSPublicSource/eigen.git` |
| **大小** | ~19MB |
| **特点** | 纯 C++ 头文件库，无需编译 |

**可用版本:**
| 分支 | Commit | 用途 |
|------|--------|------|
| `3.4` | `9df21dc8b4b576a7aa5c0094daa8d7e8b8be60f0` | 当前版本 |
| `3.3` | `02f420012a169ed9267a8a78083aaa588e713353` | 版本降级测试 |
| `3.2` | `ed5cd0a4d16e12daa1bef608628c103e67969d63` | 多版本测试 |

**Store 结构:**
```
eigen/{commit}/
└── _shared/           # 完整源码
    ├── .git/
    ├── Eigen/         # 头文件目录
    ├── CMakeLists.txt
    └── ...
```

---

### 2. Lz4 - 多平台库

| 属性 | 值 |
|------|-----|
| **类型** | Platform-Specific (多平台二进制) |
| **仓库** | `git@git.inner.truesightai.com:TSPublicBinary/3rdparty/Lz4.git` |
| **大小** | ~620KB |
| **特点** | 标准多平台库，有 macOS/iOS/android 目录 |

**可用版本:**
| 分支 | Commit | 用途 |
|------|--------|------|
| `ts_dev` | `dc1bce25f43c2c888bd1133c3555b443559d523a` | 当前版本 |
| `master` | `dc7917972f5ebd96e638412841eae1626dc254af` | 分支切换测试 |

**Store 结构:**
```
Lz4/{commit}/
├── _shared/
│   ├── .git/
│   ├── FindLz4.cmake
│   └── README.md
├── macOS/
│   └── usr/
│       ├── include/    # lz4.h, lz4frame.h, lz4hc.h
│       └── lib/        # liblz4.a
├── iOS/
│   └── usr/
│       ├── include/
│       └── lib/
└── android/
    ├── arm64-v8a/
    │   └── usr/
    │       ├── include/
    │       └── lib/
    └── armeabi-v7a/
        └── usr/
            ├── include/
            └── lib/
```

**Sparse 配置 (来自 codepac-dep.json):**
```json
{
  "sparse": "${ALL_COMMON_SPARSE}"
}
// ALL_COMMON_SPARSE = {"mac":["macOS"],"ios":["iOS"],"android":["android"],...}
```

---

### 3. virboxprotect - General 库 (二进制型)

| 属性 | 值 |
|------|-----|
| **类型** | General (只有 _shared) |
| **仓库** | `git@git.inner.truesightai.com:TSPublicBinary/3rdparty/virboxprotect.git` |
| **大小** | ~124KB |
| **特点** | 小体积 General 库，适合快速测试 |

**可用版本:**
| 分支 | Commit | 用途 |
|------|--------|------|
| `master` | `73d374bae0640cf895fb007cbf0a4ac540238d7e` | PixCook 当前使用 |
| `master` (新) | `5bb67335c95803f0392937ec12d0d85aef4353ff` | 最新版本 |

**Store 结构:**
```
virboxprotect/{commit}/
└── _shared/
    ├── .git/
    ├── FindVirbox.cmake
    └── README.md
```

---

### 4. pthreads - Windows 专用库

| 属性 | 值 |
|------|-----|
| **类型** | General (Windows only) |
| **仓库** | `git@git.inner.truesightai.com:TSPublicBinary/3rdparty/pthreads.git` |
| **大小** | macOS 下为空 |
| **特点** | 测试"平台不适用"场景 |

**可用版本:**
| 分支 | Commit | 用途 |
|------|--------|------|
| `develop` | `a66e21790fc16c66650aca42cb2c8c53f4b9fca1` | 当前版本 |
| `master` | `c311d3003a3cb9ff3936bf10d52f84fb4a19f09d` | 版本切换测试 |

**注意:** 在 macOS 上下载后目录为空，因为只包含 Win 平台文件。

---

### 5. yalantinglibs - 头文件库

| 属性 | 值 |
|------|-----|
| **类型** | Header-only (仅 common/include) |
| **仓库** | `git@git.inner.truesightai.com:TSPublicSource/3rdparty/yalantinglibs.git` |
| **大小** | 较小 |
| **特点** | Sparse 只检出 include 目录 |

**可用版本:**
| 分支 | Commit | 用途 |
|------|--------|------|
| `ts_dev` | `1e1022d2f369f8551a69c74f136692c07a5197d2` | 当前版本 |
| `main` | `2f287f0db7b586c99bc3c12459573cc9f7389319` | 版本切换测试 |

**Sparse 配置:**
```json
{
  "sparse": {
    "common": ["include"]
  }
}
```

---

### 6. libflatbuffers - 混合型库

| 属性 | 值 |
|------|-----|
| **类型** | Mixed (平台目录 + common/include) |
| **仓库** | `git@git.inner.truesightai.com:TSPublicBinary/3rdparty/libflatbuffers.git` |
| **大小** | ~4.2MB |
| **特点** | 复杂 sparse 配置 |

**可用版本:**
| 分支 | Commit | 用途 |
|------|--------|------|
| `master` | `55c4a7021a5d7bb3fdbd585b6bfa16fb2153bc55` | 当前版本 |

**Sparse 配置:**
```json
{
  "sparse": {
    "mac": ["macOS"],
    "win": ["Win"],
    "android": ["android"],
    "common": ["include"]
  }
}
```

**Store 结构:**
```
libflatbuffers/{commit}/
├── _shared/
│   └── include/       # 公共头文件
├── macOS/
│   └── ...           # macOS 二进制
├── Win/
│   └── ...           # Windows 二进制
└── android/
    └── ...           # Android 二进制
```

---

## 测试场景映射

| 场景 | 使用库 | 验证点 |
|------|--------|--------|
| General 库链接 | eigen, virboxprotect | _shared → 项目目录 |
| 多平台库链接 | Lz4 | macOS/iOS/android 目录创建 |
| 混合库链接 | libflatbuffers | common + 平台目录同时处理 |
| 头文件库链接 | yalantinglibs | sparse common/include |
| 版本升级 | eigen 3.3→3.4 | Store 新版本下载，符号链接更新 |
| 版本降级 | eigen 3.4→3.3 | Store 旧版本复用，符号链接更新 |
| 分支切换 | Lz4 ts_dev→master | 不同 commit 处理 |
| Store 复用 | 多项目链接 eigen | 同一 Store 位置多次链接 |
| 平台不适用 | pthreads (macOS) | 空目录处理 |
| 重新下载 | 任意库删除 Store 后 | 自动重新下载 |

---

## codepac-dep.json 示例

**来自 PixCook 的真实配置:**
```json
{
  "version": "2.0.53",
  "vars": {
    "ALL_COMMON_SPARSE": "{\"mac\":[\"macOS\",\"macOS-asan\"],\"ios\":[\"iOS\"],\"android\":[\"android\"]}"
  },
  "repos": {
    "common": [
      {
        "url": "git@git.inner.truesightai.com:TSPublicSource/eigen.git",
        "commit": "9df21dc8b4b576a7aa5c0094daa8d7e8b8be60f0",
        "branch": "3.4",
        "dir": "eigen"
      },
      {
        "url": "git@git.inner.truesightai.com:TSPublicBinary/3rdparty/Lz4.git",
        "commit": "dc1bce25f43c2c888bd1133c3555b443559d523a",
        "branch": "ts_dev",
        "dir": "Lz4",
        "sparse": "${ALL_COMMON_SPARSE}"
      },
      {
        "url": "git@git.inner.truesightai.com:TSPublicBinary/3rdparty/virboxprotect.git",
        "commit": "73d374bae0640cf895fb007cbf0a4ac540238d7e",
        "branch": "master",
        "dir": "virboxprotect"
      }
    ]
  }
}
```

---

## 注意事项

1. **网络依赖**: 测试需要访问内部 GitLab，CI 环境需配置 SSH 密钥
2. **缓存策略**: 首次运行会下载库到 Store，后续测试复用
3. **清理策略**: 测试结束后清理项目目录的符号链接，保留 Store 缓存
4. **体积控制**: eigen 较大 (~19MB)，可考虑用 virboxprotect 替代部分测试
