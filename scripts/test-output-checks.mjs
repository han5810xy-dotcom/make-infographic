import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkOutput, degradeStructure } from './output-checks.mjs';
import { buildStructureSvg } from './render-structure.mjs';
import { runKnowledgeWorkflow } from './workflow.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'assets/demo-knowledge-source.md'), 'utf8');
const authored = JSON.parse(await readFile(join(root, 'examples/knowledge-ioed-authored.json'), 'utf8'));
const workflow = await runKnowledgeWorkflow(source, { authored });
const structure = workflow.structure;
const evidenceIndex = workflow.evidenceIndex;
const svgByView = Object.fromEntries(structure.views.map((view) => [view.id, buildStructureSvg(structure, view)]));
const findings = checkOutput(structure, { evidenceIndex, svgByView });
assert.deepEqual(findings.filter((item) => item.severity === 'error'), [], JSON.stringify(findings));

const broken = structuredClone(structure);
broken.propositions[0].evidence = [];
broken.relations[0].evidence = [];
const degraded = degradeStructure(broken, { evidenceIndex });
assert.ok(degraded.degraded);
assert.ok(degraded.actions.length >= 2);
assert.ok(degraded.structure.gaps.length >= 2);
assert.ok(degraded.structure.propositions.every((item) => item.evidence.length));
assert.ok(degraded.structure.relations.every((item) => item.evidence.length));
assert.ok(degraded.structure.views.length > 0);
const rendered = degraded.structure.views.map((view) => buildStructureSvg(degraded.structure, view));
for (const svg of rendered) {
  assert.ok(!svg.includes('undefined'));
  assert.ok(!svg.includes('NaN'));
  assert.ok(svg.includes('<svg'));
}
assert.deepEqual(checkOutput(degraded.structure, { evidenceIndex, svgByView: Object.fromEntries(degraded.structure.views.map((view, index) => [view.id, rendered[index]])) }).filter((item) => item.severity === 'error'), []);
console.log(JSON.stringify({ flagship_errors: 0, degraded_views: rendered.length, degraded_actions: degraded.actions }, null, 2));
console.log('output checks OK');
