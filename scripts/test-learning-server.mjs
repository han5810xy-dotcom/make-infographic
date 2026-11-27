import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeStructure } from './knowledge-contract.mjs';
import { syncLearning } from './learning-core.mjs';
import { startLearningServer } from './learn-server.mjs';

const proposition = (id, text, kind = '主张') => ({
  id, kind, layer: 'main', text,
  evidence: [{ quote_id: `q_${id}`, speaker: 'assistant', turn_index: 0, verbatim: false }],
  weight: 0.9, provenance: 'summary',
});

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'make-infographic-server-'));
  const structure = finalizeStructure({
    topic: '学习证据', headline: '学习证据',
    propositions: [proposition('p1', '分数只说明测试跑通'), proposition('p2', '自己的话才留下学习证据', '定义')],
    relations: [{ from: 'p1', to: 'p2', kind: '支持', strength: 0.8, evidence: [{ quote_id: 'q_relation', speaker: 'assistant', turn_index: 1, verbatim: false }] }],
    topo: 'chain', backbone: ['p1'], gaps: [],
  });
  structure.source_hash = 'document-server-test';
  await mkdir(join(workspace, 'infographics'), { recursive: true });
  await writeFile(join(workspace, 'infographics', 'a.json'), JSON.stringify(structure));
  await writeFile(join(workspace, 'infographics', 'a.source.md'), '助手：分数只说明测试跑通。自己的话才留下学习证据。');
  await syncLearning(workspace);
  return workspace;
}

async function withServer(run) {
  const workspace = await fixture();
  const running = await startLearningServer({ workspace, port: 0 });
  const base = `http://127.0.0.1:${running.server.address().port}`;
  const request = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { 'x-learn-token': running.token, ...options.headers },
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { response, body, text };
  };
  try { return await run({ ...running, base, request, workspace }); }
  finally {
    await new Promise((resolve) => running.server.close(resolve));
    await rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
}

const answerInput = (item, extra = {}) => ({ concept_id: item.concept_id, route: item.route, answer: '它只说明测试通过，不说明理解。', self_report: 'without_looking', prompt_id: item.probe.prompt_id, ...extra });

test('loopback server prints a fragment token, serves assets, and protects APIs', async () => withServer(async ({ base, request, token, url }) => {
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.match(url, new RegExp(`^${base}/#token=${token}$`));
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /学习工作台/);
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  assert.equal((await request('/app.js')).response.status, 200);
  const unauthorized = await fetch(`${base}/api/state`);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { ok: false, error: '缺少或无效的学习令牌。' });
  const wrongToken = await fetch(`${base}/api/state`, { headers: { 'x-learn-token': '0'.repeat(64) } });
  assert.equal(wrongToken.status, 401);
  const rejectedHost = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/state`, { headers: { 'x-learn-token': token, host: 'example.com' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(rejectedHost, 403);
  const crossOrigin = await request('/api/answer', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(crossOrigin.response.status, 403);
  assert.equal(crossOrigin.body.ok, false);
  const cors = await request('/api/state', { headers: { Origin: base } });
  assert.equal(cors.response.headers.get('access-control-allow-origin'), null);
}));

test('state and prompts hide original propositions; only a saved answer reveals evidence', async () => withServer(async ({ base, request }) => {
  const { response, body: state, text } = await request('/api/state');
  assert.equal(response.status, 200);
  assert.equal(state.counts.concepts, 2);
  assert.equal(state.counts.due, 2);
  assert.equal(state.graph.nodes.length, 2);
  assert.equal(state.graph.edges.length, 1);
  assert.equal(state.documents.length, 1);
  assert.equal(text.includes('分数只说明测试跑通'), false);
  assert.equal(text.includes('自己的话才留下学习证据'), false);
  assert.equal(JSON.stringify(state.due).includes('instruction'), true);
  const due = state.due[0];
  const prompt = await request(`/api/prompt?concept_id=${due.concept_id}&route=${due.route}`);
  assert.equal(prompt.response.status, 200);
  assert.equal(prompt.body.prompt_id, due.probe.prompt_id);
  assert.equal(prompt.text.includes('分数只说明测试跑通'), false);
  assert.equal(prompt.text.includes('自己的话才留下学习证据'), false);
  const missingEvent = await request(`/api/reveal?event_id=e_${'0'.repeat(20)}`);
  assert.equal(missingEvent.response.status, 404);
  const answer = await request('/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Origin: base }, body: JSON.stringify(answerInput(due)) });
  assert.equal(answer.response.status, 200);
  assert.equal(answer.body.event.answer, '它只说明测试通过，不说明理解。');
  assert.match(answer.body.reveal.text, /^(分数只说明测试跑通|自己的话才留下学习证据)$/);
  assert.ok(answer.body.reveal.sources[0].evidence.length);
  const revealed = await request(`/api/reveal?event_id=${answer.body.event.event_id}`);
  assert.equal(revealed.response.status, 200);
  assert.equal(revealed.body.reveal.text, answer.body.reveal.text);
  assert.equal(revealed.body.event.answer, answer.body.event.answer);
  const exported = await request('/api/export');
  assert.equal(exported.response.status, 200);
  assert.match(exported.response.headers.get('content-disposition'), /attachment/);
  assert.equal(exported.body.schema_version, 'learning.v1');
  assert.equal(exported.body.events.length, 1);
  const after = await request('/api/state');
  assert.equal(after.body.counts.events, 1);
  assert.equal(after.body.events[0].answer, answer.body.event.answer);
}));

test('answers serialize without losing records', async () => withServer(async ({ request }) => {
  const state = (await request('/api/state')).body;
  const due = state.due[0];
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => request('/api/answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(answerInput(due, { answer: `第 ${index + 1} 次自己的解释` })),
  })));
  for (const result of results) assert.equal(result.response.status, 200);
  const after = (await request('/api/state')).body;
  assert.equal(after.events.length, 6);
  assert.deepEqual(after.events.map((event) => event.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(after.events.map((event) => event.answer)).size, 6);
}));

test('invalid methods, content types, oversized bodies, and stale prompts return JSON errors', async () => withServer(async ({ base, request }) => {
  const due = (await request('/api/state')).body.due[0];
  const method = await request('/api/state', { method: 'POST' });
  assert.equal(method.response.status, 405);
  const type = await request('/api/answer', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(type.response.status, 415);
  const oversized = await request('/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: 'x'.repeat(1024 * 1024) }) });
  assert.equal(oversized.response.status, 413);
  const malformed = await request('/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.response.status, 400);
  const stale = await request('/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(answerInput(due, { prompt_id: 'l_stale' })) });
  assert.equal(stale.response.status, 409);
  assert.deepEqual(Object.keys(stale.body), ['ok', 'error']);
  assert.equal(stale.body.ok, false);
  assert.equal((await request('/api/state')).body.events.length, 0);
  const missingAsset = await fetch(`${base}/not-found`);
  assert.equal(missingAsset.status, 404);
}));
