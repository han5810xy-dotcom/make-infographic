export const TURN_LAYOUT = 'turn-card';
export const TURN_LIMIT = 300;
export const TURN_LABELS = Object.freeze({ before: '原以为', snag: '撞车', after: '正解', takeaway: '一句带走' });
const BLOCKS = ['before', 'snag', 'after', 'takeaway'];
const LABEL_CHARS = [...Object.values(TURN_LABELS).join('')].length;
const FORBIDDEN_PREFIX = /^(?:差别|依据|归纳|例|注意|出处|按什么分|为什么这么分|比的是)[｜|]\s*/;
const FORBIDDEN_FIELD = /\b(?:units|relations|coverage|branches\.kind|figures\[\d+\])\b/gi;

export const visibleLen = (s) => [...String(s ?? '').replace(/\s/g, '')].length;
const clean = (s) => String(s ?? '')
  .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.、])\s*/gm, '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();
const normalized = (s) => clean(s).replace(/[\s，。！？；：、,.!?;:]/g, '');

export function canvasText(s) {
  return clean(s).replace(FORBIDDEN_PREFIX, '').replace(FORBIDDEN_FIELD, '').replace(/[｜|]\s*$/, '').trim();
}

function isSubsequence(short, long) {
  const a = [...normalized(short)];
  const b = [...normalized(long)];
  let i = 0;
  for (const ch of b) if (ch === a[i]) i++;
  return i === a.length;
}

export function originOf(text, source) {
  const a = normalized(text);
  const b = normalized(source || '');
  if (!a) return '未判定';
  if (!b) return '归纳';
  return b.includes(a) || isSubsequence(a, b) ? '原话' : '归纳';
}

function sentences(source) {
  const text = String(source).split(/\r?\n/)
    .map((line) => clean(line))
    .filter(Boolean)
    .flatMap((line) => line.split(/(?<=[。！？!?])/))
    .map((s) => s.trim())
    .filter((s) => visibleLen(s) >= 4 && !/^#{1,6}\s*$/.test(s));
  return text.map((text, index) => ({ text, index }));
}

function clauses(source) {
  const base = sentences(source);
  const parts = base.flatMap((s) => s.text.split(/[；;，,]/).map((text) => ({ text: text.trim(), index: s.index, part: true })))
    .filter((s) => visibleLen(s.text) >= 6 && !/[，,：:]$/.test(s.text));
  return [...base.map((s) => ({ ...s, part: false })), ...parts];
}

function overlap(a, b) {
  const grams = (s) => {
    const x = [...normalized(s)];
    return new Set(x.slice(0, -1).map((_, i) => x[i] + x[i + 1]));
  };
  const aa = grams(a);
  const bb = grams(b);
  let n = 0;
  for (const g of aa) if (bb.has(g)) n++;
  return n;
}

function pickSnag(list, candidate) {
  const cue = /识别练习|厌烦|范畴错误|反相关|流畅性错觉|证据最弱|代价|冲突|反例|错了|不对|其实|但是|然而|误解|噪声|估分|供给断裂|陷阱|忽略|丢/g;
  let best = null;
  for (const s of list) {
    if (s.index === candidate.anchor) continue;
    if ([candidate.before, candidate.after].some((x) => {
      const a = normalized(x);
      const b = normalized(s.text);
      return a === b || a.includes(b) || b.includes(a);
    })) continue;
    const matches = s.text.match(cue) || [];
    if (!matches.length) continue;
    const proximity = Math.max(0, 5 - Math.abs(s.index - candidate.anchor)) * 2;
    const related = Math.min(8, overlap(s.text, candidate.before) + overlap(s.text, candidate.after));
    const lengthPenalty = visibleLen(s.text) > 100 ? 8 : 0;
    const score = matches.length * 10 + proximity + related - lengthPenalty;
    if (!best || score > best.score) best = { ...s, score };
  }
  return best?.text || '';
}

function pickTakeaway(list, candidate, snag) {
  const cue = /→|必须|只能|证据|行为数据|不是自评|排期算法|载荷|规律|规则|结论|修法|完全不同|记住|核心/g;
  let best = null;
  for (const s of list) {
    if ([candidate.before, candidate.after, snag].some((x) => {
      const a = normalized(x);
      const b = normalized(s.text);
      if (a === b) return true;
      return s.part ? visibleLen(b) >= 10 && a.includes(b) : a.includes(b) || b.includes(a);
    })) continue;
    const matches = s.text.match(cue) || [];
    if (!matches.length) continue;
    const proximity = Math.max(0, 5 - Math.abs(s.index - candidate.anchor)) * 2;
    const lengthPenalty = visibleLen(s.text) > 90 ? 10 : visibleLen(s.text) > 65 ? 4 : 0;
    const score = matches.length * 10 + proximity - lengthPenalty;
    if (!best || score > best.score) best = { ...s, score };
  }
  return best?.text || candidate.after;
}

function headingOf(source) {
  const line = source.split(/\r?\n/).map((x) => x.trim()).find((x) => /^#{1,6}\s+/.test(x));
  return clean((line || source.split(/\r?\n/).find((x) => x.trim()) || '一次想通').replace(/^#{1,6}\s+/, ''));
}

export function extractTurn(source) {
  const list = sentences(source);
  const candidates = [];
  for (const s of list) {
    let m = s.text.match(/(.{2,70}?)不是(.{2,50}?)[，,](?:是|而是)(.{2,110})/);
    if (m) {
      const before = `${m[1].split(/[:：]/).pop().trim()}不是${m[2].trim()}`;
      candidates.push({ before, after: m[3].trim(), anchor: s.index, score: 100 - Math.max(0, visibleLen(before) - 30) });
    }
    m = s.text.match(/(.{2,60})，你(.{2,110})/);
    if (m && !/^(?:造出|得到|变成|会导致)/.test(m[2].trim()))
      candidates.push({ before: m[1].split(/[:：]/).pop().trim(), after: `你${m[2].trim()}`, anchor: s.index, score: 120 });
    m = s.text.match(/(.{2,60}?)别当(.{2,30}?)(?:丢|忽略)/);
    if (m) {
      const next = list.find((x) => x.index > s.index && /证据|数据|不是|反而|其实/.test(x.text));
      if (next) candidates.push({ before: `把${m[1].replace(/^[一二三四五六七八九十]+[，,、.]\s*/, '').trim()}当${m[2].trim()}`, after: next.text, anchor: s.index, score: 112 });
    }
    if (/主指标只能选/.test(s.text)) {
      const prev = [...list].reverse().find((x) => x.index < s.index && /时长|日活|指标/.test(x.text));
      if (prev) candidates.push({ before: prev.text, after: s.text.replace(/^.*?：/, ''), anchor: s.index, score: 76 });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.anchor - b.anchor);
  const candidate = candidates[0];
  if (!candidate) return { title: headingOf(source), before: '', snag: '', after: '', takeaway: '' };
  const snag = pickSnag(list, candidate);
  const takeaway = pickTakeaway(clauses(source), candidate, snag);
  const heading = headingOf(source);
  const joined = `${candidate.before}，${candidate.after}`;
  const headingRelated = overlap(heading, `${candidate.before}${candidate.after}${takeaway}`);
  const title = visibleLen(heading) <= 24 && headingRelated >= 2 && !/代价|问题|方向|说明|方法/.test(heading)
    ? heading
    : visibleLen(joined) <= 24 ? joined : visibleLen(candidate.after) <= 18 ? candidate.after : candidate.before;
  return { title, before: candidate.before, snag, after: candidate.after, takeaway };
}

function allocate(total, lengths) {
  const min = 20;
  const budgets = lengths.map(() => min);
  let left = total - budgets.reduce((a, b) => a + b, 0);
  while (left > 0) {
    let at = -1;
    let best = -1;
    lengths.forEach((n, i) => {
      const need = Math.max(0, n - budgets[i]);
      if (need > best) { best = need; at = i; }
    });
    if (at < 0 || best <= 0) break;
    const add = Math.min(left, best);
    budgets[at] += add;
    left -= add;
  }
  return budgets;
}

function fitText(text, budget, block, omitted) {
  const value = canvasText(text);
  if (visibleLen(value) <= budget) return value;
  const chars = [...value];
  let cut = Math.max(1, budget);
  const window = chars.slice(Math.max(0, cut - 12), cut);
  const boundary = Math.max(window.lastIndexOf('。'), window.lastIndexOf('；'), window.lastIndexOf('，'), window.lastIndexOf('：'));
  if (boundary >= 0) cut = Math.max(1, cut - 11 + boundary);
  const kept = chars.slice(0, cut).join('').replace(/[，。；：、,.!?;:\s]+$/, '');
  const removed = chars.slice([...kept].length).join('').replace(/^[，。；：、,.!?;:\s]+/, '');
  if (removed) omitted.push({ block: TURN_LABELS[block], text: removed });
  return kept;
}

export function turnBodyChars(card) {
  const inferred = Array.isArray(card.inferredBlocks) ? card.inferredBlocks.length * 2 : 0;
  return visibleLen(card.title) + BLOCKS.reduce((n, k) => n + visibleLen(card[k]), 0) + LABEL_CHARS + inferred;
}

export function missingBlocks(card) {
  return BLOCKS.filter((k) => k !== 'takeaway' && !canvasText(card[k]));
}

export function memoryCheck(card, source = '') {
  const missing = missingBlocks(card);
  if (missing.length) return { ok: false, missing, reason: `缺少「${TURN_LABELS[missing[0]]}」：这段内容没有讲清${missing[0] === 'before' ? '原来的判断是什么' : missing[0] === 'snag' ? '这个判断被什么推翻' : '推翻之后应当怎么判断'}。补上后再出图。` };
  if (normalized(card.before) === normalized(card.after)) return { ok: false, missing: [], reason: '「原以为」和「正解」还是同一句话，没有形成转弯。' };
  const distinctive = BLOCKS.map((k) => overlap(card[k], source || card[k])).reduce((a, b) => a + b, 0);
  if (distinctive < 3) return { ok: false, missing: [], reason: '四块话都太泛，一年后看不出这是哪段内容。请保留这段对话特有的例子、反例或判断。' };
  return { ok: true, missing: [], reason: '能只凭旧判断、反例和新判断认出这段内容。' };
}

export function normalizeTurnCard(input, { source = '', demo = false } = {}) {
  let raw;
  if (input && input.turn) raw = { title: input.title || input.topic || '一次想通', ...input.turn, takeaway: input.turn.takeaway || input.conclusion || input.turn.after };
  else if (input && ['before', 'snag', 'after'].some((k) => input[k])) raw = { title: input.title || input.topic || '一次想通', ...input, takeaway: input.takeaway || input.conclusion || input.after };
  else {
    const sourceLike = source || [
      input?.topic,
      ...(input?.reading?.units || []).map((u) => u.gist),
      ...(input?.figures || []).map((f) => f.title),
      input?.conclusion,
    ].filter(Boolean).join('。');
    raw = extractTurn(sourceLike);
  }
  const card = { layout: TURN_LAYOUT, title: canvasText(raw.title), demo };
  const omitted = [];
  const origins = {};
  for (const k of BLOCKS) {
    card[k] = canvasText(raw[k]);
    origins[k] = originOf(card[k], source);
  }
  let total = turnBodyChars(card);
  if (total > TURN_LIMIT) {
    const titleBudget = Math.min(24, visibleLen(card.title));
    const takeawayBudget = Math.min(56, visibleLen(card.takeaway));
    const budgets = allocate(TURN_LIMIT - LABEL_CHARS - titleBudget - takeawayBudget, BLOCKS.slice(0, 3).map((k) => visibleLen(card[k])));
    card.title = fitText(card.title, titleBudget, 'title', omitted);
    card.takeaway = fitText(card.takeaway, takeawayBudget, 'takeaway', omitted);
    BLOCKS.slice(0, 3).forEach((k, i) => { card[k] = fitText(card[k], budgets[i], k, omitted); });
    total = turnBodyChars(card);
  }
  const check = memoryCheck(card, source);
  return { card, omitted, origins, bodyChars: total, memory: check };
}

export const DEMO_SOURCE = '用户：我以为自测就是读完再 recognizing 答案，就算自测。\n助手：但重读只会让文字更熟，不会让记忆更牢。正确做法是先自己回忆，再看答案。先回忆，再反馈；熟悉感不是掌握，能独立回忆才是。';

export function demoCard() {
  const source = DEMO_SOURCE;
  const input = {
    title: '自测不是看着熟，是能拿出来',
    before: '读完再 recognizing 答案，就算自测',
    snag: '重读只会让文字更熟，不会让记忆更牢',
    after: '先自己回忆，再看答案',
    takeaway: '熟悉感不是掌握，能独立回忆才是',
  };
  return normalizeTurnCard(input, { source, demo: true });
}

export function printOmissions(omitted) {
  if (!omitted.length) return;
  console.log('未上图（已从画面删去，完整记录仍保留）：');
  for (const item of omitted) console.log(`- ${item.block}：${item.text.length > 80 ? `${item.text.slice(0, 80)}…` : item.text}`);
}
