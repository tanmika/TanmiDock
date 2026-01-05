/**
 * 事务管理
 * 支持 link 操作的原子性，中断后可恢复
 */
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { getConfigDir } from './platform.js';

/**
 * 操作类型
 */
export type OperationType = 'link' | 'unlink' | 'move' | 'absorb' | 'replace' | 'download';

export interface Operation {
  type: OperationType;
  target: string;
  source?: string;
  backup?: string;
  completed: boolean;
}

/**
 * 事务日志
 */
export interface TransactionLog {
  id: string;
  startTime: string;
  projectPath: string;
  operations: Operation[];
  status: 'pending' | 'committed' | 'rolledback';
}

/**
 * 获取事务目录
 */
function getTransactionDir(): string {
  return path.join(getConfigDir(), 'transactions');
}

/**
 * 获取事务日志路径
 */
function getTransactionPath(id: string): string {
  return path.join(getTransactionDir(), `${id}.json`);
}

/**
 * 生成事务 ID
 */
function generateTransactionId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * 事务管理器
 */
export class Transaction {
  private log: TransactionLog;
  private logPath: string;
  readonly id: string;

  /**
   * 创建新事务实例（需调用 begin() 开始）
   */
  constructor(projectPath: string) {
    const id = generateTransactionId();
    this.id = id;
    this.log = {
      id,
      startTime: new Date().toISOString(),
      projectPath,
      operations: [],
      status: 'pending',
    };
    this.logPath = getTransactionPath(id);
  }

  /**
   * 从现有日志恢复事务（内部用）
   */
  private static fromLog(log: TransactionLog, logPath: string): Transaction {
    const tx = Object.create(Transaction.prototype) as Transaction;
    tx.log = log;
    tx.logPath = logPath;
    (tx as { id: string }).id = log.id;
    return tx;
  }

  /**
   * 开始事务（持久化日志）
   */
  async begin(): Promise<void> {
    const txDir = getTransactionDir();
    await fs.mkdir(txDir, { recursive: true });
    await fs.writeFile(this.logPath, JSON.stringify(this.log, null, 2), 'utf-8');
  }

  /**
   * 静态方法：开始新事务
   */
  static async start(projectPath: string): Promise<Transaction> {
    const tx = new Transaction(projectPath);
    await tx.begin();
    return tx;
  }

  /**
   * 查找第一个未完成事务
   */
  static async findPending(): Promise<Transaction | null> {
    const pending = await Transaction.getPendingTransactions();
    if (pending.length === 0) return null;
    const log = pending[0];
    const logPath = getTransactionPath(log.id);
    return Transaction.fromLog(log, logPath);
  }

  /**
   * 从日志恢复事务
   */
  static async recover(id: string): Promise<Transaction | null> {
    const logPath = getTransactionPath(id);
    try {
      const content = await fs.readFile(logPath, 'utf-8');
      const log = JSON.parse(content) as TransactionLog;
      return Transaction.fromLog(log, logPath);
    } catch {
      return null;
    }
  }

  /**
   * 获取所有未完成事务
   */
  static async getPendingTransactions(): Promise<TransactionLog[]> {
    const txDir = getTransactionDir();
    const pending: TransactionLog[] = [];

    try {
      const files = await fs.readdir(txDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await fs.readFile(path.join(txDir, file), 'utf-8');
          const log = JSON.parse(content) as TransactionLog;
          if (log.status === 'pending') {
            pending.push(log);
          }
        } catch {
          // 忽略损坏的日志文件
        }
      }
    } catch {
      // 目录不存在
    }

    return pending;
  }

  /**
   * 记录操作（执行前调用）
   */
  async recordOperation(op: Omit<Operation, 'completed'>): Promise<void> {
    this.log.operations.push({ ...op, completed: false });
    await this.save();
  }

  /**
   * 简化的操作记录方法
   * @param type 操作类型
   * @param target 目标路径
   * @param source 来源路径（可选）
   */
  recordOp(type: OperationType, target: string, source?: string): void {
    this.log.operations.push({ type, target, source, completed: true });
  }

  /**
   * 标记操作完成
   */
  async markCompleted(index: number): Promise<void> {
    if (index >= 0 && index < this.log.operations.length) {
      this.log.operations[index].completed = true;
      await this.save();
    }
  }

  /**
   * 获取最后一个操作的索引
   */
  getLastOperationIndex(): number {
    return this.log.operations.length - 1;
  }

  /**
   * 提交事务（删除日志）
   */
  async commit(): Promise<void> {
    this.log.status = 'committed';
    try {
      await fs.unlink(this.logPath);
    } catch {
      // 日志已删除
    }
  }

  /**
   * 回滚事务
   */
  async rollback(): Promise<string[]> {
    const errors: string[] = [];

    // 逆序回滚已完成的操作
    for (let i = this.log.operations.length - 1; i >= 0; i--) {
      const op = this.log.operations[i];
      if (!op.completed) continue;

      try {
        await this.rollbackOperation(op);
      } catch (err) {
        errors.push(`回滚操作 ${op.type} (${op.target}) 失败: ${(err as Error).message}`);
      }
    }

    this.log.status = 'rolledback';
    await this.save();

    // 回滚完成后删除日志
    if (errors.length === 0) {
      try {
        await fs.unlink(this.logPath);
      } catch {
        // 忽略
      }
    }

    return errors;
  }

  /**
   * 回滚单个操作
   */
  private async rollbackOperation(op: Operation): Promise<void> {
    switch (op.type) {
      case 'link':
        // 删除创建的符号链接
        try {
          const stat = await fs.lstat(op.target);
          if (stat.isSymbolicLink()) {
            await fs.unlink(op.target);
          }
        } catch {
          // 链接不存在
        }
        // 如果有备份，恢复
        if (op.backup) {
          try {
            await fs.rename(op.backup, op.target);
          } catch {
            // 备份不存在
          }
        }
        break;

      case 'unlink':
        // unlink 操作的回滚需要重新创建链接
        if (op.source) {
          await fs.symlink(op.source, op.target, 'dir');
        }
        break;

      case 'move':
      case 'absorb':
        // 移动操作的回滚：移回原位置
        if (op.source) {
          try {
            await fs.rename(op.target, op.source);
          } catch {
            // 目标可能不存在或已被修改
          }
        }
        break;

      case 'replace':
        // replace 删除了原目录并创建了链接，回滚时删除链接
        // 注意：原目录已被删除，无法完全恢复
        try {
          const stat = await fs.lstat(op.target);
          if (stat.isSymbolicLink()) {
            await fs.unlink(op.target);
          }
        } catch {
          // 链接不存在
        }
        break;

      case 'download':
        // download 创建了新目录，回滚时删除
        try {
          await fs.rm(op.target, { recursive: true, force: true });
        } catch {
          // 目录不存在
        }
        break;
    }
  }

  /**
   * 保存事务日志
   */
  async save(): Promise<void> {
    await fs.writeFile(this.logPath, JSON.stringify(this.log, null, 2), 'utf-8');
  }

  /**
   * 获取事务 ID
   */
  getId(): string {
    return this.log.id;
  }

  /**
   * 获取事务状态
   */
  getStatus(): TransactionLog['status'] {
    return this.log.status;
  }

  /**
   * 获取项目路径
   */
  getProjectPath(): string {
    return this.log.projectPath;
  }
}

export default Transaction;
