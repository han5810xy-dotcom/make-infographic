import assert from 'node:assert/strict';
import { runKnowledgeWorkflow } from './workflow.mjs';
import { validateStructure } from './knowledge-contract.mjs';

const source = `用户：我以为分数高就说明学习有效。
助手：因为分数只说明测试跑通，所以要用真实作答判断理解。真实作答才能说明理解。`;
const authored = {
  topic: '分数与理解',
  propositions: [
    { id: 'p1', kind: '主张', text: '分数高说明学习有效', evidence: [{ speaker: 'user', turn_index: 0, text: '我以为分数高就说明学习有效。', verbatim: true }], provenance: 'summary' },
    { id: 'p2', kind: '因果', text: '分数只说明测试跑通', evidence: [{ speaker: 'assistant', turn_index: 1, text: '因为分数只说明测试跑通', verbatim: true }], provenance: 'quote' },
    { id: 'p3', kind: '步骤', text: '用真实作答判断理解', evidence: [{ speaker: 'assistant', turn_index: 1, text: '所以要用真实作答判断理解。', verbatim: true }], provenance: 'summary' },
  ],
  relations: [
    { id: 'r1', from: 'p2', to: 'p3', kind: '支持', evidence: [{ speaker: 'assistant', turn_index: 1, text: '因为分数只说明测试跑通，所以要用真实作答判断理解。', verbatim: true }], strength: 0.9 },
  ],
  gaps: [],
  key_conclusions: ['分数只说明测试跑通', '用真实作答判断理解'],
};
const result = await runKnowledgeWorkflow(source, { authored });
assert.equal(result.steps.length, 8);
assert.equal(result.structure.propositions.length, 3);
assert.equal(result.structure.relations.length, 1);
assert.ok(result.structure.propositions.every((item) => item.weight >= 0 && item.weight <= 1));
assert.ok(result.structure.views.length >= 1);
assert.deepEqual(validateStructure(result.structure, { evidenceIndex: result.evidenceIndex }).errors, []);
assert.ok(result.stats.propositions >= 3);
console.log(JSON.stringify(result.stats, null, 2));
console.log('workflow OK');
