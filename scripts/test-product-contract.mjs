import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REQUIRED_FILES, VERSION } from './release-contract.mjs';
import { scrubArtifact } from './publish.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('one canonical workflow and private learning data stay out of git', async () => {
  const workflow = await readFile(join(root, 'references/workflow.md'), 'utf8');
  const skill = await readFile(join(root, 'SKILL.md'), 'utf8');
  const ignore = await readFile(join(root, '.gitignore'), 'utf8');
  assert.match(workflow, /对话 → 知识结构 → 学习证据/);
  assert.doesNotMatch(workflow, /默认只生成一张竖图/);
  assert.match(skill, /concept_id/);
  assert.match(skill, /learn\.mjs/);
  for (const path of ['.knowledge/', '.bridge-token', 'infographics/']) assert.ok(ignore.includes(path), path);
});

test('schema and release contract include the learning substrate', async () => {
  const schema = JSON.parse(await readFile(join(root, 'references/knowledge-structure.schema.json'), 'utf8'));
  assert.ok(schema.$defs.proposition.required.includes('concept_id'));
  assert.ok(schema.$defs.proposition.required.includes('layer'));
  assert.deepEqual(schema.$defs.view.properties.graphic.enum, ['flow', 'tree', 'matrix', 'network', 'turn-band']);
  for (const path of ['scripts/learning-core.mjs', 'scripts/learn.mjs', 'scripts/learn-server.mjs', 'scripts/publish.mjs', 'web/learn/index.html', 'web/learn/app.js', 'web/learn/styles.css']) assert.ok(REQUIRED_FILES.includes(path), path);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, VERSION);
});

test('trace parser copies remain byte-identical and reject forged ids', async () => {
  const extension = await readFile(join(root, 'extension/trace-core.js'), 'utf8');
  const website = await readFile(join(root, '../site/web/trace-core.js'), 'utf8');
  assert.equal(extension, website);
  await import('../extension/trace-core.js');
  const trace = globalThis.TraceCore.normalizeTrace('用户：一句话\n助手：另一句话');
  const forged = { ...trace, id: 'tr_0000000000000000' };
  assert.throws(() => globalThis.TraceCore.normalizeTrace(JSON.stringify(forged)), /id 与内容不一致/);
});

test('public artifacts use a whitelist and never include evidence or learning state', () => {
  const artifact = scrubArtifact({
    id: 's_1234567890abcdef', topic: '学习', headline: '标题', source_hash: 'private-source', events: [{ answer: '私有答案' }],
    propositions: [{ id: 'p1', concept_id: 'c_1234567890abcdef', kind: '主张', text: '一个判断', provenance: 'summary', evidence: [{ quote_id: 'private-quote' }], weight: 0.9 }],
    relations: [{ from: 'p1', to: 'p1', kind: '支持', evidence: [{ quote_id: 'private-quote' }] }],
  });
  assert.equal(artifact.propositions[0].concept_id, 'c_1234567890abcdef');
  assert.equal(artifact.relations.length, 0);
  const text = JSON.stringify(artifact);
  for (const forbidden of ['private-source', '私有答案', 'private-quote', 'evidence', 'weight', 'events']) assert.ok(!text.includes(forbidden), forbidden);
});

test('multi-structure CLI writes a bundle and every structure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'make-infographic-bundle-'));
  try {
    const source = join(dir, 'source.md');
    const out = join(dir, 'bundle.json');
    const lines = Array.from({ length: 70 }, (_, index) => `${index % 2 ? '助手' : '用户'}：第${index}条独立命题：证据必须逐字引回原句，不能看起来像就画。`);
    await writeFile(source, lines.join('\n'));
    const result = spawnSync(process.execPath, [join(root, 'scripts/knowledge.mjs'), 'workflow', '--source', source, '--out', out], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const bundle = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(bundle.schema_version, 'knowledge-bundle.v1');
    assert.ok(bundle.structures.length > 1);
    for (let index = 0; index < bundle.structures.length; index++) {
      const single = JSON.parse(await readFile(join(dir, `bundle-${String(index + 1).padStart(2, '0')}.json`), 'utf8'));
      assert.equal(single.id, bundle.structures[index].id);
    }
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
});
