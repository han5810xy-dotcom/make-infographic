import { collectDialogue } from './collect.mjs';
import { resolveAuthoring } from './knowledge-authoring.mjs';
import { evidenceIndexFromCollected, finalizeStructure, validateStructure, visibleLen } from './knowledge-contract.mjs';
import { buildPropositions } from './propositionize.mjs';
import { extractRelations, relationSemanticErrors, validateRelationsSemantics } from './relations.mjs';
import { buildFramework } from './attention.mjs';
import { buildViews, viewConsistency } from './views.mjs';

export async function runKnowledgeWorkflow(source, { authored = null } = {}) {
  const steps = [];
  const collected = collectDialogue(source);
  steps.push({ step: 1, name: '完整浏览用户对话', turns: collected.utterances?.length || 0, source_chars: visibleLen(source) });

  let structure;
  let evidenceIndex;
  if (authored) {
    const resolved = resolveAuthoring(authored, source);
    structure = resolved.structure;
    evidenceIndex = resolved.evidenceIndex;
  } else {
    const proposed = buildPropositions(collected);
    structure = proposed.structure;
    evidenceIndex = proposed.evidenceIndex;
    const extracted = extractRelations(structure, collected, evidenceIndex);
    structure = finalizeStructure({ ...structure, relations: extracted.relations, gaps: [...structure.gaps, ...extracted.gaps] });
  }
  steps.push({ step: 2, name: '分析注意力权重', propositions: structure.propositions.length, note: '由 buildFramework 在关系已知后重算纠正度' });

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
  steps.push({ step: 3, name: '理解对话内容', key_conclusions: authored?.key_conclusions?.length || 0, gaps: structure.gaps.length });

  structure = buildFramework(structure, collected, evidenceIndex);
  structure = finalizeStructure(structure);
  const relationErrors = validateRelationsSemantics(structure, evidenceIndex);
  if (relationErrors.length) throw new Error(`关系层未通过：${relationErrors.join('；')}`);
  steps.push({ step: 4, name: '逻辑提炼', relations: structure.relations.length, kinds: [...new Set(structure.relations.map((item) => item.kind))] });

  steps.push({ step: 5, name: '构建结构框架', backbone: structure.backbone.length, topo: structure.topo, weights: structure.propositions.map((item) => Number(item.weight.toFixed(3))) });
  structure.views = buildViews(structure, evidenceIndex);
  structure = finalizeStructure(structure);
  const consistency = viewConsistency(structure);
  if (consistency.length) throw new Error(`图种选择未通过：${consistency.join('；')}`);
  steps.push({ step: 6, name: '按逻辑选择图种', views: structure.views.map((view) => ({ id: view.id, graphic: view.graphic, target: view.target })) });

  const contract = validateStructure(structure, { evidenceIndex });
  if (contract.errors.length) throw new Error(`结构校验未通过：${contract.errors.join('；')}`);
  steps.push({ step: 7, name: '检查', errors: contract.errors.length, warnings: contract.warnings.length, relation_errors: relationErrors.length });
  steps.push({ step: 8, name: '输出图片', status: 'ready-for-render', structure_id: structure.id });
  return { structure, collected, evidenceIndex, steps, stats: { propositions: structure.propositions.length, relations: structure.relations.length, backbone: structure.backbone.length, views: structure.views.length, gaps: structure.gaps.length } };
}
