import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCli, workdir, opt, wantsHelp, checkFlags, WORKDIR_HELP, WORKDIR_FLAGS } from './console.mjs';
import { writeAtomic, writeBinaryAtomic } from './safeio.mjs';
import { withArtifactLock } from './artifacts.mjs';
import { runKnowledgeWorkflow } from './workflow.mjs';
import { checkOutput, degradeStructure } from './output-checks.mjs';
import { buildStructureHtml, buildStructureSvg, renderStructurePng } from './render-structure.mjs';
import { visibleLen } from './knowledge-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FLAGS = ['spec', 'in', 'source', 'out', 'scale', 'html-only', 'demo', 'help', ...WORKDIR_FLAGS];
const slug = (value) => String(value || '知识结构').replace(/[\\/:*?"<>|\s，。：；、！？]+/g, '').slice(0, 40) || '知识结构';
const stamp = (date = new Date()) => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;

async function buildIndex(ws) {
  const dir = join(ws, 'infographics');
  let names = [];
  try { names = await readdir(dir); } catch { return join(dir, 'index.html'); }
  const records = [];
  for (const name of names.filter((item) => item.endsWith('.json') && !item.endsWith('.evidence.json')).sort()) {
    try {
      const data = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (!data.views || !data.propositions) continue;
      const stem = name.slice(0, -5);
      const png = names.includes(`${stem}-v1.png`) ? `${stem}-v1.png` : '';
      records.push({ stem, data, png });
    } catch {}
  }
  records.sort((a, b) => String(b.data.created_at || '').localeCompare(String(a.data.created_at || '')));
  const items = records.map(({ stem, data, png }) => `<article class="card"><a href="${png || `${stem}-v1.html`}">${png ? `<img src="${png}" alt="${data.headline || data.topic}">` : '<span>HTML</span>'}</a><h2>${data.headline || data.topic}</h2><p>${data.propositions.length} 条命题 · ${data.relations.length} 条关系 · ${data.views.length} 个视图</p><p><a href="${stem}.json">结构记录</a> · <a href="${stem}.source.md">来源对话</a></p></article>`).join('');
  const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>知识结构图集</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f7fc;color:#17181c;font-family:"Microsoft YaHei","PingFang SC",sans-serif}main{max-width:1120px;margin:auto;padding:48px 24px}h1{font-size:36px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}.card{background:#fff;border:1px solid #dce2ee;border-radius:14px;padding:16px}.card img{width:100%;height:auto;border-radius:8px}.card h2{font-size:20px}.card p{font-size:14px;color:#5c626e}.card a{color:#2f5cff}@media(max-width:760px){.grid{grid-template-columns:1fr}}</style></head><body><main><h1>知识结构图集</h1><p>先有结构，再有图。每张图都能回到命题、关系与原句。</p><div class="grid">${items || '<p>还没有结构。</p>'}</div></main></body></html>`;
  await writeAtomic(join(dir, 'index.html'), page);
  return join(dir, 'index.html');
}

export async function main(argv = process.argv.slice(2)) {
  checkFlags(argv, FLAGS);
  const ws = workdir(argv);
  const inVal = opt(argv, 'in', '');
  const sourceVal = opt(argv, 'source', '');
  const specFile = opt(argv, 'spec', '');
  const demo = argv.includes('--demo');
  if (wantsHelp(argv) || (!inVal && !sourceVal && !specFile && !demo)) {
    console.log(`用法：node scripts/make.mjs --in 对话.md --out 主题\n     node scripts/make.mjs --spec 作者结构.json --in 对话.md --out 主题\n     node scripts/make.mjs --demo\n\n先解析成命题与关系，再按拓扑生成主图、分支细节图与知识总览。\n可选：--html-only  --scale 2  ${WORKDIR_HELP}\n旧版 turn card 仍在 scripts/make-turn-card.mjs。`);
    return 0;
  }
  const scale = Number(opt(argv, 'scale', '2'));
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('--scale 需要是正数。');
  let source = '';
  let authored = null;
  if (demo) {
    source = await readFile(join(here, '../assets/demo-knowledge-source.md'), 'utf8');
    authored = JSON.parse(await readFile(join(here, '../examples/knowledge-ioed-authored.json'), 'utf8'));
  } else {
    const sourcePath = sourceVal || inVal;
    if (!sourcePath) throw new Error('没有读到对话内容。');
    source = await readFile(resolve(sourcePath), 'utf8');
    if (specFile) authored = JSON.parse(await readFile(resolve(specFile), 'utf8'));
  }
  if (!source.trim()) throw new Error('对话内容为空。');
  const workflow = await runKnowledgeWorkflow(source, { authored });
  let structure = workflow.structure;
  let svgByView = Object.fromEntries(structure.views.map((view) => [view.id, buildStructureSvg(structure, view)]));
  let findings = checkOutput(structure, { evidenceIndex: workflow.evidenceIndex, svgByView });
  if (findings.some((item) => item.severity === 'error')) {
    const degraded = degradeStructure(structure, { evidenceIndex: workflow.evidenceIndex });
    structure = degraded.structure;
    console.log(`已降级：${degraded.actions.join('；')}`);
  }
  const base = `${stamp()}_${slug(opt(argv, 'out', structure.topic))}`;
  await withArtifactLock(ws, async () => {
    const outDir = join(ws, 'infographics');
    const tmpDir = join(ws, '.knowledge/tmp');
    await mkdir(outDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true });
    structure.created_at = new Date().toISOString();
    const payload = JSON.stringify(structure, null, 2);
    await writeAtomic(join(outDir, `${base}.json`), payload);
    await writeAtomic(join(outDir, `${base}.evidence.json`), JSON.stringify(Object.fromEntries(workflow.evidenceIndex), null, 2));
    await writeAtomic(join(outDir, `${base}.source.md`), source);
    for (const view of structure.views) {
      const stem = `${base}-${view.id}`;
      const svg = buildStructureSvg(structure, view);
      const html = buildStructureHtml(structure, view);
      await writeAtomic(join(outDir, `${stem}.svg`), svg);
      await writeAtomic(join(outDir, `${stem}.html`), html);
      if (!argv.includes('--html-only')) {
        const staged = join(tmpDir, `${stem}.png`);
        try {
          const rendered = await renderStructurePng(structure, view, staged, { scale });
          await writeBinaryAtomic(join(outDir, `${stem}.png`), await readFile(staged));
          console.log(`PNG 已生成：${join(outDir, `${stem}.png`)} (${rendered.width}x${rendered.height})`);
        } catch (error) {
          console.log(`PNG 降级为 HTML：${join(outDir, `${stem}.html`)}（${error.message}）`);
        }
      }
      console.log(`视图 ${view.id}：${view.props.title || view.graphic}`);
    }
  });
  const index = await buildIndex(ws);
  console.log(`结构：${structure.propositions.length} 条命题，${structure.relations.length} 条关系，${structure.backbone.length} 条主干，${structure.topo}。`);
  console.log(`图集已更新：${index}`);
  console.log('OK');
  return 0;
}

startCli(import.meta.url, 'make', main);
