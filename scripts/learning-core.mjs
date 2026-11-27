import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { withFileLock, writeAtomic } from './safeio.mjs';
import { sha256, stableConceptId } from './knowledge-contract.mjs';

export const LEARNING_SCHEMA = 'learning.v1';
export const ROUTES = Object.freeze(['recall', 'explain', 'apply', 'transfer']);
export const SELF_REPORTS = Object.freeze(['without_looking', 'with_hint', 'unsure', 'needs_review']);
export const INTERVALS_DAYS = Object.freeze([1, 3, 7, 21, 60]);
const DAY = 24 * 60 * 60 * 1000;
const dirs = (workspace) => {
  const root = resolve(workspace);
  return { root, knowledge: join(root, '.knowledge'), structures: join(root, '.knowledge', 'structures') };
};
const registryPath = (workspace) => join(dirs(workspace).knowledge, 'learning-registry.json');
const eventsPath = (workspace) => join(dirs(workspace).knowledge, 'learning-events.jsonl');
const aliasPath = (workspace) => join(dirs(workspace).knowledge, 'concept-aliases.json');
const lockPath = (workspace) => join(dirs(workspace).knowledge, 'learning.lock');

const compact = (value) => String(value ?? '').toLowerCase().replace(/[\s，。！？；：、,.!?;:"“”‘’'()（）《》〈〉「」『』\[\]—…]/g, '');
const cueOf = (proposition) => Number.isInteger(proposition.evidence?.[0]?.turn_index) ? `第 ${proposition.evidence[0].turn_index + 1} 轮` : '这条判断';
const resolveAlias = (id, aliases) => {
  const seen = new Set();
  let current = id;
  while (aliases[current] && !seen.has(current)) { seen.add(current); current = aliases[current]; }
  return current;
};

export function probeFor(concept, route = 'recall', structure = null) {
  if (!ROUTES.includes(route)) throw new Error(`route 只接受 ${ROUTES.join(' / ')}。`);
  const cue = concept.cue || cueOf(concept.text);
  const prompts = {
    recall: `不看资料，回到「${concept.topic}」的${cue}。当时关于${concept.kind}，对话得出了什么判断？`,
    explain: `不看资料，回到「${concept.topic}」的${cue}，用自己的话解释当时的${concept.kind}。它为什么成立？什么情况下会失效？`,
    apply: `把「${concept.topic}」的${cue}中用到的判断，搬到一个你真实遇到的新情境。你会怎么判断，为什么？`,
    transfer: `换一个完全不同领域，为「${concept.topic}」的${cue}构造一个对应例子；指出哪里能照搬，哪里不能照搬。`,
  };
  const question = concept.probe_questions?.[route] || prompts[route];
  const material = JSON.stringify({ concept_id: concept.concept_id, route, text: concept.text, structure_id: structure?.id || concept.sources?.[0]?.structure_id || '' });
  return { prompt_id: `l_${sha256(material).slice(0, 16)}`, route, question, cue, instruction: '先写自己的话，再揭示原对话证据。系统不自动判分。' };
}

export function buildRegistry(structures, aliases = {}, evidenceByStructure = new Map()) {
  const concepts = new Map();
  const documents = new Map();
  const addConcept = (id) => {
    if (!concepts.has(id)) concepts.set(id, { concept_id: id, text: '', topic: '', kind: '', cue: '', sources: [], relations: [], probe_questions: {} });
    return concepts.get(id);
  };
  for (const structure of structures || []) {
    const documentId = structure.source_hash || structure.id;
    documents.set(documentId, { document_id: documentId, structure_id: structure.id, topic: structure.topic, headline: structure.headline || '', source_file: structure.source_file || '' });
    const normalized = (structure.propositions || []).map((item) => ({ ...item, concept_id: item.concept_id || stableConceptId(item) }));
    const byId = new Map(normalized.map((item) => [item.id, item]));
    for (const proposition of normalized) {
      const originalId = proposition.concept_id;
      const conceptId = resolveAlias(originalId, aliases);
      const concept = addConcept(conceptId);
      if (!concept.text) {
        concept.text = proposition.text;
        concept.topic = structure.topic;
        concept.kind = proposition.kind;
        concept.cue = cueOf(proposition);
        concept.probe_questions = proposition.probe_questions || {};
      }
      concept.sources.push({
        structure_id: structure.id,
        proposition_id: proposition.id,
        document_id: documentId,
        source_hash: structure.source_hash || '',
        provenance: proposition.provenance,
        layer: proposition.layer,
        evidence: proposition.evidence || [],
        evidence_text: (proposition.evidence || []).map((item) => evidenceByStructure.get(structure.id)?.[item.quote_id]?.text || '').filter(Boolean),
      });
    }
    for (const relation of structure.relations || []) {
      const from = byId.get(relation.from);
      const to = byId.get(relation.to);
      if (!from || !to) continue;
      const fromId = resolveAlias(from.concept_id, aliases);
      const toId = resolveAlias(to.concept_id, aliases);
      if (fromId === toId) continue;
      addConcept(fromId);
      addConcept(toId);
      const target = concepts.get(fromId);
      const key = `${toId}|${relation.kind}|${structure.id}`;
      if (!target.relations.some((item) => item.key === key)) target.relations.push({ key, to: toId, kind: relation.kind, strength: relation.strength, structure_id: structure.id, evidence: relation.evidence || [] });
    }
  }
  return {
    schema_version: LEARNING_SCHEMA,
    generated_at: new Date().toISOString(),
    documents: [...documents.values()],
    concepts: [...concepts.values()].sort((a, b) => a.topic.localeCompare(b.topic, 'zh-CN') || a.concept_id.localeCompare(b.concept_id)),
  };
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`读不懂 ${path}；文件已保留，没有覆盖。`); }
}

export function validateAliases(data) {
  for (const [from, to] of Object.entries(data)) if (!/^c_[a-f0-9]{16}$/.test(from) || !/^c_[a-f0-9]{16}$/.test(to) || from === to) throw new Error('concept-aliases.json 含非法映射。');
  for (const id of Object.keys(data)) {
    const seen = new Set();
    let current = id;
    while (data[current]) {
      if (seen.has(current)) throw new Error('concept-aliases.json 含循环映射。');
      seen.add(current);
      current = data[current];
    }
  }
  return data;
}

export async function readAliases(workspace) {
  return validateAliases(await readJson(aliasPath(workspace), {}));
}

export async function syncLearning(workspace) {
  const { structures } = dirs(workspace);
  await mkdir(structures, { recursive: true });
  const records = [];
  for (const dir of [structures, join(resolve(workspace), 'infographics')]) {
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names.filter((item) => item.endsWith('.json') && !item.endsWith('.evidence.json')).sort()) {
      try {
        const data = JSON.parse(await readFile(join(dir, name), 'utf8'));
        if (!/^s_[a-f0-9]{16}$/.test(data.id || '') || !Array.isArray(data.propositions)) continue;
        const stem = name.slice(0, -5);
        let evidence = {};
        try { evidence = JSON.parse(await readFile(join(dir, `${stem}.evidence.json`), 'utf8')); } catch {}
        data.source_hash ||= sha256(await readFile(join(dir, `${stem}.source.md`), 'utf8'));
        data.source_file ||= join(dir, `${stem}.source.md`);
        records.push({ structure: data, evidence });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const unique = new Map(records.map((record) => [record.structure.id, record]));
  for (const { structure, evidence } of unique.values()) {
    const base = join(structures, structure.id);
    if (!structure.source_file?.startsWith(structures)) {
      await writeAtomic(`${base}.json`, `${JSON.stringify(structure, null, 2)}\n`);
      await writeAtomic(`${base}.evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`);
      try { await writeAtomic(`${base}.source.md`, await readFile(structure.source_file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const aliases = await readAliases(workspace);
  const registry = buildRegistry([...unique.values()].map((item) => item.structure), aliases, new Map([...unique.values()].map((item) => [item.structure.id, item.evidence])));
  await writeAtomic(registryPath(workspace), `${JSON.stringify(registry, null, 2)}\n`);
  return registry;
}

export async function readEvents(workspace) {
  let text = '';
  try { text = await readFile(eventsPath(workspace), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return text.split('\n').filter(Boolean).map((line, index) => {
    try { const event = JSON.parse(line); validateEvent(event); return event; }
    catch (error) { throw new Error(`学习账本第 ${index + 1} 行损坏或哈希不一致；文件已保留，没有覆盖。${error.message ? `（${error.message}）` : ''}`); }
  });
}

function eventHash(event) {
  const { event_id, seq, ...material } = event;
  return `e_${sha256(JSON.stringify(material)).slice(0, 20)}`;
}

function validateEvent(event) {
  if (event.schema_version !== LEARNING_SCHEMA) throw new Error('学习事件版本不合法。');
  if (!/^c_[a-f0-9]{16}$/.test(event.concept_id)) throw new Error('学习事件缺少合法 concept_id。');
  if (!ROUTES.includes(event.route)) throw new Error('学习事件 route 不合法。');
  if (!SELF_REPORTS.includes(event.self_report)) throw new Error('学习事件 self_report 不合法。');
  if (!event.answer?.trim()) throw new Error('学习事件答案不能为空。');
  if (event.answer.length > 10000) throw new Error('单次答案超过 10000 字。');
  if (event.event_id !== eventHash(event)) throw new Error('学习事件哈希不一致。');
}

export function projectLearning(registry, events, { now = Date.now(), aliases = {} } = {}) {
  const grouped = new Map();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const key = `${resolveAlias(event.concept_id, aliases)}|${event.route}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  }
  const rows = [];
  for (const concept of registry.concepts) {
    const stages = new Set();
    const routes = {};
    for (let routeIndex = 0; routeIndex < ROUTES.length; routeIndex++) {
      const route = ROUTES[routeIndex];
      const attempts = grouped.get(`${concept.concept_id}|${route}`) || [];
      const last = attempts.at(-1);
      const prerequisite = routeIndex > 0 && !events.some((event) => (resolveAlias(event.concept_id, aliases)) === concept.concept_id && event.route === ROUTES[routeIndex - 1] && event.self_report === 'without_looking');
      if (!last) { routes[route] = { attempts: 0, due: !prerequisite, interval_days: 0, stage: prerequisite ? 'locked' : 'not_attempted' }; continue; }
      if (last.self_report === 'without_looking') stages.add(ROUTES.indexOf(route) + 1);
      const previous = attempts.slice(0, -1).filter((event) => event.self_report === 'without_looking').length;
      const intervalIndex = last.self_report === 'without_looking' ? Math.min(INTERVALS_DAYS.length - 1, previous) : 0;
      const dueAt = new Date(last.at).getTime() + INTERVALS_DAYS[intervalIndex] * DAY;
      routes[route] = { attempts: attempts.length, due: dueAt <= now, due_at: new Date(dueAt).toISOString(), interval_days: INTERVALS_DAYS[intervalIndex], stage: last.self_report, last_answer: last.answer };
    }
    rows.push({ ...concept, routes, evidence_stage: Math.max(0, ...stages), due: ROUTES.some((route) => routes[route].due) });
  }
  const due = rows.filter((row) => row.due).sort((a, b) => {
    const rank = (row) => row.sources.some((source) => source.layer === 'main') ? 0 : 1;
    return rank(a) - rank(b) || a.topic.localeCompare(b.topic, 'zh-CN') || a.concept_id.localeCompare(b.concept_id);
  });
  return { rows, due, by_route: Object.fromEntries(ROUTES.map((route) => [route, events.filter((event) => event.route === route).length])), counts: { concepts: rows.length, due: due.length, events: events.length, explanations: events.filter((event) => event.route === 'explain').length } };
}

export async function learningState(workspace, { now = Date.now() } = {}) {
  const registry = await readJson(registryPath(workspace), null);
  if (!registry) return { registry: { schema_version: LEARNING_SCHEMA, concepts: [], documents: [] }, projection: projectLearning({ concepts: [] }, [], { now }), events: [] };
  const events = await readEvents(workspace);
  const aliases = await readAliases(workspace);
  return { registry, events, aliases, projection: projectLearning(registry, events, { now, aliases }) };
}

export async function dueConcepts(workspace, { now = Date.now(), limit = 3 } = {}) {
  const state = await learningState(workspace, { now });
  return state.projection.due.slice(0, limit).map((concept) => {
    const route = ROUTES.find((item) => concept.routes[item].due) || 'recall';
    const source = state.registry.documents.find((document) => document.structure_id === concept.sources[0]?.structure_id);
    return { concept_id: concept.concept_id, topic: concept.topic, kind: concept.kind, route, probe: probeFor(concept, route, source) };
  });
}

export async function recordAnswer(workspace, input) {
  const { concept_id, route = 'recall', answer, self_report = 'without_looking', prompt_id } = input;
  return withFileLock(lockPath(workspace), async () => {
    const latest = await learningState(workspace);
    const resolvedId = resolveAlias(concept_id, latest.aliases);
    const concept = latest.registry.concepts.find((item) => item.concept_id === resolvedId);
    if (!concept) throw new Error('找不到这个概念，请先运行 learn sync。');
    const probe = probeFor(concept, route);
    if (prompt_id && prompt_id !== probe.prompt_id) throw new Error('题目已变化，请重新取题后再答。');
    const events = latest.events;
    const event = {
      schema_version: LEARNING_SCHEMA,
      seq: (events.at(-1)?.seq || 0) + 1,
      event_id: '',
      concept_id: resolvedId,
      route,
      answer: String(answer || '').trim(),
      self_report,
      prompt_id: probe.prompt_id,
      at: new Date().toISOString(),
      source: { structure_id: concept.sources[0]?.structure_id || '', proposition_id: concept.sources[0]?.proposition_id || '', document_id: concept.sources[0]?.document_id || '' },
    };
    event.event_id = eventHash(event);
    validateEvent(event);
    const text = `${events.length ? `${events.map((item) => JSON.stringify(item)).join('\n')}\n` : ''}${JSON.stringify(event)}\n`;
    await mkdir(dirs(workspace).knowledge, { recursive: true });
    await writeAtomic(eventsPath(workspace), text);
    return { event, reveal: revealConcept(latest.registry, resolvedId) };
  });
}

export function revealConcept(registry, conceptId) {
  const concept = registry.concepts.find((item) => item.concept_id === conceptId);
  if (!concept) throw new Error('找不到这个概念。');
  return { concept_id: concept.concept_id, text: concept.text, topic: concept.topic, kind: concept.kind, sources: concept.sources };
}

export async function exportLearning(workspace) {
  const state = await learningState(workspace);
  const assets = [];
  for (const document of state.registry.documents) {
    const base = join(dirs(workspace).structures, document.structure_id);
    let structure;
    let evidence = {};
    let source = '';
    try {
      structure = JSON.parse(await readFile(`${base}.json`, 'utf8'));
      evidence = JSON.parse(await readFile(`${base}.evidence.json`, 'utf8'));
      source = await readFile(`${base}.source.md`, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      continue;
    }
    assets.push({ structure, evidence, source });
  }
  return { schema_version: LEARNING_SCHEMA, exported_at: new Date().toISOString(), registry: state.registry, aliases: await readAliases(workspace), events: state.events, assets };
}

export async function importLearning(workspace, bundle) {
  if (bundle?.schema_version !== LEARNING_SCHEMA || !Array.isArray(bundle.events) || !bundle.registry || !Array.isArray(bundle.registry.concepts)) throw new Error('学习包结构不合法。');
  if (bundle.registry.concepts.length && !Array.isArray(bundle.assets)) throw new Error('学习包缺少可恢复的来源结构。');
  const aliases = validateAliases({ ...(bundle.aliases || {}), ...await readAliases(workspace) });
  const assets = (bundle.assets || []).map((asset) => {
    if (!/^s_[a-f0-9]{16}$/.test(asset.structure?.id || '') || !Array.isArray(asset.structure.propositions) || typeof asset.source !== 'string' || !asset.evidence || typeof asset.evidence !== 'object' || Array.isArray(asset.evidence)) throw new Error('学习包中的来源结构不合法。');
    return { ...asset, structure: { ...asset.structure, source_file: join(dirs(workspace).structures, `${asset.structure.id}.source.md`) } };
  });
  const existing = await readEvents(workspace);
  const merged = new Map(existing.map((event) => [event.event_id, event]));
  for (const event of bundle.events) {
    validateEvent(event);
    const previous = merged.get(event.event_id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error(`学习事件冲突：${event.event_id}`);
    merged.set(event.event_id, event);
  }
  const ordered = [...merged.values()].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime() || a.event_id.localeCompare(b.event_id)).map((event, index) => ({ ...event, seq: index + 1 }));
  await mkdir(dirs(workspace).structures, { recursive: true });
  for (const asset of assets) {
    const base = join(dirs(workspace).structures, asset.structure.id);
    await writeAtomic(`${base}.json`, `${JSON.stringify(asset.structure, null, 2)}\n`);
    await writeAtomic(`${base}.evidence.json`, `${JSON.stringify(asset.evidence, null, 2)}\n`);
    await writeAtomic(`${base}.source.md`, asset.source);
  }
  await mkdir(dirs(workspace).knowledge, { recursive: true });
  await writeAtomic(eventsPath(workspace), `${ordered.map((event) => JSON.stringify(event)).join('\n')}\n`);
  await writeAtomic(aliasPath(workspace), `${JSON.stringify(aliases, null, 2)}\n`);
  await syncLearning(workspace);
  return { imported: bundle.events.length, total: ordered.length };
}
