import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROFILE_ROOT, profileStale, LEGACY_PREFIX } from './browser.mjs';

const HOUR_MS = 60 * 60 * 1000;
async function sweep(root, predicate, { now = Date.now(), dryRun = false } = {}) {
  let names;
  try { names = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const removed = [];
  for (const name of names) {
    const path = join(root, name);
    let info;
    try { info = await stat(path); } catch { continue; }
    if (!info.isDirectory() || !predicate(name, info.mtimeMs, now)) continue;
    if (!dryRun) await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    removed.push(path);
  }
  return removed;
}

export async function clean({ dryRun = false, now = Date.now() } = {}) {
  const profiles = await sweep(PROFILE_ROOT(), (_name, mtime) => profileStale(mtime, now, HOUR_MS), { dryRun, now });
  const legacy = await sweep(tmpdir(), (name, mtime) => name.startsWith(LEGACY_PREFIX) && profileStale(mtime, now, HOUR_MS), { dryRun, now });
  return { dryRun, profiles, legacy };
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dryRun = process.argv.includes('--dry-run');
  if (process.argv.slice(2).some((arg) => arg !== '--dry-run')) {
    console.error('用法：node scripts/clean.mjs [--dry-run]（只删除一小时未活动的 make-infographic 临时配置）');
    process.exitCode = 1;
  } else {
    try {
      const result = await clean({ dryRun });
      for (const path of [...result.profiles, ...result.legacy]) console.log(`${dryRun ? '将删除' : '已删除'} ${path}`);
      console.log(`${dryRun ? '待删除' : '已删除'} ${result.profiles.length + result.legacy.length} 个临时目录。`);
    } catch (error) {
      console.error(`清理失败：${error.message}`);
      process.exitCode = 1;
    }
  }
}
