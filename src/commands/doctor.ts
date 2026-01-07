/**
 * doctor 命令 - 检测环境问题
 */
import fs from 'fs/promises';
import { Command } from 'commander';
import { isCodepacInstalled } from '../core/codepac.js';
import { getDiskInfo, formatSize } from '../utils/disk.js';
import * as config from '../core/config.js';
import { warn, error, success, blank, title } from '../utils/logger.js';

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}

interface DoctorOptions {
  json: boolean;
}

/**
 * 创建 doctor 命令
 */
export function createDoctorCommand(): Command {
  return new Command('doctor')
    .description('检测环境问题')
    .option('--json', '输出 JSON 格式')
    .action(async (options: DoctorOptions) => {
      await runDiagnostics(options);
    });
}

/**
 * 运行诊断
 */
async function runDiagnostics(options: DoctorOptions): Promise<void> {
  if (!options.json) {
    title('TanmiDock 环境诊断');
    blank();
  }

  const results: CheckResult[] = [];

  // 1. 检查 codepac
  const hasCodepac = await isCodepacInstalled();
  results.push({
    name: 'codepac',
    status: hasCodepac ? 'ok' : 'error',
    message: hasCodepac ? '已安装' : '未安装，无法下载库',
  });

  // 2. 检查配置
  const cfg = await config.load();
  results.push({
    name: '配置文件',
    status: cfg ? 'ok' : 'warn',
    message: cfg ? '已初始化' : '未初始化，运行 tanmi-dock init',
  });

  // 3. 检查 Store 目录
  if (cfg?.storePath) {
    try {
      await fs.access(cfg.storePath);
      results.push({
        name: 'Store目录',
        status: 'ok',
        message: cfg.storePath,
      });
    } catch {
      results.push({
        name: 'Store目录',
        status: 'error',
        message: '不存在或无权限',
      });
    }
  }

  // 4. 检查磁盘空间
  const disks = await getDiskInfo();
  const storeDisk = disks.find((d) => cfg?.storePath?.startsWith(d.path));
  if (storeDisk) {
    const lowSpace = storeDisk.free < 5 * 1024 * 1024 * 1024;
    results.push({
      name: '磁盘空间',
      status: lowSpace ? 'warn' : 'ok',
      message: `${formatSize(storeDisk.free)} 可用${lowSpace ? ' (建议 > 5GB)' : ''}`,
    });
  } else if (disks.length > 0) {
    // 使用系统盘信息
    const systemDisk = disks.find((d) => d.isSystem) || disks[0];
    const lowSpace = systemDisk.free < 5 * 1024 * 1024 * 1024;
    results.push({
      name: '磁盘空间',
      status: lowSpace ? 'warn' : 'ok',
      message: `${formatSize(systemDisk.free)} 可用${lowSpace ? ' (建议 > 5GB)' : ''}`,
    });
  }

  // 统计
  const errors = results.filter((r) => r.status === 'error').length;
  const warnings = results.filter((r) => r.status === 'warn').length;

  // JSON 输出
  if (options.json) {
    const output = {
      checks: results,
      summary: {
        total: results.length,
        errors,
        warnings,
        ok: results.length - errors - warnings,
      },
      healthy: errors === 0,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // 输出结果
  for (const r of results) {
    switch (r.status) {
      case 'ok':
        success(`[ok] ${r.name}: ${r.message}`);
        break;
      case 'warn':
        warn(`[warn] ${r.name}: ${r.message}`);
        break;
      case 'error':
        error(`[err] ${r.name}: ${r.message}`);
        break;
    }
  }

  blank();

  if (errors > 0) {
    error(`发现 ${errors} 个错误，${warnings} 个警告`);
  } else if (warnings > 0) {
    warn(`发现 ${warnings} 个警告`);
  } else {
    success('环境正常');
  }
}

export default createDoctorCommand;
