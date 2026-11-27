import { cleanDisplay } from './collect.mjs';
import { stableQuoteId, visibleLen } from './contract.mjs';
import { RELATION_KINDS, sha256 } from './knowledge-contract.mjs';

const compact = (value) => String(value ?? '').toLowerCase().replace(/[\s，。！？；：、,.!?;:"“”‘’'()（）《》〈〉「」『』\[\]—…]/g, '');

const CUES = Object.freeze({
  因果: /因为|所以|因此|导致|使得|由于|从而|造成|带来|促成|引发|because|therefore|so that|causes?|leads? to/i,
  递进: /首先|然后|下一步|随后|进而|接着|最后|换成|撤下|改为|改成|挪进|替换|调整|修正|完成|实现|建立|建设|形成|first|then|next|finally/i,
  对比: /不是.{0,80}而是|相比|相较于|区别于|不同于|对比|不同|差异|区别|一致|相同|rather than|instead|compared with/i,
  条件: /如果|只要|只有|才|前提|条件下|必须|需要|否则|unless|if|only if|provided that/i,
  转折: /但是|但|然而|不过|却|可是|反而|相反|but|however|yet/i,
  包含: /包括|包含|属于|是一种|可归入|分为|组成|涵盖|只有.{0,12}(?:块|个|部分)|includes?|consists? of|belongs to/i,
  支持: /说明|表明|证据|支持|意味着|因此|证明|验证|可见|据此|换句话说|也就是说|足以|反映|体现|检验|判断|检查|例如|比如|实际含义|shows?|indicates?|supports?|means? that/i,
  反驳: /不是|不等于|推翻|反驳|不能证明|并不意味着|不成立|错了|不对|does not prove|refutes?|wrong/i,
});

function bigrams(value) {
  const chars = [...compact(value)];
  return chars.slice(0, -1).map((_, index) => chars[index] + chars[index + 1]);
}

function overlapScore(text, proposition, evidenceIndex) {
  const left = new Set(bigrams(text));
  if (!left.size) return 0;
  const sources = [proposition.text, ...(proposition.evidence || []).map((item) => evidenceIndex?.get(item.quote_id)?.text || '')].filter(Boolean);
  let best = 0;
  for (const source of sources) {
    const right = bigrams(source);
    if (!right.length) continue;
    const rightSet = new Set(right);
    const hit = [...left].filter((gram) => rightSet.has(gram)).length;
    best = Math.max(best, hit / left.size);
  }
  return best;
}

export function sourceSentences(collected) {
  const out = [];
  for (const utterance of collected.utterances || []) {
    const text = String(utterance.text || '');
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      const englishEnd = char === '.' && (index + 1 >= text.length || /\s/.test(text[index + 1])) && !/\d/.test(text[index - 1] || '');
      if (/[。！？!?]/.test(char) || englishEnd) {
        const quote = text.slice(start, index + 1).trim();
        if (quote) out.push({ quote, text: cleanDisplay(quote), speaker: utterance.speaker, turn_index: utterance.turn_index, quote_id: stableQuoteId({ speaker: utterance.speaker, turnIndex: utterance.turn_index, text: quote }) });
        start = index + 1;
      }
    }
    const tail = text.slice(start).trim();
    if (tail) out.push({ quote: tail, text: cleanDisplay(tail), speaker: utterance.speaker, turn_index: utterance.turn_index, quote_id: stableQuoteId({ speaker: utterance.speaker, turnIndex: utterance.turn_index, text: tail }) });
  }
  return out;
}

function detectKind(text) {
  if (/不是.{0,80}而是|rather than|instead/i.test(text)) return '对比';
  if (/如果|只要|只有|才|前提|条件下|unless|if|only if|provided that/i.test(text)) return '条件';
  if (/但是|但|然而|不过|却|可是|but|however|yet/i.test(text)) return '转折';
  if (/因为|所以|因此|导致|使得|由于|从而|because|therefore|so that|causes?|leads? to/i.test(text)) return '因果';
  if (/首先|然后|下一步|随后|进而|接着|最后|first|then|next|finally/i.test(text)) return '递进';
  if (/包括|包含|属于|是一种|可归入|includes?|consists? of|belongs to/i.test(text)) return '包含';
  if (/推翻|反驳|不能证明|并不意味着|不成立|错了|不对|does not prove|refutes?|wrong/i.test(text)) return '反驳';
  if (/说明|表明|证据|支持|意味着|shows?|indicates?|supports?|means? that/i.test(text)) return '支持';
  return '';
}

function splitDirections(text, kind) {
  if (kind === '因果') {
    const because = text.search(/因为|由于|because/i);
    const so = text.search(/所以|因此|所以|so|therefore/i);
    if (because >= 0 && so > because) return [text.slice(because, so), text.slice(so)];
    const lead = text.search(/导致|使得|从而|leads? to|causes?/i);
    if (lead > 0) return [text.slice(0, lead), text.slice(lead)];
  }
  if (kind === '条件') {
    const match = text.match(/^(.{2,180}?)(?:如果|只要|只有|才|就|if|unless|only if)(.{2,180})$/i);
    if (match) return [match[1], match[2]];
  }
  if (kind === '对比') {
    const match = text.match(/^(.{2,180}?)(?:不是|而非|rather than|instead)(.{2,180})$/i);
    if (match) return [match[1], match[2]];
  }
  if (kind === '转折') {
    const match = text.match(/^(.{2,180}?)(?:但是|但|然而|不过|却|可是|but|however|yet)(.{2,180})$/i);
    if (match) return [match[1], match[2]];
  }
  if (kind === '递进') {
    const match = text.match(/^(.{2,180}?)(?:首先|然后|下一步|随后|进而|接着|最后|first|then|next|finally)(.{2,180})$/i);
    if (match) return [match[1], match[2]];
  }
  if (kind === '包含') {
    const match = text.match(/^(.{2,180}?)(?:包括|包含|属于|是一种|可归入|includes?|consists? of|belongs to)(.{2,180})$/i);
    if (match) return [match[2], match[1]];
  }
  if (kind === '支持' || kind === '反驳') {
    const match = text.match(/^(.{2,180}?)(?:说明|表明|证据|支持|意味着|推翻|反驳|不能证明|并不意味着|shows?|indicates?|supports?|means? that|does not prove|refutes?)(.{2,180})$/i);
    if (match) return [match[1], match[2]];
  }
  return null;
}

export function evidencePosition(proposition, sentence, evidenceIndex) {
  const sources = [proposition.text, ...(proposition.evidence || []).map((item) => evidenceIndex?.get(item.quote_id)?.text || '')].filter(Boolean);
  let best = -1;
  for (const source of sources) {
    const index = sentence.text.indexOf(source);
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best;
}

export function extractRelations(structure, collected, evidenceIndex) {
  const relations = [];
  const gaps = [];
  const seen = new Set();
  for (const sentence of sourceSentences(collected)) {
    const kind = detectKind(sentence.text);
    if (!kind) continue;
    const directions = splitDirections(sentence.text, kind);
    if (!directions) continue;
    const scored = structure.propositions.map((proposition) => ({
      proposition,
      left: overlapScore(directions[0], proposition, evidenceIndex),
      right: overlapScore(directions[1], proposition, evidenceIndex),
    }));
    const left = scored.filter((item) => item.left >= 0.18).sort((a, b) => b.left - a.left)[0];
    const right = scored.filter((item) => item.right >= 0.18).sort((a, b) => b.right - a.right)[0];
    if (!left || !right || left.proposition.id === right.proposition.id) continue;
    const leftPosition = evidencePosition(left.proposition, sentence, evidenceIndex);
    const rightPosition = evidencePosition(right.proposition, sentence, evidenceIndex);
    let from = left.proposition;
    let to = right.proposition;
    if (leftPosition >= 0 && rightPosition >= 0) {
      if (kind === '包含') {
        from = leftPosition < rightPosition ? right.proposition : left.proposition;
        to = leftPosition < rightPosition ? left.proposition : right.proposition;
      } else {
        from = leftPosition < rightPosition ? left.proposition : right.proposition;
        to = leftPosition < rightPosition ? right.proposition : left.proposition;
      }
    }
    if ((kind === '因果' || kind === '条件') && [from.layer, to.layer].includes('example')) {
      gaps.push({ missing: '例子与主结论被连成因果或条件', why: `原句「${sentence.text}」两端层级不同，未建边。` });
      continue;
    }
    const key = `${from.id}|${to.id}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const strength = Math.min(0.95, Math.round((0.6 + Math.min(left.left, right.right) * 0.35) * 100) / 100);
    relations.push({
      id: `r${relations.length + 1}`,
      from: from.id,
      to: to.id,
      kind,
      evidence: [{ quote_id: sentence.quote_id, verbatim: true }],
      strength,
    });
  }
  return { relations, gaps };
}

function directionalCue(kind, text) {
  if (kind === '因果') return /因为.{0,160}(?:所以|因此)|(?:所以|因此).{0,160}因为|导致|使得|造成|带来|促成|引发|leads? to|causes?/i.test(text);
  if (kind === '条件') return /如果|只要|只有|才|否则|unless|if|only if|provided that/i.test(text);
  if (kind === '对比') return /不是.{0,100}而是|相比|相较于|区别于|不同于|rather than|instead|compared with/i.test(text);
  if (kind === '转折') return /但是|然而|不过|却|可是|反而|相反|but|however|yet/i.test(text);
  if (kind === '包含') return /包括|包含|分为|组成|属于|是一种|可归入|涵盖|只有.{0,12}(?:块|个|部分)|includes?|consists? of|belongs to/i.test(text);
  if (kind === '支持') return /说明|表明|证据|支持|意味着|证明|验证|可见|据此|换句话说|也就是说|足以|反映|体现|检验|判断|检查|例如|比如|实际含义|shows?|indicates?|supports?|means? that/i.test(text);
  if (kind === '递进') return /首先|然后|下一步|随后|进而|接着|最后|换成|撤下|改为|改成|挪进|替换|调整|修正|完成|实现|建立|建设|形成|first|then|next|finally/i.test(text);
  if (kind === '反驳') return /不是|不等于|推翻|反驳|不能证明|并不意味着|不成立|错了|不对|does not prove|refutes?|wrong/i.test(text);
  return false;
}

export function relationReviewHash(relation, evidenceIndex, structure = null) {
  const endpoint = (id) => {
    const proposition = structure?.propositions?.find((item) => item.id === id);
    return proposition ? { text: proposition.text, evidence: (proposition.evidence || []).map((item) => item.quote_id) } : id;
  };
  return sha256(JSON.stringify({
    from: endpoint(relation.from),
    to: endpoint(relation.to),
    kind: relation.kind,
    strength: relation.strength,
    evidence: (relation.evidence || []).map((item) => [item.quote_id, evidenceIndex?.get(item.quote_id)?.text || '']),
  }));
}

function hasValidReview(relation, evidenceIndex, structure) {
  return !!relation.review_hash && relation.review_hash === relationReviewHash(relation, evidenceIndex, structure);
}

export function relationSemanticErrors(relation, structure, evidenceIndex) {
  const errors = [];
  if (!RELATION_KINDS.includes(relation.kind)) return [`${relation.id}：关系种类不合法`];
  const from = structure.propositions.find((item) => item.id === relation.from);
  const to = structure.propositions.find((item) => item.id === relation.to);
  if (!from || !to) return [...errors, `${relation.id}：两端命题不存在`];
  const texts = (relation.evidence || []).map((item) => evidenceIndex?.get(item.quote_id)?.text || '').filter(Boolean);
  if (!texts.length) return [...errors, `${relation.id}：没有可核对的关系原句`];
  const reviewed = hasValidReview(relation, evidenceIndex, structure);
  if (!reviewed) {
    if (!texts.some((text) => directionalCue(relation.kind, text))) errors.push(`${relation.id}：原句没有讲述「${relation.kind}」的明确方向线索`);
    for (const [label, proposition] of [['起点', from], ['终点', to]]) {
      const covered = texts.some((text) => overlapScore(text, proposition, evidenceIndex) >= 0.18);
      if (!covered) errors.push(`${relation.id}：关系原句没有覆盖${label}命题`);
    }
    const directionChecked = texts.some((text) => {
      const directions = splitDirections(text, relation.kind);
      if (!directions) return false;
      const sentence = { text };
      const fromPosition = evidencePosition(from, sentence, evidenceIndex);
      const toPosition = evidencePosition(to, sentence, evidenceIndex);
      if (fromPosition < 0 || toPosition < 0) return false;
      const expectedFrom = relation.kind === '包含'
        ? (fromPosition > toPosition ? from : to)
        : (fromPosition < toPosition ? from : to);
      return expectedFrom.id === relation.from;
    });
    if (!directionChecked) errors.push(`${relation.id}：箭头方向无法从原句确认`);
  }
  if ((relation.kind === '因果' || relation.kind === '条件') && [from.layer, to.layer].includes('example')) errors.push(`${relation.id}：例子不能与主结论连成因果或条件`);
  if (relation.strength < 0.5) errors.push(`${relation.id}：弱关系不能进入正式结构，请移入 gaps 或细节图`);
  return errors;
}

export function validateRelationsSemantics(structure, evidenceIndex) {
  const errors = [];
  for (const relation of structure.relations || []) errors.push(...relationSemanticErrors(relation, structure, evidenceIndex));
  return [...new Set(errors)];
}
