import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tool = join(root, '../site/tools/import-published.mjs');
const artifact = {
  schema_version: 'public-knowledge-artifact.v1', structure_id: 's_1234567890abcdef', topic: '学习', headline: '公开的判断', subhead: '一件主动公开的作品',
  propositions: [{ concept_id: 'c_1234567890abcdef', kind: '主张', text: '自己的话才留下学习证据', provenance: 'summary' }],
  relations: [],
};
const workspace = async (run) => {
  const dir = await mkdtemp(join(tmpdir(), 'make-infographic-published-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
};
const runImport = (input, out, extra = []) => spawnSync(process.execPath, [tool, '--in', input, '--out', out, ...extra], { encoding: 'utf8', windowsHide: true });

test('published import renders only whitelisted artifact fields', async () => workspace(async (dir) => {
  const input = join(dir, 'input');
  const out = join(dir, 'web');
  await mkdir(input);
  await writeFile(join(input, 'artifact.json'), JSON.stringify(artifact));
  const result = runImport(input, out);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(await readFile(join(out, 'data/published.json'), 'utf8'));
  assert.equal(data.items.length, 1);
  const detail = await readFile(join(out, 'published/s_1234567890abcdef.html'), 'utf8');
  assert.match(detail, /自己的话才留下学习证据/);
  assert.doesNotMatch(detail, /evidence|events|source_hash|mastery/);
  assert.match(await readFile(join(out, 'published.html'), 'utf8'), /公开的判断/);
}));

test('published import rejects private fields and preserves unrelated files', async () => workspace(async (dir) => {
  const input = join(dir, 'input');
  const out = join(dir, 'web');
  await mkdir(input);
  await mkdir(join(out, 'published'), { recursive: true });
  await writeFile(join(out, 'published/user-notes.txt'), 'keep');
  await writeFile(join(input, 'artifact.json'), JSON.stringify({ ...artifact, evidence: [{ text: 'private quote' }] }));
  const rejected = runImport(input, out);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /私有字段/);
  await writeFile(join(input, 'artifact.json'), JSON.stringify(artifact));
  const accepted = runImport(input, out);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(await readFile(join(out, 'published/user-notes.txt'), 'utf8'), 'keep');
  await rm(join(input, 'artifact.json'));
  const emptied = runImport(input, out);
  assert.equal(emptied.status, 0, emptied.stderr);
  await assert.rejects(() => access(join(out, 'published/s_1234567890abcdef.html')));
  assert.equal(await readFile(join(out, 'published/user-notes.txt'), 'utf8'), 'keep');
}));
