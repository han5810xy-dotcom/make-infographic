import { existsSync } from 'node:fs';
import { constants } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, parse, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONTRACT = {
  "VERSION": "2.1.0",
  "ARCHIVE_NAME": "make-infographic-2.1.0.zip",
  "REQUIRED_FILES": [
    "SKILL.md",
    "package.json",
    "pnpm-lock.yaml",
    "README.md",
    "scripts/package-release.mjs",
    "scripts/release-contract.mjs",
    "scripts/clean.mjs",
    "scripts/make.mjs",
    "scripts/make-turn-card.mjs",
    "scripts/render-structure.mjs",
    "scripts/visual-syntax.mjs",
    "scripts/workflow.mjs",
    "scripts/output-checks.mjs",
    "scripts/knowledge-contract.mjs",
    "scripts/learning-core.mjs",
    "scripts/learn.mjs",
    "scripts/learn-server.mjs",
    "scripts/publish.mjs",
    "scripts/knowledge-authoring.mjs",
    "scripts/knowledge.mjs",
    "scripts/propositionize.mjs",
    "scripts/relations.mjs",
    "scripts/attention.mjs",
    "scripts/views.mjs",
    "scripts/ambient.mjs",
    "scripts/trace.mjs",
    "scripts/render.mjs",
    "scripts/turn-card.mjs",
    "scripts/browser.mjs",
    "scripts/console.mjs",
    "scripts/safeio.mjs",
    "scripts/artifacts.mjs",
    "scripts/contract.mjs",
    "scripts/collect.mjs",
    "scripts/judge.mjs",
    "scripts/turn.mjs",
    "scripts/library.mjs",
    "scripts/review.mjs",
    "references/workflow.md",
    "references/knowledge-workflow.md",
    "references/knowledge-structure.schema.json",
    "assets/demo-turn-card.html",
    "assets/demo-turn-card.png",
    "assets/demo-knowledge-source.md",
    "examples/knowledge-ioed-authored.json",
    "examples/knowledge-ioed-main.png",
    "examples/knowledge-ioed-backbone.png",
    "examples/knowledge-ioed-detail.png",
    "bridge/server.mjs",
    "extension/manifest.json",
    "extension/trace-core.js",
    "extension/content.js",
    "extension/popup.html",
    "extension/popup.js",
    "extension/background.js",
    "web/learn/index.html",
    "web/learn/app.js",
    "web/learn/styles.css"
  ]
};
const VERSION = CONTRACT.VERSION;
const ZIP_NAME = CONTRACT.ARCHIVE_NAME;
const REQUIRED_FILES = CONTRACT.REQUIRED_FILES;
const scriptDirectory = (() => {
  try { return dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); }
})();

const say = (message) => console.log(message);
const fail = (message) => { console.error(`没装好：${message}`); process.exitCode = 1; };

function run(command, args, options = {}) {
  const shell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
  return spawnSync(command, args, { encoding: 'utf8', shell, ...options });
}

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function findZip() {
  const explicit = process.env.MAKE_INFOGRAPHIC_ZIP;
  const candidates = explicit ? [resolve(explicit)] : [join(process.cwd(), ZIP_NAME), join(scriptDirectory, ZIP_NAME)];
  for (const path of candidates) {
    if (!(await isFile(path))) continue;
    if (basename(path) !== ZIP_NAME) throw new Error(`安装包文件名必须精确为 ${ZIP_NAME}，当前为 ${basename(path)}。`);
    return path;
  }
  if (explicit) throw new Error(`找不到安装包：${resolve(explicit)}（文件名必须为 ${ZIP_NAME}）`);
  throw new Error(`当前文件夹里没有 ${ZIP_NAME}。把安装包和 install.mjs 放在一起再运行；不会自动选择其他版本。`);
}

function chooseTarget() {
  const index = process.argv.indexOf('--target');
  let root;
  if (index >= 0) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--target 后面要写技能目录。');
    root = resolve(value);
  } else {
    const home = homedir();
    const candidates = [join(home, '.qoder-cn', 'skills'), join(home, '.claude', 'skills'), join(home, '.dsh', 'skills')];
    root = candidates.find((path) => existsSync(path)) || candidates[0];
  }
  const parsed = parse(root);
  if (root === parsed.root || root === homedir() || root === resolve('.')) throw new Error('拒绝把技能安装到文件系统、用户目录或当前目录根级。');
  return root;
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 20) throw new Error('需要 Node 20 或更高版本，请升级 Node 后重跑。');
}

function detectInstaller() {
  const attempts = [];
  const pnpmArgs = ['install', '--ignore-scripts', '--frozen-lockfile'];
  if (process.env.MAKE_INFOGRAPHIC_PNPM) {
    const script = resolve(process.env.MAKE_INFOGRAPHIC_PNPM);
    if (!existsSync(script)) throw new Error(`MAKE_INFOGRAPHIC_PNPM 指向的文件不存在：${script}`);
    const probe = run(process.execPath, [script, '--version']);
    if (probe.status !== 0) throw new Error(`无法运行 MAKE_INFOGRAPHIC_PNPM：${script}`);
    attempts.push({ command: process.execPath, args: [script, ...pnpmArgs], how: 'pnpm (MAKE_INFOGRAPHIC_PNPM)' });
  }
  if (attempts.length) return attempts[0];
  for (const [command, prefix] of [['pnpm', pnpmArgs], ['npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']]]) {
    for (const executable of process.platform === 'win32' ? [command, `${command}.cmd`] : [command]) {
      const probe = run(executable, ['--version']);
      if (probe.status === 0 && probe.stdout?.trim()) attempts.push({ command: executable, args: prefix, how: command });
    }
  }
  if (attempts.length) return attempts[0];
  const corepack = run('corepack', ['pnpm', '--version']);
  if (corepack.status === 0 && corepack.stdout?.trim()) attempts.push({ command: 'corepack', args: ['pnpm', ...pnpmArgs], how: 'corepack' });
  if (!attempts.length) throw new Error('找不到 pnpm / corepack / npm，无法安装已声明的 puppeteer-core 依赖。请先安装其中一种；不会自动下载 Chromium。');
  return attempts[0];
}

function browserCandidates() {
  const paths = [];
  const push = (path) => { const value = String(path || '').trim(); if (value && !paths.includes(value)) paths.push(value); };
  push(process.env.BROWSER_PATH);
  push(process.env.CHROME_PATH);
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      push(join(root, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    for (const name of ['Microsoft Edge', 'Google Chrome', 'Chromium', 'Brave Browser']) {
      push(`/Applications/${name}.app/Contents/MacOS/${name}`);
    }
    push(join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  } else {
    for (const executable of ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser', 'brave-browser']) push(`/usr/bin/${executable}`);
  }
  for (const directory of String(process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const executable of process.platform === 'win32' ? ['msedge.exe', 'chrome.exe', 'chromium.exe'] : ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser']) push(join(directory, executable));
  }
  return paths;
}

async function checkBrowser() {
  const candidates = browserCandidates();
  for (const path of candidates) if (await isFile(path)) { await access(path, constants.R_OK); return path; }
  throw new Error(
    '未找到已安装的 Edge / Chrome / Chromium。请安装浏览器，或设置 BROWSER_PATH 指向可执行文件后重跑。\n' +
    '已检查：\n  ' + (candidates.join('\n  ') || '（没有候选路径）') + '\n本安装器绝不会自动下载 Chromium。',
  );
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function bounds(buffer, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) throw new Error('安装包损坏：数据越界。');
}

function safeEntryName(name) {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error(`安装包里有不安全的文件路径：${name}`);
  const parts = name.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`安装包里有不安全的文件路径：${name}`);
  return parts;
}

function validateArchive(buffer) {
  if (buffer.length < 22 || buffer.length > 512 * 1024 * 1024) throw new Error('安装包损坏：大小不合法。');
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0 || eocd + 22 + buffer.readUInt16LE(eocd + 20) !== buffer.length) throw new Error('安装包损坏：ZIP 目录无效。');
  if (buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6)) throw new Error('安装包损坏：不支持分卷 ZIP。');
  const count = buffer.readUInt16LE(eocd + 10);
  if (count !== buffer.readUInt16LE(eocd + 8) || count === 0xffff) throw new Error('安装包损坏：条目数或 ZIP64 不受支持。');
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('安装包损坏：不支持 ZIP64。');
  bounds(buffer, centralOffset, centralSize);
  let cursor = centralOffset;
  const files = [];
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > centralOffset + centralSize || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('安装包损坏：中央目录不完整。');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const external = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    bounds(buffer, cursor + 46, nameLength + extraLength + commentLength);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    safeEntryName(name);
    if (names.has(name)) throw new Error(`安装包有重复文件：${name}`);
    names.add(name);
    if (flags & 1 || method !== 8) throw new Error(`安装包不支持加密或非 deflate 文件：${name}`);
    if (((external >>> 16) & 0o170000) === 0o120000) throw new Error(`安装包不允许符号链接：${name}`);
    bounds(buffer, localOffset, 30);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`安装包里的 ${name} 损坏了。`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
    if (localName !== name || buffer.readUInt16LE(localOffset + 6) !== flags || buffer.readUInt16LE(localOffset + 8) !== method ||
        buffer.readUInt32LE(localOffset + 14) !== expectedCrc || buffer.readUInt32LE(localOffset + 18) !== compressedSize || buffer.readUInt32LE(localOffset + 22) !== size) {
      throw new Error(`安装包里的 ${name} 本地目录与中央目录不一致。`);
    }
    const start = localOffset + 30 + localNameLength + localExtraLength;
    bounds(buffer, start, compressedSize);
    files.push({ name, start, compressedSize, size, expectedCrc });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('安装包损坏：中央目录有多余数据。');
  const expected = new Set([...REQUIRED_FILES, 'LICENSE']);
  for (const name of expected) if (!names.has(name)) throw new Error(`安装包缺少文件：${name}`);
  for (const name of names) if (!expected.has(name)) throw new Error(`安装包有多余文件：${name}`);
  return files;
}

async function extractStaged(buffer, destination, files) {
  const { inflateRawSync } = await import('node:zlib');
  for (const file of files) {
    let data;
    try { data = inflateRawSync(buffer.subarray(file.start, file.start + file.compressedSize), { maxOutputLength: 64 * 1024 * 1024 }); }
    catch { throw new Error(`安装包里的 ${file.name} 解压失败。`); }
    if (data.length !== file.size) throw new Error(`安装包里的 ${file.name} 大小不对。`);
    if (crc32(data) !== file.expectedCrc) throw new Error(`安装包里的 ${file.name} CRC 校验失败。`);
    const parts = safeEntryName(file.name);
    const target = resolve(destination, ...parts);
    if (!target.startsWith(`${resolve(destination)}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`安装包路径越界：${file.name}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx' });
  }
}

async function install() {
  checkNode();
  const unknown = process.argv.slice(2).filter((value, index, all) => value.startsWith('--') && value !== '--target' && !(index > 0 && all[index - 1] === '--target'));
  if (unknown.length) throw new Error(`不认识的安装参数：${unknown.join('、')}。可用参数只有 --target <技能目录>。`);
  const targetRoot = chooseTarget();
  const target = join(targetRoot, 'make-infographic');
  const zipPath = await findZip();
  const buffer = await readFile(zipPath);
  // Validate the complete archive, including every CRC, before touching existing installs.
  const files = validateArchive(buffer);
  const browser = await checkBrowser();
  const installer = detectInstaller();
  await mkdir(targetRoot, { recursive: true });
  const staging = await mkdtemp(join(targetRoot, '.make-infographic-staging-'));
  let backup = '';
  let replaced = false;
  try {
    await extractStaged(buffer, staging, files);
    const installResult = run(installer.command, installer.args, {
      cwd: staging,
      stdio: 'inherit',
      env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true', PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true', npm_config_ignore_scripts: 'true' },
    });
    if (installResult.error || installResult.status !== 0) throw new Error(`依赖没装上（${installer.how}）。旧安装未改动；不会自动下载 Chromium。`);
    if (existsSync(target)) {
      backup = await mkdtemp(join(targetRoot, '.make-infographic-backup-'));
      await rm(backup, { recursive: true, force: true });
      await rename(target, backup);
      say(`发现旧版，暂存到 ${backup}`);
    }
    await mkdir(target, { recursive: true });
    replaced = true;
    await cp(staging, target, { recursive: true, force: true, filter: (source) => !source.split(/[\\/]/).includes('node_modules') });
    const targetDeps = run(installer.command, installer.args, {
      cwd: target,
      stdio: 'inherit',
      env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true', PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true', npm_config_ignore_scripts: 'true' },
    });
    if (targetDeps.error || targetDeps.status !== 0) throw new Error(`新目录依赖安装失败（${installer.how}）。旧安装未改动；不会自动下载 Chromium。`);
    if (backup) {
      try { await rm(backup, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      catch { say(`提醒：新安装成功，但旧版备份仍保留在 ${backup}`); }
    }
    say(`技能文件已放进 ${target}`);
    say(`浏览器：${browser}`);
    say(`依赖管理器：${installer.how}（已禁止安装脚本，不会下载 Chromium）`);
    say('装好了。在 Qoder 里选中一段文字，说『出图』。');
  } catch (error) {
    const rollbackErrors = [];
    if (replaced) {
      try { await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (e) { rollbackErrors.push(`删除新安装失败：${e.message}`); }
    }
    if (backup && existsSync(backup)) {
      try { await rename(backup, target); } catch (e) { rollbackErrors.push(`恢复旧安装失败：${e.message}`); }
    }
    if (rollbackErrors.length) throw new Error(`${error.message}\n回滚未完成：${rollbackErrors.join('；')}\n旧版备份：${backup || '无'}`);
    if (backup && existsSync(backup)) throw new Error(`${error.message}\n回滚未完成，旧版仍在 ${backup}`);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}

if (process.argv.slice(2).some((value) => value === '--help' || value === '-h')) {
  console.log(`用法：node install.mjs [--target 技能目录]\n安装 make-infographic ${VERSION}。安装包必须与脚本同目录，文件名精确为 ${ZIP_NAME}。`);
} else {
  install().catch((error) => fail(error?.message || '发生了未知问题。'));
}
