import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { learningState, recordAnswer, revealConcept, exportLearning, probeFor, ROUTES } from './learning-core.mjs';

const MAX_BODY = 1024 * 1024;
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const assetRoot = fileURLToPath(new URL('../web/learn/', import.meta.url));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, status, value, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function constantToken(provided, expected) {
  if (typeof provided !== 'string') return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function checkHost(req) {
  const host = req.headers.host || '';
  const match = /^(\[[0-9a-fA-F:]+\]|[^:]+)(?::(\d+))?$/.exec(host);
  if (!match) throw new HttpError(403, '不允许的主机地址。');
  const name = match[1].replace(/^\[|\]$/g, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(name)) throw new HttpError(403, '只接受本机地址。');
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  try {
    const target = new URL(origin);
    if (target.origin !== `http://${req.headers.host}`) throw new Error();
  } catch { throw new HttpError(403, '不允许跨站请求。'); }
}

async function readJson(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, '请求必须使用 application/json。');
  const length = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(length) && length > MAX_BODY) {
    req.resume();
    throw new HttpError(413, '请求正文不能超过 1MB。');
  }
  const chunks = [];
  let size = 0;
  await new Promise((resolvePromise, reject) => {
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on('end', resolvePromise);
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError(400, '请求中断。')));
  });
  if (size > MAX_BODY) throw new HttpError(413, '请求正文不能超过 1MB。');
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, '请求正文不是合法 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求正文必须是 JSON 对象。');
  return value;
}

function safeConcept(concept) {
  return {
    concept_id: concept.concept_id,
    topic: concept.topic,
    kind: concept.kind,
    due: concept.due,
    evidence_stage: concept.evidence_stage,
    routes: concept.routes,
    sources: concept.sources.map((source) => ({
      structure_id: source.structure_id,
      proposition_id: source.proposition_id,
      document_id: source.document_id,
      layer: source.layer,
      provenance: source.provenance,
    })),
    relations: concept.relations.map((relation) => ({ to: relation.to, kind: relation.kind })),
  };
}

function stateResponse(state) {
  const { projection, registry, events } = state;
  const concepts = projection.rows.map(safeConcept);
  return {
    counts: projection.counts,
    by_route: projection.by_route,
    due: projection.due.slice(0, 3).map((concept) => {
      const route = ROUTES.find((item) => concept.routes[item].due) || 'recall';
      return { concept_id: concept.concept_id, topic: concept.topic, kind: concept.kind, route, probe: probeFor(concept, route) };
    }),
    concepts,
    events,
    documents: registry.documents,
    graph: {
      nodes: concepts.map(({ concept_id, topic, evidence_stage }) => ({ concept_id, topic, evidence_stage })),
      edges: concepts.flatMap((concept) => concept.relations.map((relation) => ({ from: concept.concept_id, to: relation.to, kind: relation.kind }))),
    },
  };
}

async function serveAsset(pathname, method, res) {
  const asset = ASSETS.get(pathname);
  if (!asset) throw new HttpError(404, '页面不存在。');
  let body;
  try { body = await readFile(join(assetRoot, asset[0])); }
  catch (error) { throw new HttpError(500, `读取本地页面失败：${error.message}`); }
  res.writeHead(200, {
    'Content-Type': asset[1],
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(method === 'HEAD' ? undefined : body);
}


export async function startLearningServer({ workspace, port = 5279, host = '127.0.0.1' } = {}) {
  if (!workspace) throw new TypeError('workspace is required');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port 必须是 0~65535 的整数。');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new TypeError('学习工作台只能监听本机回环地址。');
  const root = resolve(workspace);
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    try {
      checkHost(req);
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') checkOrigin(req);
      let pathname;
      try { pathname = new URL(req.url, `http://${req.headers.host}`).pathname; }
      catch { throw new HttpError(400, '请求地址不合法。'); }
      if (!pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, '静态资源只支持 GET。');
        return await serveAsset(pathname, req.method, res);
      }
      if (!constantToken(req.headers['x-learn-token'], token)) throw new HttpError(401, '缺少或无效的学习令牌。');
      const query = new URL(req.url, `http://${req.headers.host}`).searchParams;
      if (pathname === '/api/state') {
        if (req.method !== 'GET') throw new HttpError(405, '只支持 GET。');
        return sendJson(res, 200, stateResponse(await learningState(root)));
      }
      if (pathname === '/api/prompt') {
        if (req.method !== 'GET') throw new HttpError(405, '只支持 GET。');
        const conceptId = query.get('concept_id');
        const requestedRoute = query.get('route');
        if (!conceptId || !/^c_[a-f0-9]{16}$/.test(conceptId)) throw new HttpError(400, 'concept_id 不合法。');
        if (requestedRoute !== null && !ROUTES.includes(requestedRoute)) throw new HttpError(400, 'route 不合法。');
        const state = await learningState(root);
        const concept = state.projection.rows.find((item) => item.concept_id === conceptId);
        if (!concept) throw new HttpError(404, '找不到这个概念。');
        const route = requestedRoute || ROUTES.find((item) => concept.routes[item].due) || 'recall';
        return sendJson(res, 200, probeFor(concept, route));
      }
      if (pathname === '/api/answer') {
        if (req.method !== 'POST') throw new HttpError(405, '只支持 POST。');
        const input = await readJson(req);
        if (typeof input.concept_id !== 'string' || !/^c_[a-f0-9]{16}$/.test(input.concept_id)) throw new HttpError(400, 'concept_id 不合法。');
        if (input.route !== undefined && !ROUTES.includes(input.route)) throw new HttpError(400, 'route 不合法。');
        if (typeof input.answer !== 'string' || !input.answer.trim()) throw new HttpError(400, '请先写下自己的解释。');
        if (input.answer.length > 10000) throw new HttpError(400, '单次答案不能超过 10000 字。');
        if (input.prompt_id !== undefined && typeof input.prompt_id !== 'string') throw new HttpError(400, 'prompt_id 不合法。');
        const result = await recordAnswer(root, input);
        return sendJson(res, 200, result);
      }
      if (pathname === '/api/reveal') {
        if (req.method !== 'GET') throw new HttpError(405, '只支持 GET。');
        const eventId = query.get('event_id');
        if (!eventId || !/^e_[a-f0-9]{20}$/.test(eventId)) throw new HttpError(400, 'event_id 不合法。');
        const state = await learningState(root);
        const event = state.events.find((item) => item.event_id === eventId);
        if (!event) throw new HttpError(404, '找不到这次作答记录；只有已保存的作答才能揭示证据。');
        let conceptId = event.concept_id;
        const seen = new Set();
        while (state.aliases[conceptId] && !seen.has(conceptId)) { seen.add(conceptId); conceptId = state.aliases[conceptId]; }
        return sendJson(res, 200, { event, reveal: revealConcept(state.registry, conceptId) });
      }
      if (pathname === '/api/export') {
        if (req.method !== 'GET') throw new HttpError(405, '只支持 GET。');
        const bundle = await exportLearning(root);
        return sendJson(res, 200, bundle, { 'Content-Disposition': 'attachment; filename="learning-evidence.json"' });
      }
      throw new HttpError(404, '接口不存在。');
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      const status = error instanceof HttpError ? error.status : /题目已变化|找不到这个概念|学习事件/.test(error.message || '') ? 409 : 500;
      if (status === 500) console.error('[learn]', error);
      sendJson(res, status, { ok: false, error: status === 500 ? '本地服务暂时无法完成请求；原始文件未被覆盖。' : error.message });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolvePromise(); });
  });
  const address = server.address();
  const shownHost = host === '::1' ? '[::1]' : host;
  const url = `http://${shownHost}:${address.port}/#token=${token}`;
  console.log(`LEARN OK ${url}`);
  return { server, token, url, workspace: root };
}
