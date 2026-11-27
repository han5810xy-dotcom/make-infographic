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
    overview: authored.overview === true,
    propositions: (authored.propositions || []).map((proposition) => ({
      id: proposition.id,
      kind: proposition.kind,
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
      reviewed: relation.reviewed === true,
    })),
    topo: authored.topo || 'network',
    backbone: authored.backbone || [],
    gaps: authored.gaps || [],
    views: authored.views,
  };
  return { structure: finalizeStructure(structure), collected, evidenceIndex };
}
