/**
 * 版本更新检查
 * 检查 npm 上是否有新的正式版本
 */
import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import { getConfigDir } from '../core/platform.js';
import { info, blank } from './logger.js';

const PACKAGE_NAME = 'tanmi-dock';
const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 小时
const CACHE_FILE = 'update-check.json';

interface UpdateCheckCache {
  lastCheck: number;
  latestVersion: string | null;
}

const MAX_RESPONSE_SIZE = 10 * 1024; // 10KB 足够

/**
 * 从 npm registry 获取最新版本
 */
async function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
      { timeout: 5000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume(); // 消费响应体以正确关闭连接
          resolve(null);
          return;
        }

        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > MAX_RESPONSE_SIZE) {
            req.destroy();
            resolve(null);
          }
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.version || null);
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * 获取当前版本
 */
async function getCurrentVersion(): Promise<string> {
  try {
    const packageJsonPath = new URL('../../package.json', import.meta.url);
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch {
    return '0.0.0';
  }
}

/**
 * 读取检查缓存
 */
async function readCache(): Promise<UpdateCheckCache | null> {
  try {
    const configDir = await getConfigDir();
    const cachePath = path.join(configDir, CACHE_FILE);
    const content = await fs.readFile(cachePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * 写入检查缓存
 */
async function writeCache(cache: UpdateCheckCache): Promise<void> {
  try {
    const configDir = await getConfigDir();
    await fs.mkdir(configDir, { recursive: true });
    const cachePath = path.join(configDir, CACHE_FILE);
    await fs.writeFile(cachePath, JSON.stringify(cache), 'utf-8');
  } catch {
    // 忽略缓存写入失败
  }
}

/**
 * 比较版本号 (忽略预发布版本)
 * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1: string, v2: string): number {
  // 去掉预发布后缀
  const clean = (v: string) => v.split('-')[0];
  const parts1 = clean(v1).split('.').map((n) => parseInt(n, 10) || 0);
  const parts2 = clean(v2).split('.').map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * 检查更新并在有新版本时提示
 * 静默失败，不影响主流程
 */
export async function checkForUpdates(): Promise<void> {
  try {
    const cache = await readCache();
    const now = Date.now();

    // 检查是否需要重新获取
    if (cache && now - cache.lastCheck < CHECK_INTERVAL) {
      // 使用缓存的版本信息
      if (cache.latestVersion) {
        const currentVersion = await getCurrentVersion();
        if (compareVersions(cache.latestVersion, currentVersion) > 0) {
          showUpdateNotice(currentVersion, cache.latestVersion);
        }
      }
      return;
    }

    // 获取最新版本
    const latestVersion = await fetchLatestVersion();

    // 更新缓存
    await writeCache({ lastCheck: now, latestVersion });

    if (latestVersion) {
      const currentVersion = await getCurrentVersion();
      if (compareVersions(latestVersion, currentVersion) > 0) {
        showUpdateNotice(currentVersion, latestVersion);
      }
    }
  } catch {
    // 静默失败
  }
}

/**
 * 显示更新提示
 */
function showUpdateNotice(currentVersion: string, latestVersion: string): void {
  blank();
  info(`新版本可用: ${currentVersion} → ${latestVersion}`);
  info('运行 `td update` 或 `npm install -g tanmi-dock` 更新');
}

export default { checkForUpdates };
