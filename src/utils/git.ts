/**
 * Git 相关工具函数
 * 用于验证本地库的 commit 状态
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import * as logger from './logger.js';

const execFileAsync = promisify(execFile);

/** Git short hash 最小长度 */
const MIN_COMMIT_LENGTH = 7;

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
 * @param expectedCommit 预期的 commit hash（完整 40 字符或至少 7 字符的前缀）
 * @returns 验证结果
 *
 * @example
 * // 完整 hash 匹配
 * await verifyLocalCommit('/path/to/lib', 'abc123def456...')
 * // 返回 { verified: true, actualCommit: 'abc123def456...', reason: 'match' }
 */
export async function verifyLocalCommit(
  localPath: string,
  expectedCommit: string
): Promise<CommitVerifyResult> {
  // Step 0: 验证 expectedCommit 有效性
  if (!expectedCommit || expectedCommit.length < MIN_COMMIT_LENGTH) {
    logger.debug(`verifyLocalCommit: expectedCommit 长度不足 (${expectedCommit?.length || 0} < ${MIN_COMMIT_LENGTH})`);
    return { verified: false, reason: 'no_git' };
  }

  const gitPath = path.join(localPath, '.git');

  // Step 1: 检查 .git 是否存在（可以是目录或文件，支持 worktree）
  try {
    const stat = await fs.stat(gitPath);
    // .git 可以是目录（普通仓库）或文件（worktree）
    if (!stat.isDirectory() && !stat.isFile()) {
      logger.debug(`verifyLocalCommit: ${localPath} 的 .git 既不是目录也不是文件`);
      return { verified: false, reason: 'no_git' };
    }
  } catch {
    // .git 不存在
    logger.debug(`verifyLocalCommit: ${localPath} 无 .git`);
    return { verified: false, reason: 'no_git' };
  }

  // Step 2: 获取当前 commit
  // 优先检查 .git/commit_hash 文件（某些场景下会预存 commit hash）
  let actualCommit: string | undefined;
  const commitHashFile = path.join(gitPath, 'commit_hash');
  try {
    const content = await fs.readFile(commitHashFile, 'utf-8');
    actualCommit = content.trim();
    if (actualCommit && actualCommit.length >= MIN_COMMIT_LENGTH) {
      logger.debug(`verifyLocalCommit: ${localPath} 从 commit_hash 文件获取 commit = ${actualCommit}`);
    } else {
      actualCommit = undefined;
    }
  } catch {
    // commit_hash 文件不存在或读取失败，继续尝试 git 命令
  }

  // 如果 commit_hash 文件没有有效内容，执行 git rev-parse HEAD
  if (!actualCommit) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', localPath, 'rev-parse', 'HEAD'], {
        timeout: 5000, // 5 秒超时
      });
      actualCommit = stdout.trim();
      logger.debug(`verifyLocalCommit: ${localPath} 当前 commit = ${actualCommit}`);
    } catch (error) {
      // git 命令执行失败，视为 no_git
      logger.debug(
        `verifyLocalCommit: git rev-parse 失败 - ${error instanceof Error ? error.message : String(error)}`
      );
      return { verified: false, reason: 'no_git' };
    }
  }

  // Step 3: 比较 commit（单向前缀匹配：actual 以 expected 开头）
  const normalizedExpected = expectedCommit.toLowerCase();
  const normalizedActual = actualCommit.toLowerCase();

  // 单向匹配：实际 commit 必须以预期 commit 开头
  const isMatch = normalizedActual.startsWith(normalizedExpected);

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
