// 写用户目录里的文件，只有这一种写法。
//
// 为什么要有这一层：这个工具把用户的长期数据（知识库、版本账本、结构 JSON）写在原地，
// 一次中断的 writeFile 会把文件截成半份；而读的那头以前把「解析失败」和「还没有这个文件」当成同一件事——
// 「库文件坏了」于是被当成「库是空的」，下一条会写库的命令就把坏文件覆盖成空的，复习记录就这么没了。
// 所以这里只管三件事：
//   1) 写要落得完整（先写 .tmp，读回核对，再改名换上去；核对不上就删临时文件、原文件不动）；
//   2) 改用户文件之前先留一份改动前的，而且**不覆盖已有的备份**——第二次跑砸了的时候，
//      唯一那份早期原样比「最近一次的旧版」值钱；确定要覆盖别处的改动时，那一份另存成 .conflict-时间.json（preserveConflict）；
//   3) 读要把「坏」和「空」分开说，坏了一定给下一步，不许安静地当成空库继续干活；
//   4) 覆盖之前要能回答「我读进来之后它有没有被别处改过」——快照（内容指纹）就在 snapshotOf 里，
//      工作台的保存和命令行撞车时靠它挡下来。
//   5) 读 → 改 → 写要按文件加锁；原子替换只防半份文件，防不住两个进程各自读到旧内容再整份覆盖。

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFile, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const say = (e) => (e && e.code ? `${e.message}（${e.code}）` : String((e && e.message) || e));

// 内容指纹：判断「还是不是我读进来那一版」靠的是它，不是修改时间。
// 时间不能用——复制一份文件、从备份换回去、别处写进同样的内容都会改时间；
// 而真正要防的那两种情况（内容没变但时间变了 / 内容变了但时间被复制回更早）它恰好都判错。
export const shaBytes = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12);
export const sha = (s) => shaBytes(Buffer.from(String(s ?? ''), 'utf8'));

export const LOCK_TIMEOUT_MS = 30000;
const LOCK_POLL_MS = 50;
const LOCK_READ_ATTEMPTS = 20;
const lockContext = new AsyncLocalStorage();
const localLockTails = new Map();
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

export async function inspectLock(lockFile) {
  let raw;
  try {
    raw = await readFile(lockFile, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new Error(`读不了锁文件：${lockFile}\n  ${say(e)}`);
  }
  try {
    const owner = JSON.parse(raw);
    if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.token) throw new Error('缺少进程号或令牌');
    return { raw, owner, error: '' };
  } catch (e) {
    return { raw, owner: null, error: say(e) };
  }
}

async function readLockOwner(lock) {
  for (let i = 0; i < LOCK_READ_ATTEMPTS; i++) {
    try {
      return await inspectLock(lock);
    } catch (e) {
      if (!e || !['EBUSY', 'EPERM'].includes(e.code) || i === LOCK_READ_ATTEMPTS - 1) throw e;
      await pause(LOCK_POLL_MS);
    }
  }
}

const staleLockMessage = (lock, info) =>
  `这份文件还被一个已经退出的进程锁着：${lock}\n` +
  `  上次持锁进程：PID ${info.owner.pid}，开始于 ${info.owner.at || '时间未知'}。\n` +
  '  为免误删别人正在用的锁，程序不会自动抢锁。先运行 node scripts/clean.mjs --stale-locks --cwd "工作目录" 查看，确认没有进程在写后再加 --yes。';

async function acquireLock(file, timeout, label) {
  await mkdir(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const started = Date.now();
  for (;;) {
    const owner = { pid: process.pid, token: randomUUID(), at: new Date().toISOString(), command: label || '' };
    const raw = JSON.stringify(owner);
    let handle;
    try {
      handle = await open(lock, 'wx');
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw new Error(`没能创建写锁：${lock}\n  ${say(e)}\n  本次没有改目标文件。`);
      handle = null;
    }
    if (handle) {
      try {
        await handle.writeFile(raw, 'utf8');
      } catch (e) {
        await handle.close().catch(() => {});
        await rm(lock, { force: true }).catch(() => {});
        throw new Error(`没能写下锁的持有者：${lock}\n  ${say(e)}\n  本次没有改目标文件。`);
      }
      await handle.close();
      return async () => {
        const now = await readLockOwner(lock);
        if (!now) throw new Error(`本次使用的锁不见了：${lock}\n  文件已经写入，但锁可能被别处手动删过；先检查有没有另一个进程也在写这个文件。`);
        if (now.owner?.token !== owner.token) throw new Error(`锁已经被别的进程换掉：${lock}\n  本次没有删掉别人的锁；先检查是否有人手工清理过锁目录。`);
        await rm(lock, { force: true });
      };
    }
    const info = await readLockOwner(lock);
    if (!info) continue;
    if (info.owner && !pidAlive(info.owner.pid)) {
      const again = await readLockOwner(lock);
      if (!again || again.owner?.token !== info.owner.token) continue;
      throw new Error(staleLockMessage(lock, info));
    }
    if (Date.now() - started >= timeout) {
      const who = info.owner ? `PID ${info.owner.pid}（${info.owner.command || '未知命令'}）` : `内容不完整（${info.error}）`;
      throw new Error(`等了 ${Math.round(timeout / 1000)} 秒仍没能写入 ${file}：${lock} 正被${who}占用。\n  本次没有改目标文件。等那个命令结束再来；若它已经退出，用 clean.mjs --stale-locks 查看遗留锁。`);
    }
    await pause(LOCK_POLL_MS);
  }
}

async function canonicalFile(file) {
  let current = resolve(file);
  const missing = [];
  for (;;) {
    try {
      const real = await realpath(current);
      const full = join(real, ...missing.reverse());
      return process.platform === 'win32' ? full.toLowerCase() : full;
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw new Error(`认不出这份文件的唯一路径，所以没有加锁：${file}\n  ${say(e)}`);
      const parent = dirname(current);
      if (parent === current) throw new Error(`认不出这份文件的唯一路径，所以没有加锁：${file}`);
      missing.push(basename(current));
      current = parent;
    }
  }
}

export async function withFileLock(file, fn, { timeout = LOCK_TIMEOUT_MS, label = '' } = {}) {
  const key = await canonicalFile(file);
  const held = lockContext.getStore();
  if (held && held.has(key)) return fn();
  const previous = localLockTails.get(key) || Promise.resolve();
  let advance;
  const turn = new Promise((ok) => { advance = ok; });
  localLockTails.set(key, turn);
  await previous;
  let release;
  try {
    release = await acquireLock(key, timeout, label);
  } catch (e) {
    advance();
    if (localLockTails.get(key) === turn) localLockTails.delete(key);
    throw e;
  }
  const next = new Set(held || []);
  next.add(key);
  let value;
  let failure;
  try {
    value = await lockContext.run(next, fn);
  } catch (e) {
    failure = e instanceof Error ? e : new Error(String(e));
  }
  try {
    await release();
  } catch (e) {
    if (!failure) failure = e instanceof Error ? e : new Error(String(e));
    else failure.message += `\n  另外，释放锁时也出了问题：${e.message || e}`;
  }
  advance();
  if (localLockTails.get(key) === turn) localLockTails.delete(key);
  if (failure) throw failure;
  return value;
}

/**
 * 一份文件此刻的快照：内容、指纹、到底有没有这个文件。
 * 读不了（权限、被别的程序占着）要如实抛出去，不能报成「没有这个文件」——
 * 上层拿它决定「要不要往这份文件上覆盖」，判成「没有」就等于放行一次覆盖。
 * @param {string} file
 * @returns {Promise<{exists:boolean,raw:string,stamp:string}>}
 */
export async function snapshotOf(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false, raw: '', stamp: '' };
    throw new Error(`读不了这份文件，所以不知道它现在是什么样子：${file}\n  ${say(e)}\n  先确认它没被别的程序独占；在弄清内容之前，工具不会往它上面写。`);
  }
  return { exists: true, raw, stamp: sha(raw) };
}

/**
 * 原子写：内容落全了才换掉原文件。
 * @param {string} file 目标文件
 * @param {string} text 全部内容
 */
const RENAME_ATTEMPTS = 20;
const RENAME_DELAY_MS = 50;

async function renameWithRetry(tmp, file) {
  let last;
  for (let i = 0; i < RENAME_ATTEMPTS; i++) {
    try {
      await rename(tmp, file);
      return;
    } catch (e) {
      last = e;
      if (!e || !['EBUSY', 'EPERM'].includes(e.code) || i === RENAME_ATTEMPTS - 1) throw e;
      await pause(RENAME_DELAY_MS);
    }
  }
  throw last;
}

export async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
    // 读回核对：证明磁盘上真是这一份。截断、编码坏了在这里被抓，而不是留给下一个读它的人。
    const back = await readFile(tmp, 'utf8');
    if (back !== text) throw new Error(`写进去的和要写的不是同一份（${Buffer.byteLength(text)} 字节 vs ${Buffer.byteLength(back)} 字节）`);
    await renameWithRetry(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw new Error(`没能写入 ${file}：${say(e)}\n  原文件没有动。磁盘是不是满了，或者这个文件正被别的程序占着？`);
  }
  return file;
}

export async function writeBinaryAtomic(file, bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, data, { flag: 'wx' });
    const back = await readFile(tmp);
    if (!back.equals(data)) throw new Error(`写进去的和要写的不是同一份（${data.length} 字节 vs ${back.length} 字节）`);
    await renameWithRetry(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw new Error(`没能写入 ${file}：${say(e)}\n  原文件没有动。磁盘是不是满了，或者这个文件正被别的程序占着？`);
  }
  return file;
}

export async function replaceFileAtomic(staged, file) {
  try {
    await renameWithRetry(staged, file);
  } catch (e) {
    throw new Error(`没能把已核对的文件放到 ${file}：${say(e)}\n  暂存文件仍在 ${staged}。`);
  }
  return file;
}

/**
 * 改用户文件之前留一份改动前的。已经有备份就不覆盖它（保住最早那一版）。
 * @param {string} file
 * @param {string} suffix 备份后缀；恢复那种「动之前留一份」用的是 .before-restore.bak
 * @returns {Promise<{made:boolean,bak:string}>}
 */
export async function backupOnce(file, suffix = '.bak') {
  const bak = `${file}${suffix}`;
  try {
    await copyFile(file, bak, constants.COPYFILE_EXCL);
    return { made: true, bak };
  } catch (e) {
    if (e && e.code === 'EEXIST') return { made: false, bak };
    throw new Error(`没能留下改动前的备份（${bak}）：${say(e)}\n  这一步不能省——所以本次没有动原文件。`);
  }
}

/**
 * 强行覆盖之前，把「将要被盖掉的那一份」原样留成另一个文件。
 * 为什么不用 .bak：.bak 的规矩是只留最早那一版，拿它存冲突等于把更早的那份顶掉——
 * 而那一份可能更有价值。名字里带时间和随机片段：
 * 两次覆盖就该留下两份证据，不许后一次把前一次悄悄删掉。
 * @param {string} file 要被覆盖的那个文件
 * @param {string} raw 它此刻在磁盘上的内容（调用方已经读出来了，不再重读一次）
 * @returns {Promise<string>} 新留下的文件路径
 */
export async function preserveConflict(file, raw) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stem = `${String(file).replace(/\.json$/i, '')}.conflict-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomUUID().slice(0, 8)}`;
  const target = `${stem}.json`;
  await writeAtomic(target, raw);
  return target;
}

/**
 * 读一份 JSON。分三种情况，绝不把「坏了」当成「空的」。
 * @param {string} file
 * @param {{what?:string, fix?:string}} o what：这东西在用户嘴里叫什么；fix：坏的时候下一步做什么
 * @returns {Promise<any|null>} 文件不存在返回 null；读不懂抛错（错误里带文件名与下一步）
 */
export async function readJsonOr(file, { what = '这份文件', fix = '' } = {}) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new Error(`读不了${what}：${file}\n  ${say(e)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${what}读不懂：${file}——它不是「空的」，是坏了（${say(e)}）。\n` +
        `  先别再跑任何会写它的命令：一写就把现在这份覆盖掉了。${fix}\n` +
        `  旁边要是有同名 .bak，那就是改动前的样子。`
    );
  }
}
