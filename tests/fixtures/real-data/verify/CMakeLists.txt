cmake_minimum_required(VERSION 3.16)

# =============================================================================
# 库验证脚本
# 用于验证 tanmi-dock 下载的库文件完整性
#
# 使用方法:
#   cmake -DLIB_ROOT=/path/to/.tanmi-dock/store -DPLATFORM=macOS -P CMakeLists.txt
#
# 参数:
#   LIB_ROOT  - 库存储根目录 (默认: ../cache)
#   PLATFORM  - 目标平台 (macOS/Windows/iOS/Android/Linux)
#   SCENARIO  - 测试场景 (project-small-multiplatform/project-large-singleplatform/project-overlap/all)
# =============================================================================

# 默认参数
if(NOT DEFINED LIB_ROOT)
    set(LIB_ROOT "${CMAKE_CURRENT_LIST_DIR}/../cache")
endif()

if(NOT DEFINED PLATFORM)
    set(PLATFORM "macOS")
endif()

if(NOT DEFINED SCENARIO)
    set(SCENARIO "all")
endif()

# 验证计数器
set(VERIFY_PASSED 0)
set(VERIFY_FAILED 0)
set(VERIFY_SKIPPED 0)

# =============================================================================
# verify_library - 验证单个库的完整性
#
# 参数:
#   LIB_NAME   - 库名称
#   COMMIT     - commit hash (7 位短 hash 或完整 hash)
#   TYPE       - 库类型: binary/header-only
#   PLATFORMS  - 支持的平台列表
# =============================================================================
function(verify_library LIB_NAME COMMIT TYPE)
    # 解析可选参数
    set(options "")
    set(oneValueArgs "")
    set(multiValueArgs PLATFORMS)
    cmake_parse_arguments(ARG "${options}" "${oneValueArgs}" "${multiValueArgs}" ${ARGN})

    # 检查平台是否匹配
    if(ARG_PLATFORMS)
        list(FIND ARG_PLATFORMS "${PLATFORM}" PLATFORM_INDEX)
        if(PLATFORM_INDEX EQUAL -1)
            message(STATUS "[SKIP] ${LIB_NAME}@${COMMIT} - 不支持平台 ${PLATFORM}")
            math(EXPR VERIFY_SKIPPED "${VERIFY_SKIPPED} + 1")
            set(VERIFY_SKIPPED ${VERIFY_SKIPPED} PARENT_SCOPE)
            return()
        endif()
    endif()

    # 构造库目录路径
    string(SUBSTRING "${COMMIT}" 0 7 COMMIT_SHORT)
    set(LIB_DIR "${LIB_ROOT}/${LIB_NAME}/${COMMIT_SHORT}/${PLATFORM}")

    # 检查目录是否存在
    if(NOT EXISTS "${LIB_DIR}")
        message(WARNING "[FAIL] ${LIB_NAME}@${COMMIT_SHORT} - 目录不存在: ${LIB_DIR}")
        math(EXPR VERIFY_FAILED "${VERIFY_FAILED} + 1")
        set(VERIFY_FAILED ${VERIFY_FAILED} PARENT_SCOPE)
        return()
    endif()

    # 检查头文件目录
    set(INCLUDE_DIR "${LIB_DIR}/include")
    if(NOT EXISTS "${INCLUDE_DIR}")
        # 尝试其他常见路径
        set(INCLUDE_DIR "${LIB_DIR}/Include")
        if(NOT EXISTS "${INCLUDE_DIR}")
            set(INCLUDE_DIR "")
        endif()
    endif()

    if(TYPE STREQUAL "header-only")
        # header-only 库只需要有头文件
        if(INCLUDE_DIR STREQUAL "")
            message(WARNING "[FAIL] ${LIB_NAME}@${COMMIT_SHORT} - header-only 库缺少 include 目录")
            math(EXPR VERIFY_FAILED "${VERIFY_FAILED} + 1")
            set(VERIFY_FAILED ${VERIFY_FAILED} PARENT_SCOPE)
            return()
        endif()
        message(STATUS "[PASS] ${LIB_NAME}@${COMMIT_SHORT} (header-only)")
        math(EXPR VERIFY_PASSED "${VERIFY_PASSED} + 1")
        set(VERIFY_PASSED ${VERIFY_PASSED} PARENT_SCOPE)
        return()
    endif()

    # binary 库需要检查库文件
    set(LIB_DIR_CHECK "${LIB_DIR}/lib")
    if(NOT EXISTS "${LIB_DIR_CHECK}")
        set(LIB_DIR_CHECK "${LIB_DIR}/Lib")
        if(NOT EXISTS "${LIB_DIR_CHECK}")
            set(LIB_DIR_CHECK "")
        endif()
    endif()

    if(LIB_DIR_CHECK STREQUAL "")
        message(WARNING "[FAIL] ${LIB_NAME}@${COMMIT_SHORT} - 缺少 lib 目录")
        math(EXPR VERIFY_FAILED "${VERIFY_FAILED} + 1")
        set(VERIFY_FAILED ${VERIFY_FAILED} PARENT_SCOPE)
        return()
    endif()

    # 检查是否有库文件
    if(PLATFORM STREQUAL "macOS" OR PLATFORM STREQUAL "iOS")
        file(GLOB LIB_FILES "${LIB_DIR_CHECK}/*.a" "${LIB_DIR_CHECK}/*.dylib" "${LIB_DIR_CHECK}/*.framework")
    elseif(PLATFORM STREQUAL "Windows")
        file(GLOB LIB_FILES "${LIB_DIR_CHECK}/*.lib" "${LIB_DIR_CHECK}/*.dll")
    elseif(PLATFORM STREQUAL "Android")
        file(GLOB LIB_FILES "${LIB_DIR_CHECK}/*.a" "${LIB_DIR_CHECK}/*.so")
    else()
        file(GLOB LIB_FILES "${LIB_DIR_CHECK}/*.a" "${LIB_DIR_CHECK}/*.so")
    endif()

    list(LENGTH LIB_FILES LIB_COUNT)
    if(LIB_COUNT EQUAL 0)
        message(WARNING "[FAIL] ${LIB_NAME}@${COMMIT_SHORT} - lib 目录下无库文件")
        math(EXPR VERIFY_FAILED "${VERIFY_FAILED} + 1")
        set(VERIFY_FAILED ${VERIFY_FAILED} PARENT_SCOPE)
        return()
    endif()

    message(STATUS "[PASS] ${LIB_NAME}@${COMMIT_SHORT} (${LIB_COUNT} files)")
    math(EXPR VERIFY_PASSED "${VERIFY_PASSED} + 1")
    set(VERIFY_PASSED ${VERIFY_PASSED} PARENT_SCOPE)
endfunction()

# =============================================================================
# 场景定义
# =============================================================================

# 场景 1: 小项目多平台
function(verify_scenario_small_multiplatform)
    message(STATUS "")
    message(STATUS "=== 场景 1: project-small-multiplatform ===")

    verify_library(eigen "9df21dc8b4b576a7aa5c0094daa8d7e8b8be60f0" header-only
        PLATFORMS macOS Windows iOS Android Linux)
    verify_library(zlib "e8cbe37af8d9fba43e9e35f1327ace2c69677911" binary
        PLATFORMS macOS Windows iOS Android Linux)
    verify_library(libpng "5fc08173000ad07c34b8b70646a6805e3308d83b" binary
        PLATFORMS macOS Windows iOS Android Linux)
    verify_library(libjpeg "2f2fd6e380412fb8d8da4393e4ac02ed02682d6a" binary
        PLATFORMS macOS Windows iOS Android Linux)
    verify_library(Lz4 "dc1bce25f43c2c888bd1133c3555b443559d523a" binary
        PLATFORMS macOS Windows iOS Android Linux)
    verify_library(libgtest "fbe94c0903c83fbc1d83282e3d62374e27d2a477" binary
        PLATFORMS macOS Windows iOS Android Linux)

    set(VERIFY_PASSED ${VERIFY_PASSED} PARENT_SCOPE)
    set(VERIFY_FAILED ${VERIFY_FAILED} PARENT_SCOPE)
    set(VERIFY_SKIPPED ${VERIFY_SKIPPED} PARENT_SCOPE)
endfunction()

# 场景 2: 大项目单平台
function(verify_scenario_large_singleplatform)
    message(STATUS "")
    message(STATUS "=== 场景 2: project-large-singleplatform ===")

    verify_library(libTSCoreBase "c90859a43cb6f791bc4dc6ed7aee656b02ce9785" binary
        PLATFORMS macOS)
    verify_library(libMemoryPool "283ab95c320fd2287b96ea85b305b7890dade372" binary
        PLATFORMS macOS)
    verify_library(libTSpdlog "a5f9696768d65b3cd303af3cc3b8c1d39bcac741" binary
        PLATFORMS macOS)
    verify_library(libopenssl "b36b0f91f43b8761168c0d1c5e14d27e0e3ef4bb" binary
        PLATFORMS macOS)
    verify_library(eigen "9df21dc8b4b576a7aa5c0094daa8d7e8b8be60f0" header-only
        PLATFORMS macOS)
    verify_library(zlib "e8cbe37af8d9fba43e9e35f1327ace2c69677911" binary
        PLATFORMS macOS)
    verify_library(libpng "5fc08173000ad07c34b8b70646a6805e3308d83b" binary
        PLATFORMS macOS)
    verify_library(libjpeg "2f2fd6e380412fb8d8da4393e4ac02ed02682d6a" binary
        PLATFORMS macOS)
    verify_library(libDngSDK "fa09c947bd21fca3a18c17a08c19c9d180c78d8d" binary
        PLATFORMS macOS)
    verify_library(libImageCodec "9c6358fe648495bf6b7f92b6a9a05e4c26160152" binary
        PLATFORMS macOS)
    verify_library(libTSAI "2fa0a2ae16671831703093b552fa009d6f351c8d" binary
        PLATFORMS macOS)
    verify_library(libgtest "fbe94c0903c83fbc1d83282e3d62374e27d2a477" binary
        PLATFORMS macOS)

    set(VERIFY_PASSED ${VERIFY_PASSED} PARENT_SCOPE)
    set(VERIFY_FAILED ${VERIFY_FAILED} PARENT_SCOPE)
    set(VERIFY_SKIPPED ${VERIFY_SKIPPED} PARENT_SCOPE)
endfunction()

# 场景 3: 重叠项目
function(verify_scenario_overlap)
    message(STATUS "")
    message(STATUS "=== 场景 3: project-overlap ===")

    verify_library(eigen "9df21dc8b4b576a7aa5c0094daa8d7e8b8be60f0" header-only
        PLATFORMS macOS Windows)
    verify_library(zlib "e8cbe37af8d9fba43e9e35f1327ace2c69677911" binary
        PLATFORMS macOS Windows)
    verify_library(libpng "5fc08173000ad07c34b8b70646a6805e3308d83b" binary
        PLATFORMS macOS Windows)
    verify_library(libjpeg "46c4c57efa1c55ad8ccb543a368993094f1bfd8a" binary
        PLATFORMS macOS Windows)
    verify_library(libTSCoreBase "25fabbd39d2b1c55cc122867c9badf60e61e017f" binary
        PLATFORMS macOS Windows)
    verify_library(libTSpdlog "2db4564765c565c00c284d65a7118fb37b56033c" binary
        PLATFORMS macOS Windows)
    verify_library(Lz4 "dc1bce25f43c2c888bd1133c3555b443559d523a" binary
        PLATFORMS macOS Windows)
    verify_library(libgtest "320672d7e6aa297c2eaad03a2c7bb088612ef030" binary
        PLATFORMS macOS Windows)

    set(VERIFY_PASSED ${VERIFY_PASSED} PARENT_SCOPE)
    set(VERIFY_FAILED ${VERIFY_FAILED} PARENT_SCOPE)
    set(VERIFY_SKIPPED ${VERIFY_SKIPPED} PARENT_SCOPE)
endfunction()

# =============================================================================
# 主验证逻辑
# =============================================================================
message(STATUS "")
message(STATUS "========================================")
message(STATUS "Tanmi-Dock 库文件验证")
message(STATUS "========================================")
message(STATUS "LIB_ROOT: ${LIB_ROOT}")
message(STATUS "PLATFORM: ${PLATFORM}")
message(STATUS "SCENARIO: ${SCENARIO}")
message(STATUS "========================================")

if(SCENARIO STREQUAL "all" OR SCENARIO STREQUAL "project-small-multiplatform")
    verify_scenario_small_multiplatform()
endif()

if(SCENARIO STREQUAL "all" OR SCENARIO STREQUAL "project-large-singleplatform")
    verify_scenario_large_singleplatform()
endif()

if(SCENARIO STREQUAL "all" OR SCENARIO STREQUAL "project-overlap")
    verify_scenario_overlap()
endif()

# =============================================================================
# 输出汇总
# =============================================================================
message(STATUS "")
message(STATUS "========================================")
message(STATUS "验证结果汇总")
message(STATUS "========================================")
message(STATUS "通过: ${VERIFY_PASSED}")
message(STATUS "失败: ${VERIFY_FAILED}")
message(STATUS "跳过: ${VERIFY_SKIPPED}")
message(STATUS "========================================")

if(VERIFY_FAILED GREATER 0)
    message(FATAL_ERROR "验证失败：${VERIFY_FAILED} 个库未通过检查")
endif()

message(STATUS "验证完成：所有库通过检查")
