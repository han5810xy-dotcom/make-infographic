import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { withFileLock, writeAtomic } from './safeio.mjs';
import { startCli, workdir, opt, checkFlags, wantsHelp, WORKDIR_FLAGS, WORKDIR_HELP } from './console.mjs';

const INDEX_VERSION = 1;
const TOPIC_WORDS = Object.freeze({
  日语: /日语|假名|动词|可能态|る前|帰る|する|来る/,
  学习: /学习|学会|记忆|复习|检索|反馈|理解|迁移/,
  证据: /证据|原文|引用|出处|quote|来源|核验/,
  排版: /排版|版式|布局|字号|画布|卡片|栅格/,
  安装: /安装|install|pnpm|npm|Node|依赖/,
  发布: /发布|Release|GitHub|Pages|站点|部署/,
  测试: /测试|自检|回归|断言|测试集|eval/,
  结构: /结构|关系|层次|矩阵|决策树|知识结构/,
  产品: /产品|用户|功能|入口|体验|需求/,
  工程: /工程|代码|脚本|并发|锁|渲染|浏览器/,
  数学: /数学|面积|比例|因子|概率|统计/,
  哲学: /哲学|苏格拉底|柏拉图|禅宗|无知|指月/,
});

const cardsDir = (workspace) => join(resolve(workspace), '.knowledge', 'cards');
const indexPath = (workspace) => join(cardsDir(workspace), 'index.json');
const lockPath = (workspace) => join(cardsDir(workspace), 'index.lock');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function topicsOf(turn, card = {}) {
  const text = `${turn?.title || card.title || ''} ${turn?.prior?.text || card.before || ''} ${turn?.collision?.text || card.snag || ''} ${turn?.revised?.text || card.after || ''} ${turn?.takeaway?.text || card.takeaway || ''}`;
  const topics = Object.entries(TOPIC_WORDS).filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic);
  return topics.length ? topics : ['未分类'];
}

async function readIndex(workspace) {
  try {
    const data = JSON.parse(await readFile(indexPath(workspace), 'utf8'));
    if (data.version !== INDEX_VERSION || !Array.isArray(data.cards)) throw new Error('版本或结构不认识');
    return data;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: INDEX_VERSION, cards: [] };
    throw new Error(`卡片库索引读不懂：${indexPath(workspace)}\n先保留这份文件，确认后再修复；本次没有覆盖它。`);
  }
}

function badgeOf(links = {}) {
  if (links.contradicts?.length) return '与旧判断冲突';
  if (links.supersedes?.length) return '取代旧判断';
  if (links.expands?.length) return '补充旧判断';
  return '';
}

function pageShell(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f7fc;color:#17181c;font-family:"Microsoft YaHei","PingFang SC",sans-serif}main{max-width:1120px;margin:auto;padding:42px 22px}h1{font-size:34px;margin:0 0 10px}p{color:#5c626e}.card{position:relative;background:#fff;border:1px solid #dce2ee;border-radius:14px;padding:18px;margin:14px 0}.card h2{font-size:21px;margin:0 0 8px}.badge{position:absolute;right:16px;top:16px;background:#fff7e9;color:#a86400;border:1px solid #efd6aa;border-radius:999px;padding:4px 9px;font-size:12px}.meta{font-size:13px;color:#5c626e;margin:6px 0}.card a{color:#2f5cff;text-decoration:none}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}@media(max-width:720px){.grid{grid-template-columns:1fr}}</style></head><body><main><h1>${esc(title)}</h1><p>一张卡，只记录一次判断改变。</p>${body}</main></body></html>`;
}

function cardHtml(item) {
  const assets = item.artifacts || {};
  const media = assets.png ? `<a href="${esc(assets.png)}"><img src="${esc(assets.png)}" alt="${esc(item.title)}" loading="lazy"></a>` : assets.html ? `<a href="${esc(assets.html)}">打开 HTML 卡片</a>` : '<span>只有内容记录</span>';
  return `<article class="card">${item.badge ? `<span class="badge">${esc(item.badge)}</span>` : ''}${media}<h2>${esc(item.title)}</h2><p class="meta">${esc(item.createdAt || '')} · ${esc(item.status)} · ${esc((item.topics || []).join(' / '))}</p><p class="meta">${esc(item.id)}${item.supersededBy ? ` · 已被 ${esc(item.supersededBy)} 取代` : ''}</p><p><a href="${esc(item.file)}">完整记录</a> · <a href="${esc(item.sourceFile)}">归档原文</a></p></article>`;
}

async function writeViews(workspace, index) {
  const dir = cardsDir(workspace);
  const cards = [...index.cards].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const timeline = cards.map((item) => `<section><h2>${esc(String(item.createdAt || '').slice(0, 10))}</h2>${cardHtml(item)}</section>`).join('') || '<p>还没有卡片。</p>';
  const groups = new Map();
  for (const item of cards) for (const topic of item.topics || ['未分类']) {
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(item);
  }
  const topics = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN')).map(([topic, items]) => `<section><h2>${esc(topic)}</h2><div class="grid">${items.map(cardHtml).join('')}</div></section>`).join('') || '<p>还没有卡片。</p>';
  await writeAtomic(join(dir, 'timeline.html'), pageShell('转弯时间线', timeline));
  await writeAtomic(join(dir, 'topics.html'), pageShell('主题视图', topics));
  const style = 'img{display:block;width:100%;height:auto;border-radius:8px;margin-bottom:12px}';
  await writeAtomic(join(dir, 'timeline.html'), (await readFile(join(dir, 'timeline.html'), 'utf8')).replace('</style>', `${style}</style>`), 'utf8');
  await writeAtomic(join(dir, 'topics.html'), (await readFile(join(dir, 'topics.html'), 'utf8')).replace('</style>', `${style}</style>`), 'utf8');
}

export async function upsertCard({ workspace, turn, card, createdAt = new Date().toISOString(), source = '', sourceFile = '', artifacts = {}, qa = null, status = '', links = {} }) {
  if (!turn?.id || !/^t_[a-f0-9]{16}$/.test(turn.id)) throw new Error('卡片缺少稳定 id。');
  const dir = cardsDir(workspace);
  await mkdir(join(dir, 'assets'), { recursive: true });
  const normalizedLinks = {
    supersedes: [...new Set((links.supersedes || []).filter(Boolean))],
    expands: [...new Set((links.expands || []).filter(Boolean))],
    contradicts: [...new Set((links.contradicts || []).filter(Boolean))],
  };
  return withFileLock(lockPath(workspace), async () => {
    const index = await readIndex(workspace);
    for (const id of Object.values(normalizedLinks).flat()) {
      if (id === turn.id) throw new Error('卡片不能链接到自己。');
      if (!index.cards.some((item) => item.id === id)) throw new Error(`找不到要链接的旧卡片：${id}`);
    }
    const previous = index.cards.find((item) => item.id === turn.id);
    const nextStatus = status || previous?.status || 'draft';
    if (!['draft', 'confirmed', 'revised'].includes(nextStatus)) throw new Error('--status 只接受 draft、confirmed 或 revised。');
    const relative = {};
    for (const [ext, file] of Object.entries(artifacts)) {
      if (!file) continue;
      const name = `${turn.id}.${ext}`;
      await copyFile(file, join(dir, 'assets', name));
      relative[ext] = `assets/${name}`;
    }
    for (const ext of ['png', 'svg', 'pdf', 'html']) {
      if (relative[ext]) continue;
      await rm(join(dir, 'assets', `${turn.id}.${ext}`), { force: true });
    }
    const sourceName = `${turn.id}.source.md`;
    await writeAtomic(join(dir, sourceName), source);
    const record = {
      schema_version: 'turn-card.v1',
      id: turn.id,
      turn,
      card: { ...card, badge: badgeOf(normalizedLinks) },
      createdAt,
      sourceHash: turn.source_hash || '',
      sourceFile,
      topics: topicsOf(turn, card),
      status: nextStatus,
      links: normalizedLinks,
      supersededBy: previous?.supersededBy || '',
      artifacts: relative,
      qa,
    };
    const file = `${turn.id}.json`;
    await writeAtomic(join(dir, file), JSON.stringify(record, null, 2));
    const meta = {
      id: turn.id,
      title: card.title || turn.title,
      createdAt,
      sourceHash: record.sourceHash,
      topics: record.topics,
      status: nextStatus,
      links: normalizedLinks,
      supersededBy: record.supersededBy,
      badge: record.card.badge,
      file,
      sourceFile: sourceName,
      artifacts: relative,
      text: `${record.card.title} ${record.card.before || ''} ${record.card.snag || ''} ${record.card.after || ''} ${record.card.takeaway || ''}`,
    };
    index.cards = index.cards.filter((item) => item.id !== turn.id);
    for (const id of normalizedLinks.supersedes) {
      const old = index.cards.find((item) => item.id === id);
      if (old) {
        old.status = 'superseded';
        old.supersededBy = turn.id;
        const oldRecord = JSON.parse(await readFile(join(dir, old.file), 'utf8'));
        oldRecord.status = 'superseded';
        oldRecord.supersededBy = turn.id;
        await writeAtomic(join(dir, old.file), JSON.stringify(oldRecord, null, 2));
      }
    }
    index.cards.push(meta);
    await writeAtomic(indexPath(workspace), JSON.stringify(index, null, 2));
    await writeViews(workspace, index);
    return { id: turn.id, file: join(dir, file), status: nextStatus, badge: meta.badge };
  });
}

export async function setCardStatus(workspace, id, status) {
  if (!['draft', 'confirmed', 'revised', 'superseded'].includes(status)) throw new Error('卡片状态只接受 draft、confirmed、revised 或 superseded。');
  return withFileLock(lockPath(workspace), async () => {
    const index = await readIndex(workspace);
    const meta = index.cards.find((item) => item.id === id);
    if (!meta) throw new Error(`找不到卡片：${id}`);
    meta.status = status;
    const record = JSON.parse(await readFile(join(cardsDir(workspace), meta.file), 'utf8'));
    record.status = status;
    await writeAtomic(join(cardsDir(workspace), meta.file), JSON.stringify(record, null, 2));
    await writeAtomic(indexPath(workspace), JSON.stringify(index, null, 2));
    await writeViews(workspace, index);
    return { id, status };
  });
}

export async function searchCards(workspace, { q = '', date = '', topic = '', status = '', limit = 50 } = {}) {
  const index = await readIndex(workspace);
  const needle = String(q).toLowerCase();
  const cards = index.cards.filter((item) => {
    if (needle && !`${item.title} ${item.text}`.toLowerCase().includes(needle)) return false;
    if (date && !String(item.createdAt || '').startsWith(date)) return false;
    if (topic && !(item.topics || []).includes(topic)) return false;
    if (status && item.status !== status) return false;
    return true;
  }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return { total: cards.length, cards: cards.slice(0, limit) };
}

export async function getCard(workspace, id) {
  const index = await readIndex(workspace);
  const meta = index.cards.find((item) => item.id === id);
  if (!meta) return null;
  return { meta, record: JSON.parse(await readFile(join(cardsDir(workspace), meta.file), 'utf8')) };
}

const FLAGS = ['cwd', 'workspace', 'q', 'date', 'topic', 'status', 'limit', 'help', ...WORKDIR_FLAGS];
async function main(argv) {
  checkFlags(argv, FLAGS);
  const workspace = workdir(argv);
  const command = argv.find((item) => !item.startsWith('-') && !['search', 'view', 'show'].includes(item));
  if (wantsHelp(argv) || !argv.length) {
    console.log(`用法：node scripts/library.mjs search "关键词" [--date 2026-11-28] [--topic 学习] [--status draft]\n     node scripts/library.mjs view timeline|topics\n     node scripts/library.mjs show <卡片id>\n　${WORKDIR_HELP}`);
    return 0;
  }
  if (argv[0] === 'search') {
    const q = opt(argv, 'q', argv[1] && !argv[1].startsWith('-') ? argv[1] : '');
    const result = await searchCards(workspace, { q, date: opt(argv, 'date'), topic: opt(argv, 'topic'), status: opt(argv, 'status'), limit: Number(opt(argv, 'limit', '50')) });
    console.log(`找到 ${result.total} 张卡片。`);
    for (const item of result.cards) console.log(`${item.id}  ${item.createdAt?.slice(0, 10) || ''}  ${item.status}  ${item.title}  [${(item.topics || []).join('/')}]`);
    return 0;
  }
  if (argv[0] === 'view') {
    const view = argv[1];
    if (!['timeline', 'topics'].includes(view)) throw new Error('view 只接受 timeline 或 topics。');
    const index = await readIndex(workspace);
    await writeViews(workspace, index);
    console.log(`${view === 'timeline' ? '时间线' : '主题视图'}：${join(cardsDir(workspace), `${view}.html`)}`);
    return 0;
  }
  if (argv[0] === 'show') {
    const id = argv[1];
    if (!id) throw new Error('show 后面要写卡片 id。');
    const found = await getCard(workspace, id);
    if (!found) throw new Error(`找不到卡片：${id}`);
    console.log(JSON.stringify(found.record, null, 2));
    return 0;
  }
  throw new Error('library.mjs 只认 search、view 或 show。');
}

startCli(import.meta.url, 'library', main);
