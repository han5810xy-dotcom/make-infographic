// 用户侧的运行环境守卫。三件事，全部只在这一处定义：
//   1) 控制台代码页：Windows cmd 默认 936，我们输出的 UTF-8 中文会变成乱码——
//      整套设计的卖点是「报错给下一步」，读不到的报错等于没有。这里认出它、切过去、并且告诉用户发生了什么。
//   2) 每次运行的完整输出留一份 UTF-8 日志（.knowledge/run.log）：控制台万一还是废的，用户有一份能看的。
//   3) 统一的失败出口：所有命令行入口都走这里，不再有的脚本吐内部堆栈、有的打印「失败：」。
//
// 不想让程序改代码页：设 MI_KEEP_CODEPAGE=1（那时会打印一行纯 ASCII 的自救办法，因为中文已经不可读）。
// 不想写日志：设 MI_NO_RUNLOG=1。

import { execSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { withFileLock, writeAtomic } from './safeio.mjs';

export const RUN_LOG = '.knowledge/run.log';
const RUN_JOURNALS = '.knowledge/run-logs';
const MAX_LOG_LINES = 400;
const LOG_LOCK_TIMEOUT_MS = 2000;

// chcp 的输出有两种语言，中文那半句在 936 窗口里还是乱码——所以只从里面抠数字，
// 而且要按「一串完整数字」抠：取末四位会把 65001 读成 5001，程序就会误判自己没切换成功。
export function codepageFrom(text) {
  const m = String(text || '').match(/\d{3,6}/);
  return m ? m[0] : '';
}

const utf8Codepage = () => {
  if (process.platform !== 'win32') return '';
  try {
    const raw = execSync('chcp', { encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
    return codepageFrom(String(raw));
  } catch {
    return '';
  }
};

// 决定「这个窗口的代码页要不要动、要说什么」——纯函数，好让自检能逐条证伪
// 提示分两种语言：改得动用中文（切完就正常了），改不动或用户不让动只能给 ASCII（那时中文已经不可读）
export function planCodepage(cp, env = process.env) {
  if (!cp || cp === '65001') return { action: 'none', hint: '' };
  if (env.MI_KEEP_CODEPAGE) return { action: 'keep', hint: `! codepage ${cp} - Chinese text may look garbled. Fix: chcp 65001   (log file: ${RUN_LOG})` };
  return { action: 'switch', hint: `（本窗口代码页原本是 ${cp}，中文会成乱码，已切到 65001；不想让程序切就设 MI_KEEP_CODEPAGE=1。完整输出同时写在 ${RUN_LOG}）`, failHint: `! codepage ${cp} - switching to 65001 failed. Fix: chcp 65001   (log file: ${RUN_LOG})` };
}

// 只在真的有问题时才开口（一个进程里只探一次：chcp 是子进程，别为每条命令都跑一遍）
let probed = null;
export function guardConsole(env = process.env) {
  if (probed) return probed;
  const cp = utf8Codepage();
  const plan = planCodepage(cp, env);
  const out = { codepage: cp, changed: false, hint: plan.hint };
  if (plan.action !== 'switch') return (probed = out);
  try {
    execSync('chcp 65001 >nul', { stdio: 'ignore' });
    if (utf8Codepage() === '65001') {
      out.changed = true;
      return (probed = out);
    }
  } catch {}
  out.changed = false;
  out.hint = plan.failHint;
  return (probed = out);
}

// 先给每次运行留一份独立日志，再去汇总。进程在汇总前退出，记录仍在；并发写入也不会互截。
export async function appendRunLog(workspace, name, lines) {
  if (process.env.MI_NO_RUNLOG || !lines.length) return '';
  const root = resolve(workspace);
  const journalDir = join(root, RUN_JOURNALS);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const journal = join(journalDir, `${stamp}-${process.pid}-${randomUUID().slice(0, 8)}.log`);
  const text = [`[${new Date().toLocaleString('zh-CN')}] ${name}`, ...lines].join('\n') + '\n';
  try {
    await writeAtomic(journal, text);
  } catch (e) {
    throw new Error(`这次输出没能留成日志：${e.message || e}\n  命令本身的结果不变，但控制台一关就没有备用记录了。`);
  }

  const file = join(root, RUN_LOG);
  try {
    await withFileLock(file, async () => {
      let old = '';
      try {
        old = await readFile(file, 'utf8');
      } catch (e) {
        if (!e || e.code !== 'ENOENT') throw e;
      }
      const pending = (await readdir(journalDir)).filter((n) => n.endsWith('.log')).sort();
      if (!pending.length) return;
      const chunks = [];
      for (const n of pending) chunks.push(await readFile(join(journalDir, n), 'utf8'));
      const all = [old && !old.endsWith('\n') ? `${old}\n` : old, ...chunks].join('').split('\n');
      if (all.at(-1) === '') all.pop();
      await writeAtomic(file, all.slice(-MAX_LOG_LINES).join('\n') + '\n');
      for (const n of pending) await rm(join(journalDir, n), { force: true });
    }, { timeout: LOG_LOCK_TIMEOUT_MS, label: '运行日志汇总' });
  } catch (e) {
    throw new Error(`这次输出已留在 ${journal}，但没能汇总进 ${file}：${e.message || e}\n  下一条命令会把它一起汇总，不要手动删除这份记录。`);
  }
  return file;
}

// 工作目录在命令行里只有一个意思，两种写法（--cwd 是 kb/review/ledger/content 原来的名字，--workspace 是 search/network/studio 原来的名字）。
// 分开定义过一次代价：用户照着另一份文档敲了 --workspace，脚本不报错，只是安静地在当前目录里干活——
// 数据写错地方比写失败难查得多。所以现在两边都认，且只在这里认一次。
export const WORKDIR_FLAGS = ['cwd', 'workspace'];
export function workdir(argv = process.argv.slice(2), dflt = process.cwd()) {
  for (const k of WORKDIR_FLAGS) {
    const i = argv.indexOf(`--${k}`);
    if (i < 0) continue;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`--${k} 后面要跟一个目录（比如 --${k} "D:/我的笔记"）`);
    return resolve(v);
  }
  return resolve(dflt);
}

// --help 的契约：打帮助就该给用法并且成功返回。
// 以前有几个脚本把 --help 当成「没给命令」退 2——用户看不出区别，包一层的脚本会以为命令失败了。
export const wantsHelp = (argv = process.argv.slice(2)) => argv.includes('--help') || argv.includes('-h');

// 帮助文本里对这一位的统一说法：每个脚本自己写一遍就会各写各的，用户看不出它们是同一件事
export const WORKDIR_HELP = '--cwd <目录>　作用于哪个工作目录（写 --workspace 也一样，两个是同义词；默认当前目录）';

// 带值的开关：取值后面不能又是一个开关，否则 `--limit --json` 会把 --json 当成值
export function opt(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  if (v === undefined || String(v).startsWith('--')) throw new Error(`--${name} 后面要跟一个值（` + `--${name} ${typeof dflt === 'number' ? '数字' : '内容'}）`);
  return v;
}

// 一次出一套图会同时写下 名.json（整套）和 名-1.json / 名-2.json…（每张一份的记录）。
// 把后者喂给导出、视图、重出，都会因为「没有 figures」被挡下来——但挡的话不能说它是 v1 旧格式：
// 那份文件里 version 就写着 2，说它是旧的是假话，用户会去找根本不存在的「旧版转换器」。
// 这里认出到底是哪一种，并把下一步写出来。放在这一层是因为它只是一句给人看的话，
// 而且内容/视图/导出三个脚本都要说同一句——曾经把它放进 structure.mjs，结果 content.mjs 动态导入它时
// 撞上 structure ↔ content 的循环引用，命令行直接挂死（unsettled top-level await）。
export function notASetMessage(spec, file = '') {
  if (spec && Array.isArray(spec.figures)) return '';
  const base = String(file).replace(/\\/g, '/').split('/').pop() || '';
  const isSidecar = /-\d+\.json$/i.test(base) || /图\s*\d+\s*\/\s*\d+/.test(String(spec?.subtitle || ''));
  if (isSidecar) {
    const whole = base.replace(/-\d+\.json$/i, '.json');
    return `这是那一套图里某一张的单图记录，不是整套结构——导出/视图/重出要的是整套那份。把它换成 infographics/${whole || '（整套那份同名、结尾没有 -1/-2/-3）.json'} 再跑一次`;
  }
  return '这份结构还是旧格式（v1 单图，没有 figures），先按 v2 重做';
}

// 拼错的开关以前会被安静忽略：用户以为 `--workspce D:/笔记` 起作用了，其实跑的是默认目录，
// 东西照样写错地方。「不认得就不跑」是这一类唯一的兜法，所以每条命令行入口都在开头调用它。
// 认得的开关由各个入口自己给（本层不知道每个脚本有哪些参数，也不该知道）。
export function checkFlags(argv, known) {
  const bad = [];
  for (const a of argv) {
    if (typeof a !== 'string' || !a.startsWith('--')) continue;
    const name = a.slice(2).split('=')[0];
    if (!name || known.includes(name)) continue;
    bad.push(name);
  }
  if (!bad.length) return;
  const lines = bad.map((name) => {
    const near = known.filter((k) => k.slice(0, 3) === name.slice(0, 3) || k.includes(name) || name.includes(k)).slice(0, 3);
    return `  不认得 --${name}${near.length ? `：你是想写 ${near.map((k) => '--' + k).join(' / ')} 吗？` : ''}`;
  });
  throw new Error(`这些开关本脚本不认，所以本次没有按它们的意思跑（宁可停下，也不让你以为生效了）：\n${lines.join('\n')}\n  这个入口认的开关：${known.map((k) => '--' + k).join(' / ')}`);
}

// 每个脚本底部只写一行：startCli(import.meta.url, 'kb', main);
// 它同时负责「这是不是被直接运行的那个文件」的判断——以前 12 个脚本各写各的，三种写法里有一种在 Windows 上会认错。
export const isEntry = (metaUrl) => !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(metaUrl));

// 真正干活的一层，单独拆出来是为了能被自检直接调用（入口判断和它绑在一起就没法测）
export async function runCli(name, main, argv = process.argv.slice(2), workspace = '') {
  // 日志要落在用户真正操作的那个目录：`--cwd D:/笔记` 跑的命令，输出记在 D:/笔记/.knowledge/run.log，
  // 而不是记在当前所在的目录里。--cwd 写错了（没跟值）由脚本自己报错，这里先退回原地别把日志层搞崩。
  let ws = workspace;
  if (!ws) {
    try {
      ws = workdir(argv);
    } catch {
      ws = process.cwd();
    }
  }
  const lines = [];
  const log = console.log.bind(console);
  const err = console.error.bind(console);
  // --json 是给程序读的：stdout 只能有那一份 JSON，环境提示、进度和失败原因都去 stderr。
  // 这条规矩放在入口层，评估脚本里的动态导入、浏览器提醒也都逃不出去。
  const machine = argv.includes('--json');
  const tee = (fn) => (...a) => {
    lines.push(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' '));
    fn(...a);
  };
  console.log = tee(machine ? err : log);
  console.error = tee(err);
  const g = guardConsole();
  if (g.hint) console.log(g.hint);
  let failed = '';
  let code = 0;
  try {
    const r = await main(argv);
    if (typeof r === 'number') code = r;
  } catch (e) {
    failed = e && e.message ? e.message : String(e);
    console.error(`失败：${failed}`);
    code = 1;
  }
  let file = '';
  let logError = '';
  try {
    file = await appendRunLog(ws, name, lines);
  } catch (e) {
    logError = e && e.message ? e.message : String(e);
    console.error(`注意：${logError}`);
  }
  if (failed && file) console.error(`（这次的完整输出也在 ${file}）`);
  console.log = log;
  console.error = err;
  return { code, failed, logFile: file, logError, printed: lines.join('\n') };
}

// 命令行入口不要用顶层 await。入口模块停在顶层 await 上时，运行期再 import() 一个（间接）绕回入口模块的文件
// 会死锁：Node 要等入口「评估完成」才让那次 import 返回，入口却在等那次 import。
// content.mjs 的 rebuild 就是这样挂死过的——图都画完了、账也记了，进程退成 13，一句 OK 都没打。
// 这里改成「发起 + 兜底」：退出码照写，异常照翻译成人话，只是不再把模块评估吊在那儿。
export function startCli(metaUrl, name, main, argv = process.argv.slice(2)) {
  cli(metaUrl, name, main, argv).catch((e) => {
    const msg = e && e.message ? e.message : String(e);
    try {
      console.error(`失败：${msg}`);
    } catch {}
    process.exitCode = 1;
  });
}

export async function cli(metaUrl, name, main, argv = process.argv.slice(2)) {
  if (!isEntry(metaUrl)) return false;
  const r = await runCli(name, main, argv);
  if (r.code) process.exitCode = r.code;
  return true;
}
