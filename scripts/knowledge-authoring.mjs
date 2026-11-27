import { collectDialogue } from './collect.mjs';
import { stableQuoteId } from './contract.mjs';
import { finalizeStructure, evidenceIndexFromCollected } from './knowledge-contract.mjs';

function resolveEvidence(item, collected) {
  const utterance = (collected.utterances || []).find((entry) => entry.speaker === item.speaker && entry.turn_index === item.turn_index);
  if (!utterance) throw new Error(`找不到第 ${item.turn_index} 轮的${item.speaker}发言`);
  const text = String(item.text || '').trim();
  if (!text || !utterance.text.includes(text)) throw new Error(`evidence 不能逐字引回原文：${text}`);
  return {
    quote_id: stableQuoteId({ speaker: item.speaker, turnIndex: item.turn_index, text }),
    speaker: item.speaker,
    turn_index: item.turn_index,
    verbatim: item.verbatim !== false,
  };
}

export function resolveAuthoring(authored, source) {
  if (!authored || typeof authored !== 'object') throw new Error('作者结构不是对象');
  const collected = collectDialogue(source);
  const evidenceIndex = evidenceIndexFromCollected(collected);
  const resolveIntoIndex = (item) => {
    const resolved = resolveEvidence(item, collected);
    const utterance = (collected.utterances || []).find((entry) => entry.speaker === item.speaker && entry.turn_index === item.turn_index);
    evidenceIndex.set(resolved.quote_id, { ...resolved, text: item.text, source_text: utterance?.text || item.text });
    return resolved;
  };
  const structure = {
    topic: authored.topic,
    headline: authored.headline || '',
    subhead: authored.subhead || '',
    weight_source: authored.weight_source || 'auto',
    backbone_source: authored.backbone_source || (authored.backbone?.length ? 'authored' : 'auto'),
    authoring_mode: authored.authoring_mode || 'authored',
    overview: authored.overview === true,
    propositions: (authored.propositions || []).map((proposition) => ({
      id: proposition.id,
      kind: proposition.kind,
      layer: proposition.layer || (proposition.kind === '例子' || (proposition.evidence || []).some((item) => /^(?:例如|比如|举例)/.test(item.text || '')) ? 'example' : 'main'),
      text: proposition.text,
      evidence: (proposition.evidence || []).map((item) => resolveIntoIndex(item)),
      weight: Number.isFinite(proposition.weight) ? proposition.weight : 0.5,
      provenance: proposition.provenance,
    })),
    relations: (authored.relations || []).map((relation) => ({
      id: relation.id,
      from: relation.from,
      to: relation.to,
      kind: relation.kind,
      evidence: (relation.evidence || []).map((item) => {
        const resolved = resolveIntoIndex(item);
        return { quote_id: resolved.quote_id, verbatim: true };
      }),
      strength: Number.isFinite(relation.strength) ? relation.strength : 0.5,
      review_hash: relation.review_hash || '',
    })),
    topo: authored.topo || 'network',
    topo_source: authored.topo ? 'authored' : 'auto',
    backbone: authored.backbone || [],
    gaps: authored.gaps || [],
    key_conclusions: authored.key_conclusions || [],
    views: authored.views,
  };
  return { structure: finalizeStructure(structure), collected, evidenceIndex };
}
