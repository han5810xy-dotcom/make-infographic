import assert from 'node:assert/strict';
import { collectDialogue } from './collect.mjs';
import { evidenceIndexFromCollected } from './knowledge-contract.mjs';
import { stableQuoteId } from './contract.mjs';
import { resolveAuthoring } from './knowledge-authoring.mjs';
import { extractRelations, relationReviewHash, validateRelationsSemantics } from './relations.mjs';

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
const reversed = structuredClone(withRelations);
reversed.relations[0].from = extracted.relations[0].to;
reversed.relations[0].to = extracted.relations[0].from;
assert.ok(validateRelationsSemantics(reversed, evidenceIndex).some((error) => error.includes('方向')));
const unrelated = structuredClone(withRelations);
unrelated.relations[0].evidence = [{ quote_id: stableQuoteId({ speaker: 'user', turnIndex: 2, text: '今天天气很好。' }), verbatim: true }];
const unrelatedSource = `${source}\n用户：今天天气很好。`;
const unrelatedCollected = collectDialogue(unrelatedSource);
const unrelatedIndex = evidenceIndexFromCollected(unrelatedCollected);
assert.ok(validateRelationsSemantics(unrelated, unrelatedIndex).some((error) => error.includes('覆盖')));
const reviewed = structuredClone(withRelations);
reviewed.relations[0].review_hash = relationReviewHash(reviewed.relations[0], evidenceIndex, reviewed);
assert.deepEqual(validateRelationsSemantics(reviewed, evidenceIndex), []);
const remapped = structuredClone(reviewed);
remapped.propositions = remapped.propositions.map((item) => ({ ...item, id: `new_${item.id}` }));
remapped.relations[0].from = `new_${reviewed.relations[0].from}`;
remapped.relations[0].to = `new_${reviewed.relations[0].to}`;
assert.deepEqual(validateRelationsSemantics(remapped, evidenceIndex), [], '人工复核哈希不能因编号重排失效');
const mutated = structuredClone(reviewed);
mutated.propositions[1].text = '偷换后的命题';
assert.notEqual(mutated.relations[0].review_hash, relationReviewHash(mutated.relations[0], evidenceIndex, mutated), '修改端点后旧复核必须失效');
console.log(JSON.stringify(extracted.relations, null, 2));
console.log('relations OK');
