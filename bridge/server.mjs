import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCli, checkFlags } from '../scripts/console.mjs';

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

function authorized(request, token) {
  const supplied = String(request.headers['x-mi-bridge-token'] || '');
  const left = Buffer.from(supplied);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function render(make, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [make, ...args], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MI_KEEP_CODEPAGE: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(stderr || stdout || `本机出图失败（退出码 ${code}）`)));
  });
}

async function main(argv) {
  checkFlags(argv, ['port', 'workspace', 'skill', 'token', 'allow-origin']);
  const port = Number(arg(argv, 'port', '5278'));
  const workspace = resolve(arg(argv, 'workspace', join(here, '../../eval/bridge')));
  const skill = resolve(arg(argv, 'skill', join(here, '..')));
  const allowOrigins = new Set(arg(argv, 'allow-origin', `http://127.0.0.1:${port}`).split(',').map((item) => item.trim()).filter(Boolean));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port 必须是 1024~65535 的整数');
  await mkdir(join(workspace, 'traces'), { recursive: true });
  let token = arg(argv, 'token');
  if (!token) {
    const tokenPath = join(workspace, '.bridge-token');
    try { token = (await readFile(tokenPath, 'utf8')).trim(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      token = randomBytes(24).toString('hex');
      await writeFile(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  }

  let queue = Promise.resolve();
  const server = createServer(async (request, response) => {
    const origin = String(request.headers.origin || '');
    const cors = allowOrigins.has(origin);
    response.setHeader('vary', 'Origin');
    if (cors) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('access-control-allow-headers', 'content-type,x-mi-bridge-token');
      response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    }
    const json = (code, value) => {
      response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(value, null, 2));
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(cors ? 204 : 403);
      response.end();
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      json(200, { ok: true, service: 'make-infographic-bridge', workspace, token_file: join(workspace, '.bridge-token') });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/capture') {
      json(404, { ok: false, error: 'not found' });
      return;
    }
    if (!authorized(request, token)) {
      json(401, { ok: false, error: '缺少或错误的桥接令牌。请复制工作目录 .bridge-token 的内容到扩展弹窗。' });
      return;
    }
    const job = queue.then(async () => {
      try {
        if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new Error('请求必须是 application/json');
        const trace = TraceCore.normalizeTrace(await readBody(request), { type: 'qwen-extension' });
        const errors = TraceCore.validateTrace(trace);
        if (errors.length) throw new Error(errors.join('；'));
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const captureDir = join(workspace, 'captures', `${stamp}-${trace.id}`);
        const jsonPath = join(captureDir, 'trace.json');
        const mdPath = join(captureDir, 'trace.md');
        await mkdir(captureDir, { recursive: true });
        await writeFile(jsonPath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
        await writeFile(mdPath, `${TraceCore.traceToMarkdown(trace)}\n`, 'utf8');
        const output = await render(join(skill, 'scripts/make.mjs'), ['--in', mdPath, '--cwd', captureDir, '--out', trace.source.title || trace.id]);
        const artifacts = {};
        const outDir = join(captureDir, 'infographics');
        for (const extension of ['png', 'svg', 'html', 'json']) {
          const { readdir } = await import('node:fs/promises');
          const names = await readdir(outDir);
          const name = names.filter((item) => item.endsWith(`.${extension}`)).sort().at(-1);
          if (name) artifacts[extension] = join(outDir, name);
        }
        json(200, { ok: true, trace_id: trace.id, turns: trace.turns.length, trace_path: jsonPath, artifacts, output });
      } catch (error) {
        json(400, { ok: false, error: error?.message || 'bridge failed' });
      }
    });
    queue = job.catch(() => {});
    await job;
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`本机桥接已启动：http://127.0.0.1:${port}/health`);
    console.log(`工作目录：${workspace}`);
    console.log(`令牌文件：${join(workspace, '.bridge-token')}（将文件内容粘贴到扩展弹窗；不要分享）`);
    console.log(`允许来源：${[...allowOrigins].join(', ')}（扩展请求在后台发送，不依赖此 CORS 来源）`);
    console.log('BRIDGE OK');
  });
}

startCli(import.meta.url, 'bridge', main);
