import assert from 'node:assert/strict';
import {
  evidenceIndexFromCollected,
  finalizeStructure,
  validateStructure,
} from './knowledge-contract.mjs';
import { stableQuoteId } from './contract.mjs';

const q1 = stableQuoteId({ speaker: 'user', turnIndex: 0, text: '我以为分数高就说明学习有效。' });
const q2 = stableQuoteId({ speaker: 'assistant', turnIndex: 1, text: '因为分数只说明测试跑通，所以要用真实作答判断理解。' });
const q3 = stableQuoteId({ speaker: 'assistant', turnIndex: 1, text: '正确做法是保留旧判断、反例和新判断。' });
const collected = {
  evidence: [
    { quote_id: q1, speaker: 'user', turn_index: 0, text: '我以为分数高就说明学习有效。' },
    { quote_id: q2, speaker: 'assistant', turn_index: 1, text: '因为分数只说明测试跑通，所以要用真实作答判断理解。' },
    { quote_id: q3, speaker: 'assistant', turn_index: 1, text: '正确做法是保留旧判断、反例和新判断。' },
  ],
  utterances: [],
};
const index = evidenceIndexFromCollected(collected);
const input = {
  topic: '分数与理解',
  propositions: [
    { id: 'p1', kind: '主张', layer: 'main', text: '我以为分数高就说明学习有效', evidence: [{ quote_id: q1, speaker: 'user', turn_index: 0, verbatim: true }], weight: 0.8, provenance: 'quote' },
    { id: 'p2', kind: '因果', layer: 'main', text: '分数只说明测试跑通', evidence: [{ quote_id: q2, speaker: 'assistant', turn_index: 1, verbatim: true }], weight: 0.9, provenance: 'quote' },
    { id: 'p3', kind: '步骤', layer: 'main', text: '用真实作答判断理解', evidence: [{ quote_id: q2, speaker: 'assistant', turn_index: 1, verbatim: true }], weight: 0.75, provenance: 'summary' },
  ],
  relations: [
    { id: 'r1', from: 'p2', to: 'p3', kind: '支持', evidence: [{ quote_id: q2, verbatim: true }], strength: 0.9 },
  ],
  topo: 'chain',
  backbone: ['p1', 'p2', 'p3'],
  gaps: [],
};

const pass = validateStructure(finalizeStructure(input), { evidenceIndex: index });
assert.deepEqual(pass.errors, []);
const finalized = finalizeStructure(input);
assert.ok(finalized.id.startsWith('s_'));
assert.deepEqual(validateStructure(finalized, { evidenceIndex: index }).errors, []);
assert.deepEqual(finalizeStructure(finalized), finalized, 'stable ids must be idempotent');

const missing = structuredClone(input);
missing.propositions[0].evidence[0].quote_id = 'q_missing';
assert.ok(validateStructure(finalizeStructure(missing), { evidenceIndex: index }).errors.some((error) => error.includes('找不到原句')));

const nonVerbatimRelation = structuredClone(input);
nonVerbatimRelation.relations[0].evidence[0].verbatim = false;
assert.ok(validateStructure(finalizeStructure(nonVerbatimRelation), { evidenceIndex: index }).errors.some((error) => error.includes('逐字')));

const badBackbone = structuredClone(input);
badBackbone.backbone = ['p1'];
assert.ok(validateStructure(finalizeStructure(badBackbone), { evidenceIndex: index }).errors.some((error) => error.includes('3~5')));

const mutatedHash = structuredClone(input);
mutatedHash.propositions[1].text = '改变结论会改变结构身份';
assert.notEqual(finalizeStructure(mutatedHash).id, finalized.id);
const mutatedLayer = structuredClone(input);
mutatedLayer.propositions[1].layer = 'example';
assert.notEqual(finalizeStructure(mutatedLayer).id, finalized.id);

console.log('knowledge contract OK');
