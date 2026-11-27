import assert from 'node:assert/strict';
import { collectDialogue } from './collect.mjs';
import { resolveAuthoring } from './knowledge-authoring.mjs';
import { extractRelations, validateRelationsSemantics } from './relations.mjs';

const source = `用户：我以为分数高就说明学习有效。
助手：因为分数只说明测试跑通，所以要用真实作答判断理解。`;
const authored = {
  topic: '分数与理解',
  propositions: [
    { id: 'p1', kind: '主张', text: '分数高说明学习有效', evidence: [{ speaker: 'user', turn_index: 0, text: '我以为分数高就说明学习有效。', verbatim: true }], provenance: 'summary' },
    { id: 'p2', kind: '因果', text: '分数只说明测试跑通', evidence: [{ speaker: 'assistant', turn_index: 1, text: '因为分数只说明测试跑通', verbatim: true }], provenance: 'quote' },
    { id: 'p3', kind: '步骤', text: '用真实作答判断理解', evidence: [{ speaker: 'assistant', turn_index: 1, text: '所以要用真实作答判断理解。', verbatim: true }], provenance: 'summary' },
  ],
  relations: [],
  gaps: [],
};
const { structure, collected, evidenceIndex } = resolveAuthoring(authored, source);
const extracted = extractRelations(structure, collected, evidenceIndex);
assert.ok(extracted.relations.length >= 1, JSON.stringify(extracted));
const byId = new Map(structure.propositions.map((item) => [item.id, item.text]));
assert.ok(byId.get(extracted.relations[0].from).includes('分数'));
assert.ok(byId.get(extracted.relations[0].to).includes('真实作答'));
assert.ok(extracted.relations.every((relation) => relation.evidence.length && relation.strength >= 0.5));
const withRelations = { ...structure, relations: extracted.relations };
assert.deepEqual(validateRelationsSemantics(withRelations, evidenceIndex), []);
console.log(JSON.stringify(extracted.relations, null, 2));
console.log('relations OK');
