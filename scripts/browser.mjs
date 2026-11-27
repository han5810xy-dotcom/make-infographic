import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WINDOWS_ROOTS = [
  ['C:/Program Files (x86)/Microsoft/Edge/Application', 'msedge.exe'],
  ['C:/Program Files/Microsoft/Edge/Application', 'msedge.exe'],
  ['C:/Program Files/Google/Chrome/Application', 'chrome.exe'],
  ['C:/Program Files (x86)/Google/Chrome/Application', 'chrome.exe'],
];

export function listCandidates(env = process.env) {
  const out = [];
  const push = (p) => {
    const s = String(p || '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  push(env.BROWSER_PATH);
  for (const [root, exe] of WINDOWS_ROOTS) push(`${root}/${exe}`);
  push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  push('/usr/bin/microsoft-edge');
  push('/usr/bin/google-chrome');
  push('/usr/bin/chromium-browser');
  return out;
}

export const LAUNCH_ARGS = ['--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none'];

export function whyLaunchFailed(e) {
  const m = String((e && e.message) || e || '');
  const code = m.match(/Code: (-?\d+)/)?.[1];
  if (code) return `一启动就退出（退出码 ${code}），多半是它自己卡在更新、或还有一份没关干净`;
  const one = m.replace(/TROUBLESHOOTING: \S+/g, '').replace(/\s+/g, ' ').trim();
  return one ? one.slice(0, 150) : '原因没报出来';
}

export async function closeBrowser(browser) {
  try {
    await browser.close();
  } catch (e) {
    console.log(`提醒：浏览器没关干净（${whyLaunchFailed(e)}）。它多半还占着一个临时配置目录，卡住下一次截图时先关掉残留窗口。`);
  }
}

export function once(open) {
  let p;
  const get = async () => {
    if (!p) p = Promise.resolve().then(open).catch((e) => { p = undefined; throw e; });
    return p;
  };
  get.reset = async () => {
    const mine = p;
    p = undefined;
    if (!mine) return;
    await closeBrowser(await mine);
  };
  return get;
}

export const PROFILE_ROOT = () => join(tmpdir(), 'make-infographic-profiles');

export function profileStale(mtimeMs, now = Date.now(), hourMs = 60 * 60 * 1000) {
  return Number.isFinite(mtimeMs) && now - mtimeMs > hourMs;
}

async function sweepProfiles(root, keep = '') {
  let names = [];
  try {
    names = await readdir(root);
  } catch {
    return { swept: 0, busy: 0 };
  }
  let swept = 0;
  let busy = 0;
  for (const n of names) {
    const p = join(root, n);
    if (keep && resolve(p) === resolve(keep)) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(p)).mtimeMs;
    } catch {
      continue;
    }
    if (!profileStale(mtimeMs)) continue;
    try {
      await rm(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 80 });
      swept++;
    } catch {
      busy++;
    }
  }
  return { swept, busy };
}

async function ownProfileDir() {
  const root = PROFILE_ROOT();
  await mkdir(root, { recursive: true });
  const dir = join(root, `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`);
  await mkdir(dir, { recursive: true });
  const { swept, busy } = await sweepProfiles(root, dir);
  if (busy) console.log(`提醒：有 ${busy} 个旧的浏览器临时目录还被占用，暂时没删掉（不影响出图，下次再清）。`);
  await noteLegacyProfiles();
  return dir;
}

export const LEGACY_PREFIX = 'puppeteer_dev_chrome_profile-';
export const LEGACY_NOTICE_MIN = 20;
let legacyNoted = false;

async function noteLegacyProfiles() {
  if (legacyNoted) return;
  legacyNoted = true;
  let names = [];
  try {
    names = (await readdir(tmpdir())).filter((n) => n.startsWith(LEGACY_PREFIX));
  } catch {
    return;
  }
  if (names.length < LEGACY_NOTICE_MIN) return;
  console.log(
    `提醒：系统临时目录里还留着 ${names.length} 份早期版本没清掉的浏览器临时配置（每份几十 MB，都在 ${tmpdir()} 下，前缀 ${LEGACY_PREFIX}）。` +
      `\n  本工具不动这些目录；要清就自己跑：node scripts/clean.mjs（只删这个名字开头、而且一小时没动过的）。`,
  );
}

export async function launchBrowser({ candidates } = {}) {
  const all = Array.isArray(candidates) ? candidates.filter(Boolean) : listCandidates();
  const present = all.filter((p) => existsSync(p));
  const puppeteer = await import('puppeteer-core');
  const tried = [];
  for (const exe of present) {
    let userDataDir = '';
    try {
      userDataDir = await ownProfileDir();
      const browser = await puppeteer.launch({ executablePath: exe, args: LAUNCH_ARGS, userDataDir });
      if (tried.length) console.log(`注意：前面那几个没打开（${tried.join('；')}），这次改用 ${exe}。`);
      browser.on?.('disconnected', () => {
        rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 }).catch(() => {});
      });
      return browser;
    } catch (e) {
      if (userDataDir) await rm(userDataDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 80 }).catch(() => {});
      tried.push(`${exe} —— ${whyLaunchFailed(e)}`);
    }
  }
  throw new Error(
    `打不开浏览器，所以没法截图。\n` +
      (tried.length
        ? `  本机装着的都真试过：\n  ${tried.join('\n  ')}\n`
        : `  这台机器上一个候选浏览器都没有：\n${all.length ? all.join('\n') : '（没有拿到任何候选）'}\n`) +
      '  1) 先用鼠标打开一次 Edge 或 Chrome——它更新卡住时命令行启动会直接退出，打开到能看网页再重跑；\n' +
      '  2) 关掉残留的无头实例：任务管理器里带 --remote-debugging 的 msedge / chrome；\n' +
      '  3) 指定别的一个：set BROWSER_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n' +
      '  4) 只想先看排版：加 --html-only，出 HTML 不截图（本工具不会自动下载 Chromium）。',
  );
}
