/**
 * Git 相关工具函数
 * 用于验证本地库的 commit 状态
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import * as logger from './logger.js';

const execAsync = promisify(exec);

export type VerifyReason = 'match' | 'mismatch' | 'no_git';

export interface CommitVerifyResult {
  verified: boolean;
  actualCommit?: string;
  reason: VerifyReason;
}

/**
 * 验证本地目录的 git commit 是否与预期一致
 *
 * @param localPath 本地目录路径
 * @param expectedCommit 预期的 commit hash（支持短 hash 前缀匹配）
 * @returns 验证结果
 *
 * @example
 * // 完整 hash 匹配
 * await verifyLocalCommit('/path/to/lib', 'abc123def456...')
 * // 返回 { verified: true, actualCommit: 'abc123def456...', reason: 'match' }
 *
 * @example
 * // 短 hash 前缀匹配
 * await verifyLocalCommit('/path/to/lib', 'abc123')
 * // 如果实际 commit 以 abc123 开头，返回 match
 */
export async function verifyLocalCommit(
  localPath: string,
  expectedCommit: string
): Promise<CommitVerifyResult> {
  const gitDir = path.join(localPath, '.git');

  // Step 1: 检查 .git 目录是否存在
  try {
    const stat = await fs.stat(gitDir);
    if (!stat.isDirectory()) {
      logger.debug(`verifyLocalCommit: ${localPath} 的 .git 不是目录`);
      return { verified: false, reason: 'no_git' };
    }
  } catch {
    // .git 不存在
    logger.debug(`verifyLocalCommit: ${localPath} 无 .git 目录`);
    return { verified: false, reason: 'no_git' };
  }

  // Step 2: 执行 git rev-parse HEAD 获取当前 commit
  let actualCommit: string;
  try {
    const { stdout } = await execAsync(`git -C "${localPath}" rev-parse HEAD`);
    actualCommit = stdout.trim();
    logger.debug(`verifyLocalCommit: ${localPath} 当前 commit = ${actualCommit}`);
  } catch (error) {
    // git 命令执行失败，视为 no_git
    logger.debug(
      `verifyLocalCommit: git rev-parse 失败 - ${error instanceof Error ? error.message : String(error)}`
    );
    return { verified: false, reason: 'no_git' };
  }

  // Step 3: 比较 commit（支持前缀匹配）
  const normalizedExpected = expectedCommit.toLowerCase();
  const normalizedActual = actualCommit.toLowerCase();

  // 前缀匹配：短 hash 或完整 hash 都支持
  const isMatch =
    normalizedActual.startsWith(normalizedExpected) ||
    normalizedExpected.startsWith(normalizedActual);

  if (isMatch) {
    logger.debug(`verifyLocalCommit: commit 匹配 (expected=${expectedCommit})`);
    return { verified: true, actualCommit, reason: 'match' };
  } else {
    logger.debug(
      `verifyLocalCommit: commit 不匹配 (expected=${expectedCommit}, actual=${actualCommit})`
    );
    return { verified: false, actualCommit, reason: 'mismatch' };
  }
}

export default {
  verifyLocalCommit,
};
