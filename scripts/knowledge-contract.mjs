import { createHash } from 'node:crypto';
import { stableQuoteId } from './contract.mjs';

export const PROPOSITION_KINDS = Object.freeze(['定义', '主张', '因果', '条件', '对比', '步骤', '例子', '例外', '数据']);
export const RELATION_KINDS = Object.freeze(['因果', '递进', '对比', '条件', '转折', '包含', '支持', '反驳']);
export const TOPOLOGIES = Object.freeze(['chain', 'tree', 'matrix', 'network', 'cycle', 'forest']);
export const GRAPHICS = Object.freeze(['flow', 'tree', 'matrix', 'network', 'timeline', 'pyramid', 'turn-band']);
export const PROVENANCE = Object.freeze(['quote', 'summary', 'inferred']);
export const LAYERS = Object.freeze(['main', 'branch', 'example', 'background']);
export const VIEW_TARGETS = Object.freeze(['backbone', 'branch']);

const compact = (value) => String(value ?? '').toLowerCase().replace(/[\s，。！？；：、,.!?;:"“”‘’'()（）《》〈〉「」『』\[\]—…]/g, '');
export const visibleLen = (value) => [...String(value ?? '').replace(/\s/g, '')].length;
export const sha256 = (value) => createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');

export function stablePropositionId(proposition, index = 0) {
  const material = [proposition.kind, proposition.layer, proposition.provenance, proposition.text, ...(proposition.evidence || []).map((item) => item.quote_id)].join('\u0000');
  return `p${index + 1}_${sha256(material).slice(0, 8)}`;
}

export function stableRelationId(relation, index = 0) {
  const material = [relation.from, relation.to, relation.kind, relation.strength, ...(relation.evidence || []).map((item) => item.quote_id)].join('\u0000');
  return `r${index + 1}_${sha256(material).slice(0, 8)}`;
}

export function structureId(structure) {
  const material = JSON.stringify({
    topic: structure.topic,
    headline: structure.headline || '',
    subhead: structure.subhead || '',
    authoring_mode: structure.authoring_mode || '',
    propositions: (structure.propositions || []).map((item) => ({
      id: item.id,
      kind: item.kind,
      layer: item.layer || 'main',
      text: item.text,
      evidence: (item.evidence || []).map((evidence) => [evidence.quote_id, evidence.speaker, evidence.turn_index, evidence.verbatim]),
      weight: item.weight,
      provenance: item.provenance,
    })),
    relations: (structure.relations || []).map((item) => ({
      id: item.id,
      from: item.from,
      to: item.to,
      kind: item.kind,
      evidence: (item.evidence || []).map((evidence) => [evidence.quote_id, evidence.verbatim]),
      strength: item.strength,
    })),
    topo: structure.topo,
    backbone: structure.backbone || [],
    gaps: structure.gaps || [],
    views: structure.views || [],
  });
  return `s_${sha256(material).slice(0, 16)}`;
}

export function evidenceIndexFromCollected(collected) {
  const index = new Map();
  for (const item of collected.evidence || []) {
    index.set(item.quote_id, {
      quote_id: item.quote_id,
      speaker: item.speaker,
      turn_index: item.turn_index,
      text: item.text,
      display: item.display || item.text,
      source_text: item.text,
    });
  }
  for (const utterance of collected.utterances || []) {
    if (!index.has(utterance.quote_id)) {
      index.set(utterance.quote_id, { ...utterance, text: utterance.text, display: utterance.text });
    }
  }
  return index;
}

function validEvidence(item, index) {
  if (!item || typeof item.quote_id !== 'string' || !item.quote_id) return 'evidence 缺少 quote_id';
  if (!['user', 'assistant'].includes(item.speaker)) return 'evidence.speaker 只能是 user 或 assistant';
  if (!Number.isInteger(item.turn_index) || item.turn_index < 0) return 'evidence.turn_index 必须是非负整数';
  if (typeof item.verbatim !== 'boolean') return 'evidence.verbatim 必须是布尔值';
  if (index && !index.has(item.quote_id)) return `evidence 找不到原句：${item.quote_id}`;
  if (index) {
    const source = index.get(item.quote_id);
    if (source.speaker !== item.speaker || source.turn_index !== item.turn_index) return `evidence 的发言者或轮次对不上：${item.quote_id}`;
    if (source.text !== undefined) {
      const expected = stableQuoteId({ speaker: item.speaker, turnIndex: item.turn_index, text: source.text });
      if (expected !== item.quote_id) return `evidence 的 quote_id 与原句哈希不一致：${item.quote_id}`;
    }
    if (source.source_text !== undefined && !source.source_text.includes(source.text)) return `evidence 原句不在当前来源中：${item.quote_id}`;
  }
  return '';
}

export function validateProposition(proposition, index) {
  const errors = [];
  if (!proposition || typeof proposition !== 'object') return ['命题不是对象'];
  if (!/^p\d+(?:_[a-f0-9]{8})?$/.test(proposition.id || '')) errors.push(`${proposition.id || '未编号'}：id 必须形如 p1 或 p1_abcd1234`);
  if (!PROPOSITION_KINDS.includes(proposition.kind)) errors.push(`${proposition.id}：kind 不在允许列表内`);
  if (!proposition.text || visibleLen(proposition.text) > 60) errors.push(`${proposition.id}：命题为空或超过 60 字`);
  if (!Array.isArray(proposition.evidence) || !proposition.evidence.length) errors.push(`${proposition.id}：没有 evidence`);
  if (Array.isArray(proposition.evidence) && proposition.evidence.length > 2) errors.push(`${proposition.id}：evidence 最多两条`);
  for (const item of proposition.evidence || []) {
    const error = validEvidence(item, index);
    if (error) errors.push(`${proposition.id}：${error}`);
  }
  if (!Number.isFinite(proposition.weight) || proposition.weight < 0 || proposition.weight > 1) errors.push(`${proposition.id}：weight 必须在 0~1`);
  if (!PROVENANCE.includes(proposition.provenance)) errors.push(`${proposition.id}：provenance 只能是 quote、summary 或 inferred`);
  if (!LAYERS.includes(proposition.layer)) errors.push(`${proposition.id}：layer 必须是 main、branch、example 或 background`);
  if (proposition.provenance === 'quote') {
    const exact = (proposition.evidence || []).some((item) => item.verbatim === true && index?.get(item.quote_id)?.text?.includes(proposition.text));
    if (!exact) errors.push(`${proposition.id}：标为 quote，但命题文字不是 evidence 原句的逐字片段`);
  }
  return errors;
}

function validRelationEvidence(item, index) {
  if (!item || typeof item.quote_id !== 'string' || !item.quote_id) return '关系 evidence 缺少 quote_id';
  if (item.verbatim !== true) return '关系 evidence 必须逐字引用原句';
  if (index && !index.has(item.quote_id)) return `关系 evidence 找不到原句：${item.quote_id}`;
  if (index) {
    const source = index.get(item.quote_id);
    if (source.text !== undefined) {
      const expected = stableQuoteId({ speaker: source.speaker, turnIndex: source.turn_index, text: source.text });
      if (expected !== item.quote_id) return `关系 evidence 的 quote_id 与原句哈希不一致：${item.quote_id}`;
    }
    if (source.source_text !== undefined && !source.source_text.includes(source.text)) return `关系 evidence 原句不在当前来源中：${item.quote_id}`;
  }
  return '';
}

export function validateRelation(relation, propositionIds, index) {
  const errors = [];
  if (!relation || typeof relation !== 'object') return ['关系不是对象'];
  if (!/^r\d+(?:_[a-f0-9]{8})?$/.test(relation.id || '')) errors.push(`${relation.id || '未编号'}：id 必须形如 r1 或 r1_abcd1234`);
  if (!propositionIds.has(relation.from)) errors.push(`${relation.id}：起点 ${relation.from} 不存在`);
  if (!propositionIds.has(relation.to)) errors.push(`${relation.id}：终点 ${relation.to} 不存在`);
  if (relation.from === relation.to) errors.push(`${relation.id}：不能连接自身`);
  if (!RELATION_KINDS.includes(relation.kind)) errors.push(`${relation.id}：关系种类不在允许列表内`);
  if (!Array.isArray(relation.evidence) || !relation.evidence.length) errors.push(`${relation.id}：没有讲述关系的原句`);
  for (const item of relation.evidence || []) {
    const error = validRelationEvidence(item, index);
    if (error) errors.push(`${relation.id}：${error}`);
  }
  if (!Number.isFinite(relation.strength) || relation.strength < 0 || relation.strength > 1) errors.push(`${relation.id}：strength 必须在 0~1`);
  return errors;
}

export function validateView(view, structure) {
  const errors = [];
  if (!view || typeof view !== 'object') return ['视图不是对象'];
  if (!view.id || typeof view.id !== 'string') errors.push('视图缺少 id');
  if (!view.props || typeof view.props !== 'object' || Array.isArray(view.props)) errors.push(`${view.id}：props 必须是对象`);
  const propositionIds = view.props?.propositionIds || [];
  if (!propositionIds.length) errors.push(`${view.id}：没有命题`);
  for (const id of propositionIds) {
    if (!structure.propositions.some((item) => item.id === id)) errors.push(`${view.id}：引用不存在的命题 ${id}`);
  }
  if (view.target === 'backbone') {
    if (propositionIds.length > 7) errors.push(`${view.id}：主图超过 7 个节点`);
  } else if (typeof view.target === 'string' && view.target.startsWith('branch:')) {
    const root = view.target.slice(7);
    if (!structure.propositions.some((item) => item.id === root)) errors.push(`${view.id}：分支根 ${root} 不存在`);
    if (propositionIds.length > 12) errors.push(`${view.id}：细节图超过 12 个节点`);
  } else errors.push(`${view.id}：target 必须是 backbone 或 branch:pX`);
  const relationIds = new Set((structure.relations || []).map((item) => item.id));
  for (const id of view.props?.relationIds || []) {
    const relation = structure.relations.find((item) => item.id === id);
    if (!relationIds.has(id)) errors.push(`${view.id}：引用不存在的关系 ${id}`);
    else if (!propositionIds.includes(relation.from) || !propositionIds.includes(relation.to)) errors.push(`${view.id}：关系 ${id} 的端点不在图中`);
  }
  if (!GRAPHICS.includes(view.graphic)) errors.push(`${view.id}：graphic 不在允许列表内`);
  return errors;
}

export function validateStructure(structure, { evidenceIndex, stage = 'all' } = {}) {
  const errors = [];
  const warnings = [];
  if (!structure || typeof structure !== 'object') return { errors: ['Structure 不是对象'], warnings };
  if (!structure.topic || visibleLen(structure.topic) > 60) errors.push('topic 为空或超过 60 字');
  if (!Array.isArray(structure.propositions) || !structure.propositions.length) errors.push('propositions 为空');
  if (!Array.isArray(structure.propositions) || structure.propositions.length > 30) errors.push('命题超过 30 条，请按主题拆分');
  if (!Array.isArray(structure.relations)) errors.push('relations 必须是数组');
  if (!TOPOLOGIES.includes(structure.topo)) errors.push('topo 不在允许列表内');
  if (!Array.isArray(structure.gaps)) errors.push('gaps 必须是数组');

  const propositionIds = new Set();
  const normalizedTexts = new Set();
  for (const proposition of structure.propositions || []) {
    errors.push(...validateProposition(proposition, evidenceIndex));
    if (propositionIds.has(proposition.id)) errors.push(`命题 id 重复：${proposition.id}`);
    propositionIds.add(proposition.id);
    const key = compact(proposition.text);
    if (normalizedTexts.has(key)) errors.push(`命题重复：${proposition.id}`);
    normalizedTexts.add(key);
  }

  const relationIds = new Set();
  const relationKeys = new Set();
  for (const relation of structure.relations || []) {
    errors.push(...validateRelation(relation, propositionIds, evidenceIndex));
    if (relationIds.has(relation.id)) errors.push(`关系 id 重复：${relation.id}`);
    relationIds.add(relation.id);
    const key = `${relation.from}|${relation.to}|${relation.kind}`;
    if (relationKeys.has(key)) errors.push(`关系重复：${relation.id}`);
    relationKeys.add(key);
  }

  if (!Array.isArray(structure.backbone)) errors.push('backbone 必须是数组');
  if (Array.isArray(structure.backbone)) {
    if (stage !== 'm1' && (structure.backbone.length < 3 || structure.backbone.length > 5)) {
      const declaredParallel = structure.backbone.length === 0 && structure.gaps?.some((gap) => gap.missing === '并列清单，没有单一骨架');
      if (!declaredParallel) errors.push('backbone 必须含 3~5 条命题；并列清单必须显式写入 gaps');
    }
    for (const id of structure.backbone) if (!propositionIds.has(id)) errors.push(`backbone 指向不存在的命题：${id}`);
    if (new Set(structure.backbone).size !== structure.backbone.length) errors.push('backbone 有重复命题');
  }

  for (const gap of structure.gaps || []) {
    if (!gap || typeof gap.missing !== 'string' || typeof gap.why !== 'string') errors.push('每个 gap 都必须写 missing 和 why');
  }

  const connected = new Set();
  for (const relation of structure.relations || []) {
    connected.add(relation.from);
    connected.add(relation.to);
  }
  for (const proposition of structure.propositions || []) {
    if (!connected.has(proposition.id)) warnings.push(`${proposition.id} 当前没有关系，出图时需要作为缺口或并列项显式处理`);
  }

  if (Array.isArray(structure.views)) {
    const viewIds = new Set();
    for (const view of structure.views) {
      errors.push(...validateView(view, structure));
      if (viewIds.has(view.id)) errors.push(`视图 id 重复：${view.id}`);
      viewIds.add(view.id);
    }
  }

  const expectedId = structureId(structure);
  if (structure.id !== expectedId) errors.push(`structure.id 必须是内容哈希 ${expectedId}`);
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function finalizeStructure(input) {
  const structure = structuredClone(input);
  const ordered = [...structure.propositions].sort((a, b) => {
    const ai = Math.min(...(a.evidence || []).map((item) => item.turn_index), Number.MAX_SAFE_INTEGER);
    const bi = Math.min(...(b.evidence || []).map((item) => item.turn_index), Number.MAX_SAFE_INTEGER);
    return ai - bi || (a.evidence?.[0]?.quote_id || '').localeCompare(b.evidence?.[0]?.quote_id || '') || a.text.localeCompare(b.text);
  });
  const idMap = new Map();
  structure.propositions = ordered.map((proposition, index) => {
    const id = stablePropositionId(proposition, index);
    idMap.set(proposition.id, id);
    return { ...proposition, id };
  });
  const relationIdMap = new Map();
  structure.relations = (structure.relations || []).map((relation, index) => {
    const from = idMap.get(relation.from) || relation.from;
    const to = idMap.get(relation.to) || relation.to;
    const id = stableRelationId({ ...relation, from, to }, index);
    relationIdMap.set(relation.id, id);
    return { ...relation, id, from, to };
  });
  structure.backbone = (structure.backbone || []).map((id) => idMap.get(id) || id);
  if (Array.isArray(structure.views)) {
    for (const view of structure.views) {
      if (Array.isArray(view.props?.propositionIds)) view.props.propositionIds = view.props.propositionIds.map((id) => idMap.get(id) || id);
      if (Array.isArray(view.props?.relationIds)) view.props.relationIds = view.props.relationIds.map((id) => relationIdMap.get(id) || id);
      if (view.props?.evidence && typeof view.props.evidence === 'object') {
        view.props.evidence = Object.fromEntries(Object.entries(view.props.evidence).map(([id, value]) => [idMap.get(id) || id, value]));
      }
      if (typeof view.target === 'string' && view.target.startsWith('branch:')) {
        view.target = `branch:${idMap.get(view.target.slice(7)) || view.target.slice(7)}`;
      }
    }
  }
  structure.id = structureId(structure);
  return structure;
}
