import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkOutput, degradeStructure } from './output-checks.mjs';
import { buildStructureSvg } from './render-structure.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const structure = JSON.parse(await readFile(join(root, 'make-infographic/eval/flagship/structure.json'), 'utf8'));
const evidenceIndex = new Map(Object.entries(JSON.parse(await readFile(join(root, 'make-infographic/eval/flagship/structure.evidence.json'), 'utf8'))));
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
console.log(JSON.stringify({ flagship_errors: 0, degraded_actions: degraded.actions }, null, 2));
console.log('output checks OK');
