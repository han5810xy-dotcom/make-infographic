import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const VERSION = '2.1.0';
export const ARCHIVE_NAME = `make-infographic-${VERSION}.zip`;
export const REQUIRED_FILES = Object.freeze([
  'SKILL.md',
  'package.json',
  'pnpm-lock.yaml',
  'README.md',
  'scripts/package-release.mjs',
  'scripts/release-contract.mjs',
  'scripts/clean.mjs',
  ...Object.freeze([
    'make.mjs', 'make-turn-card.mjs', 'render-structure.mjs', 'visual-syntax.mjs',
    'workflow.mjs', 'output-checks.mjs', 'knowledge-contract.mjs',
    'learning-core.mjs', 'learn.mjs', 'learn-server.mjs', 'publish.mjs',
    'knowledge-authoring.mjs', 'knowledge.mjs', 'propositionize.mjs', 'relations.mjs',
    'attention.mjs', 'views.mjs', 'ambient.mjs', 'trace.mjs', 'render.mjs',
    'turn-card.mjs', 'browser.mjs', 'console.mjs', 'safeio.mjs', 'artifacts.mjs',
    'contract.mjs', 'collect.mjs', 'judge.mjs', 'turn.mjs', 'library.mjs', 'review.mjs',
  ].map((name) => `scripts/${name}`)),
  'references/workflow.md',
  'references/knowledge-workflow.md',
  'references/knowledge-structure.schema.json',
  'assets/demo-turn-card.html',
  'assets/demo-turn-card.png',
  'assets/demo-knowledge-source.md',
  'examples/knowledge-ioed-authored.json',
  'examples/knowledge-ioed-main.png',
  'examples/knowledge-ioed-backbone.png',
  'examples/knowledge-ioed-detail.png',
  'bridge/server.mjs',
  'extension/manifest.json',
  'extension/trace-core.js',
  'extension/content.js',
  'extension/popup.html',
  'extension/popup.js',
  'extension/background.js',
  'web/learn/index.html',
  'web/learn/app.js',
  'web/learn/styles.css',
]);

export const ALLOWED_FILES = Object.freeze([...REQUIRED_FILES, 'LICENSE']);
export const OPTIONAL_FILES = Object.freeze(['LICENSE']);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function assertAllowedNames(names, { optional = OPTIONAL_FILES } = {}) {
  const expected = new Set(REQUIRED_FILES);
  const actual = new Set(names);
  const allowed = new Set([...expected, ...optional]);
  if (actual.size !== names.length) throw new Error('安装包有重复文件。');
  for (const name of expected) if (!actual.has(name)) throw new Error(`安装包缺少文件：${name}`);
  for (const name of actual) if (!allowed.has(name)) throw new Error(`安装包有多余文件：${name}`);
}

export function safeEntryName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`安装包里有不安全的文件路径：${name}`);
  }
  const parts = name.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`安装包里有不安全的文件路径：${name}`);
  return parts;
}

export function assertFileBounds(buffer, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error('安装包损坏：文件越界。');
  }
}

export function readZip(buffer) {
  if (buffer.length < 22 || buffer.length > 512 * 1024 * 1024) throw new Error('安装包损坏：ZIP 大小不合法。');
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0 || eocd + 22 + buffer.readUInt16LE(eocd + 20) !== buffer.length) throw new Error('安装包损坏：ZIP 目录无效。');
  if (buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6) || buffer.readUInt16LE(eocd + 8) !== buffer.readUInt16LE(eocd + 10)) {
    throw new Error('安装包损坏：不支持分卷 ZIP。');
  }
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  assertFileBounds(buffer, centralOffset, centralSize);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('安装包损坏：不支持 ZIP64。');
  let cursor = centralOffset;
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > centralOffset + centralSize || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('安装包损坏：中央目录不完整。');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    assertFileBounds(buffer, cursor + 46, nameLength + extraLength + commentLength);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    safeEntryName(name);
    if (flags & 1 || method !== 8) throw new Error(`安装包不支持加密或非 deflate 文件：${name}`);
    if (((externalAttributes >>> 16) & 0o170000) === 0o120000) throw new Error(`安装包不允许符号链接：${name}`);
    assertFileBounds(buffer, localOffset, 30);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`安装包里的 ${name} 损坏了。`);
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    if (localFlags !== flags || localMethod !== method || localCrc !== crc || localCompressedSize !== compressedSize || localSize !== size) {
      throw new Error(`安装包里的 ${name} 目录信息不一致。`);
    }
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
    if (localName !== name) throw new Error(`安装包里的 ${name} 文件名不一致。`);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    assertFileBounds(buffer, dataStart, compressedSize);
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    try { data = inflateRawSync(compressed, { maxOutputLength: 64 * 1024 * 1024 }); }
    catch { throw new Error(`安装包里的 ${name} 解压失败。`); }
    if (data.length !== size) throw new Error(`安装包里的 ${name} 大小不对。`);
    if (crc32(data) !== crc) throw new Error(`安装包里的 ${name} CRC 校验失败。`);
    entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('安装包损坏：中央目录有多余数据。');
  assertAllowedNames(entries.map((entry) => entry.name));
  return entries;
}

export async function extractZip(buffer, destination) {
  const entries = readZip(buffer);
  for (const entry of entries) {
    const target = resolve(destination, ...safeEntryName(entry.name));
    if (target !== resolve(destination) && !target.startsWith(`${resolve(destination)}${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error(`安装包里有越界路径：${entry.name}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.data, { flag: 'wx' });
  }
  return entries;
}

// Fixed metadata, sorted byte order and raw DEFLATE make builds independent of clock/timezone.
export async function buildZip(root, destination, names = REQUIRED_FILES, { epoch = 315532800, validate = true } = {}) {
  const sorted = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (validate) assertAllowedNames(sorted);
  const seconds = Math.floor(epoch);
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(seconds) || date.getUTCFullYear() < 1980 || date.getUTCFullYear() > 2107) throw new Error('SOURCE_DATE_EPOCH 超出 ZIP 日期范围。');
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const name of sorted) {
    safeEntryName(name);
    const data = await readFile(join(root, ...name.split('/')));
    const compressed = deflateRawSync(data, { level: 9 });
    const encodedName = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(encodedName.length, 26);
    chunks.push(local, encodedName, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(dosTime, 12);
    record.writeUInt16LE(dosDate, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(encodedName.length, 28);
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, encodedName);
    offset += local.length + encodedName.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...chunks, centralBuffer, end]);
  if (validate) readZip(archive);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  await writeFile(temporary, archive);
  await rename(temporary, destination);
  return archive;
}
