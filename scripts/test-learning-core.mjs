import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeStructure, stableConceptId } from './knowledge-contract.mjs';
import { buildRegistry, probeFor, projectLearning, syncLearning, learningState, dueConcepts, recordAnswer, exportLearning, importLearning } from './learning-core.mjs';

const workspace = async (run) => {
  const dir = await mkdtemp(join(tmpdir(), 'make-infographic-learning-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
};
const structure = (topic, text, id) => finalizeStructure({
  topic, headline: topic, propositions: [{ id: 'p1', kind: '主张', layer: 'main', text, evidence: [{ quote_id: `q_${id}`, speaker: 'assistant', turn_index: 0, verbatim: true }], weight: 0.9, provenance: 'summary' }], relations: [], topo: 'chain', backbone: ['p1'], gaps: [],
});

test('concept identity survives proposition renumbering and repeated dialogues', () => {
  const a = structure('学习', '分数只说明测试跑通', 'a');
  const b = structure('另一段对话', '分数只说明测试跑通', 'b');
  assert.equal(a.propositions[0].concept_id, b.propositions[0].concept_id);
  assert.notEqual(a.propositions[0].id, b.propositions[0].id);
  assert.equal(a.propositions[0].concept_id, stableConceptId(a.propositions[0]));
  const registry = buildRegistry([a, b]);
  assert.equal(registry.concepts.length, 1);
  assert.equal(registry.concepts[0].sources.length, 2);
});

test('due prompt hides the answer and reveal requires a recorded attempt', async () => workspace(async (dir) => {
  const s = structure('学习', '分数只说明测试跑通', 'a');
  s.source_hash = 'document-a';
  await mkdir(join(dir, 'infographics'), { recursive: true });
  await writeFile(join(dir, 'infographics/a.json'), JSON.stringify(s));
  await writeFile(join(dir, 'infographics/a.source.md'), '助手：分数只说明测试跑通。');
  await writeFile(join(dir, 'infographics/a.evidence.json'), JSON.stringify({ q_a: { quote_id: 'q_a', speaker: 'assistant', turn_index: 0, text: '分数只说明测试跑通。' } }));
  await syncLearning(dir);
  const due = await dueConcepts(dir);
  assert.equal(due.length, 1);
  assert.ok(!due[0].probe.question.includes('分数只说明测试跑通'));
  const before = await learningState(dir);
  assert.equal(before.events.length, 0);
  const result = await recordAnswer(dir, { concept_id: due[0].concept_id, route: due[0].route, answer: '它只证明测试通过，不能证明理解。', self_report: 'without_looking', prompt_id: due[0].probe.prompt_id });
  assert.equal(result.event.answer, '它只证明测试通过，不能证明理解。');
  assert.equal(result.reveal.text, '分数只说明测试跑通');
  const state = await learningState(dir);
  assert.equal(state.projection.counts.events, 1);
  assert.equal(state.projection.rows[0].evidence_stage, 1);
  assert.equal(state.projection.rows[0].routes.recall.due, false);
  assert.equal(state.projection.rows[0].routes.explain.due, true);
  assert.equal(state.events[0].source.document_id, 'document-a');
}));

test('self-report is preserved, never converted into a correctness score', async () => workspace(async (dir) => {
  const registry = buildRegistry([structure('学习', '分数只说明测试跑通', 'a')]);
  const base = { schema_version: 'learning.v1', concept_id: registry.concepts[0].concept_id, route: 'recall', answer: '不确定', self_report: 'unsure', prompt_id: 'l_test', at: new Date().toISOString(), source: {} };
  const projection = projectLearning(registry, [{ ...base, seq: 1, event_id: 'e_test' }]);
  assert.equal(projectionSafe(projection), true);
  assert.equal(projection.rows[0].evidence_stage, 0);
  assert.equal(projection.rows[0].routes.recall.interval_days, 1);
  assert.equal(projection.rows[0].routes.explain.due, false, '未独立回忆前不能跳到解释题');
  assert.ok(!JSON.stringify(projection).includes('accuracy'));
}));
function projectionSafe(value) { return value && value.counts.concepts === 1; }

test('export/import is idempotent and tampering is rejected', async () => workspace(async (dir) => {
  const s = structure('学习', '分数只说明测试跑通', 'a');
  s.source_hash = 'document-a';
  await mkdir(join(dir, 'infographics'), { recursive: true });
  await writeFile(join(dir, 'infographics/a.json'), JSON.stringify(s));
  await writeFile(join(dir, 'infographics/a.source.md'), '助手：分数只说明测试跑通。');
  await writeFile(join(dir, 'infographics/a.evidence.json'), JSON.stringify({ q_a: { quote_id: 'q_a', speaker: 'assistant', turn_index: 0, text: '分数只说明测试跑通。' } }));
  await syncLearning(dir);
  const due = await dueConcepts(dir);
  await recordAnswer(dir, { concept_id: due[0].concept_id, route: 'recall', answer: '自己的解释', self_report: 'with_hint', prompt_id: due[0].probe.prompt_id });
  const bundle = await exportLearning(dir);
  const other = await mkdtemp(join(tmpdir(), 'make-infographic-learning-import-'));
  try {
    assert.deepEqual(await importLearning(other, bundle), { imported: 1, total: 1 });
    assert.deepEqual(await importLearning(other, bundle), { imported: 1, total: 1 });
    const restored = await learningState(other);
    assert.equal(restored.events.length, 1);
    assert.equal(restored.registry.concepts.length, 1);
    assert.equal(restored.registry.concepts[0].sources[0].evidence_text[0], '分数只说明测试跑通。');
    const bad = structuredClone(bundle);
    bad.events[0].answer = '篡改';
    await assert.rejects(() => importLearning(other, bad), /哈希不一致/);
  } finally { await rm(other, { recursive: true, force: true, maxRetries: 5 }); }
}));

test('prompt identity changes when the underlying proposition changes', () => {
  const registry = buildRegistry([structure('学习', '分数只说明测试跑通', 'a')]);
  const changed = structuredClone(registry);
  changed.concepts[0].text = '分数说明理解';
  assert.notEqual(probeFor(registry.concepts[0]).prompt_id, probeFor(changed.concepts[0]).prompt_id);
});
