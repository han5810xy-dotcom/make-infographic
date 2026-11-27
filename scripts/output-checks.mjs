import { relationSemanticErrors } from './relations.mjs';
import { buildViews, viewConsistency } from './views.mjs';
import { finalizeStructure, validateProposition, validateRelation, validateStructure } from './knowledge-contract.mjs';
import { buildStructureSvg } from './render-structure.mjs';

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

function svgMap(structure) {
  return Object.fromEntries((structure.views || []).map((view) => [view.id, buildStructureSvg(structure, view)]));
}

export function checkOutput(structure, { evidenceIndex, svgByView = {} } = {}) {
  const findings = [];
  const add = (id, message, action, severity = 'error') => findings.push({ id, title: CHECKS.find(([key]) => key === id)?.[1] || id, message, action, severity });
  const byId = new Map(structure.propositions.map((item) => [item.id, item]));
  const propositionIds = new Set(byId.keys());
  for (const proposition of structure.propositions) {
    const errors = validateProposition(proposition, evidenceIndex);
    if (errors.length) add('evidence-nodes', errors.join('；'), '补上可核对的原句 evidence，或把这条命题移入 gaps。');
  }
  if (structure.coverage && structure.coverage.ratio < 0.9) {
    const declared = (structure.coverage.missing || []).every((key) => (structure.gaps || []).some((gap) => gap.why.includes(key)));
    add('evidence-nodes', `关键结论覆盖只有 ${(structure.coverage.ratio * 100).toFixed(1)}%。`, '补回遗漏的关键结论，或明确写入 gaps。', declared ? 'warning' : 'error');
  }
  for (const relation of structure.relations || []) {
    const errors = [...validateRelation(relation, propositionIds, evidenceIndex), ...relationSemanticErrors(relation, structure, evidenceIndex)];
    if (errors.length) add('evidence-edges', errors.join('；'), '补上讲述关系的原句，或删除这条边。');
    if (errors.some((error) => error.includes('方向'))) add('direction', errors.filter((error) => error.includes('方向')).join('；'), '按原句方向改 from/to，或把边移入 gaps。');
    if ((relation.kind === '因果' || relation.kind === '条件') && [byId.get(relation.from)?.layer, byId.get(relation.to)?.layer].includes('example')) add('example-layer', `${relation.id} 把例子和主结论连成了因果或条件。`, '改成支持／包含，或删除这条边。');
  }
  const connected = new Set((structure.relations || []).flatMap((relation) => [relation.from, relation.to]));
  for (const proposition of structure.propositions) {
    if (!connected.has(proposition.id) && !(structure.gaps || []).some((gap) => gap.why.includes(proposition.text))) add('no-dangling', `${proposition.id} 没有任何关系，也没有缺口说明。`, '建立有原句的关系，或在 gaps 中明确列出。', 'warning');
  }
  for (const relation of structure.relations || []) {
    const drawn = (structure.views || []).some((view) => view.props?.relationIds?.includes(relation.id));
    if (!drawn) add('no-isolated-relations', `${relation.id} 没有出现在任何视图里。`, '把边加入主图或分支细节图。');
  }
  const declaredParallel = !structure.backbone?.length && (structure.gaps || []).some((gap) => gap.missing === '并列清单，没有单一骨架');
  if (!declaredParallel && (structure.backbone?.length < 3 || structure.backbone?.length > 5)) add('backbone', `主干只有 ${structure.backbone?.length || 0} 条。`, '重算注意力权重，或明确输出并列清单。');
  for (const view of structure.views || []) {
    const limit = view.target === 'backbone' ? 7 : 12;
    if ((view.props?.propositionIds || []).length > limit) add('node-limit', `${view.id} 有 ${view.props.propositionIds.length} 个节点，超过 ${limit}。`, '拆成主图与分支细节图。');
  }
  const rendered = Object.keys(svgByView).length ? svgByView : svgMap(structure);
  for (const [viewId, svg] of Object.entries(rendered)) {
    const visibleText = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((match) => match[1].replace(/<[^>]+>/g, '')).join(' ');
    const leaked = (visibleText.match(/\b(?:units|relations|coverage|propositions|backbone|gaps)\b/gi) || [])
      .filter((word) => !structure.propositions.some((item) => String(item.text).toLowerCase().includes(word.toLowerCase())));
    if (leaked.length) add('no-internal-fields', `${viewId} 出现内部字段名：${[...new Set(leaked)].join('、')}。`, '改回读者能懂的说法。');
    const contentSvg = svg.replace(/<g data-(?:evidence|gaps)>[\s\S]*?<\/g>/g, '');
    if (/…|\.{3,}|。{3,}|等等/.test(contentSvg)) add('no-placeholders', `${viewId} 出现省略号或“等等”。`, '删掉占位内容，或拆图。');
    for (const gap of structure.gaps || []) {
      if (!svg.includes(gap.missing) || !svg.includes(gap.why)) add('gaps-visible', `${viewId} 没有完整呈现缺口：${gap.missing}。`, '在图上加虚线缺口框或脚注。', 'warning');
    }
  }
  for (const error of viewConsistency(structure)) add('multi-view', error, '按结构拓扑重新选图或补齐视图。');
  return findings;
}

export function degradeStructure(input, { evidenceIndex } = {}) {
  let structure = structuredClone(input);
  const actions = [];
  for (let round = 0; round < 3; round++) {
    const validNodes = [];
    for (const proposition of structure.propositions) {
      const errors = validateProposition(proposition, evidenceIndex);
      const placeholder = /…|\.{3,}|。{3,}|等等/.test(proposition.text);
      if (!errors.length && !placeholder) validNodes.push(proposition);
      else {
        structure.gaps.push({ missing: '一条命题未通过来源或表达检查，已移除', why: proposition.text });
        actions.push(`移除命题 ${proposition.id}`);
      }
    }
    const ids = new Set(validNodes.map((item) => item.id));
    structure.propositions = validNodes;
    const validEdges = [];
    for (const relation of structure.relations || []) {
      const errors = [...validateRelation(relation, ids, evidenceIndex), ...relationSemanticErrors(relation, structure, evidenceIndex)];
      if (!ids.has(relation.from) || !ids.has(relation.to) || errors.length) {
        structure.gaps.push({ missing: '一条关系未通过证据检查，已移除', why: errors.join('；') || '端点命题已被移除' });
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
    const findings = checkOutput(structure, { evidenceIndex, svgByView: svgMap(structure) });
    if (!findings.some((item) => item.severity === 'error')) return { structure, actions, findings, degraded: actions.length > 0 };
  }
  const findings = checkOutput(structure, { evidenceIndex, svgByView: svgMap(structure) });
  return { structure, actions, findings, degraded: true };
}
