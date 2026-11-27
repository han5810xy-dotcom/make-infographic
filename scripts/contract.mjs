import { createHash } from 'node:crypto';

export const TURN_KINDS = Object.freeze(['口诀', '画面', '反例']);
export const SPEAKERS = Object.freeze(['user', 'assistant', 'inferred']);

export const sha256 = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');

export function stableQuoteId({ speaker, turnIndex, text }) {
  return `q_${sha256(`${turnIndex}\u0000${speaker}\u0000${text}`).slice(0, 12)}`;
}

export function stableTurnId(turn) {
  const material = [
    turn.prior?.quote || turn.prior?.text || '',
    turn.collision?.quote || turn.collision?.text || '',
    turn.revised?.quote || turn.revised?.text || '',
    turn.takeaway?.text || '',
  ].join('\u0000');
  return `t_${sha256(material).slice(0, 16)}`;
}

export function sourceHash(source) {
  return sha256(String(source ?? '').replace(/\r\n/g, '\n'));
}

export function visibleLen(value) {
  return [...String(value ?? '').replace(/\s/g, '')].length;
}

export function clipAtBoundary(value, limit) {
  const text = String(value ?? '').trim();
  if (visibleLen(text) <= limit) return text;
  const chars = [...text];
  let cut = Math.max(1, limit);
  const window = chars.slice(Math.max(0, cut - 14), cut);
  const boundary = Math.max(
    window.lastIndexOf('。'),
    window.lastIndexOf('！'),
    window.lastIndexOf('？'),
    window.lastIndexOf('；'),
    window.lastIndexOf('，'),
    window.lastIndexOf(':'),
    window.lastIndexOf('：'),
  );
  if (boundary >= 0) cut = Math.max(1, cut - 13 + boundary);
  const isWord = (char) => !!char && /[A-Za-z0-9_]/.test(char);
  if (isWord(chars[cut - 1]) && isWord(chars[cut])) {
    let left = cut;
    while (left > 0 && isWord(chars[left - 1])) left--;
    let right = cut;
    while (right < chars.length && isWord(chars[right])) right++;
    if (left > 0) cut = left;
    else if (right <= limit) cut = right;
  }
  return chars.slice(0, cut).join('').replace(/[，。！？；：、,.!?;:\s]+$/g, '');
}

export function exactQuote(quote, source) {
  const q = String(quote ?? '');
  return !!q && String(source ?? '').includes(q);
}

export function validateTurn(turn, source = '') {
  const errors = [];
  if (!turn || typeof turn !== 'object') return ['Turn 不是对象。'];
  if (!turn.id || !/^t_[a-f0-9]{16}$/.test(turn.id)) errors.push('id 不是稳定的转弯编号。');
  if (!turn.title || visibleLen(turn.title) > 24) errors.push('标题超过 24 字。');
  for (const key of ['prior', 'collision', 'revised']) {
    const block = turn[key];
    if (!block || typeof block !== 'object') {
      errors.push(`${key} 缺失。`);
      continue;
    }
    if (!block.text) errors.push(`${key}.text 为空。`);
    if (!SPEAKERS.includes(block.source)) errors.push(`${key}.source 不合法。`);
    if (!Number.isFinite(block.confidence) || block.confidence < 0 || block.confidence > 1)
      errors.push(`${key}.confidence 不在 0 到 1 之间。`);
    if (key === 'prior' && block.source === 'inferred') {
      if (!block.quote && !block.inference) errors.push('推断的 prior 必须写清推断依据。');
    } else if (!exactQuote(block.quote, source)) {
      errors.push(`${key}.quote 不能逐字指回原文。`);
    }
  }
  if (!turn.takeaway || !turn.takeaway.text || visibleLen(turn.takeaway.text) > 40)
    errors.push('takeaway 为空或超过 40 字。');
  if (!TURN_KINDS.includes(turn.takeaway?.kind)) errors.push('takeaway.kind 不合法。');
  if (!Array.isArray(turn.evidence) || !turn.evidence.length) errors.push('evidence 为空。');
  for (const item of turn.evidence || []) {
    if (!item.quote_id || !['user', 'assistant'].includes(item.speaker))
      errors.push('evidence 缺少 quote_id 或 speaker。');
    if (!Number.isInteger(item.turn_index) || item.turn_index < 0)
      errors.push('evidence.turn_index 不是非负整数。');
    if (!exactQuote(item.text, source)) errors.push(`证据「${item.text}」不能逐字指回原文。`);
  }
  if (!['corpus', 'model'].includes(turn.provenance)) errors.push('provenance 不合法。');
  if (!turn.created_at || !turn.source_hash) errors.push('created_at 或 source_hash 缺失。');
  return errors;
}
