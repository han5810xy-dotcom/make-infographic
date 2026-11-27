import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, closeBrowser } from './browser.mjs';
import { buildStructureHtml, buildStructureSvg } from './render-structure.mjs';
import { VISUAL_SYNTAX } from './visual-syntax.mjs';
import { runKnowledgeWorkflow } from './workflow.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(root, 'make-infographic/eval/m3/visual');
await mkdir(outDir, { recursive: true });
const widths = [375, 768, 1080];
const prop = (id, text, kind = '主张', provenance = 'summary') => ({ id, kind, text, evidence: [], weight: 0.8, provenance });
const rel = (id, from, to, kind = '支持') => ({ id, from, to, kind, evidence: [], strength: 0.9 });
const base = (topo, propositions, relations, backbone = propositions.map((item) => item.id)) => ({
  id: `s_${topo}`, topic: `${topo} 测试`, headline: '', subhead: '', propositions, relations, topo, backbone, gaps: [],
});
const cases = [
  base('chain', [prop('p1', '旧判断'), prop('p2', '反例出现'), prop('p3', '采用新规则'), prop('p4', '得到可检验结果')], [rel('r1', 'p1', 'p2', '反驳'), rel('r2', 'p2', 'p3', '支持'), rel('r3', 'p3', 'p4', '因果')]),
  base('tree', [prop('p1', '核心概念', '定义'), prop('p2', '分支一'), prop('p3', '分支二'), prop('p4', '细节命题')], [rel('r1', 'p2', 'p1', '包含'), rel('r2', 'p3', 'p1', '包含'), rel('r3', 'p4', 'p2', '包含')]),
  base('matrix', [prop('p1', '方案 A'), prop('p2', '方案 B'), prop('p3', '维度一'), prop('p4', '维度二')], [rel('r1', 'p1', 'p2', '对比'), rel('r2', 'p3', 'p4', '对比')]),
  base('network', [prop('p1', '中心命题'), prop('p2', '证据一'), prop('p3', '证据二'), prop('p4', '反例'), prop('p5', '结论')], [rel('r1', 'p2', 'p1', '支持'), rel('r2', 'p3', 'p1', '支持'), rel('r3', 'p4', 'p1', '反驳'), rel('r4', 'p1', 'p5', '因果')]),
  base('cycle', [prop('p1', '观察'), prop('p2', '假设'), prop('p3', '检验'), prop('p4', '修正')], [rel('r1', 'p1', 'p2', '递进'), rel('r2', 'p2', 'p3', '递进'), rel('r3', 'p3', 'p4', '转折'), rel('r4', 'p4', 'p1', '递进')]),
  base('forest', [prop('p1', '主题一'), prop('p2', '主题一细节'), prop('p3', '主题二'), prop('p4', '主题二细节')], [rel('r1', 'p2', 'p1', '包含'), rel('r2', 'p4', 'p3', '包含')], []),
];
const longText = '这是一条刻意保留完整内容的长命题，用来验证动态换行、节点高度、依据区和结论区都不会把文字截断，也不允许用省略号冒充完整表达。'.repeat(3);
const longCase = base('tree', [prop('p1', longText, '定义'), prop('p2', longText), prop('p3', longText)], [rel('r1', 'p2', 'p1', '包含'), rel('r2', 'p3', 'p1', '包含')]);
longCase.headline = '长标题与长正文必须完整显示，而不是缩字或截断 '.repeat(4);
longCase.gaps = [{ missing: '一条关系缺少明确原句，未画入图中', why: longText }];
longCase.views = [{ id: 'v1', target: 'backbone', graphic: 'tree', props: { propositionIds: ['p1', 'p2', 'p3'], relationIds: ['r1', 'r2'], evidence: {}, title: longCase.headline } }];
cases.push(longCase);
const graphic = { chain: 'flow', tree: 'tree', matrix: 'matrix', network: 'network', cycle: 'network', forest: 'tree' };
for (const structure of cases) {
  structure.views = [{ id: 'v1', target: 'backbone', graphic: graphic[structure.topo], props: { propositionIds: structure.propositions.map((item) => item.id), relationIds: structure.relations.map((item) => item.id), evidence: {}, title: `${structure.topo} 图种测试` } }];
}
const turn = base('chain', [prop('p1', '原以为重读就是自测'), prop('p2', '重读只增加熟悉感'), prop('p3', '先自己回忆再看答案'), prop('p4', '能独立回忆才是掌握')], [rel('r1', 'p1', 'p2', '反驳'), rel('r2', 'p2', 'p3', '支持'), rel('r3', 'p3', 'p4', '支持')]);
turn.views = [{ id: 'v1', target: 'backbone', graphic: 'turn-band', props: { propositionIds: turn.propositions.map((item) => item.id), relationIds: turn.relations.map((item) => item.id), evidence: {}, title: '转折带测试' } }];
cases.push(turn);

const browser = await launchBrowser();
const results = [];
try {
  const page = await browser.newPage();
  for (const structure of cases) {
    const view = structure.views[0];
    const html = buildStructureHtml(structure, view);
    const svg = buildStructureSvg(structure, view);
    assert.ok(svg.includes('data-node-id='));
    assert.ok(svg.includes('@han5810xy · make-infographic'));
    assert.ok(!/\b(?:units|relations|coverage)\b|…|\.{3,}/.test(svg));
    const caseDir = join(outDir, structure.topo === 'chain' && view.graphic === 'turn-band' ? 'turn-band' : structure.topo);
    await mkdir(caseDir, { recursive: true });
    const widthResults = [];
    for (const width of widths) {
      await page.setViewport({ width, height: 1200, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'load' });
      const observed = await page.evaluate(() => {
        const svg = document.querySelector('svg');
        return {
          viewport: innerWidth,
          scrollW: document.documentElement.scrollWidth,
          svgW: svg.getBoundingClientRect().width,
          nodes: svg.querySelectorAll('[data-node-id]').length,
          edges: svg.querySelectorAll('[data-edge-id]').length,
          text: svg.textContent,
          textOverflow: [...svg.querySelectorAll('[data-node-id]')].filter((text) => {
            const shape = text.previousElementSibling;
            if (!shape) return false;
            const box = text.getBBox();
            const shapeBox = shape.getBBox();
            return box.x < shapeBox.x - 1 || box.x + box.width > shapeBox.x + shapeBox.width + 1 || box.y < shapeBox.y - 1 || box.y + box.height > shapeBox.y + shapeBox.height + 1;
          }).map((text) => text.getAttribute('data-node-id')),
          arrowVisibility: [...svg.querySelectorAll('[data-edge-id][marker-end]')].every((edge) => {
            const end = edge.getPointAtLength(edge.getTotalLength());
            return ![...svg.querySelectorAll('[data-node-id]')].some((text) => {
              const shape = text.previousElementSibling;
              if (!shape) return false;
              const box = shape.getBBox();
              return end.x > box.x + 2 && end.x < box.x + box.width - 2 && end.y > box.y + 2 && end.y < box.y + box.height - 2;
            });
          }),
        };
      });
      assert.ok(observed.scrollW <= observed.viewport + 1, `${structure.topo}/${width} 横向溢出`);
      assert.equal(observed.nodes, structure.propositions.length);
      assert.equal(observed.edges, structure.relations.length, `${structure.topo}/${width} 丢边`);
      assert.deepEqual(observed.textOverflow, [], `${structure.topo}/${width} 文字出框`);
      assert.equal(observed.arrowVisibility, true, `${structure.topo}/${width} 箭头被节点遮住`);
      await page.screenshot({ path: join(caseDir, `${width}.png`), fullPage: true });
      widthResults.push({ width, ...observed });
    }
    results.push({ topo: structure.topo, graphic: view.graphic, nodes: structure.propositions.length, edges: structure.relations.length, widths: widthResults });
  }
} finally {
  await closeBrowser(browser);
}

const flagshipSource = await readFile(join(root, 'make-infographic/assets/demo-knowledge-source.md'), 'utf8');
const flagshipAuthored = JSON.parse(await readFile(join(root, 'make-infographic/examples/knowledge-ioed-authored.json'), 'utf8'));
const flagshipWorkflow = await runKnowledgeWorkflow(flagshipSource, { authored: flagshipAuthored });
const flagship = flagshipWorkflow.structure;
const nodeText = (svg) => {
  const map = new Map();
  for (const match of svg.matchAll(/<text data-node-id="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    map.set(match[1], match[2].replace(/<[^>]+>/g, '').trim());
  }
  return map;
};
const mainNodes = nodeText(buildStructureSvg(flagship, flagship.views[0]));
const detailNodes = nodeText(buildStructureSvg(flagship, flagship.views[1]));
for (const [id, text] of detailNodes) if (mainNodes.has(id)) assert.equal(mainNodes.get(id), text, `多图措辞不一致：${id}`);
const atlasView = flagship.views.find((view) => view.props.layout === 'atlas');
assert.ok(atlasView, '旗舰结构缺少知识总览');
const atlasNodes = nodeText(buildStructureSvg(flagship, atlasView));
for (const [id, text] of atlasNodes) {
  if (mainNodes.has(id)) assert.equal(mainNodes.get(id), text, `总览与主图措辞不一致：${id}`);
  if (detailNodes.has(id)) assert.equal(detailNodes.get(id), text, `总览与细节图措辞不一致：${id}`);
}
assert.ok(mainNodes.size <= 7);
assert.ok(detailNodes.size <= 12);
assert.ok(atlasNodes.size <= 12);

const report = {
  schema_version: 'knowledge-m3-visual.v1',
  at: new Date().toISOString(),
  pass: true,
  syntax: VISUAL_SYNTAX,
  topologies: results.map((item) => item.topo),
  turn_band: true,
  knowledge_atlas: true,
  flagship_views: flagship.views.length,
  width_checks: results.length * widths.length,
  multi_view_consistency: true,
  results,
};
await writeFile(join(root, 'make-infographic/eval/m3/m3-results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(join(root, 'make-infographic/eval/m3/m3-results.md'), `# M3 可视化语法验收\n\n- 图种：${report.topologies.join(' / ')}\n- 转折带：通过\n- 知识总览：通过（旗舰结构 ${flagship.views.length} 个视图）\n- 宽度检查：${report.width_checks}\n- 同结构多图编号与措辞一致：通过\n`, 'utf8');
console.log(JSON.stringify({ pass: true, topologies: report.topologies, width_checks: report.width_checks, multi_view_consistency: true }, null, 2));
console.log('VISUAL M3 OK');
