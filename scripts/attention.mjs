import { visibleLen } from './knowledge-contract.mjs';

const compact = (value) => String(value ?? '').toLowerCase().replace(/[\s，。！？；：、,.!?;:"“”‘’'()（）《》〈〉「」『』\[\]—…]/g, '');
const QUESTION = /[？?]|为什么|怎么|如何|是否|能不能|难道|凭什么|凭什么|why|how|whether/i;
const CHALLENGE = /不是|不对|错了|矛盾|反对|不接受|不能|不要|为什么|怎么|wrong|incorrect|however|but/i;
const CORRECTION = /不是|不能|不等于|纠正|推翻|改口|错误|其实|相反|而非|wrong|incorrect|instead|rather than/i;
const CONCLUSION = /结论|因此|所以|正确|应该|必须|记住|核心|一句话|检验|判断|检查|不能只|conclusion|therefore|should|must|remember/i;

function evidenceSource(item, proposition, utterance, evidenceIndex) {
  if (!utterance) return -1;
  const text = String(utterance.text || '');
  const quoted = evidenceIndex?.get(item.quote_id)?.text || '';
  const direct = text.indexOf(quoted || proposition.text);
  if (direct >= 0) return direct;
  return text.length / 2;
}

function bigrams(value) {
  const chars = [...compact(value)];
  return chars.slice(0, -1).map((_, index) => chars[index] + chars[index + 1]);
}

function similarity(a, b) {
  const left = bigrams(a);
  const right = new Set(bigrams(b));
  if (!left.length && !right.size) return 1;
  if (!left.length || !right.size) return 0;
  return left.filter((gram) => right.has(gram)).length / left.length;
}

function normalize(values) {
  const max = Math.max(...values, 0);
  if (!max) return values.map(() => 0);
  return values.map((value) => value / max);
}

export function attentionSignals(structure, collected, evidenceIndex) {
  const propositions = structure.propositions || [];
  const utterances = collected.utterances || [];
  const repeatRaw = propositions.map((proposition) => {
    let count = 0;
    for (const other of propositions) {
      if (other.id === proposition.id) continue;
      if (similarity(proposition.text, other.text) >= 0.62) count++;
    }
    const quoteIds = new Set((proposition.evidence || []).map((item) => item.quote_id));
    for (const other of propositions) {
      if (other.id !== proposition.id && (other.evidence || []).some((item) => quoteIds.has(item.quote_id))) count++;
    }
    return count;
  });
  const followupRaw = propositions.map((proposition) => {
    const lastTurn = Math.max(...(proposition.evidence || []).map((item) => item.turn_index), -1);
    return utterances.filter((utterance) => utterance.speaker === 'user' && utterance.turn_index > lastTurn && utterance.turn_index <= lastTurn + 3 && QUESTION.test(utterance.text)).length;
  });
  const correctionRaw = propositions.map((proposition) => {
    const relationHit = (structure.relations || []).some((relation) => ['反驳', '转折'].includes(relation.kind) && (relation.to === proposition.id || relation.from === proposition.id));
    return relationHit || CORRECTION.test(proposition.text) ? 1 : 0;
  });
  const positionRaw = propositions.map((proposition) => {
    const evidence = proposition.evidence || [];
    let offset = 0.5;
    for (const item of evidence) {
      const utterance = utterances.find((entry) => entry.speaker === item.speaker && entry.turn_index === item.turn_index);
      const source = evidenceSource(item, proposition, utterance, evidenceIndex);
      if (utterance && source >= 0) offset = Math.min(offset, source / Math.max(1, utterance.text.length));
    }
    if (offset < 0.18 || offset > 0.82) return 1;
    return CONCLUSION.test(proposition.text) ? 1 : 0.2;
  });
  return {
    repeat: normalize(repeatRaw),
    followup: normalize(followupRaw),
    correction: normalize(correctionRaw),
    position: normalize(positionRaw),
  };
}

export function computeWeights(structure, collected, evidenceIndex) {
  const signals = attentionSignals(structure, collected, evidenceIndex);
  const weights = signals.repeat.map((_, index) => Math.round((
    0.25 + 0.75 * (
      signals.repeat[index] * 0.25
      + signals.followup[index] * 0.15
      + signals.correction[index] * 0.35
      + signals.position[index] * 0.25
    )
  ) * 1000) / 1000);
  return {
    weights,
    signals: Object.fromEntries(Object.entries(signals).map(([key, values]) => [key, values.map((value) => Math.round(value * 1000) / 1000)])),
    formula: '0.25 + 0.75*(0.25*重复度 + 0.15*追问度 + 0.35*纠正度 + 0.25*位置度)；位置度按原句在发言中的前后位置与结论线索计算（产品自定）',
  };
}

function connectedComponent(ids, relations) {
  const allowed = new Set(ids);
  const adjacency = new Map(ids.map((id) => [id, new Set()]));
  for (const relation of relations || []) {
    if (allowed.has(relation.from) && allowed.has(relation.to)) {
      adjacency.get(relation.from).add(relation.to);
      adjacency.get(relation.to).add(relation.from);
    }
  }
  let best = [];
  for (const id of ids) {
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length) {
      const current = queue.shift();
      for (const next of adjacency.get(current) || []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    if (seen.size > best.length) best = [...seen];
  }
  return best;
}

function orderBackbone(ids, relations) {
  const allowed = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  for (const relation of relations || []) {
    if (!allowed.has(relation.from) || !allowed.has(relation.to) || relation.kind === '对比') continue;
    indegree.set(relation.to, indegree.get(relation.to) + 1);
    outgoing.get(relation.from).push(relation.to);
  }
  const ready = ids.filter((id) => indegree.get(id) === 0);
  const ordered = [];
  while (ready.length) {
    const id = ready.shift();
    ordered.push(id);
    for (const next of outgoing.get(id) || []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  if (ordered.length === ids.length) return ordered;
  return ids;
}

export function selectBackbone(structure) {
  const candidates = structure.propositions
    .filter((proposition) => proposition.weight >= 0.7)
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
    .map((proposition) => proposition.id);
  if (candidates.length < 3) return { backbone: [], reason: '权重达到 0.7 的命题不足 3 条' };
  const component = connectedComponent(candidates, structure.relations);
  if (component.length < 3) return { backbone: [], reason: '高权重命题之间没有连成 3 条以上的明确关系' };
  const ordered = orderBackbone(candidates.filter((id) => component.includes(id)).slice(0, 5), structure.relations);
  const indegree = new Map(ordered.map((id) => [id, 0]));
  const outdegree = new Map(ordered.map((id) => [id, 0]));
  for (const relation of structure.relations || []) {
    if (indegree.has(relation.from) && indegree.has(relation.to)) {
      outdegree.set(relation.from, outdegree.get(relation.from) + 1);
      indegree.set(relation.to, indegree.get(relation.to) + 1);
    }
  }
  const hasResult = ordered.some((id) => outdegree.get(id) === 0);
  if (!hasResult) return { backbone: [], reason: '高权重子图没有终局结论，只有循环或并列' };
  return { backbone: ordered, reason: '' };
}

export function inferTopology(structure) {
  const propositions = structure.propositions || [];
  const relations = structure.relations || [];
  if (!relations.length) return 'forest';
  const adjacency = new Map(propositions.map((item) => [item.id, []]));
  for (const relation of relations) {
    if (!adjacency.has(relation.from) || !adjacency.has(relation.to)) continue;
    adjacency.get(relation.from).push(relation.to);
  }
  const visiting = new Set();
  const visited = new Set();
  let cycle = false;
  const visit = (id) => {
    if (visiting.has(id)) { cycle = true; return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of adjacency.get(id) || []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of adjacency.keys()) visit(id);
  if (cycle) return 'cycle';
  const component = connectedComponent(propositions.map((item) => item.id), relations);
  if (component.length < propositions.length) return 'forest';
  const kinds = relations.map((relation) => relation.kind);
  if (kinds.filter((kind) => kind === '对比').length >= Math.max(2, Math.ceil(relations.length / 2))) return 'matrix';
  if (kinds.filter((kind) => kind === '包含').length >= Math.ceil(relations.length / 2)) return 'tree';
  const indegree = new Map(propositions.map((item) => [item.id, 0]));
  const outdegree = new Map(propositions.map((item) => [item.id, 0]));
  for (const relation of relations) {
    indegree.set(relation.to, indegree.get(relation.to) + 1);
    outdegree.set(relation.from, outdegree.get(relation.from) + 1);
  }
  if ([...indegree.values()].every((value) => value <= 1) && [...outdegree.values()].every((value) => value <= 1)) return 'chain';
  return 'network';
}

export function buildFramework(structure, collected, evidenceIndex) {
  const next = structuredClone(structure);
  const useAuthored = next.weight_source === 'authored' && next.propositions.every((item) => Number.isFinite(item.weight));
  const computed = useAuthored
    ? { weights: next.propositions.map((item) => item.weight), signals: {}, formula: '作者按重复度、追问度、纠正度、位置度综合评定' }
    : computeWeights(next, collected, evidenceIndex);
  next.propositions = next.propositions.map((proposition, index) => ({ ...proposition, weight: computed.weights[index] }));
  next.attention = computed;
  const backbone = selectBackbone(next);
  next.backbone = backbone.backbone;
  const backboneIds = new Set(next.backbone);
  const backboneStructure = {
    ...next,
    propositions: next.propositions.filter((item) => backboneIds.has(item.id)),
    relations: (next.relations || []).filter((relation) => backboneIds.has(relation.from) && backboneIds.has(relation.to)),
  };
  next.topo = next.backbone.length ? inferTopology(backboneStructure) : inferTopology(next);
  next.gaps = [...(next.gaps || [])];
  const connected = new Set((next.relations || []).flatMap((relation) => [relation.from, relation.to]));
  for (const proposition of next.propositions) {
    if (connected.has(proposition.id) || next.backbone.includes(proposition.id)) continue;
    if (!next.gaps.some((gap) => gap.why.includes(proposition.text))) next.gaps.push({ missing: '有一条命题尚未建立明确关系', why: proposition.text });
  }
  if (!next.backbone.length) {
    if (!next.gaps.some((gap) => gap.missing === '并列清单，没有单一骨架')) next.gaps.push({ missing: '并列清单，没有单一骨架', why: backbone.reason });
    if (next.topo !== 'forest') next.topo = 'forest';
  }
  return next;
}
