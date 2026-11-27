import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCli } from './console.mjs';
import { collectDialogue } from './collect.mjs';
import { resolveAuthoring } from './knowledge-authoring.mjs';
import { validateStructure } from './knowledge-contract.mjs';
import { buildPropositions } from './propositionize.mjs';
import { runKnowledgeWorkflow } from './workflow.mjs';

const usage = `用法：node scripts/knowledge.mjs propositions --source 对话.md --out 候选.json
     node scripts/knowledge.mjs resolve --authored 作者稿.json --source 对话.md --out 结构.json
     node scripts/knowledge.mjs workflow --source 对话.md --out 结构.json [--authored 作者稿.json]
     node scripts/knowledge.mjs check --structure 结构.json --source 对话.md [--stage m1|all]`;

function arg(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return '';
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} 后面要写一个值。`);
  return value;
}

async function writeJson(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sidecarPath(path) {
  const target = resolve(path);
  return target.toLowerCase().endsWith('.json') ? target.replace(/\.json$/i, '.evidence.json') : `${target}.evidence.json`;
}

async function main(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(usage);
    return 0;
  }
  const command = argv[0];
  const sourcePath = arg(argv, 'source');
  if (!sourcePath) throw new Error(usage);
  const source = await readFile(resolve(sourcePath), 'utf8');
  if (command === 'propositions') {
    const out = arg(argv, 'out');
    if (!out) throw new Error(usage);
    const result = buildPropositions(collectDialogue(source));
    await writeJson(out, { structures: result.structures, evidence: Object.fromEntries(result.evidenceIndex), stats: result.stats });
    console.log(`候选结构：${result.structures.length} 份；命题：${result.stats.proposition_count} 条。`);
    console.log('注意：自动结果只是候选，最终结构应由模型按证据契约撰写。');
    return 0;
  }
  if (command === 'resolve') {
    const authoredPath = arg(argv, 'authored');
    const out = arg(argv, 'out');
    if (!authoredPath || !out) throw new Error(usage);
    const authored = JSON.parse(await readFile(resolve(authoredPath), 'utf8'));
    const { structure, evidenceIndex } = resolveAuthoring(authored, source);
    const validation = validateStructure(structure, { evidenceIndex, stage: 'm1' });
    if (validation.errors.length) throw new Error(validation.errors.join('\n'));
    const sidecar = sidecarPath(out);
    await writeJson(out, structure);
    await writeJson(sidecar, Object.fromEntries(evidenceIndex));
    console.log(`结构已写出：${resolve(out)}`);
    console.log(`证据索引：${sidecar}`);
    return 0;
  }
  if (command === 'workflow') {
    const out = arg(argv, 'out');
    const authoredPath = arg(argv, 'authored');
    if (!out) throw new Error(usage);
    const authored = authoredPath ? JSON.parse(await readFile(resolve(authoredPath), 'utf8')) : null;
    const result = await runKnowledgeWorkflow(source, { authored });
    if (result.structures.length === 1) {
      await writeJson(out, result.structure);
      await writeJson(sidecarPath(out), Object.fromEntries(result.evidenceIndex));
    } else {
      const bundle = { schema_version: 'knowledge-bundle.v1', structures: result.structures, stats: result.stats };
      await writeJson(out, bundle);
      await writeJson(sidecarPath(out), Object.fromEntries(result.evidenceIndex));
      for (let index = 0; index < result.structures.length; index++) {
        const stem = out.replace(/\.json$/i, '');
        await writeJson(`${stem}-${String(index + 1).padStart(2, '0')}.json`, result.structures[index]);
      }
    }
    console.log(`八步工作流完成：${result.stats.propositions} 条命题，${result.stats.relations} 条关系，${result.stats.views} 个视图。`);
    console.log(`结构已写出：${resolve(out)}（${result.structures.length} 份）`);
    return 0;
  }
  if (command === 'check') {
    const structurePath = arg(argv, 'structure');
    if (!structurePath) throw new Error(usage);
    const structure = JSON.parse(await readFile(resolve(structurePath), 'utf8'));
    const sidecar = sidecarPath(structurePath);
    let evidenceIndex;
    try { evidenceIndex = new Map(Object.entries(JSON.parse(await readFile(sidecar, 'utf8')))); }
    catch (error) { throw new Error(`缺少或读不懂证据索引 ${sidecar}；请用原结构重新出图，避免绕过来源核验。`); }
    const stage = arg(argv, 'stage') || 'all';
    const result = validateStructure(structure, { evidenceIndex, stage });
    for (const warning of result.warnings) console.log(`提醒：${warning}`);
    for (const error of result.errors) console.log(`错误：${error}`);
    console.log(result.errors.length ? '知识结构检查未通过。' : '知识结构检查通过。');
    return result.errors.length ? 2 : 0;
  }
  throw new Error(`不认识的知识命令：${command}\n${usage}`);
}

startCli(import.meta.url, 'knowledge', main);
