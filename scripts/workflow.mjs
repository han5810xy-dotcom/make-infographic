import { collectDialogue, cleanDisplay } from './collect.mjs';
import { stableQuoteId } from './contract.mjs';
import { resolveAuthoring } from './knowledge-authoring.mjs';
import { evidenceIndexFromCollected, finalizeStructure, validateStructure, visibleLen } from './knowledge-contract.mjs';
import { buildPropositions, kindOf } from './propositionize.mjs';
import { extractRelations, relationSemanticErrors, validateRelationsSemantics } from './relations.mjs';
import { buildFramework } from './attention.mjs';
import { buildViews, viewConsistency } from './views.mjs';

const compact = (value) => String(value ?? '').toLowerCase().replace(/[\s，。！？；：、,.!?;:"“”‘’'()（）《》〈〉「」『』\[\]—…]/g, '');

function keyCovered(key, proposition, evidenceIndex) {
  const needle = compact(key);
  if (!needle) return false;
  if (compact(proposition.text).includes(needle) || needle.includes(compact(proposition.text))) return true;
  return (proposition.evidence || []).some((item) => {
    const text = compact(evidenceIndex.get(item.quote_id)?.text || '');
    return text.includes(needle) || needle.includes(text);
  });
}

function ensureKeyConclusions(structure, authored, collected, evidenceIndex) {
  const keys = authored?.key_conclusions || structure.key_conclusions || [];
  const missing = [];
  for (const key of keys) {
    if ((structure.propositions || []).some((proposition) => keyCovered(key, proposition, evidenceIndex))) continue;
    const utterance = (collected.utterances || []).find((item) => item.text.includes(key));
    const text = cleanDisplay(key);
    if (!utterance || !text || visibleLen(text) > 60) {
      missing.push(key);
      continue;
    }
    const quote_id = stableQuoteId({ speaker: utterance.speaker, turnIndex: utterance.turn_index, text: key });
    evidenceIndex.set(quote_id, { quote_id, speaker: utterance.speaker, turn_index: utterance.turn_index, text: key, source_text: utterance.text });
    structure.propositions.push({
      id: `p${structure.propositions.length + 1}`,
      kind: kindOf(text),
      layer: 'main',
      text,
      evidence: [{ quote_id, speaker: utterance.speaker, turn_index: utterance.turn_index, verbatim: true }],
      weight: 0.75,
      provenance: 'quote',
    });
  }
  const covered = keys.filter((key) => (structure.propositions || []).some((proposition) => keyCovered(key, proposition, evidenceIndex))).length;
  structure.key_conclusions = keys;
  structure.coverage = { total: keys.length, covered, missing, ratio: keys.length ? covered / keys.length : 1 };
  if (missing.length) structure.gaps.push({ missing: '关键结论覆盖不足', why: missing.join('；') });
  return structure;
}

async function runSingle(source, collected, authored, proposed = null) {
  const steps = [];
  let structure;
  let evidenceIndex;
  if (authored) {
    const resolved = resolveAuthoring(authored, source);
    structure = resolved.structure;
    evidenceIndex = resolved.evidenceIndex;
  } else if (proposed) {
    structure = proposed.structure;
    evidenceIndex = proposed.evidenceIndex;
    const extracted = extractRelations(structure, collected, evidenceIndex);
    structure = finalizeStructure({ ...structure, relations: extracted.relations, gaps: [...structure.gaps, ...extracted.gaps] });
  } else {
    const generated = buildPropositions(collected);
    structure = generated.structure;
    evidenceIndex = generated.evidenceIndex;
    const extracted = extractRelations(structure, collected, evidenceIndex);
    structure = finalizeStructure({ ...structure, relations: extracted.relations, gaps: [...structure.gaps, ...extracted.gaps] });
  }
  structure.authoring_mode = authored ? 'authored' : 'auto-candidate';
  steps.push({ step: 1, name: '完整浏览用户对话', turns: collected.utterances?.length || 0, source_chars: visibleLen(source) });
  steps.push({ step: 2, name: '分析注意力权重', propositions: structure.propositions.length, note: '由 buildFramework 在关系已知后重算纠正度' });

  structure = ensureKeyConclusions(structure, authored, collected, evidenceIndex);
  structure = finalizeStructure(structure);
  const m1 = validateStructure(structure, { evidenceIndex, stage: 'm1' });
  if (m1.errors.length) throw new Error(`命题层未通过：${m1.errors.join('；')}`);
  const automatic = authored ? { relations: [], gaps: [] } : extractRelations(structure, collected, evidenceIndex);
  const relationMap = new Map();
  for (const relation of [...(structure.relations || []), ...automatic.relations]) {
    const key = `${relation.from}|${relation.to}`;
    if (!relationMap.has(key)) relationMap.set(key, relation);
  }
  structure.relations = [...relationMap.values()];
  structure.gaps = [...(structure.gaps || []), ...automatic.gaps];
  const validRelations = [];
  for (const relation of structure.relations || []) {
    const errors = relationSemanticErrors(relation, structure, evidenceIndex);
    if (errors.length) structure.gaps.push({ missing: '关系证据不足，已从正式结构删除', why: errors.join('；') });
    else validRelations.push(relation);
  }
  structure.relations = validRelations;
  structure = finalizeStructure(structure);
  steps.push({ step: 3, name: '理解对话内容', key_conclusions: structure.coverage?.total || 0, coverage: structure.coverage?.ratio ?? 1, gaps: structure.gaps.length });

  const resolvedViews = structure.views;
  structure = buildFramework(structure, collected, evidenceIndex);
  structure = finalizeStructure(structure);
  const relationErrors = validateRelationsSemantics(structure, evidenceIndex);
  if (relationErrors.length) throw new Error(`关系层未通过：${relationErrors.join('；')}`);
  steps.push({ step: 4, name: '逻辑提炼', relations: structure.relations.length, kinds: [...new Set(structure.relations.map((item) => item.kind))] });

  steps.push({ step: 5, name: '构建结构框架', backbone: structure.backbone.length, topo: structure.topo, weights: structure.propositions.map((item) => Number(item.weight.toFixed(3))) });
  structure.views = resolvedViews?.length ? resolvedViews : buildViews(structure, evidenceIndex);
  structure = finalizeStructure(structure);
  const consistency = viewConsistency(structure);
  if (consistency.length) throw new Error(`图种选择未通过：${consistency.join('；')}`);
  steps.push({ step: 6, name: '按逻辑选择图种', views: structure.views.map((view) => ({ id: view.id, graphic: view.graphic, target: view.target })) });

  const contract = validateStructure(structure, { evidenceIndex });
  if (contract.errors.length) throw new Error(`结构校验未通过：${contract.errors.join('；')}`);
  steps.push({ step: 7, name: '检查', errors: contract.errors.length, warnings: contract.warnings.length, relation_errors: relationErrors.length });
  steps.push({ step: 8, name: '输出图片', status: 'ready-for-render', structure_id: structure.id });
  return { structure, collected, evidenceIndex, steps, stats: { propositions: structure.propositions.length, relations: structure.relations.length, backbone: structure.backbone.length, views: structure.views.length, gaps: structure.gaps.length, coverage: structure.coverage?.ratio ?? 1 } };
}

export async function runKnowledgeWorkflow(source, { authored = null } = {}) {
  const collected = collectDialogue(source);
  const runs = [];
  if (authored) {
    runs.push(await runSingle(source, collected, authored));
  } else {
    const proposed = buildPropositions(collected);
    for (const structure of proposed.structures) {
      const evidenceIndex = new Map(proposed.evidenceIndex);
      runs.push(await runSingle(source, collected, null, { structure, evidenceIndex }));
    }
  }
  const first = runs[0];
  const stats = runs.reduce((total, run) => ({
    propositions: total.propositions + run.stats.propositions,
    relations: total.relations + run.stats.relations,
    backbone: total.backbone + run.stats.backbone,
    views: total.views + run.stats.views,
    gaps: total.gaps + run.stats.gaps,
  }), { propositions: 0, relations: 0, backbone: 0, views: 0, gaps: 0 });
  stats.structures = runs.length;
  return {
    structure: first.structure,
    structures: runs.map((run) => run.structure),
    collected,
    evidenceIndex: first.evidenceIndex,
    steps: first.steps,
    stats,
  };
}
