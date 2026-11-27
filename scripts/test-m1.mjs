import assert from 'node:assert/strict';
import { collectDialogue } from './collect.mjs';
import { judgeCollected } from './judge.mjs';
import { validateTurn } from './contract.mjs';

const now = '2026-11-27T00:00:00.000Z';
const run = (source) => judgeCollected(collectDialogue(source), { now, source });

const corrected = `用户：我以为复习就是每天把卡片再看一遍。\n助手：不是。复习不是再看一遍，而是先自己回想，再看答案。`;
const a = run(corrected);
assert.equal(a.status, 'turns');
assert.equal(a.turns.length, 1);
assert.equal(a.turns[0].prior.source, 'user');
assert.ok(corrected.includes(a.turns[0].prior.quote));
assert.deepEqual(validateTurn(a.turns[0], corrected), []);

const explained = `用户：讲一下间隔重复。\n助手：间隔重复不是按天平均复习，而是按遗忘曲线安排。`;
const b = run(explained);
assert.equal(b.status, 'no-turn');
assert.equal(b.message, '这段对话里没有转弯，只有讲解。');
assert.ok(b.candidates.length > 0);

const multiple = `用户：我以为卡片越多，学得越快。\n助手：不是。卡片多不等于学得快，检索难度才是关键。\n用户：我还以为反馈越及时越好。\n助手：其实不是。及时反馈会替代检索，应该先作答再反馈。`;
const c = run(multiple);
assert.equal(c.turns.length, 2);
assert.equal(new Set(c.turns.map((turn) => turn.id)).size, 2);
for (const turn of c.turns) assert.deepEqual(validateTurn(turn, multiple), []);

const inferred = `用户：为什么大家把看懂当成学会？\n助手：不是。看懂只是识别，学会是能独立解释。`;
const d = run(inferred);
assert.equal(d.status, 'turns');
assert.equal(d.turns[0].prior.source, 'inferred');
assert.match(d.turns[0].prior.inference, /从你后面的问法看/);
assert.deepEqual(validateTurn(d.turns[0], inferred), []);

const again = run(corrected);
assert.equal(again.turns[0].id, a.turns[0].id);

console.log(JSON.stringify({
  corrected: a.turns.length,
  pure_explanation: b.turns.length,
  multiple: c.turns.length,
  inferred_prior: d.turns[0].prior.source,
  stable_id: again.turns[0].id === a.turns[0].id,
}, null, 2));
console.log('M1 synthetic checks: OK');
