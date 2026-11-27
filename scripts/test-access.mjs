import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser, closeBrowser } from './browser.mjs';

await import('../extension/trace-core.js');
const TraceCore = globalThis.TraceCore;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(root, 'make-infographic/eval/access-m1');
const mockPath = join(outDir, 'mock-qwen.html');
const tracePath = join(outDir, 'qwen-trace.json');
const traceMdPath = join(outDir, 'qwen-trace.md');
const skill = join(root, 'make-infographic');
await mkdir(outDir, { recursive: true });

const mock = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Qwen 测试会话</title></head><body><main>
<div data-role="user" class="chat-message user">我以为读完再 recognizing 答案，就算自测。</div>
<div data-role="assistant" class="chat-message assistant"><div class="thinking-panel">先区分熟悉感与独立回忆，再检查重读能证明什么。</div><div class="answer">不是。重读只会让文字更熟，不会让记忆更牢。正确做法是先自己回忆，再看答案。先回忆，再反馈；熟悉感不是掌握，能独立回忆才是。</div></div>
</main></body></html>`;
await writeFile(mockPath, mock, 'utf8');

function run(args) {
  return execFileSync(process.execPath, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, MI_KEEP_CODEPAGE: '1' },
  });
}

const browser = await launchBrowser();
let extensionTrace;
let webImportPass = false;
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(mockPath).href, { waitUntil: 'load' });
  await page.addScriptTag({ path: join(root, 'make-infographic/extension/trace-core.js') });
  extensionTrace = await page.evaluate(() => globalThis.TraceCore.captureQwen(document, window.location));
  const importPage = await browser.newPage();
  await importPage.goto(pathToFileURL(join(root, 'site/web/import.html')).href, { waitUntil: 'load' });
  await importPage.click('#sample');
  await importPage.click('#parse');
  const importStatus = await importPage.$eval('#status', (element) => element.textContent);
  const importTurns = await importPage.$$eval('#turns .turn', (elements) => elements.length);
  webImportPass = importStatus.includes('已解析 2 轮') && importTurns === 2;
} finally {
  await closeBrowser(browser);
}
assert.equal(webImportPass, true, '网页导入入口没有解析出两轮对话');
assert.equal(extensionTrace.turns.length, 2);
assert.equal(extensionTrace.turns[0].speaker, 'user');
assert.equal(extensionTrace.turns[1].speaker, 'assistant');
assert.ok(extensionTrace.turns[1].thinking.includes('区分熟悉感与独立回忆'));
assert.ok(extensionTrace.turns[1].text.includes('先自己回忆，再看答案'));
await writeFile(tracePath, `${JSON.stringify(extensionTrace, null, 2)}\n`, 'utf8');
await writeFile(traceMdPath, `${TraceCore.traceToMarkdown(extensionTrace)}\n`, 'utf8');

run([join(root, 'make-infographic/scripts/trace.mjs'), 'import', '--in', traceMdPath, '--out', join(outDir, 'imported-trace.json')]);
const imported = JSON.parse(await readFile(join(outDir, 'imported-trace.json'), 'utf8'));
assert.deepEqual(imported.turns, extensionTrace.turns);
const special = TraceCore.normalizeTrace(JSON.stringify({ messages: [
  { role: 'user', text: '第一行\n用户：这不是新轮次\n```\n代码' },
  { role: 'assistant', text: '回答', thinking: '可见思考\n思考：仍然是思考' },
] }));
assert.deepEqual(TraceCore.parseMarkdown(TraceCore.traceToMarkdown(special)).turns, special.turns);
assert.throws(() => TraceCore.normalizeTrace('{"messages": ['), /JSON|Unexpected|property/i);

const bridgePort = 5391;
const bridgeWorkspace = join(outDir, 'bridge');
const bridge = spawn(process.execPath, [join(root, 'make-infographic/bridge/server.mjs'), '--port', String(bridgePort), '--workspace', bridgeWorkspace, '--skill', skill], {
  cwd: root,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeLogs = '';
bridge.stdout.on('data', (chunk) => { bridgeLogs += chunk.toString(); });
bridge.stderr.on('data', (chunk) => { bridgeLogs += chunk.toString(); });
try {
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`桥接启动超时：${bridgeLogs}`)), 15000);
    bridge.stdout.on('data', () => {
      if (bridgeLogs.includes('BRIDGE OK')) { clearTimeout(timer); resolvePromise(); }
    });
    bridge.on('exit', (code) => { clearTimeout(timer); reject(new Error(`桥接提前退出 ${code}：${bridgeLogs}`)); });
  });
  const denied = await fetch(`http://127.0.0.1:${bridgePort}/capture`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(extensionTrace),
  });
  assert.equal(denied.status, 401, '无令牌请求必须被拒绝');
  const token = (await readFile(join(bridgeWorkspace, '.bridge-token'), 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${bridgePort}/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mi-bridge-token': token },
    body: JSON.stringify(extensionTrace),
  });
  const bridgeResult = await response.json();
  assert.equal(response.status, 200, JSON.stringify(bridgeResult));
  assert.equal(bridgeResult.ok, true);
  assert.ok(bridgeResult.artifacts.png);
  await readFile(bridgeResult.artifacts.png);
} finally {
  bridge.kill();
}

const importWorkspace = join(outDir, 'import-render');
const importOutput = run([join(root, 'make-infographic/scripts/trace.mjs'), 'render', tracePath, '--out-dir', importWorkspace, '--skill', skill]);
assert.ok(importOutput.includes('"ok": true'));

const skillWorkspace = join(outDir, 'skill-render');
const skillOutput = run([join(skill, 'scripts/make.mjs'), '--in', traceMdPath, '--cwd', skillWorkspace, '--out', 'Qwen 同一会话']);
assert.ok(skillOutput.trimEnd().endsWith('OK'));

async function newestPng(workspace) {
  const names = await readdir(join(workspace, 'infographics'));
  const png = names.filter((name) => name.endsWith('.png')).sort().at(-1);
  assert.ok(png, `${workspace} 没有 PNG`);
  return join(workspace, 'infographics', png);
}
const extensionPng = await newestPng(bridgeWorkspace);
const importPng = await newestPng(importWorkspace);
const skillPng = await newestPng(skillWorkspace);
for (const png of [extensionPng, importPng, skillPng]) {
  const bytes = await readFile(png);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
}

const report = {
  schema_version: 'access-m1.v1',
  at: new Date().toISOString(),
  pass: true,
  routes: ['qwen-extension', 'import', 'skill'],
  web_import: webImportPass,
  turns: extensionTrace.turns.length,
  visible_thinking_blocks: extensionTrace.turns.filter((turn) => turn.thinking).length,
  artifacts: { extension: extensionPng, import: importPng, skill: skillPng },
  trace: tracePath,
  extension_loaded: false,
  limitations: ['当前已安装的 Chrome／Edge 不允许命令行加载未打包扩展；捕获规则在模拟 Qwen DOM 上验收，真实扩展运行未实测。', '未登录真实 Qwen 会话。', '可见思考只捕获页面当前展示内容，不读取隐藏推理。'],
};
await writeFile(join(outDir, 'm1-results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(join(outDir, 'm1-results.md'), `# M1 三入口验收\n\n- 结论：通过\n- 入口：Qwen 扩展／网页导入／Skill\n- 轮次：${report.turns}\n- 可见思考块：${report.visible_thinking_blocks}\n- 网页导入解析：${webImportPass ? '通过' : '未通过'}\n- 三条路均生成 PNG\n\n扩展使用模拟 Qwen DOM 验收；未登录真实 Qwen，且只捕获页面可见思考。\n`, 'utf8');
console.log(JSON.stringify({ pass: true, routes: 3, turns: report.turns, visible_thinking_blocks: report.visible_thinking_blocks }, null, 2));
console.log('ACCESS M1 OK');
