import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { withFileLock, writeAtomic } from './safeio.mjs';
import { startCli, workdir, opt, checkFlags, wantsHelp, WORKDIR_FLAGS, WORKDIR_HELP } from './console.mjs';
import { searchCards, getCard, setCardStatus } from './library.mjs';

export const INTERVALS = Object.freeze([1, 3, 7, 21, 60]);
const reviewPath = (workspace) => join(resolve(workspace), '.knowledge', 'review.json');
const lockPath = (workspace) => join(resolve(workspace), '.knowledge', 'review.lock');
const DAY = 24 * 60 * 60 * 1000;
const BLOCKS = Object.freeze({ before: '原以为', snag: '撞车', after: '正解', takeaway: '一句带走' });

async function readReview(workspace) {
  try {
    const data = JSON.parse(await readFile(reviewPath(workspace), 'utf8'));
    if (data.version !== 1 || !data.cards || typeof data.cards !== 'object') throw new Error('结构不认识');
    return data;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, cards: {} };
    throw new Error(`复习记录读不懂：${reviewPath(workspace)}\n先保留这份文件，确认后再修复。`);
  }
}

export function makeProbe(card) {
  const collision = String(card.snag || '').trim();
  const expected = String(card.after || '').trim();
  return {
    question: collision ? `不看图，用一句话说出：${collision}之后，正确判断是什么？` : '不看图，用一句话说出这张卡的新判断。',
    answer: expected,
    block: 'after',
    maxLines: 3,
    groundedIn: 'after',
  };
}

function emptyState(card, now) {
  const probe = makeProbe(card);
  return {
    id: card.id,
    probe,
    state: 'new',
    intervalIndex: 0,
    intervalDays: INTERVALS[0],
    due: new Date(now).toISOString(),
    attempts: [],
    status: 'draft',
    lastAnswer: '',
    diagnosis: '',
  };
}

export async function ensureProbes(workspace, { now = Date.now() } = {}) {
  return withFileLock(lockPath(workspace), async () => {
    const review = await readReview(workspace);
    const found = await searchCards(workspace, { limit: 10000 });
    for (const meta of found.cards) {
      if (review.cards[meta.id]) continue;
      const full = await getCard(workspace, meta.id);
      review.cards[meta.id] = emptyState({ id: meta.id, ...full.record.card }, now);
    }
    await writeAtomic(reviewPath(workspace), JSON.stringify(review, null, 2));
    return review;
  });
}

export function normalizeAnswer(value) {
  return String(value || '').toLowerCase().replace(/[\s，。！？；：、,.!?;:"“”‘’'()（）《》〈〉「」『』\[\]—…]/g, '');
}

function bigrams(value) {
  const chars = [...normalizeAnswer(value)];
  const out = [];
  for (let index = 0; index < chars.length - 1; index++) out.push(chars[index] + chars[index + 1]);
  return out;
}

function blockScore(answer, text) {
  const a = normalizeAnswer(answer);
  const b = normalizeAnswer(text);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) >= 6 ? 0.92 : Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const right = new Set(bigrams(b));
  const left = bigrams(a);
  if (!left.length) return 0;
  return left.filter((gram) => right.has(gram)).length / left.length;
}

export function diagnoseAnswer(card, answer) {
  const scores = Object.fromEntries(Object.entries(BLOCKS).map(([key]) => [key, blockScore(answer, card[key])]));
  const expected = scores[card.probe?.block || 'after'] || scores.after;
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const hit = expected >= 0.45;
  return {
    hit,
    failedBlock: hit ? '' : 'after',
    bestBlock: best[0],
    scores,
    text: hit
      ? `命中「正解」块；这是本地词面诊断，仍需你确认表达是否真的等价。`
      : `未命中「正解」块。最接近的是「${BLOCKS[best[0]]}」，先回去看「撞车」怎样推翻「原以为」。`,
  };
}

export function scheduleReview(state, { correct, now = Date.now() } = {}) {
  const current = Math.max(0, Math.min(INTERVALS.length - 1, Number(state.intervalIndex) || 0));
  const next = correct ? Math.min(INTERVALS.length - 1, current + 1) : Math.max(0, current - 1);
  const intervalDays = INTERVALS[next];
  return {
    ...state,
    state: correct ? 'review' : 'learning',
    intervalIndex: next,
    intervalDays,
    due: new Date(now + intervalDays * DAY).toISOString(),
  };
}

export async function dueCards(workspace, { now = Date.now(), limit = 3 } = {}) {
  const review = await ensureProbes(workspace, { now });
  return Object.values(review.cards)
    .filter((item) => new Date(item.due).getTime() <= now)
    .sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime() || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export async function answerCard(workspace, id, answer, { now = Date.now() } = {}) {
  if (!String(answer || '').trim()) throw new Error('答案不能为空。');
  return withFileLock(lockPath(workspace), async () => {
    const review = await readReview(workspace);
    const full = await getCard(workspace, id);
    if (!full) throw new Error(`找不到卡片：${id}`);
    const state = review.cards[id] || emptyState({ id, ...full.record.card }, now);
    const diagnosis = diagnoseAnswer(full.record.card, answer);
    state.lastAnswer = String(answer).trim();
    state.diagnosis = diagnosis.text;
    state.status = 'draft';
    state.attempts.push({ at: new Date(now).toISOString(), answer: state.lastAnswer, diagnosis });
    review.cards[id] = state;
    await writeAtomic(reviewPath(workspace), JSON.stringify(review, null, 2));
    await setCardStatus(workspace, id, 'draft');
    return { state, diagnosis };
  });
}

export async function confirmCard(workspace, id, { now = Date.now() } = {}) {
  return withFileLock(lockPath(workspace), async () => {
    const review = await readReview(workspace);
    const full = await getCard(workspace, id);
    if (!full) throw new Error(`找不到卡片：${id}`);
    const state = review.cards[id] || emptyState({ id, ...full.record.card }, now);
    if (!state.lastAnswer) throw new Error('还没有留下答案，先运行 answer。');
    review.cards[id] = { ...scheduleReview(state, { correct: true, now }), status: 'confirmed' };
    await writeAtomic(reviewPath(workspace), JSON.stringify(review, null, 2));
    await setCardStatus(workspace, id, 'confirmed');
    return review.cards[id];
  });
}

export async function reviseCard(workspace, id, answer, { now = Date.now() } = {}) {
  if (!String(answer || '').trim()) throw new Error('更正答案不能为空。');
  return withFileLock(lockPath(workspace), async () => {
    const review = await readReview(workspace);
    const full = await getCard(workspace, id);
    if (!full) throw new Error(`找不到卡片：${id}`);
    const state = review.cards[id] || emptyState({ id, ...full.record.card }, now);
    const diagnosis = diagnoseAnswer(full.record.card, answer);
    state.lastAnswer = String(answer).trim();
    state.diagnosis = diagnosis.text;
    state.attempts.push({ at: new Date(now).toISOString(), answer: state.lastAnswer, diagnosis, revised: true });
    review.cards[id] = { ...scheduleReview(state, { correct: false, now }), status: 'revised' };
    await writeAtomic(reviewPath(workspace), JSON.stringify(review, null, 2));
    await setCardStatus(workspace, id, 'revised');
    return { state: review.cards[id], diagnosis };
  });
}

function offsetNow(argv) {
  const raw = opt(argv, 'time', '');
  const match = raw.match(/^\+(\d+)$/);
  if (!match) return Date.now();
  return Date.now() + Number(match[1]) * DAY;
}

const FLAGS = ['cwd', 'workspace', 'time', 'help', ...WORKDIR_FLAGS];
async function main(argv) {
  checkFlags(argv, FLAGS);
  const workspace = workdir(argv);
  const now = offsetNow(argv);
  if (wantsHelp(argv) || !argv.length) {
    console.log(`用法：node scripts/review.mjs build\n     node scripts/review.mjs due [--time +1|+3|+7]\n     node scripts/review.mjs card <id>\n     node scripts/review.mjs answer <id> "你的答案"\n     node scripts/review.mjs confirm <id>\n     node scripts/review.mjs revise <id> "更正后的答案"\n　${WORKDIR_HELP}`);
    return 0;
  }
  if (argv[0] === 'build') {
    const review = await ensureProbes(workspace, { now });
    console.log(`复习探针已就绪：${Object.keys(review.cards).length} 张。`);
    return 0;
  }
  if (argv[0] === 'due') {
    const due = await dueCards(workspace, { now });
    console.log(`今天该问的 ${Math.min(3, due.length)} 张`);
    for (const item of due) console.log(`${item.id}  ${item.probe.question}`);
    return 0;
  }
  if (argv[0] === 'card') {
    const id = argv[1];
    const review = await ensureProbes(workspace, { now });
    const state = review.cards[id];
    if (!state) throw new Error(`找不到复习条目：${id}`);
    console.log(`${id}\n${state.probe.question}\n（最多 ${state.probe.maxLines} 行；答案必须落在「${BLOCKS[state.probe.block]}」块。）`);
    return 0;
  }
  if (argv[0] === 'answer') {
    const id = argv[1];
    const answer = argv.slice(2).join(' ');
    const result = await answerCard(workspace, id, answer, { now });
    console.log(result.diagnosis.text);
    console.log('答案已保存为 draft；确认用 confirm，想改答案用 revise。');
    return 0;
  }
  if (argv[0] === 'confirm') {
    const state = await confirmCard(workspace, argv[1], { now });
    console.log(`已确认；下次 ${state.intervalDays} 天后，即 ${state.due.slice(0, 10)}。`);
    return 0;
  }
  if (argv[0] === 'revise') {
    const id = argv[1];
    const answer = argv.slice(2).join(' ');
    const result = await reviseCard(workspace, id, answer, { now });
    console.log(result.diagnosis.text);
    console.log(`已记为 revised；下次 ${result.state.intervalDays} 天后，即 ${result.state.due.slice(0, 10)}。`);
    return 0;
  }
  throw new Error('review.mjs 只认 build、due、card、answer、confirm 或 revise。');
}

startCli(import.meta.url, 'review', main);
