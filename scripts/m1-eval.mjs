import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { collectDialogue } from './collect.mjs';
import { judgeCollected } from './judge.mjs';
import { validateTurn } from './contract.mjs';

const usage = `用法：node scripts/m1-eval.mjs --ground-truth eval/m1-ground-truth.json [--root 工作区] [--out eval/m1-results.json]`;

function arg(argv, name, fallback = '') {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} 后面要写一个值。`);
  return value;
}

const normalize = (value) => String(value ?? '').toLowerCase().replace(/[\s，。！？；：、,.!?;:"“”‘’'()（）《》〈〉「」『』\[\]—…]/g, '');
function bigrams(value) {
  const chars = [...normalize(value)];
  const out = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}
function similarity(a, b) {
  const left = bigrams(a);
  const right = new Set(bigrams(b));
  if (!left.length && !right.size) return 1;
  if (!left.length || !right.size) return 0;
  let hit = 0;
  for (const item of left) if (right.has(item)) hit++;
  return hit / left.length;
}
function quoteMatch(predicted, expected) {
  if (!predicted || !expected) return 0;
  const a = normalize(predicted);
  const b = normalize(expected);
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    return shorter >= 8 ? 0.95 : shorter / Math.max(a.length, b.length);
  }
  return similarity(predicted, expected);
}
function turnMatch(predicted, truth) {
  const revised = quoteMatch(predicted.revised.quote, truth.revised_quote);
  const prior = quoteMatch(predicted.prior.quote || predicted.prior.text, truth.prior_quote);
  const collision = quoteMatch(predicted.collision.quote, truth.collision_quote);
  const score = Math.max(revised, Math.min(1, prior * 0.55 + collision * 0.45));
  return { score, revised, prior, collision };
}

async function main(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(usage);
    return 0;
  }
  const groundTruthPath = resolve(arg(argv, 'ground-truth'));
  if (!groundTruthPath) throw new Error(usage);
  const root = resolve(arg(argv, 'root', process.cwd()));
  const outPath = resolve(arg(argv, 'out', join(root, 'eval', 'm1-results.json')));
  const truth = JSON.parse(await readFile(groundTruthPath, 'utf8'));
  const cases = [];
  let trueTurns = 0;
  let predictedTurns = 0;
  let matchedTrueTurns = 0;
  let matchedPredictedTurns = 0;
  let falsePositiveCases = 0;
  let untraceablePriors = 0;

  for (const item of truth.cases || []) {
    const sourcePath = isAbsolute(item.source_path) ? item.source_path : resolve(root, item.source_path);
    const source = await readFile(sourcePath, 'utf8');
    const judged = judgeCollected(collectDialogue(source), { source });
    const expected = item.turns || [];
    const matchedTruth = new Set();
    const matchedPrediction = new Set();
    const pairs = [];
    for (let p = 0; p < judged.turns.length; p++) {
      let best = null;
      for (let t = 0; t < expected.length; t++) {
        const match = turnMatch(judged.turns[p], expected[t]);
        if (!best || match.score > best.score) best = { index: t, ...match };
      }
      if (best && best.score >= 0.62) {
        matchedTruth.add(best.index);
        matchedPrediction.add(p);
        pairs.push({ predicted_index: p, truth_index: best.index, score: Number(best.score.toFixed(3)) });
      }
    }
    const falsePositives = judged.turns.map((turn, index) => ({ turn, index }))
      .filter(({ index }) => !matchedPrediction.has(index))
      .map(({ turn, index }) => ({ index, id: turn.id, title: turn.title, revised: turn.revised.quote }));
    if (falsePositives.length) falsePositiveCases++;
    for (const turn of judged.turns) {
      const errors = validateTurn(turn, source);
      if (turn.prior.source !== 'inferred' && !source.includes(turn.prior.quote)) untraceablePriors++;
      if (errors.length) untraceablePriors++;
    }
    trueTurns += expected.length;
    predictedTurns += judged.turns.length;
    matchedTrueTurns += matchedTruth.size;
    matchedPredictedTurns += matchedPrediction.size;
    cases.push({
      case_id: item.case_id,
      source_path: item.source_path,
      expected_turns: expected.length,
      predicted_turns: judged.turns.length,
      matched_true_turns: matchedTruth.size,
      false_positives: falsePositives,
      missed: expected.map((turn, index) => ({ turn, index })).filter(({ index }) => !matchedTruth.has(index)).map(({ turn, index }) => ({ index, revised: turn.revised_quote })),
      pairs,
      predicted: judged.turns,
    });
  }

  const recall = trueTurns ? matchedTrueTurns / trueTurns : 1;
  const precision = predictedTurns ? matchedPredictedTurns / predictedTurns : 1;
  const result = {
    schema_version: 'm1-eval.v1',
    at: new Date().toISOString(),
    ground_truth: groundTruthPath,
    totals: {
      cases: cases.length,
      true_turns: trueTurns,
      predicted_turns: predictedTurns,
      matched_true_turns: matchedTrueTurns,
      matched_predicted_turns: matchedPredictedTurns,
      recall: Number(recall.toFixed(4)),
      precision: Number(precision.toFixed(4)),
      false_positive_cases: falsePositiveCases,
      false_positive_turns: predictedTurns - matchedPredictedTurns,
      untraceable_priors: untraceablePriors,
    },
    pass: recall >= 0.8 && falsePositiveCases <= 1 && untraceablePriors === 0,
    cases,
  };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const md = [
    '# M1 抽取验收',
    '',
    `- 用例：${cases.length}`,
    `- 真转弯：${trueTurns}`,
    `- 抽中：${matchedTrueTurns}`,
    `- 召回：${(recall * 100).toFixed(1)}%`,
    `- 误报段数：${falsePositiveCases}`,
    `- 误报转弯数：${predictedTurns - matchedPredictedTurns}`,
    `- prior 不可追溯：${untraceablePriors}`,
    `- 结论：${result.pass ? '通过' : '未通过'}`,
    '',
    '| 用例 | 真转弯 | 预测 | 命中 | 误报 |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...cases.map((item) => `| ${item.case_id} | ${item.expected_turns} | ${item.predicted_turns} | ${item.matched_true_turns} | ${item.false_positives.length} |`),
    '',
  ].join('\n');
  await writeFile(outPath.replace(/\.json$/i, '.md'), md, 'utf8');
  console.log(JSON.stringify(result.totals, null, 2));
  console.log(`结论：${result.pass ? '通过' : '未通过'}`);
  console.log(`结果：${outPath}`);
  return result.pass ? 0 : 2;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`失败：${error?.message || error}`);
  process.exitCode = 1;
});
