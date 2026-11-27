import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCli } from './console.mjs';

await import('../extension/trace-core.js');
const TraceCore = globalThis.TraceCore;
const usage = `用法：node scripts/trace.mjs import --in 对话.md --out trace.json
     node scripts/trace.mjs paste --text "用户：... 助手：..." --out trace.json
     node scripts/trace.mjs validate trace.json
     node scripts/trace.mjs markdown trace.json --out trace.md
     node scripts/trace.mjs render trace.json --out-dir 输出目录 [--skill 技能目录]`;

function arg(argv, name, fallback = '') {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} 后面要写一个值。`);
  return value;
}

async function writeText(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value, 'utf8');
}

async function readTrace(path) {
  const text = await readFile(resolve(path), 'utf8');
  const trace = TraceCore.normalizeTrace(text, { type: 'import' });
  const errors = TraceCore.validateTrace(trace);
  if (errors.length) throw new Error(errors.join('；'));
  return trace;
}

async function main(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(usage);
    return 0;
  }
  const command = argv[0];
  if (command === 'import' || command === 'paste') {
    const out = arg(argv, 'out');
    if (!out) throw new Error(usage);
    let input;
    if (command === 'import') {
      const source = arg(argv, 'in');
      if (!source) throw new Error(usage);
      input = await readFile(resolve(source), 'utf8');
    } else {
      input = arg(argv, 'text');
      if (!input) input = await new Promise((resolvePromise, reject) => {
        let text = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { text += chunk; });
        process.stdin.on('end', () => resolvePromise(text));
        process.stdin.on('error', reject);
      });
    }
    const trace = TraceCore.normalizeTrace(input, { type: arg(argv, 'type') || 'import', url: arg(argv, 'url'), title: arg(argv, 'title') });
    const errors = TraceCore.validateTrace(trace);
    if (errors.length) throw new Error(errors.join('；'));
    await writeText(out, `${JSON.stringify(trace, null, 2)}\n`);
    console.log(`Trace 已写入：${resolve(out)}（${trace.turns.length} 轮）`);
    return 0;
  }
  if (command === 'validate') {
    const trace = await readTrace(argv[1]);
    console.log(`Trace 合法：${trace.turns.length} 轮，${trace.turns.filter((turn) => turn.thinking).length} 轮含可见思考。`);
    return 0;
  }
  if (command === 'markdown') {
    const trace = await readTrace(argv[1]);
    const out = arg(argv, 'out');
    if (!out) throw new Error(usage);
    await writeText(out, `${TraceCore.traceToMarkdown(trace)}\n`);
    console.log(`Markdown 已写入：${resolve(out)}`);
    return 0;
  }
  if (command === 'render') {
    const trace = await readTrace(argv[1]);
    const outDir = resolve(arg(argv, 'out-dir'));
    if (!arg(argv, 'out-dir')) throw new Error(usage);
    const skill = resolve(arg(argv, 'skill', join(dirname(fileURLToPath(import.meta.url)), '..')));
    const make = join(skill, 'scripts/make.mjs');
    const tracePath = join(outDir, 'traces', `${trace.id}.md`);
    await writeText(tracePath, `${TraceCore.traceToMarkdown(trace)}\n`);
    const title = trace.source.title || trace.turns[0]?.text?.slice(0, 24) || '对话知识结构';
    const result = spawnSync(process.execPath, [make, '--in', tracePath, '--cwd', outDir, '--out', title], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, MI_KEEP_CODEPAGE: '1' },
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || '出图失败');
    console.log(result.stdout.trim());
    console.log(JSON.stringify({ ok: true, trace: tracePath, out_dir: outDir }, null, 2));
    return 0;
  }
  throw new Error(`不认识的 Trace 命令：${command}\n${usage}`);
}

startCli(import.meta.url, 'trace', main);
