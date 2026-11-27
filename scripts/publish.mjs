import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startCli, opt, checkFlags, wantsHelp } from './console.mjs';

const usage = '用法：node scripts/publish.mjs --structure 结构.json --out 公开目录 --consent "我确认发布" [--png 图片.png]';

export function scrubArtifact(structure) {
  if (!/^s_[a-f0-9]{16}$/.test(structure?.id || '') || !Array.isArray(structure.propositions)) throw new Error('这不是可发布的知识结构。');
  const byId = new Map(structure.propositions.map((item) => [item.id, item.concept_id]));
  return {
    schema_version: 'public-knowledge-artifact.v1',
    structure_id: structure.id,
    topic: structure.topic,
    headline: structure.headline || '',
    subhead: structure.subhead || '',
    propositions: structure.propositions.map((item) => ({ concept_id: item.concept_id, kind: item.kind, text: item.text, provenance: item.provenance })),
    relations: (structure.relations || []).filter((item) => item.from !== item.to && byId.has(item.from) && byId.has(item.to)).map((item) => ({ from: byId.get(item.from), to: byId.get(item.to), kind: item.kind })),
  };
}

async function main(argv) {
  checkFlags(argv, ['structure', 'out', 'consent', 'png', 'help']);
  if (wantsHelp(argv) || !argv.length) { console.log(usage); return 0; }
  if (opt(argv, 'consent') !== '我确认发布') throw new Error('发布是可见操作。确认只公开知识产物后，加 --consent "我确认发布"。');
  const input = opt(argv, 'structure');
  const out = opt(argv, 'out');
  if (!input || !out) throw new Error(usage);
  const structure = JSON.parse(await readFile(resolve(input), 'utf8'));
  const artifact = scrubArtifact(structure);
  const target = resolve(out);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  const png = opt(argv, 'png');
  if (png) await writeFile(join(target, 'artifact.png'), await readFile(resolve(png)));
  console.log(`公开产物已写出：${target}`);
  console.log('只包含命题、关系与可选图片；来源原句、证据 ID、学习事件与私有状态未导出。');
  return 0;
}

startCli(import.meta.url, 'publish', main);
