import { GRAPHICS } from './knowledge-contract.mjs';

export const TOPO_GRAPHIC = Object.freeze({
  chain: 'flow',
  tree: 'tree',
  matrix: 'matrix',
  network: 'network',
  cycle: 'network',
  forest: 'tree',
});

export function graphicForTopology(topo) {
  return TOPO_GRAPHIC[topo] || 'network';
}

function components(structure) {
  const ids = structure.propositions.map((item) => item.id);
  const adjacency = new Map(ids.map((id) => [id, new Set()]));
  for (const relation of structure.relations || []) {
    if (!adjacency.has(relation.from) || !adjacency.has(relation.to)) continue;
    adjacency.get(relation.from).add(relation.to);
    adjacency.get(relation.to).add(relation.from);
  }
  const seen = new Set();
  const output = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const group = [];
    const queue = [id];
    seen.add(id);
    while (queue.length) {
      const current = queue.shift();
      group.push(current);
      for (const next of adjacency.get(current) || []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    output.push(group);
  }
  return output;
}

function nearestBackbone(structure, start) {
  const backbone = new Set(structure.backbone || []);
  if (backbone.has(start)) return start;
  const adjacency = new Map(structure.propositions.map((item) => [item.id, []]));
  for (const relation of structure.relations || []) {
    if (!adjacency.has(relation.from) || !adjacency.has(relation.to)) continue;
    adjacency.get(relation.from).push(relation.to);
    adjacency.get(relation.to).push(relation.from);
  }
  const queue = [[start, null]];
  const seen = new Set([start]);
  while (queue.length) {
    const [id, parent] = queue.shift();
    if (backbone.has(id)) return id;
    for (const next of adjacency.get(id) || []) {
      if (!seen.has(next)) { seen.add(next); queue.push([next, parent || id]); }
    }
  }
  return null;
}

export function buildViews(structure, evidenceIndex = new Map()) {
  const views = [];
  const backbone = structure.backbone?.length ? structure.backbone : structure.propositions.map((item) => item.id);
  const mainChunks = [];
  for (let index = 0; index < backbone.length; index += 7) mainChunks.push(backbone.slice(index, index + 7));
  for (const propositionIds of mainChunks) {
    const relationIds = (structure.relations || []).filter((relation) => propositionIds.includes(relation.from) && propositionIds.includes(relation.to)).map((relation) => relation.id);
    views.push({
      id: `v${views.length + 1}`,
      target: 'backbone',
      graphic: graphicForTopology(structure.topo),
      props: { propositionIds, relationIds, evidence: Object.fromEntries(propositionIds.map((id) => [id, (structure.propositions.find((item) => item.id === id)?.evidence || []).map((item) => evidenceIndex.get(item.quote_id)?.text || '').filter(Boolean)])), headline: structure.headline || '', subhead: structure.subhead || '', title: structure.topo === 'forest' ? `${structure.topic}·并列结构` : `${structure.topic}·主图` },
    });
  }
  if (structure.topo === 'forest') {
    for (const group of components(structure)) {
      if (group.length <= 1 || views.some((view) => group.every((id) => view.props.propositionIds.includes(id)))) continue;
      const relationIds = (structure.relations || []).filter((relation) => group.includes(relation.from) && group.includes(relation.to)).map((relation) => relation.id);
      views.push({ id: `v${views.length + 1}`, target: 'backbone', graphic: 'tree', props: { propositionIds: group, relationIds, evidence: Object.fromEntries(group.map((id) => [id, (structure.propositions.find((item) => item.id === id)?.evidence || []).map((item) => evidenceIndex.get(item.quote_id)?.text || '').filter(Boolean)])), headline: structure.headline || '', subhead: structure.subhead || '', title: `${structure.topic}·分支` } });
    }
  }
  const branches = new Map();
  for (const proposition of structure.propositions) {
    if (structure.backbone?.includes(proposition.id)) continue;
    const root = nearestBackbone(structure, proposition.id);
    if (!root) continue;
    if (!branches.has(root)) branches.set(root, []);
    branches.get(root).push(proposition.id);
  }
  for (const [root, propositionIds] of branches) {
    const unique = [...new Set([root, ...propositionIds])].slice(0, 12);
    const relationIds = (structure.relations || []).filter((relation) => unique.includes(relation.from) && unique.includes(relation.to)).map((relation) => relation.id);
    views.push({ id: `v${views.length + 1}`, target: `branch:${root}`, graphic: graphicForTopology(structure.topo), props: { propositionIds: unique, relationIds, evidence: Object.fromEntries(unique.map((id) => [id, (structure.propositions.find((item) => item.id === id)?.evidence || []).map((item) => evidenceIndex.get(item.quote_id)?.text || '').filter(Boolean)])), headline: structure.headline || '', subhead: structure.subhead || '', title: `${structure.topic}·分支细节` } });
  }
  const backboneSet = new Set(structure.backbone || []);
  if (structure.overview && structure.backbone?.length && structure.propositions.length <= 12) {
    const propositionIds = structure.propositions.map((item) => item.id);
    const relationIds = (structure.relations || []).map((item) => item.id);
    views.push({ id: `v${views.length + 1}`, target: `branch:${structure.backbone[0]}`, graphic: 'network', props: { propositionIds, relationIds, evidence: Object.fromEntries(propositionIds.map((id) => [id, (structure.propositions.find((item) => item.id === id)?.evidence || []).map((item) => evidenceIndex.get(item.quote_id)?.text || '').filter(Boolean)])), headline: structure.headline || '', subhead: structure.subhead || '', layout: 'atlas', title: `${structure.topic}·知识总览` } });
  }
  for (const group of components(structure)) {
    if (group.length < 2 || group.some((id) => backboneSet.has(id))) continue;
    if (views.some((view) => group.every((id) => view.props.propositionIds.includes(id)))) continue;
    const relationIds = (structure.relations || []).filter((relation) => group.includes(relation.from) && group.includes(relation.to)).map((relation) => relation.id);
    views.push({ id: `v${views.length + 1}`, target: `branch:${group[0]}`, graphic: graphicForTopology(structure.topo), props: { propositionIds: group, relationIds, evidence: Object.fromEntries(group.map((id) => [id, (structure.propositions.find((item) => item.id === id)?.evidence || []).map((item) => evidenceIndex.get(item.quote_id)?.text || '').filter(Boolean)])), headline: structure.headline || '', subhead: structure.subhead || '', title: `${structure.topic}·旁支细节` } });
  }
  return views;
}

export function viewConsistency(structure) {
  const errors = [];
  const byId = new Map(structure.propositions.map((item) => [item.id, item]));
  for (const view of structure.views || []) {
    if (!GRAPHICS.includes(view.graphic)) errors.push(`${view.id}：图种不合法`);
    const expected = graphicForTopology(structure.topo);
    if (view.graphic !== expected && !(structure.topo === 'forest' && view.graphic === 'tree') && view.graphic !== 'turn-band' && view.props?.layout !== 'atlas') errors.push(`${view.id}：图种 ${view.graphic} 与拓扑 ${structure.topo} 不一致`);
    for (const id of view.props?.propositionIds || []) {
      if (!byId.has(id)) errors.push(`${view.id}：引用不存在的命题 ${id}`);
    }
  }
  return errors;
}
