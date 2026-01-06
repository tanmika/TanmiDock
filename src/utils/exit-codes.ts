/**
 * 标准化退出码
 * 兼容 BSD sysexits.h + 自定义扩展
 */

export const EXIT_CODES = {
  // 标准退出码
  SUCCESS: 0, // 成功
  GENERAL_ERROR: 1, // 一般错误
  MISUSE: 2, // 命令行参数错误

  // 自定义退出码 (10-63)
  NOT_INITIALIZED: 10, // 未初始化
  LOCK_HELD: 11, // 锁被占用

  // BSD sysexits.h (64-78)
  DATAERR: 65, // 数据格式错误
  NOINPUT: 66, // 输入文件不存在
  NOUSER: 67, // 用户不存在
  NOHOST: 68, // 主机不存在
  UNAVAILABLE: 69, // 服务不可用
  SOFTWARE: 70, // 内部软件错误
  OSERR: 71, // 系统错误
  OSFILE: 72, // 系统文件缺失
  CANTCREAT: 73, // 无法创建文件
  IOERR: 74, // IO 错误
  TEMPFAIL: 75, // 临时失败
  PROTOCOL: 76, // 协议错误
  NOPERM: 77, // 权限不足
  CONFIG: 78, // 配置错误

  // 信号退出码 (128+signal)
  INTERRUPTED: 130, // 被 SIGINT 中断 (128+2)
  TERMINATED: 143, // 被 SIGTERM 终止 (128+15)
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * 退出码描述
 */
export const EXIT_CODE_DESCRIPTIONS: Record<ExitCode, string> = {
  [EXIT_CODES.SUCCESS]: '成功',
  [EXIT_CODES.GENERAL_ERROR]: '一般错误',
  [EXIT_CODES.MISUSE]: '命令行参数错误',
  [EXIT_CODES.NOT_INITIALIZED]: '未初始化',
  [EXIT_CODES.LOCK_HELD]: '锁被占用',
  [EXIT_CODES.DATAERR]: '数据格式错误',
  [EXIT_CODES.NOINPUT]: '输入文件不存在',
  [EXIT_CODES.NOUSER]: '用户不存在',
  [EXIT_CODES.NOHOST]: '主机不存在',
  [EXIT_CODES.UNAVAILABLE]: '服务不可用',
  [EXIT_CODES.SOFTWARE]: '内部软件错误',
  [EXIT_CODES.OSERR]: '系统错误',
  [EXIT_CODES.OSFILE]: '系统文件缺失',
  [EXIT_CODES.CANTCREAT]: '无法创建文件',
  [EXIT_CODES.IOERR]: 'IO 错误',
  [EXIT_CODES.TEMPFAIL]: '临时失败',
  [EXIT_CODES.PROTOCOL]: '协议错误',
  [EXIT_CODES.NOPERM]: '权限不足',
  [EXIT_CODES.CONFIG]: '配置错误',
  [EXIT_CODES.INTERRUPTED]: '被中断',
  [EXIT_CODES.TERMINATED]: '被终止',
};

/**
 * 带消息的退出
 */
export function exit(code: ExitCode, message?: string): never {
  if (message) {
    const prefix = code === EXIT_CODES.SUCCESS ? '[ok]' : '[err]';
    console.error(`${prefix} ${message}`);
  }
  process.exit(code);
}

/**
 * 根据错误类型获取退出码
 */
export function getExitCodeFromError(err: Error): ExitCode {
  const message = err.message.toLowerCase();

  if (message.includes('permission') || message.includes('eacces')) {
    return EXIT_CODES.NOPERM;
  }
  if (message.includes('enoent') || message.includes('not found') || message.includes('不存在')) {
    return EXIT_CODES.NOINPUT;
  }
  if (message.includes('config') || message.includes('配置')) {
    return EXIT_CODES.CONFIG;
  }
  if (message.includes('lock') || message.includes('锁')) {
    return EXIT_CODES.LOCK_HELD;
  }
  if (message.includes('初始化') || message.includes('not initialized')) {
    return EXIT_CODES.NOT_INITIALIZED;
  }

  return EXIT_CODES.GENERAL_ERROR;
}

export default EXIT_CODES;
