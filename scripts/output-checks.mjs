import { relationSemanticErrors } from './relations.mjs';
import { buildViews, viewConsistency } from './views.mjs';
import { finalizeStructure, validateStructure } from './knowledge-contract.mjs';

const CHECKS = Object.freeze([
  ['evidence-nodes', '每个节点都有命题来源'],
  ['evidence-edges', '每条边都有 evidence'],
  ['no-dangling', '无悬空节点'],
  ['no-isolated-relations', '无孤立关系'],
  ['direction', '箭头方向与原文一致'],
  ['example-layer', '例子未与主结论连成因果'],
  ['backbone', '骨架 3~5 条或明确并列'],
  ['node-limit', '每图节点数不超限'],
  ['no-internal-fields', '无内部字段名'],
  ['no-placeholders', '无省略号与“等等”'],
  ['multi-view', '多图之间编号与措辞一致'],
  ['gaps-visible', '缺口清单显式呈现'],
]);

export function checkOutput(structure, { evidenceIndex, svgByView = {} } = {}) {
  const findings = [];
  const add = (id, message, action, severity = 'error') => findings.push({ id, title: CHECKS.find(([key]) => key === id)?.[1] || id, message, action, severity });
  const byId = new Map(structure.propositions.map((item) => [item.id, item]));
  for (const proposition of structure.propositions) {
    if (!proposition.evidence?.length) add('evidence-nodes', `${proposition.id} 没有来源。`, '补上原句 evidence，或把这条命题移入 gaps。');
  }
  for (const relation of structure.relations || []) {
    if (!relation.evidence?.length) add('evidence-edges', `${relation.id} 没有关系原句。`, '补上讲述关系的原句，或删除这条边。');
    const errors = relationSemanticErrors(relation, structure, evidenceIndex);
    if (errors.some((error) => error.includes('方向'))) add('direction', errors.join('；'), '按原句方向改 from/to，或把边移入 gaps。');
    if ((relation.kind === '因果' || relation.kind === '条件') && [byId.get(relation.from)?.kind, byId.get(relation.to)?.kind].includes('例子')) add('example-layer', `${relation.id} 把例子和主结论连成了因果或条件。`, '改成支持／包含，或删除这条边。');
  }
  const connected = new Set((structure.relations || []).flatMap((relation) => [relation.from, relation.to]));
  for (const proposition of structure.propositions) {
    if (!connected.has(proposition.id) && !(structure.gaps || []).some((gap) => gap.why.includes(proposition.text))) add('no-dangling', `${proposition.id} 没有任何关系，也没有缺口说明。`, '建立有原句的关系，或在 gaps 中明确列出。', 'warning');
  }
  for (const relation of structure.relations || []) {
    const drawn = (structure.views || []).some((view) => view.props?.relationIds?.includes(relation.id));
    if (!drawn) add('no-isolated-relations', `${relation.id} 没有出现在任何视图里。`, '把边加入主图或分支细节图。', 'warning');
  }
  const declaredParallel = !structure.backbone?.length && (structure.gaps || []).some((gap) => gap.missing === '并列清单，没有单一骨架');
  if (!declaredParallel && (structure.backbone?.length < 3 || structure.backbone?.length > 5)) add('backbone', `主干只有 ${structure.backbone?.length || 0} 条。`, '重算注意力权重，或明确输出并列清单。');
  for (const view of structure.views || []) {
    const limit = view.target === 'backbone' ? 7 : 12;
    if ((view.props?.propositionIds || []).length > limit) add('node-limit', `${view.id} 有 ${view.props.propositionIds.length} 个节点，超过 ${limit}。`, '拆成主图与分支细节图。');
  }
  for (const [viewId, svg] of Object.entries(svgByView)) {
    const leaked = (svg.match(/\b(?:units|relations|coverage|propositions|backbone|gaps)\b/gi) || [])
      .filter((word) => !structure.propositions.some((item) => String(item.text).toLowerCase().includes(word.toLowerCase())));
    if (leaked.length) add('no-internal-fields', `${viewId} 出现内部字段名：${[...new Set(leaked)].join('、')}。`, '改回读者能懂的说法。');
    if (/…|\.{3,}|。{3,}|等等/.test(svg)) add('no-placeholders', `${viewId} 出现省略号或“等等”。`, '删掉占位内容，或拆图。');
    if ((structure.gaps || []).length && !svg.includes('缺口')) add('gaps-visible', `${viewId} 没有呈现缺口清单。`, '在图上加虚线缺口框或脚注。', 'warning');
  }
  const texts = new Map(structure.propositions.map((item) => [item.id, item.text]));
  for (const view of structure.views || []) {
    for (const id of view.props?.propositionIds || []) if (!texts.has(id)) add('multi-view', `${view.id} 引用了不存在的命题 ${id}。`, '从视图移除该 id，或补回命题。');
  }
  for (const error of viewConsistency(structure)) add('multi-view', error, '按结构拓扑重新选图。');
  return findings;
}

export function degradeStructure(input, { evidenceIndex } = {}) {
  let structure = structuredClone(input);
  const actions = [];
  const validNodes = [];
  for (const proposition of structure.propositions) {
    if (proposition.evidence?.length) validNodes.push(proposition);
    else {
      structure.gaps.push({ missing: '一条命题缺少来源，未画入图中', why: proposition.text });
      actions.push(`移除无来源命题 ${proposition.id}`);
    }
  }
  const ids = new Set(validNodes.map((item) => item.id));
  structure.propositions = validNodes;
  const validEdges = [];
  for (const relation of structure.relations || []) {
    const errors = relationSemanticErrors(relation, structure, evidenceIndex);
    if (!ids.has(relation.from) || !ids.has(relation.to) || errors.length) {
      structure.gaps.push({ missing: '一条关系证据不足，未画入图中', why: errors.join('；') || '端点命题已被移除' });
      actions.push(`移除关系 ${relation.id}`);
    } else validEdges.push(relation);
  }
  structure.relations = validEdges;
  structure.backbone = (structure.backbone || []).filter((id) => ids.has(id));
  if ((structure.backbone.length < 3 || structure.backbone.length > 5) && !structure.gaps.some((gap) => gap.missing === '并列清单，没有单一骨架')) {
    structure.gaps.push({ missing: '并列清单，没有单一骨架', why: '主干不足 3 条或超过 5 条，改为并列视图。' });
    structure.backbone = [];
    structure.topo = 'forest';
    actions.push('改为并列视图');
  }
  structure.views = buildViews(structure, evidenceIndex);
  structure = finalizeStructure(structure);
  const contract = validateStructure(structure, { evidenceIndex });
  if (contract.errors.length) throw new Error(`降级后结构仍不合法：${contract.errors.join('；')}`);
  return { structure, actions, degraded: actions.length > 0 };
}
