import assert from 'node:assert/strict';
import { collectDialogue } from './collect.mjs';
import { buildPropositions } from './propositionize.mjs';
import { selectBackbone } from './attention.mjs';
import { runKnowledgeWorkflow } from './workflow.mjs';
import { buildViews, viewConsistency } from './views.mjs';
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
const multiWorkflow = await runKnowledgeWorkflow(longCollected.utterances.map((turn) => `${turn.speaker === 'user' ? '用户' : '助手'}：${turn.text}`).join('\n'));
assert.ok(multiWorkflow.structures.length > 1, '多主题不能在默认工作流里被丢弃');
assert.ok(multiWorkflow.structures.every((structure) => validateStructure(structure, { evidenceIndex: multiWorkflow.evidenceIndex }).errors.length === 0));
const chainProps = Array.from({ length: 6 }, (_, index) => ({ id: `p${index + 1}`, kind: '主张', layer: index === 0 ? 'example' : 'main', text: `命题${index + 1}`, evidence: [], weight: 1 - index * 0.01 }));
const chainRelations = chainProps.slice(0, -1).map((item, index) => ({ id: `r${index + 1}`, from: item.id, to: chainProps[index + 1].id, kind: '递进', evidence: [], strength: 0.9 }));
const chainStructure = { propositions: chainProps, relations: chainRelations, backbone: [] };
const chainBackbone = selectBackbone(chainStructure).backbone;
assert.equal(chainBackbone.length, 5);
assert.ok(chainBackbone.includes('p6'), '真结论不能因权重截断被丢掉');
assert.ok(!chainBackbone.includes('p1'), '例子不能进入骨架');
const authoredBackbone = { ...chainStructure, backbone_source: 'authored', backbone: ['p2', 'p3', 'p4', 'p6'] };
assert.deepEqual(selectBackbone(authoredBackbone).backbone, ['p2', 'p3', 'p4', 'p6']);
const cyclic = { propositions: chainProps.slice(1, 5), relations: [...chainRelations.slice(1, 3), { id: 'r_cycle', from: 'p4', to: 'p2', kind: '递进', evidence: [], strength: 0.9 }], backbone: [] };
assert.deepEqual(selectBackbone(cyclic).backbone, [], '无终端 sink 的环不能伪装成骨架');
const branchStructure = {
  topic: '分支', topo: 'tree', backbone: ['p1'], headline: '', subhead: '',
  propositions: Array.from({ length: 26 }, (_, index) => ({ id: `p${index + 1}`, kind: '主张', text: `分支命题 ${index + 1}`, evidence: [], weight: 0.8 })),
  relations: Array.from({ length: 25 }, (_, index) => ({ id: `r${index + 1}`, from: `p${index + 2}`, to: 'p1', kind: '包含', evidence: [], strength: 0.9 })),
  gaps: [],
};
branchStructure.views = buildViews(branchStructure);
assert.ok(branchStructure.views.filter((view) => view.target === 'branch:p1').length >= 3, '分支必须分页而不是静默截断');
assert.ok(branchStructure.views.every((view) => view.props.propositionIds.length <= 12));
assert.deepEqual(viewConsistency(branchStructure), []);
console.log('propositionize OK');
