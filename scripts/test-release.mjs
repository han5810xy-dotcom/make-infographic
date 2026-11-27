import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { ARCHIVE_NAME, REQUIRED_FILES, VERSION, buildZip, extractZip, readZip } from './release-contract.mjs';
import { refreshIndex } from './make-turn-card.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const NODE = process.execPath;
const distInstaller = join(root, 'dist', 'install.mjs');

async function workspace(run) {
  const dir = await mkdtemp(join(tmpdir(), 'make-infographic-release-test-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

async function runInstaller(dir, { zipName = ARCHIVE_NAME, args = [], env = {}, existing = false, failDeps = false, browser = true } = {}) {
  const zip = join(dir, zipName);
  if (!existsSync(zip)) await cp(join(root, 'dist', ARCHIVE_NAME), zip);
  const skills = join(dir, 'skills');
  if (existing) {
    await mkdir(join(skills, 'make-infographic'), { recursive: true });
    await writeFile(join(skills, 'make-infographic', 'old.txt'), 'keep');
  }
  const home = join(dir, 'home');
  await mkdir(home, { recursive: true });
  const browserPath = join(dir, 'fake-browser.exe');
  await writeFile(browserPath, 'not executed');
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const success = process.platform === 'win32' ? '@echo off\r\necho 1.0.0\r\nexit /b 0\r\n' : '#!/bin/sh\necho 1.0.0\nexit 0\n';
  const failure = process.platform === 'win32' ? '@echo off\r\nif "%1"=="--version" (echo 1.0.0&exit /b 0)\r\necho dependency-failed\r\nexit /b 7\r\n' : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi\necho dependency-failed\nexit 7\n';
  await writeFile(join(bin, command), failDeps ? failure : success, { mode: 0o755 });
  const childEnv = {
    ...process.env, HOME: home, USERPROFILE: home, MAKE_INFOGRAPHIC_ZIP: zip,
    BROWSER_PATH: browser ? browserPath : '', CHROME_PATH: '', PATH: bin,
    PUPPETEER_SKIP_DOWNLOAD: 'true',
    ...env,
  };
  if (process.platform === 'win32') {
    const normalized = Object.fromEntries(Object.entries(childEnv).map(([key, value]) => [key.toUpperCase(), value]));
    for (const key of Object.keys(childEnv)) delete childEnv[key];
    Object.assign(childEnv, normalized);
  }
  return {
    skills,
    browser: browserPath,
    result: spawnSync(NODE, [distInstaller, '--target', skills, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: childEnv,
    }),
  };
}

test('archive contract: exact allowlist, required runtime assets, no private eval', async () => workspace(async (dir) => {
  const buffer = await readFile(join(root, 'dist', ARCHIVE_NAME));
  const entries = readZip(buffer);
  const names = entries.map((entry) => entry.name);
  for (const required of ['bridge/server.mjs', 'LICENSE', 'scripts/clean.mjs', 'extension/manifest.json', 'scripts/package-release.mjs', 'scripts/release-contract.mjs']) {
    assert.ok(names.includes(required), `missing ${required}`);
  }
  assert.ok(!names.some((name) => /(^|\/)(private-eval|eval|site|node_modules|dist)(\/|$)/.test(name)));
  assert.deepEqual([...names].sort(), [...new Set([...REQUIRED_FILES, 'LICENSE'])].sort());
  const extracted = join(dir, 'extracted');
  await extractZip(buffer, extracted);
  assert.equal(await readFile(join(extracted, 'bridge', 'server.mjs'), 'utf8'), await readFile(join(root, 'bridge', 'server.mjs'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(extracted, 'package.json'), 'utf8'));
  assert.equal(pkg.version, VERSION);
}));

test('archive contract: deterministic bytes and structure rejection', async () => workspace(async (dir) => {
  const first = await buildZip(root, join(dir, 'a.zip'), [...REQUIRED_FILES, 'LICENSE'], { epoch: 1700000000 });
  const second = await buildZip(root, join(dir, 'b.zip'), [...REQUIRED_FILES, 'LICENSE'], { epoch: 1700000000 });
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, await buildZip(root, join(dir, 'c.zip'), [...REQUIRED_FILES, 'LICENSE'], { epoch: 1700000002 }));
  await assert.rejects(async () => readZip(await buildZip(root, join(dir, 'extra.zip'), [...REQUIRED_FILES, 'LICENSE', 'README.en.md'], { epoch: 315532800, validate: false })), /多余文件/);
  await assert.rejects(async () => readZip(await buildZip(root, join(dir, 'missing.zip'), REQUIRED_FILES.filter((name) => name !== 'bridge/server.mjs'), { epoch: 315532800, validate: false })), /缺少文件/);
}));

test('installer: help and unknown flags do not modify an existing install', async () => workspace(async (dir) => {
  const help = await runInstaller(dir, { args: ['--help'], existing: true });
  assert.equal(help.result.status, 0, help.result.stderr);
  assert.match(help.result.stdout, /--target/);
  assert.equal(await readFile(join(help.skills, 'make-infographic/old.txt'), 'utf8'), 'keep');
  const unknown = await runInstaller(dir, { args: ['--typo'], existing: true });
  assert.notEqual(unknown.result.status, 0);
  assert.match(unknown.result.stderr, /不认识的安装参数/);
  assert.equal(await readFile(join(unknown.skills, 'make-infographic/old.txt'), 'utf8'), 'keep');
}));

test('installer: rejects wrong exact archive name without touching old install', async () => workspace(async (dir) => {
  const { result, skills } = await runInstaller(dir, { zipName: 'make-infographic-9.9.9.zip', existing: true });
  const target = join(skills, 'make-infographic');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /文件名必须精确/);
  assert.equal(await readFile(join(target, 'old.txt'), 'utf8'), 'keep');
}));

test('installer: CRC failure leaves old install intact and removes staging', async () => workspace(async (dir) => {
  const zip = join(dir, ARCHIVE_NAME);
  const bytes = await readFile(join(root, 'dist', ARCHIVE_NAME));
  const first = readZip(bytes)[0];
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central > 0);
  const nameLength = bytes.readUInt16LE(central + 28);
  const extraLength = bytes.readUInt16LE(central + 30);
  const commentLength = bytes.readUInt16LE(central + 32);
  const local = bytes.readUInt32LE(central + 42);
  const payload = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
  assert.equal(first.name, bytes.subarray(local + 30, local + 30 + nameLength).toString('utf8'));
  assert.ok(extraLength + commentLength + payload < bytes.length);
  const wrongCrc = (bytes.readUInt32LE(central + 16) ^ 0xffffffff) >>> 0;
  bytes.writeUInt32LE(wrongCrc, central + 16);
  bytes.writeUInt32LE(wrongCrc, local + 14);
  await writeFile(zip, bytes);
  const { result, skills } = await runInstaller(dir, { existing: true });
  const target = join(skills, 'make-infographic');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CRC 校验失败/);
  assert.equal(await readFile(join(target, 'old.txt'), 'utf8'), 'keep');
  assert.ok(!(await readdir(skills)).some((name) => name.includes('staging')));
}));

test('installer: dependency failure rolls back old install', async () => workspace(async (dir) => {
  const { result, skills } = await runInstaller(dir, { existing: true, failDeps: true });
  const target = join(skills, 'make-infographic');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /依赖没装上/);
  assert.equal(await readFile(join(target, 'old.txt'), 'utf8'), 'keep');
  assert.ok(!(await readdir(skills)).some((name) => name.includes('staging') || name.includes('backup')));
}));

test('installer: replacement failure restores backup', async () => workspace(async (dir) => {
  const hook = join(dir, 'fail-commit.mjs');
  await writeFile(hook, `import fs from 'node:fs/promises';\nimport { syncBuiltinESMExports } from 'node:module';\nconst rename = fs.rename;\nfs.rename = async (from, to) => {\n  if (String(from).includes('.make-infographic-staging-') && String(to).endsWith('make-infographic')) throw new Error('injected commit failure');\n  return rename(from, to);\n};\nsyncBuiltinESMExports();\n`);
  const { result, skills } = await runInstaller(dir, { existing: true, env: { NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` } });
  const target = join(skills, 'make-infographic');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /injected commit failure/);
  assert.equal(await readFile(join(target, 'old.txt'), 'utf8'), 'keep');
  assert.ok(!(await readdir(skills)).some((name) => name.includes('staging') || name.includes('backup')));
}));

test('installer: successful replacement removes old files', async () => workspace(async (dir) => {
  const { result, skills, browser } = await runInstaller(dir, { existing: true });
  const target = join(skills, 'make-infographic');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!existsSync(join(target, 'old.txt')));
  assert.ok(existsSync(join(target, 'bridge', 'server.mjs')));
  assert.match(result.stdout, /不会下载 Chromium/);
  assert.ok(result.stdout.includes(browser));
}));

test('installer: missing browser fails clearly without download', async () => workspace(async (dir) => {
  const empty = join(dir, 'empty');
  await mkdir(empty);
  const hideBrowsers = join(dir, 'hide-browsers.mjs');
  await writeFile(hideBrowsers, `import fs from 'node:fs/promises';\nimport { syncBuiltinESMExports } from 'node:module';\nconst stat = fs.stat;\nfs.stat = async (path, ...args) => {\n  if (/[\\\\/](msedge|chrome|chromium)(\\.exe)?$/i.test(String(path))) throw Object.assign(new Error('hidden for test'), { code: 'ENOENT' });\n  return stat(path, ...args);\n};\nsyncBuiltinESMExports();\n`);
  const { result, skills } = await runInstaller(dir, {
    browser: false,
    env: { NODE_OPTIONS: `--import=${pathToFileURL(hideBrowsers).href}`, BROWSER_PATH: join(empty, 'none.exe'), CHROME_PATH: '' },
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /未找到已安装/);
  assert.match(result.stderr, /绝不会自动下载 Chromium/);
  assert.ok(!existsSync(skills));
}));

test('legacy turn-card index cannot clobber unified index', async () => workspace(async (dir) => {
  const output = join(dir, 'infographics');
  await mkdir(output);
  await writeFile(join(output, 'index.html'), 'unified-index-marker');
  await writeFile(join(output, 'card.json'), JSON.stringify({ layout: 'turn-card', title: 'old card' }));
  const result = await refreshIndex(dir);
  assert.equal(result.page, join(output, 'turn-index.html'));
  assert.equal(await readFile(join(output, 'index.html'), 'utf8'), 'unified-index-marker');
  assert.match(await readFile(result.page, 'utf8'), /old card/);
}));
