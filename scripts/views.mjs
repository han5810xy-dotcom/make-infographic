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
  const propositionIdsAll = structure.propositions.map((item) => item.id);
  const relationById = new Map((structure.relations || []).map((item) => [item.id, item]));
  const evidenceFor = (ids) => Object.fromEntries(ids.map((id) => [id, (structure.propositions.find((item) => item.id === id)?.evidence || []).map((item) => ({
    text: evidenceIndex.get(item.quote_id)?.text || '',
    speaker: item.speaker,
    turn_index: item.turn_index,
    quote_id: item.quote_id,
  })).filter((item) => item.text)]));
  const addView = ({ target, graphic, propositionIds, title, layout = '' }) => {
    const unique = [...new Set(propositionIds)];
    if (!unique.length) return;
    const relationIds = (structure.relations || []).filter((relation) => unique.includes(relation.from) && unique.includes(relation.to)).map((relation) => relation.id);
    views.push({
      id: `v${views.length + 1}`,
      target,
      graphic,
      props: { propositionIds: unique, relationIds, evidence: evidenceFor(unique), headline: structure.headline || '', subhead: structure.subhead || '', ...(layout ? { layout } : {}), title },
    });
  };
  const chunk = (ids, size) => {
    const output = [];
    for (let index = 0; index < ids.length; index += size) output.push(ids.slice(index, index + size));
    return output;
  };

  if (!structure.backbone?.length) {
    for (const group of components(structure)) {
      for (const propositionIds of chunk(group, 7)) addView({ target: 'backbone', graphic: 'tree', propositionIds, title: `${structure.topic}·并列结构` });
    }
  } else {
    for (const propositionIds of chunk(structure.backbone, 7)) addView({ target: 'backbone', graphic: graphicForTopology(structure.topo), propositionIds, title: `${structure.topic}·主图` });
  }

  const branches = new Map();
  for (const proposition of structure.propositions) {
    if (structure.backbone?.includes(proposition.id)) continue;
    const root = nearestBackbone(structure, proposition.id);
    if (!root) continue;
    if (!branches.has(root)) branches.set(root, []);
    branches.get(root).push(proposition.id);
  }
  for (const [root, descendants] of branches) {
    for (const group of chunk(descendants, 11)) addView({ target: `branch:${root}`, graphic: graphicForTopology(structure.topo), propositionIds: [root, ...group], title: `${structure.topic}·分支细节` });
  }

  if (structure.overview && structure.backbone?.length && structure.propositions.length <= 12) {
    addView({ target: `branch:${structure.backbone[0]}`, graphic: 'network', propositionIds: propositionIdsAll, title: `${structure.topic}·知识总览`, layout: 'atlas' });
  }

  const coveredNodes = new Set(views.flatMap((view) => view.props.propositionIds));
  for (const id of propositionIdsAll) {
    if (coveredNodes.has(id)) continue;
    addView({ target: `branch:${id}`, graphic: graphicForTopology(structure.topo), propositionIds: [id], title: `${structure.topic}·独立命题` });
    coveredNodes.add(id);
  }

  const coveredRelations = new Set(views.flatMap((view) => view.props.relationIds));
  for (const relation of structure.relations || []) {
    if (coveredRelations.has(relation.id)) continue;
    addView({ target: `branch:${relation.from}`, graphic: graphicForTopology(structure.topo), propositionIds: [relation.from, relation.to], title: `${structure.topic}·关系细节` });
    coveredRelations.add(relation.id);
  }
  return views;
}

export function viewConsistency(structure) {
  const errors = [];
  const byId = new Map(structure.propositions.map((item) => [item.id, item]));
  const relationById = new Map((structure.relations || []).map((item) => [item.id, item]));
  const coveredNodes = new Set();
  const coveredRelations = new Set();
  for (const view of structure.views || []) {
    if (!GRAPHICS.includes(view.graphic)) errors.push(`${view.id}：图种不合法`);
    const expected = graphicForTopology(structure.topo);
    if (view.graphic !== expected && !(structure.topo === 'forest' && view.graphic === 'tree') && view.graphic !== 'turn-band' && view.props?.layout !== 'atlas') errors.push(`${view.id}：图种 ${view.graphic} 与拓扑 ${structure.topo} 不一致`);
    for (const id of view.props?.propositionIds || []) {
      if (!byId.has(id)) errors.push(`${view.id}：引用不存在的命题 ${id}`);
      coveredNodes.add(id);
    }
    for (const id of view.props?.relationIds || []) {
      const relation = relationById.get(id);
      if (!relation) errors.push(`${view.id}：引用不存在的关系 ${id}`);
      else {
        if (!view.props.propositionIds.includes(relation.from) || !view.props.propositionIds.includes(relation.to)) errors.push(`${view.id}：关系 ${id} 的端点不在图中`);
        coveredRelations.add(id);
      }
    }
  }
  for (const id of byId.keys()) if (!coveredNodes.has(id)) errors.push(`命题 ${id} 没有出现在任何视图里`);
  for (const id of relationById.keys()) if (!coveredRelations.has(id)) errors.push(`关系 ${id} 没有出现在任何视图里`);
  return errors;
}
