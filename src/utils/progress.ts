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
}

/**
 * 创建文件操作进度条
 *
 * 确定模式: [name] ████████░░ 45% | 100 MB / 220 MB
 * 不确定模式: [name] ████████ | 100 MB | 2.3 MB/s
 */
export function createProgressBar(options: ProgressBarOptions = {}): cliProgress.SingleBar {
  const { name, total, showSpeed = false } = options;
  const hasTotal = total !== undefined && total > 0;

  // 构建格式字符串
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
    // 不确定模式：只显示已处理大小
    format = name
      ? `${name} {bar} | {current}`
      : '{bar} | {current}';
    if (showSpeed) {
      format += ' | {speed}';
    }
  }

  const bar = new cliProgress.SingleBar({
    format,
    barCompleteChar: '█',
    barIncompleteChar: '░',
    hideCursor: true,
    clearOnComplete: false,
    stopOnComplete: true,
    forceRedraw: true,
  });

  return bar;
}

/**
 * 进度追踪器
 * 用于计算速度和管理进度条更新
 */
export class ProgressTracker {
  private bar: cliProgress.SingleBar;
  private startTime: number;
  private lastUpdate: number;
  private lastBytes: number;
  private currentSpeed: number = 0;
  private total: number;
  private hasTotal: boolean;

  constructor(options: ProgressBarOptions = {}) {
    this.bar = createProgressBar(options);
    this.total = options.total ?? 0;
    this.hasTotal = this.total > 0;
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

    if (this.hasTotal) {
      this.bar.start(100, 0, {
        current: formatBytes(0),
        total: formatBytes(this.total),
        speed: formatSpeed(0),
      });
    } else {
      // 不确定模式：使用一个"填充"动画
      this.bar.start(100, 50, {
        current: formatBytes(0),
        speed: formatSpeed(0),
      });
    }
  }

  /**
   * 更新进度
   * @param currentBytes 当前已处理字节数
   */
  update(currentBytes: number): void {
    const now = Date.now();
    const elapsed = (now - this.lastUpdate) / 1000;

    // 计算速度（至少间隔 100ms 更新一次速度）
    if (elapsed >= 0.1) {
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
      // 不确定模式：保持 50% 显示，更新大小和速度
      this.bar.update(50, {
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
    this.bar.stop();
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
  /** 更新间隔 (ms)，默认 500ms */
  interval?: number;
}

/**
 * 下载进度监控器
 * 通过定时检查目录大小来监控下载进度
 */
export class DownloadMonitor {
  private tracker: ProgressTracker;
  private getDirSize: (dirPath: string) => Promise<number>;
  private interval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private dirPath: string = '';
  private started: boolean = false;

  constructor(options: DownloadMonitorOptions) {
    this.tracker = new ProgressTracker({
      name: options.name,
      total: options.estimatedSize,
      showSpeed: true,
    });
    this.getDirSize = options.getDirSize;
    this.interval = options.interval ?? 500;
  }

  /**
   * 开始监控指定目录
   */
  start(dirPath: string): void {
    if (this.started) return;
    this.started = true;
    this.dirPath = dirPath;
    this.tracker.start();

    this.timer = setInterval(async () => {
      try {
        const size = await this.getDirSize(this.dirPath);
        this.tracker.update(size);
      } catch {
        // 目录可能不存在，忽略
      }
    }, this.interval);
  }

  /**
   * 更新预估总大小
   */
  setEstimatedSize(size: number): void {
    this.tracker.setTotal(size);
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
    if (this.dirPath) {
      try {
        const finalSize = await this.getDirSize(this.dirPath);
        this.tracker.update(finalSize);
      } catch {
        // 忽略
      }
    }
    this.tracker.stop();
  }
}

export default {
  formatBytes,
  formatSpeed,
  createProgressBar,
  ProgressTracker,
  createProgressCallback,
  DownloadMonitor,
};
