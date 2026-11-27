import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { collectDialogue } from './collect.mjs';
import { judgeCollected } from './judge.mjs';

const usage = `用法：
  node scripts/turn.mjs collect --in 对话.md [--out .turn-collect.json]
  node scripts/turn.mjs judge --in .turn-collect.json [--out .turns.json]
  node scripts/turn.mjs extract --in 对话.md [--out .turns.json]

collect 只切发言、标说话人、整理候选证据；judge 只在候选里判断转弯。`;

function value(argv, name, fallback = '') {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) throw new Error(`--${name} 后面要写一个值。`);
  return next;
}

async function save(path, data) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return target;
}

async function main(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(usage);
    return 0;
  }
  const command = argv[0];
  if (!['collect', 'judge', 'extract'].includes(command)) throw new Error(`不认得子命令：${command}\n${usage}`);
  const input = value(argv, 'in');
  if (!input) throw new Error('缺少 --in 对话文件。');
  const source = await readFile(resolve(input), 'utf8');
  if (command === 'collect') {
    const collected = collectDialogue(source);
    const out = await save(value(argv, 'out', '.turn-collect.json'), collected);
    console.log(`collect 完成：${collected.stats.utterances} 段发言，${collected.stats.sentences} 句证据，${collected.candidates.length} 条候选。`);
    console.log(`候选证据表：${out}`);
    return 0;
  }
  const collected = command === 'judge'
    ? JSON.parse(await readFile(resolve(input), 'utf8'))
    : collectDialogue(source);
  const threshold = Number(value(argv, 'threshold', '64'));
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error('--threshold 要在 0 到 100 之间。');
  const judged = judgeCollected(collected, { threshold, source: collected.raw_source || source });
  const out = await save(value(argv, 'out', '.turns.json'), judged);
  console.log(judged.message);
  if (!judged.turns.length) {
    for (const candidate of judged.candidates.slice(0, 12)) {
      console.log(`候选：${candidate.type}｜${candidate.collision?.display || candidate.prior?.display || ''}`);
      console.log(`未采纳：${candidate.reject_reason || '证据强度不足'}`);
    }
  } else {
    for (const turn of judged.turns) {
      console.log(`${turn.id}｜${turn.title}｜prior: ${turn.prior.source === 'inferred' ? '推断' : turn.prior.quote}`);
    }
  }
  console.log(`判断结果：${out}`);
  return 0;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`失败：${error?.message || error}`);
  process.exitCode = 1;
});
