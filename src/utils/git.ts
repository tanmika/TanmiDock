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

/** commit hash 格式校验 */
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;

export type VerifyReason = 'match' | 'mismatch' | 'no_git';

export interface CommitVerifyResult {
  verified: boolean;
  actualCommit?: string;
  reason: VerifyReason;
}

/**
 * 检测本地目录的 git commit hash
 *
 * 优先读取 .git/commit_hash 文件，回退到 git rev-parse HEAD。
 * 统一了 verifyLocalCommit 和 store.ts 嵌套依赖中的 commit 检测逻辑。
 *
 * @param localPath 本地目录路径
 * @returns commit hash 或 null（无 .git / 检测失败）
 */
export async function detectLocalCommit(localPath: string): Promise<string | null> {
  const gitPath = path.join(localPath, '.git');

  // Step 1: 检查 .git 是否存在（可以是目录或文件，支持 worktree）
  try {
    const stat = await fs.stat(gitPath);
    if (!stat.isDirectory() && !stat.isFile()) {
      logger.debug(`detectLocalCommit: ${localPath} 的 .git 既不是目录也不是文件`);
      return null;
    }
  } catch {
    logger.debug(`detectLocalCommit: ${localPath} 无 .git`);
    return null;
  }

  // Step 2: 优先检查 .git/commit_hash 文件
  const commitHashFile = path.join(gitPath, 'commit_hash');
  try {
    const content = await fs.readFile(commitHashFile, 'utf-8');
    const hash = content.trim();
    if (hash && COMMIT_HASH_PATTERN.test(hash)) {
      logger.debug(`detectLocalCommit: ${localPath} 从 commit_hash 文件获取 commit = ${hash}`);
      return hash;
    }
  } catch {
    // commit_hash 文件不存在或读取失败，继续尝试 git 命令
  }

  // Step 3: 回退到 git rev-parse HEAD
  try {
    const { stdout } = await execFileAsync('git', ['-C', localPath, 'rev-parse', 'HEAD'], {
      timeout: 5000,
    });
    const hash = stdout.trim();
    if (hash && COMMIT_HASH_PATTERN.test(hash)) {
      logger.debug(`detectLocalCommit: ${localPath} 当前 commit = ${hash}`);
      return hash;
    }
    logger.debug(`detectLocalCommit: git rev-parse 返回无效 hash: ${hash}`);
    return null;
  } catch (error) {
    logger.debug(
      `detectLocalCommit: git rev-parse 失败 - ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
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

  // Step 1+2: 检测本地 commit
  const actualCommit = await detectLocalCommit(localPath);
  if (!actualCommit) {
    return { verified: false, reason: 'no_git' };
  }

  // Step 3: 比较 commit（单向前缀匹配：actual 以 expected 开头）
  const normalizedExpected = expectedCommit.toLowerCase();
  const normalizedActual = actualCommit.toLowerCase();

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
  detectLocalCommit,
  verifyLocalCommit,
};
