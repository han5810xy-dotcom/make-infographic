import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { startCli, workdir, opt, checkFlags, wantsHelp, WORKDIR_FLAGS, WORKDIR_HELP } from './console.mjs';
import { syncLearning, learningState, dueConcepts, recordAnswer, revealConcept, exportLearning, importLearning, readAliases, ROUTES, SELF_REPORTS } from './learning-core.mjs';

const usage = `用法：node scripts/learn.mjs sync
     node scripts/learn.mjs due [--limit 3]
     node scripts/learn.mjs prompt <concept_id> [--route recall|explain|apply|transfer]
     node scripts/learn.mjs answer <concept_id> --route recall --self-report without_looking --answer "自己的话"
     node scripts/learn.mjs reveal <event_id>
     node scripts/learn.mjs status
     node scripts/learn.mjs merge <旧concept_id> <保留concept_id>
     node scripts/learn.mjs export --out 学习包.json
     node scripts/learn.mjs import --in 学习包.json
     node scripts/learn.mjs serve [--port 5279]
　${WORKDIR_HELP}`;

async function writeJson(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main(argv) {
  checkFlags(argv, ['limit', 'route', 'self-report', 'answer', 'out', 'in', 'port', 'help', ...WORKDIR_FLAGS]);
  const workspace = workdir(argv);
  if (wantsHelp(argv) || !argv.length) { console.log(usage); return 0; }
  const command = argv[0];
  if (command === 'sync') {
    const registry = await syncLearning(workspace);
    console.log(`概念已同步：${registry.concepts.length} 个，来源 ${registry.documents.length} 段对话。`);
    return 0;
  }
  if (command === 'due') {
    const limit = Number(opt(argv, 'limit', '3'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('--limit 必须是 1~20 的整数。');
    const due = await dueConcepts(workspace, { limit });
    if (!due.length) { console.log('当前没有到期概念。'); return 0; }
    for (const item of due) console.log(`${item.concept_id}  [${item.route}]  ${item.topic}\n${item.probe.question}\n`);
    return 0;
  }
  if (command === 'prompt') {
    const state = await learningState(workspace);
    const concept = state.projection.rows.find((item) => item.concept_id === argv[1]);
    if (!concept) throw new Error('找不到这个概念，请先运行 learn sync。');
    const route = opt(argv, 'route', ROUTES.find((item) => concept.routes[item].due) || 'recall');
    const { probeFor } = await import('./learning-core.mjs');
    const probe = probeFor(concept, route);
    console.log(`${probe.question}\n${probe.instruction}\nprompt_id: ${probe.prompt_id}`);
    return 0;
  }
  if (command === 'answer') {
    const conceptId = argv[1];
    const route = opt(argv, 'route', 'recall');
    const selfReport = opt(argv, 'self-report', 'without_looking');
    const answer = opt(argv, 'answer');
    if (!ROUTES.includes(route)) throw new Error(`--route 只接受 ${ROUTES.join(' / ')}。`);
    if (!SELF_REPORTS.includes(selfReport)) throw new Error(`--self-report 只接受 ${SELF_REPORTS.join(' / ')}。`);
    const result = await recordAnswer(workspace, { concept_id: conceptId, route, answer, self_report: selfReport });
    console.log(`已保存你的原话：${result.event.event_id}`);
    console.log('这里不自动判分。用 learn reveal 查看原对话证据，或在本机工作台继续。');
    return 0;
  }
  if (command === 'reveal') {
    const state = await learningState(workspace);
    const event = state.events.find((item) => item.event_id === argv[1]);
    if (!event) throw new Error('找不到这次作答记录。');
    let conceptId = event.concept_id;
    const seen = new Set();
    while (state.aliases[conceptId] && !seen.has(conceptId)) { seen.add(conceptId); conceptId = state.aliases[conceptId]; }
    const reveal = revealConcept(state.registry, conceptId);
    console.log(`你的原话：\n${event.answer}\n\n对话里的判断：\n${reveal.text}\n\n原句证据：\n${reveal.sources.flatMap((source) => source.evidence_text || []).join('\n')}\n\n来源：${reveal.sources.map((source) => `${source.structure_id} / ${source.proposition_id}`).join('；')}`);
    return 0;
  }
  if (command === 'status') {
    const state = await learningState(workspace);
    const p = state.projection;
    console.log(`概念 ${p.counts.concepts} · 到期 ${p.counts.due} · 学习记录 ${p.counts.events} · 自己的解释 ${p.counts.explanations}`);
    for (const row of p.rows) console.log(`${row.concept_id}  ${row.topic}  证据到${['未接触', '回忆', '解释', '应用', '迁移'][row.evidence_stage]}  ${row.due ? '待复习' : '未到期'}`);
    return 0;
  }
  if (command === 'merge') {
    const [from, to] = argv.slice(1, 3);
    if (!from || !to || from === to) throw new Error('merge 后面要写旧 concept_id 和保留 concept_id。');
    const state = await learningState(workspace);
    if (!state.registry.concepts.some((item) => item.concept_id === from) || !state.registry.concepts.some((item) => item.concept_id === to)) throw new Error('两个 concept_id 都必须已存在。');
    const aliases = { ...await readAliases(workspace), [from]: to };
    let cursor = to;
    const seen = new Set();
    while (aliases[cursor]) {
      if (cursor === from || seen.has(cursor)) throw new Error('这次合并会形成循环映射，未写入。');
      seen.add(cursor);
      cursor = aliases[cursor];
    }
    await writeJson(join(workspace, '.knowledge', 'concept-aliases.json'), aliases);
    await syncLearning(workspace);
    console.log(`已合并：${from} → ${to}。历史学习事件保留原 ID，投影时归并到保留概念。`);
    return 0;
  }
  if (command === 'export') {
    const out = opt(argv, 'out');
    if (!out) throw new Error(usage);
    await writeJson(out, await exportLearning(workspace));
    console.log(`学习包已导出：${resolve(out)}`);
    return 0;
  }
  if (command === 'import') {
    const input = opt(argv, 'in');
    if (!input) throw new Error(usage);
    const result = await importLearning(workspace, JSON.parse(await readFile(resolve(input), 'utf8')));
    console.log(`导入 ${result.imported} 条，去重后共 ${result.total} 条学习记录。`);
    return 0;
  }
  if (command === 'serve') {
    const port = Number(opt(argv, 'port', '5279'));
    const { startLearningServer } = await import('./learn-server.mjs');
    await startLearningServer({ workspace, port });
    return 0;
  }
  throw new Error(`不认识的学习命令：${command}\n${usage}`);
}

startCli(import.meta.url, 'learn', main);
