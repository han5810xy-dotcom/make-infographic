import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCli } from '../scripts/console.mjs';

await import('../extension/trace-core.js');
const TraceCore = globalThis.TraceCore;
const here = dirname(fileURLToPath(import.meta.url));

function arg(argv, name, fallback = '') {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} 后面要写一个值。`);
  return value;
}

async function readBody(request, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('请求超过 5MB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv) {
  const port = Number(arg(argv, 'port', '5278'));
  const workspace = resolve(arg(argv, 'workspace', join(here, '../../eval/bridge')));
  const skill = resolve(arg(argv, 'skill', 'C:/Users/13258/.qoder-cn/skills/make-infographic'));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port 必须是 1024~65535 的整数');
  await mkdir(join(workspace, 'traces'), { recursive: true });

  const server = createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'content-type');
    response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, service: 'make-infographic-bridge', workspace, skill }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/capture') {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }
    try {
      const trace = TraceCore.normalizeTrace(await readBody(request), { type: 'qwen-extension' });
      const errors = TraceCore.validateTrace(trace);
      if (errors.length) throw new Error(errors.join('；'));
      const jsonPath = join(workspace, 'traces', `${trace.id}.json`);
      const mdPath = join(workspace, 'traces', `${trace.id}.md`);
      await writeFile(jsonPath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
      await writeFile(mdPath, `${TraceCore.traceToMarkdown(trace)}\n`, 'utf8');
      const result = spawnSync(process.execPath, [join(skill, 'scripts/make.mjs'), '--in', mdPath, '--cwd', workspace, '--out', trace.source.title || trace.id], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, MI_KEEP_CODEPAGE: '1' },
      });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout || '本机出图失败');
      const names = await readdir(join(workspace, 'infographics'));
      const artifacts = {};
      for (const extension of ['png', 'svg', 'pdf', 'html', 'json']) {
        const name = names.filter((item) => item.endsWith(`.${extension}`)).sort().at(-1);
        if (name) artifacts[extension] = join(workspace, 'infographics', name);
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, trace_id: trace.id, turns: trace.turns.length, trace_path: jsonPath, artifacts, output: result.stdout }, null, 2));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: error?.message || 'bridge failed' }, null, 2));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`本机桥接已启动：http://127.0.0.1:${port}/health`);
    console.log(`工作目录：${workspace}`);
    console.log('BRIDGE OK');
  });
}

startCli(import.meta.url, 'bridge', main);
