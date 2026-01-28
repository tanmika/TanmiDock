/**
 * 进度条工具模块
 * 统一封装 cli-progress，提供文件操作和下载的进度反馈
 */
import cliProgress from 'cli-progress';

/**
 * 格式化字节大小为人类可读格式
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * 格式化速度为人类可读格式
 */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * 进度条配置选项
 */
export interface ProgressBarOptions {
  /** 操作名称，显示在进度条前 */
  name?: string;
  /** 总大小 (bytes)，不提供则为不确定模式 */
  total?: number;
  /** 是否显示速度 */
  showSpeed?: boolean;
  /** 进度条宽度（字符数），默认 40 */
  barWidth?: number;
}

/** 不确定模式下移动方块的宽度 */
const MARQUEE_BLOCK_WIDTH = 6;

/**
 * 生成移动方块动画条（Windows XP 风格）
 * @param position 当前位置 (0 到 barWidth)
 * @param barWidth 进度条总宽度
 * @returns 动画条字符串
 */
export function generateMarqueeBar(position: number, barWidth: number): string {
  const blockWidth = MARQUEE_BLOCK_WIDTH;
  const result: string[] = [];

  for (let i = 0; i < barWidth; i++) {
    // 方块位置范围: [position, position + blockWidth)
    // 使用循环模式，方块可以从右边"环绕"到左边
    const inBlock =
      (i >= position && i < position + blockWidth) ||
      (position + blockWidth > barWidth && i < (position + blockWidth) % barWidth);

    result.push(inBlock ? '█' : '░');
  }

  return result.join('');
}

/**
 * 构建进度条格式字符串
 */
function buildProgressFormat(options: ProgressBarOptions): string {
  const { name, total, showSpeed = false } = options;
  const hasTotal = total !== undefined && total > 0;

  let format: string;
  if (hasTotal) {
    // 确定模式：显示百分比
    format = name
      ? `${name} {bar} {percentage}% | {current} / {total}`
      : '{bar} {percentage}% | {current} / {total}';
    if (showSpeed) {
      format += ' | {speed}';
    }
  } else {
    // 不确定模式：使用自定义动画条
    format = name
      ? `${name} {animBar} | {current}`
      : '{animBar} | {current}';
    if (showSpeed) {
      format += ' | {speed}';
    }
  }

  return format;
}

/**
 * 创建文件操作进度条
 *
 * 确定模式: [name] ████████░░ 45% | 100 MB / 220 MB
 * 不确定模式: [name] ░░░███░░░░░░░ | 100 MB | 2.3 MB/s (移动方块动画)
 */
export function createProgressBar(options: ProgressBarOptions = {}): cliProgress.SingleBar {
  const { barWidth = 40 } = options;
  const format = buildProgressFormat(options);

  const bar = new cliProgress.SingleBar({
    format,
    barCompleteChar: '█',
    barIncompleteChar: '░',
    barsize: barWidth,
    hideCursor: true,
    clearOnComplete: false,
    stopOnComplete: true,
    forceRedraw: true,
  });

  return bar;
}

/**
 * 多进度条管理器
 * 使用 cli-progress MultiBar 统一管理并行进度条的终端显示
 */
export class MultiBarManager {
  private multibar: cliProgress.MultiBar;

  constructor() {
    this.multibar = new cliProgress.MultiBar({
      barCompleteChar: '█',
      barIncompleteChar: '░',
      hideCursor: true,
      clearOnComplete: false,
      forceRedraw: true,
    });
  }

  getMultiBar(): cliProgress.MultiBar {
    return this.multibar;
  }

  /**
   * 在进度条上方安全输出消息
   */
  log(message: string): void {
    this.multibar.log(message + '\n');
  }

  /**
   * 停止所有进度条
   */
  stop(): void {
    this.multibar.stop();
  }
}

/**
 * 进度追踪器
 * 用于计算速度和管理进度条更新
 */
export class ProgressTracker {
  private bar: cliProgress.SingleBar;
  private multibar: cliProgress.MultiBar | null;
  private startTime: number;
  private lastUpdate: number;
  private lastBytes: number;
  private currentSpeed: number = 0;
  private total: number;
  private hasTotal: boolean;
  private barWidth: number;
  private marqueePosition: number = 0;
  private options: ProgressBarOptions;

  constructor(options: ProgressBarOptions = {}, multibar?: cliProgress.MultiBar) {
    this.multibar = multibar ?? null;
    this.options = options;
    if (multibar) {
      // multibar 模式：先创建占位 bar，start() 时再初始化
      this.bar = null as unknown as cliProgress.SingleBar;
    } else {
      this.bar = createProgressBar(options);
    }
    this.total = options.total ?? 0;
    this.hasTotal = this.total > 0;
    this.barWidth = options.barWidth ?? 40;
    this.startTime = Date.now();
    this.lastUpdate = this.startTime;
    this.lastBytes = 0;
  }

  /**
   * 开始进度条
   */
  start(): void {
    // 重置时间戳，确保速度计算正确
    this.startTime = Date.now();
    this.lastUpdate = this.startTime;
    this.lastBytes = 0;
    this.currentSpeed = 0;
    this.marqueePosition = 0;

    if (this.multibar) {
      // multibar 模式：通过 multibar.create() 创建子进度条
      const format = buildProgressFormat(this.options);
      this.bar = this.multibar.create(100, 0, {
        current: formatBytes(0),
        total: formatBytes(this.total),
        speed: formatSpeed(0),
        animBar: this.hasTotal ? undefined : generateMarqueeBar(0, this.barWidth),
      }, { format, barsize: this.barWidth });
    } else if (this.hasTotal) {
      this.bar.start(100, 0, {
        current: formatBytes(0),
        total: formatBytes(this.total),
        speed: formatSpeed(0),
      });
    } else {
      // 不确定模式：使用移动方块动画
      this.bar.start(100, 0, {
        animBar: generateMarqueeBar(0, this.barWidth),
        current: formatBytes(0),
        speed: formatSpeed(0),
      });
    }
  }

  /**
   * 更新进度
   * @param currentBytes 当前已处理字节数
   * @param forceSpeed 强制更新速度（用于 stop() 时的最后一次更新）
   */
  update(currentBytes: number, forceSpeed: boolean = false): void {
    const now = Date.now();
    const elapsed = (now - this.lastUpdate) / 1000;

    // 计算速度（至少间隔 100ms 更新一次速度，或强制更新）
    // 强制更新时只要 elapsed > 0 就计算速度
    if (elapsed >= 0.1 || (forceSpeed && elapsed > 0)) {
      this.currentSpeed = (currentBytes - this.lastBytes) / elapsed;
      this.lastBytes = currentBytes;
      this.lastUpdate = now;
    }

    if (this.hasTotal) {
      const percentage = Math.min(100, Math.round((currentBytes / this.total) * 100));
      this.bar.update(percentage, {
        current: formatBytes(currentBytes),
        total: formatBytes(this.total),
        speed: formatSpeed(this.currentSpeed),
      });
    } else {
      // 不确定模式：更新移动方块动画
      this.marqueePosition = (this.marqueePosition + 2) % this.barWidth;
      this.bar.update(0, {
        animBar: generateMarqueeBar(this.marqueePosition, this.barWidth),
        current: formatBytes(currentBytes),
        speed: formatSpeed(this.currentSpeed),
      });
    }
  }

  /**
   * 更新总大小（用于下载时获取到实际大小后更新）
   */
  setTotal(total: number): void {
    if (total > 0) {
      this.total = total;
      this.hasTotal = true;
    }
  }

  /**
   * 完成进度条
   */
  stop(): void {
    if (this.hasTotal) {
      this.bar.update(100, {
        current: formatBytes(this.total),
        total: formatBytes(this.total),
        speed: formatSpeed(this.currentSpeed),
      });
    }
    if (this.multibar) {
      this.multibar.remove(this.bar);
    } else {
      this.bar.stop();
    }
  }
}

/**
 * 创建进度回调函数
 * 用于 copyDirWithProgress 等带进度回调的函数
 */
export function createProgressCallback(
  tracker: ProgressTracker
): (copiedBytes: number, totalBytes: number) => void {
  return (copiedBytes: number) => {
    tracker.update(copiedBytes);
  };
}

/**
 * 下载进度监控器选项
 */
export interface DownloadMonitorOptions {
  /** 操作名称 */
  name?: string;
  /** 预估总大小 (bytes)，来自历史记录 */
  estimatedSize?: number;
  /** 目录大小获取函数 */
  getDirSize: (dirPath: string) => Promise<number>;
  /** 更新间隔 (ms)，默认 200ms */
  interval?: number;
  /** 非 TTY 模式下的日志输出间隔 (ms)，默认 10000ms */
  logInterval?: number;
  /** 多进度条管理器，用于并行下载 */
  manager?: MultiBarManager;
}

/**
 * 下载进度监控器
 * 通过定时检查目录大小来监控下载进度
 * TTY 模式：使用进度条
 * 非 TTY 模式：周期性输出日志行（方便 AI 等自动化工具监控）
 */
export class DownloadMonitor {
  private tracker: ProgressTracker | null = null;
  private getDirSize: (dirPath: string) => Promise<number>;
  private interval: number;
  private logInterval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private dirPath: string = '';
  private started: boolean = false;
  private isTTY: boolean;
  private name: string;
  private estimatedSize: number;
  private lastLogTime: number = 0;
  private lastSize: number = 0;
  private lastSizeTime: number = 0;

  constructor(options: DownloadMonitorOptions) {
    this.isTTY = process.stdout.isTTY ?? false;
    this.name = options.name ?? '下载';
    this.estimatedSize = options.estimatedSize ?? 0;
    this.getDirSize = options.getDirSize;
    this.interval = options.interval ?? 200;
    this.logInterval = options.logInterval ?? 10000;

    // TTY 模式下使用进度条
    if (this.isTTY) {
      const multibar = options.manager?.getMultiBar();
      this.tracker = new ProgressTracker({
        name: options.name,
        total: options.estimatedSize,
        showSpeed: true,
      }, multibar);
    }
  }

  /**
   * 开始监控指定目录
   */
  start(dirPath: string): void {
    if (this.started) return;
    this.started = true;
    this.dirPath = dirPath;
    this.lastLogTime = Date.now();
    this.lastSizeTime = Date.now();

    if (this.isTTY && this.tracker) {
      this.tracker.start();
    } else {
      // 非 TTY：输出开始日志
      console.log(`[progress] ${this.name}: 开始下载...`);
    }

    this.timer = setInterval(async () => {
      try {
        const size = await this.getDirSize(this.dirPath);
        this.updateProgress(size);
      } catch {
        // 目录可能不存在，忽略
      }
    }, this.interval);
  }

  /**
   * 更新进度
   */
  private updateProgress(size: number): void {
    const now = Date.now();

    if (this.isTTY && this.tracker) {
      // TTY 模式：更新进度条
      this.tracker.update(size);
    } else {
      // 非 TTY 模式：周期性输出日志
      if (now - this.lastLogTime >= this.logInterval) {
        // 计算速度
        const elapsed = (now - this.lastSizeTime) / 1000;
        const speed = elapsed > 0 ? (size - this.lastSize) / elapsed : 0;

        let progressStr: string;
        if (this.estimatedSize > 0) {
          const percentage = Math.min(100, Math.round((size / this.estimatedSize) * 100));
          progressStr = `${formatBytes(size)} / ${formatBytes(this.estimatedSize)} (${percentage}%)`;
        } else {
          progressStr = formatBytes(size);
        }

        const speedStr = speed > 0 ? ` @ ${formatSpeed(speed)}` : '';
        console.log(`[progress] ${this.name}: ${progressStr}${speedStr}`);

        this.lastLogTime = now;
        this.lastSize = size;
        this.lastSizeTime = now;
      }
    }
  }

  /**
   * 更新预估总大小
   */
  setEstimatedSize(size: number): void {
    this.estimatedSize = size;
    if (this.tracker) {
      this.tracker.setTotal(size);
    }
  }

  /**
   * 停止监控
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // 最后更新一次
    let finalSize = 0;
    if (this.dirPath) {
      try {
        finalSize = await this.getDirSize(this.dirPath);
      } catch {
        // 忽略
      }
    }

    if (this.isTTY && this.tracker) {
      // 强制更新速度，确保最后一次 update 能计算出正确的速度
      this.tracker.update(finalSize, true);
      this.tracker.stop();
    } else {
      // 非 TTY：输出完成日志
      console.log(`[progress] ${this.name}: 完成 (${formatBytes(finalSize)})`);
    }
  }
}

export default {
  formatBytes,
  formatSpeed,
  createProgressBar,
  MultiBarManager,
  ProgressTracker,
  createProgressCallback,
  DownloadMonitor,
};
