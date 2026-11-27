import assert from 'node:assert/strict';
import { collectDialogue } from './collect.mjs';
import { buildPropositions } from './propositionize.mjs';
import { evidenceIndexFromCollected, validateStructure, visibleLen } from './knowledge-contract.mjs';

const source = `用户：任务：把对话变成知识结构。
\`\`\`json
{"subtitle": "", "units": []}
\`\`\`
我以为分数高就说明学习有效。
助手：因为分数只说明测试跑通，所以要用真实作答判断理解。真实作答才能说明理解。
助手：因为分数只说明测试跑通，所以要用真实作答判断理解。`;
const collected = collectDialogue(source);
const result = buildPropositions(collected, { topic: '分数与理解' });
assert.ok(result.structure.propositions.length >= 2);
assert.ok(result.structure.propositions.every((item) => visibleLen(item.text) <= 60));
assert.ok(result.structure.propositions.every((item) => !/subtitle|units/.test(item.text)));
assert.equal(new Set(result.structure.propositions.map((item) => item.text)).size, result.structure.propositions.length);
const validation = validateStructure(result.structure, { evidenceIndex: result.evidenceIndex, stage: 'm1' });
assert.deepEqual(validation.errors, []);

const longCollected = {
  utterances: Array.from({ length: 70 }, (_, index) => ({
    speaker: index % 2 ? 'assistant' : 'user',
    turn_index: Math.floor(index / 2),
    text: `第${index}条独立命题：证据必须能逐字引回原句，不能看起来像就画。`,
  })),
  evidence: [],
};
const longResult = buildPropositions(longCollected);
assert.ok(longResult.structures.length > 1);
assert.ok(longResult.structures.every((structure) => structure.propositions.length <= 30));
console.log('propositionize OK');
