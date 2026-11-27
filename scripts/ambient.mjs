import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { startCli } from './console.mjs';

function arg(argv, name, fallback = '') {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} 后面要写一个值。`);
  return value;
}

async function main(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node scripts/ambient.mjs prepare --source 对话.md --out 意境图brief.json\n     node scripts/ambient.mjs import --brief brief.json --image 生成图.png --out-dir ambient');
    return 0;
  }
  if (argv[0] === 'prepare') {
    const sourcePath = arg(argv, 'source');
    const out = arg(argv, 'out');
    if (!sourcePath || !out) throw new Error('prepare 需要 --source 和 --out。');
    const source = await readFile(resolve(sourcePath), 'utf8');
    const title = source.split(/\r?\n/).find((line) => line.trim())?.replace(/^[*#\s]+/, '').slice(0, 60) || '对话意境';
    const brief = {
      schema_version: 'ambient-brief.v1',
      type: 'ambient',
      purpose: '装饰与纪念，不承载知识结构、证据或关系',
      source: resolve(sourcePath),
      title,
      prompt: `为这段对话生成一张独立意境图。主题：${title}。白底极简编辑插画，安静、内省；不使用文字、图标、渐变、阴影、信息图元素、箭头或 UI。画面只用于氛围与纪念，与知识结构图严格分开。`,
      separate_from_infographics: true,
    };
    const target = resolve(out);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(brief, null, 2)}\n`, 'utf8');
    console.log(`意境图 brief 已写出：${target}`);
    return 0;
  }
  if (argv[0] === 'import') {
    const briefPath = arg(argv, 'brief');
    const imagePath = arg(argv, 'image');
    const outDir = arg(argv, 'out-dir');
    if (!briefPath || !imagePath || !outDir) throw new Error('import 需要 --brief、--image 和 --out-dir。');
    const brief = JSON.parse(await readFile(resolve(briefPath), 'utf8'));
    if (brief.type !== 'ambient' || brief.separate_from_infographics !== true) throw new Error('只有 type=ambient 且与信息图分离的 brief 才能导入。');
    const targetDir = resolve(outDir);
    if (targetDir.toLowerCase().includes('infographics')) throw new Error('意境图不许写进 infographics。');
    await mkdir(targetDir, { recursive: true });
    const extension = imagePath.toLowerCase().endsWith('.png') ? 'png' : imagePath.toLowerCase().endsWith('.jpg') || imagePath.toLowerCase().endsWith('.jpeg') ? 'jpg' : '';
    if (!extension) throw new Error('意境图只接受 PNG 或 JPG。');
    const id = `ambient_${Date.now().toString(36)}`;
    const file = `${id}.${extension}`;
    await copyFile(resolve(imagePath), join(targetDir, file));
    const manifest = { ...brief, schema_version: 'ambient-art.v1', id, file, imported_at: new Date().toISOString() };
    await writeFile(join(targetDir, `${id}.json`), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`意境图已单独保存：${join(targetDir, file)}`);
    return 0;
  }
  throw new Error('ambient.mjs 只认 prepare 或 import。');
}

startCli(import.meta.url, 'ambient', main);
