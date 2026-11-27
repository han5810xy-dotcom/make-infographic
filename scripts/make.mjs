import { mkdir, readFile, readdir } from 'node:fs/promises';
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
const stamp = (date = new Date()) => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;

function fallbackHtml(structure, findings) {
  const rows = findings.map((item) => `<li><b>${item.title}</b>：${item.message}<br><span>动作：${item.action}</span></li>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${structure.topic} · 降级报告</title><style>body{max-width:860px;margin:40px auto;padding:0 20px;background:#f7f9fd;color:#17181c;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}li{margin:12px 0;padding:12px;background:#fff;border:1px solid #efd6aa;border-radius:10px}span{color:#7a4a00}</style></head><body><h1>${structure.topic}</h1><p>自动降级后仍有问题，本页保留完整诊断，不冒充合格图片。</p><ol>${rows}</ol><p><a href="index.html">返回图集</a></p></body></html>`;
}

async function buildIndex(ws) {
  const dir = join(ws, 'infographics');
  let names = [];
  try { names = await readdir(dir); } catch { return join(dir, 'index.html'); }
  const records = [];
  for (const name of names.filter((item) => item.endsWith('.json') && !item.endsWith('.evidence.json')).sort()) {
    try {
      const data = JSON.parse(await readFile(join(dir, name), 'utf8'));
      const stem = name.slice(0, -5);
      if (data.views && data.propositions) {
        const png = names.includes(`${stem}-v1.png`) ? `${stem}-v1.png` : '';
        records.push({ stem, data, png, kind: 'structure' });
      } else if (data.layout === 'turn-card') {
        const png = names.includes(`${stem}.png`) ? `${stem}.png` : '';
        records.push({ stem, data, png, kind: 'turn-card' });
      }
    } catch {}
  }
  records.sort((a, b) => String(b.data.created_at || b.data.createdAt || '').localeCompare(String(a.data.created_at || a.data.createdAt || '')));
  const items = records.map(({ stem, data, png, kind }) => {
    const title = data.headline || data.topic || data.title || '未命名';
    const detail = kind === 'structure'
      ? `${data.propositions.length} 条命题 · ${data.relations.length} 条关系 · ${data.views.length} 个视图`
      : `turn card · ${data.bodyChars || ''} 字`;
    return `<article class="card"><a href="${png || (kind === 'structure' ? `${stem}-v1.html` : `${stem}.html`)}">${png ? `<img src="${png}" alt="${title}">` : '<span>HTML</span>'}</a><h2>${title}</h2><p>${detail}</p><p><a href="${stem}.json">${kind === 'structure' ? '结构记录' : '卡片记录'}</a> · <a href="${stem}.source.md">来源对话</a>${kind === 'structure' ? ` · <a href="${stem}.evidence.json">证据索引</a>` : ''}</p></article>`;
  }).join('');
  const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>知识结构图集</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f7fc;color:#17181c;font-family:"Microsoft YaHei","PingFang SC",sans-serif}main{max-width:1120px;margin:auto;padding:48px 24px}h1{font-size:36px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}.card{background:#fff;border:1px solid #dce2ee;border-radius:14px;padding:16px}.card img{width:100%;height:auto;border-radius:8px}.card h2{font-size:20px}.card p{font-size:14px;color:#5c626e}.card a{color:#2f5cff}@media(max-width:760px){.grid{grid-template-columns:1fr}}</style></head><body><main><h1>知识结构图集</h1><p>先有结构，再有图。知识结构与旧版 turn card 都保留在同一索引里。</p><div class="grid">${items || '<p>还没有结构。</p>'}</div></main></body></html>`;
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
    console.log(`用法：node scripts/make.mjs --spec 作者结构.json --in 对话.md --out 主题\n     node scripts/make.mjs --in 对话.md --out 主题\n     node scripts/make.mjs --demo\n\n正式流程：模型先写 Proposition／Relation／Structure，脚本再校验、降级与渲染。\n--in 不带 --spec 时只跑自动候选模式，画面会标注“自动候选·待复核”。\n可选：--html-only  --scale 2  ${WORKDIR_HELP}\n旧版 turn card 仍在 scripts/make-turn-card.mjs。`);
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
  const outputs = [];
  await withArtifactLock(ws, async () => {
    const outDir = join(ws, 'infographics');
    const tmpDir = join(ws, '.knowledge/tmp');
    await mkdir(outDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true });
    for (let structureIndex = 0; structureIndex < workflow.structures.length; structureIndex++) {
      let structure = workflow.structures[structureIndex];
      let svgByView = Object.fromEntries(structure.views.map((view) => [view.id, buildStructureSvg(structure, view)]));
      let findings = checkOutput(structure, { evidenceIndex: workflow.evidenceIndex, svgByView });
      let actions = [];
      if (findings.some((item) => item.severity === 'error')) {
        const degraded = degradeStructure(structure, { evidenceIndex: workflow.evidenceIndex });
        structure = degraded.structure;
        actions = degraded.actions;
        findings = degraded.findings;
        svgByView = Object.fromEntries(structure.views.map((view) => [view.id, buildStructureSvg(structure, view)]));
        console.log(`已降级：${actions.join('；') || '保留诊断报告'}`);
      }
      const hasErrors = findings.some((item) => item.severity === 'error');
      structure.created_at = new Date().toISOString();
      structure.workflow = workflow.steps;
      structure.checks = findings;
      structure.degradation = { actions, html_only: argv.includes('--html-only'), browser_screenshotted: false };
      const suffix = workflow.structures.length > 1 ? `-${String(structureIndex + 1).padStart(2, '0')}` : '';
      const base = `${stamp()}_${slug(opt(argv, 'out', structure.topic))}${suffix}`;
      await writeAtomic(join(outDir, `${base}.json`), JSON.stringify(structure, null, 2));
      await writeAtomic(join(outDir, `${base}.evidence.json`), JSON.stringify(Object.fromEntries(workflow.evidenceIndex), null, 2));
      await writeAtomic(join(outDir, `${base}.source.md`), source);
      if (hasErrors) {
        await writeAtomic(join(outDir, `${base}-fallback.html`), fallbackHtml(structure, findings));
        console.log(`HTML 诊断降级：${join(outDir, `${base}-fallback.html`)}`);
        outputs.push({ base, fallback: true });
        continue;
      }
      const navigation = {
        views: structure.views.map((view) => ({ id: view.id, title: view.props.title || view.id, href: `${base}-${view.id}.html` })),
        source: `${base}.source.md`,
        evidence: `${base}.evidence.json`,
      };
      for (const view of structure.views) {
        const stem = `${base}-${view.id}`;
        const svg = buildStructureSvg(structure, view);
        const html = buildStructureHtml(structure, view, { navigation });
        await writeAtomic(join(outDir, `${stem}.svg`), svg);
        await writeAtomic(join(outDir, `${stem}.html`), html);
        if (!argv.includes('--html-only')) {
          const staged = join(tmpDir, `${stem}.png`);
          try {
            const rendered = await renderStructurePng(structure, view, staged, { scale });
            await writeBinaryAtomic(join(outDir, `${stem}.png`), await readFile(staged));
            structure.degradation.browser_screenshotted = true;
            console.log(`PNG 已生成：${join(outDir, `${stem}.png`)} (${rendered.width}x${rendered.height})`);
          } catch (error) {
            console.log(`PNG 降级为 HTML：${join(outDir, `${stem}.html`)}（${error.message}）`);
          }
        } else {
          console.log(`HTML 已生成：${join(outDir, `${stem}.html`)}（未做浏览器截图）`);
        }
        console.log(`视图 ${view.id}：${view.props.title || view.graphic}`);
      }
      await writeAtomic(join(outDir, `${base}.json`), JSON.stringify(structure, null, 2));
      outputs.push({ base, fallback: false });
    }
  });
  const index = await buildIndex(ws);
  console.log(`结构：${workflow.stats.structures} 份，${workflow.stats.propositions} 条命题，${workflow.stats.relations} 条关系，${workflow.stats.backbone} 条主干。`);
  console.log(`图集已更新：${index}`);
  console.log('OK');
  return 0;
}

startCli(import.meta.url, 'make', main);
