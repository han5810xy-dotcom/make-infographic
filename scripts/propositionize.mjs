import { cleanDisplay } from './collect.mjs';
import { stableQuoteId } from './contract.mjs';
import { finalizeStructure, visibleLen, evidenceIndexFromCollected } from './knowledge-contract.mjs';

const BLOCKED = /^(?:你好|您好|嗨|哈喽|谢谢|多谢|明白了|好的|好|没问题|可以|继续|请继续|你继续|我现在|我先|让我|接下来我|下一步我|收到|嗯|哦|啊|呀|吧|呢|吗)[。！!?，,\s]*$/i;
const META = /^(?:任务|要求|指令|背景|说明|备注|测试|回归|验收|实现|修改|修复|重跑|检查|继续执行|不要问我|我自己定|做完报告)\s*[:：]/;
const LOW_VALUE = /^(?:```|[{}\[\]]|["'][^"']+["']\s*:|[A-Za-z_][A-Za-z0-9_]*\s*:|#{1,6}\s|[-*+]\s|\d+[.)]\s|https?:\/\/)/;
const TASK_SECTION = /^(?:任务|目标|技术栈|目录|流程|命令|环境变量|验收|不做|注意事项|要求|指令)\s*[:：]?\s*$/;
const TOPIC_ANCHORS = Object.freeze(['记忆', '学习', '复习', '证据', '命题', '关系', '结构', '排版', '渲染', '浏览器', '安装', '依赖', 'Node', 'pnpm', 'npm', '发布', '站点', '页面', '产品', '用户', '对话', '知识', '数学', '哲学', '日语', '测试', '性能', '安全', '数据', '模型', '提示', '工作流', '卡片']);

const compact = (value) => String(value ?? '').toLowerCase().replace(/[\s，。！？；：、,.!?;:"“”‘’'()（）《》〈〉「」『』\[\]—…]/g, '');

function splitSentence(text) {
  const source = String(text ?? '');
  const out = [];
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const englishEnd = char === '.'
      && (index + 1 >= source.length || /\s/.test(source[index + 1]))
      && !/\d/.test(source[index - 1] || '');
    if (/[。！？!?]/.test(char) || englishEnd) {
      const quote = source.slice(start, index + 1).trim();
      if (quote) out.push(quote);
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function splitClause(text) {
  const source = String(text ?? '').trim();
  if (visibleLen(source) <= 60) return [source];
  const parts = [];
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    if (/[；;]/.test(source[index])) {
      parts.push(source.slice(start, index + 1).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  const out = [];
  for (const part of parts.filter(Boolean)) {
    if (visibleLen(part) <= 60) {
      out.push(part);
      continue;
    }
    let cursor = 0;
    for (let index = 0; index < part.length; index++) {
      if (/[，,]/.test(part[index])) {
        const clause = part.slice(cursor, index + 1).trim();
        if (visibleLen(clause) >= 6) out.push(clause);
        cursor = index + 1;
      }
    }
    const tail = part.slice(cursor).trim();
    if (tail) out.push(tail);
  }
  return out.filter(Boolean);
}

export function kindOf(text) {
  const value = String(text || '');
  if (/例如|比如|举例|例如说|举个/.test(value)) return '例子';
  if (/但是|然而|不过|例外|除非|特殊情况下/.test(value)) return '例外';
  if (/如果|只要|只有|才|前提|条件/.test(value)) return '条件';
  if (/不是.{0,40}而是|相比|区别于|不同于|对比| rather than | instead /.test(value)) return '对比';
  if (/因为|所以|因此|导致|使得|由于|从而/.test(value)) return '因果';
  if (/首先|然后|下一步|先.{0,20}再|步骤|流程/.test(value)) return '步骤';
  if (/\d|%|％|倍|万|亿/.test(value)) return '数据';
  if (/指的是|定义为|所谓|是一种|是指|本质/.test(value)) return '定义';
  return '主张';
}

export function topicAnchorsOf(text) {
  const value = String(text || '');
  return TOPIC_ANCHORS.filter((anchor) => value.toLowerCase().includes(anchor.toLowerCase()));
}

export function propositionCandidates(collected) {
  const candidates = [];
  for (const utterance of collected.utterances || []) {
    for (const sentence of splitSentence(utterance.text)) {
      for (const quote of splitClause(sentence)) {
        const text = cleanDisplay(quote);
        if (!text || BLOCKED.test(text) || META.test(text) || LOW_VALUE.test(text) || TASK_SECTION.test(text)) continue;
        if (/\n\s*(?:```|[{}\[\]]|["'][^"']+["']\s*:)/.test(quote)) continue;
        if (visibleLen(text) < 4 || visibleLen(text) > 60) continue;
        candidates.push({
          text,
          quote,
          speaker: utterance.speaker,
          turn_index: utterance.turn_index,
          quote_id: stableQuoteId({ speaker: utterance.speaker, turnIndex: utterance.turn_index, text: quote }),
          kind: kindOf(text),
          provenance: text === quote ? 'quote' : 'summary',
        });
      }
    }
  }
  return candidates;
}

function topicScore(candidate, anchors) {
  const own = topicAnchorsOf(candidate.text);
  return own.filter((anchor) => anchors.includes(anchor)).length;
}

export function buildPropositions(collected, { topic = '' } = {}) {
  const candidates = propositionCandidates(collected);
  const anchorCounts = new Map();
  for (const candidate of candidates) {
    for (const anchor of topicAnchorsOf(candidate.text)) anchorCounts.set(anchor, (anchorCounts.get(anchor) || 0) + 1);
  }
  const dominant = [...anchorCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
  const seen = new Set();
  const propositions = [];
  const gaps = [];
  for (const candidate of candidates) {
    const key = compact(candidate.text);
    if (seen.has(key)) continue;
    seen.add(key);
    propositions.push({
      id: `p${propositions.length + 1}`,
      kind: candidate.kind,
      text: candidate.text,
      evidence: [{ quote_id: candidate.quote_id, speaker: candidate.speaker, turn_index: candidate.turn_index, verbatim: true }],
      weight: 0.5,
      provenance: candidate.provenance,
      layer: candidate.kind === '例子' || /^(?:例如|比如|举例)/.test(candidate.text) ? 'example' : 'main',
    });
  }
  for (const utterance of collected.utterances || []) {
    for (const sentence of splitSentence(utterance.text)) {
      if (visibleLen(cleanDisplay(sentence)) > 60 && !splitClause(sentence).some((part) => visibleLen(cleanDisplay(part)) <= 60)) {
        gaps.push({ missing: '有原句无法在不改写的前提下压成单条命题', why: `第 ${utterance.turn_index} 轮：${cleanDisplay(sentence).slice(0, 60)}` });
      }
    }
  }
  const resolvedTopic = topic || dominant || cleanDisplay(collected.utterances?.[0]?.text || '未命名对话').slice(0, 60) || '未命名对话';
  const structure = {
    id: '',
    topic: resolvedTopic,
    authoring_mode: 'auto-candidate',
    propositions,
    relations: [],
    topo: propositions.length > 12 ? 'network' : 'chain',
    backbone: [],
    gaps,
  };
  const finalized = finalizeStructure(structure);
  const structures = splitByTopic(finalized);
  const evidenceIndex = evidenceIndexFromCollected(collected);
  for (const candidate of candidates) {
    const utterance = (collected.utterances || []).find((item) => item.speaker === candidate.speaker && item.turn_index === candidate.turn_index);
    evidenceIndex.set(candidate.quote_id, { ...candidate, source_text: utterance?.text || candidate.quote });
  }
  return {
    structure: structures[0],
    structures,
    evidenceIndex,
    candidates,
    stats: { candidate_count: candidates.length, proposition_count: propositions.length, structure_count: structures.length, gap_count: gaps.length, dominant_topic: dominant },
  };
}

export function splitByTopic(structure) {
  if (structure.propositions.length <= 30) return [structure];
  const groups = new Map();
  for (const proposition of structure.propositions) {
    const anchors = topicAnchorsOf(proposition.text);
    const key = anchors[0] || '其他';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(proposition);
  }
  const output = [];
  for (const [key, propositions] of groups) {
    for (let offset = 0; offset < propositions.length; offset += 30) {
      const chunk = propositions.slice(offset, offset + 30);
      const suffix = `${structure.topic}·${key}${propositions.length > 30 ? `·${Math.floor(offset / 30) + 1}` : ''}`;
      const topic = [...suffix].slice(0, 60).join('');
      output.push(finalizeStructure({
        ...structure,
        id: '',
        topic,
        propositions: chunk,
        relations: structure.relations.filter((relation) => chunk.some((item) => item.id === relation.from) && chunk.some((item) => item.id === relation.to)),
        backbone: structure.backbone.filter((id) => chunk.some((item) => item.id === id)),
        gaps: [...structure.gaps, { missing: '原对话包含多个主题或超过 30 条命题', why: `本结构只保留「${key}」的第 ${offset + 1}~${offset + chunk.length} 条命题。` }],
      }));
    }
  }
  return output;
}
