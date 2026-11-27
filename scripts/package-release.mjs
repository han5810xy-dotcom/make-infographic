import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCHIVE_NAME, OPTIONAL_FILES, REQUIRED_FILES, VERSION, buildZip } from './release-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const output = join(dist, ARCHIVE_NAME);
const installerTemplate = await readFile(join(root, 'assets/install-v2.mjs'), 'utf8');
const contract = JSON.stringify({ VERSION, ARCHIVE_NAME, REQUIRED_FILES }, null, 2);
const optional = [];
for (const name of OPTIONAL_FILES) {
  try { await access(join(root, name)); optional.push(name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const files = [...REQUIRED_FILES, ...optional];
const marker = '/* @release-contract */ null';
if (!installerTemplate.includes(marker)) throw new Error('安装器模板缺少发布契约占位符。');
const installer = installerTemplate.replace(marker, contract);
const epochValue = process.env.SOURCE_DATE_EPOCH ?? '315532800';
if (!/^\d+$/.test(epochValue)) throw new Error('SOURCE_DATE_EPOCH 必须是非负 Unix 秒数。');

const archive = await buildZip(root, output, files, { epoch: Number(epochValue) });
await writeFile(join(dist, 'install.mjs'), installer);
console.log(`已打包 ${files.length} 个文件 → ${output}`);
console.log(`大小 ${archive.length} 字节；安装器：${join(dist, 'install.mjs')}`);
console.log('OK');
