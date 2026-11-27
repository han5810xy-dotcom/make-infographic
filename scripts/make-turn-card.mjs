import { readFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { startCli, workdir, opt, wantsHelp, checkFlags, WORKDIR_HELP, WORKDIR_FLAGS } from './console.mjs';
import { writeAtomic, sha } from './safeio.mjs';
import { reserveArtifact, withArtifactLock } from './artifacts.mjs';
import { buildTurnHtml, renderTurnPng, renderTurnPdf, buildTurnSvg, adaptTurnCard, esc } from './render.mjs';
import { TURN_LAYOUT, TURN_LIMIT, normalizeTurnCard, demoCard, printOmissions, turnBodyChars, visibleLen, DEMO_SOURCE } from './turn-card.mjs';
import { collectDialogue } from './collect.mjs';
import { judgeCollected } from './judge.mjs';
import { sourceHash, stableTurnId } from './contract.mjs';
import { upsertCard } from './library.mjs';
import { ensureProbes } from './review.mjs';

let WS = process.cwd();
const outDir = () => join(WS, 'infographics');
const p2 = (n) => String(n).padStart(2, '0');
const now = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
const fileStamp = (d = new Date()) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
const slug = (s) => String(s).replace(/[\\/:*?"<>|\s，。：；、！？]+/g, '').slice(0, 24) || '转弯图';
const FLAGS = ['spec', 'in', 'source', 'template', 'out', 'scale', 'fmt', 'demo', 'html-only', 'status', 'supersedes', 'expands', 'contradicts', 'help', ...WORKDIR_FLAGS];

export function extractJson(raw) {
  const text = String(raw).trim();
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error('这个文件里没有可读的 JSON。');
}

function outBase(argv, fallback) {
  const arg = opt(argv, 'out', '');
  if (!arg) return fallback;
  const name = basename(arg).replace(/\.png$/i, '');
  if (name !== arg) console.log(`注意：--out 只取名字部分（${name}），产物仍写入 ${outDir()}。`);
  return slug(name);
}

async function readSource(path) {
  try { return await readFile(resolve(path), 'utf8'); }
  catch { throw new Error(`读不到内容文件：${resolve(path)}\n  --in 需要指向一段 .md 或 .txt 内容。`); }
}

function linkIds(argv, name) {
  return [...new Set(opt(argv, name, '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function badgeOf(links) {
  if (links.contradicts.length) return '与旧判断冲突';
  if (links.supersedes.length) return '取代旧判断';
  if (links.expands.length) return '补充旧判断';
  return '';
}

function synthesizeTurn(card, source, createdAt) {
  const exact = (quote) => !!quote && String(source).includes(quote);
  const block = (text, quote) => exact(quote)
    ? { text, quote, source: 'assistant', confidence: 0.7 }
    : { text, quote: '', source: 'inferred', confidence: 0.5, inference: `内容规格没有提供可逐字核对的原文：${text}` };
  const turn = {
    id: '',
    title: card.title,
    prior: block(card.before, card.before),
    collision: block(card.snag, card.snag),
    revised: block(card.after, card.after),
    takeaway: { text: card.takeaway || card.after, kind: '口诀' },
    evidence: [],
    provenance: 'model',
    created_at: createdAt,
    source_hash: sourceHash(source),
  };
  turn.id = stableTurnId(turn);
  return turn;
}

export async function refreshIndex(ws = WS) {
  if (!ws) throw new Error('刷新图集需要工作目录。');
  return withArtifactLock(ws, async () => {
    const dir = join(ws, 'infographics');
    let names = [];
    try { names = await readdir(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const cards = [];
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      let data;
      try { data = JSON.parse(await readFile(join(dir, name), 'utf8')); } catch { continue; }
      if (data.layout !== TURN_LAYOUT) continue;
      const stem = basename(name, '.json');
      cards.push({ stem, data, png: names.includes(`${stem}.png`) ? `${stem}.png` : '', svg: names.includes(`${stem}.svg`) ? `${stem}.svg` : '', pdf: names.includes(`${stem}.pdf`) ? `${stem}.pdf` : '', html: names.includes(`${stem}.html`) ? `${stem}.html` : '' });
    }
    cards.sort((a, b) => String(b.data.createdAt || '').localeCompare(String(a.data.createdAt || '')));
    const items = cards.map(({ stem, data, png, svg, pdf, html }) => `<article class="card"><a href="${png || html}">${png ? `<img src="${png}" alt="${esc(data.title)}" loading="lazy">` : '<span>HTML</span>'}</a><h2>${esc(data.title)}</h2><p>${esc(data.createdAt || '')} · 正文 ${data.bodyChars || turnBodyChars(data)} 字${data.demo ? ' · 示例' : ''}</p><p><a href="${stem}.json">内容记录</a> · <a href="${stem}.source.md">原文</a>${svg ? ` · <a href="${svg}">SVG</a>` : ''}${pdf ? ` · <a href="${pdf}">PDF</a>` : ''}</p></article>`).join('');
    const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>转弯图集</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f7fc;color:#17181c;font-family:"Microsoft YaHei","PingFang SC",sans-serif}main{max-width:1120px;margin:auto;padding:48px 24px}h1{font-size:36px}p{color:#5c626e}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}.card{background:#fff;border:1px solid #dce2ee;border-radius:14px;padding:16px}.card img{width:100%;height:auto;display:block;border-radius:8px}.card h2{font-size:20px;margin:16px 0 8px}.card p{font-size:14px;margin:6px 0}.card a{color:#2f5cff}@media(max-width:760px){.grid{grid-template-columns:1fr}}</style></head><body><main><h1>转弯图集</h1><p>一张图，只记录一次判断改变。</p><div class="grid">${items || '<p>还没有图。</p>'}</div></main></body></html>`;
    // The unified index belongs to make.mjs; legacy runs must never clobber it.
    const pagePath = join(dir, 'turn-index.html');
    await writeAtomic(pagePath, page);
    return { page: pagePath, count: cards.length };
  });
}

async function renderJob(job, { argv, formats, scale, source, sourceFile, demo, links, status, index, total }) {
  const result = normalizeTurnCard(job.input, { source, demo });
  const { card, omitted, origins, memory } = result;
  const turn = job.turn || synthesizeTurn(card, source, now());
  card.inferredBlocks = [
    ...(turn.prior?.source === 'inferred' ? ['before'] : []),
    ...(turn.collision?.source === 'inferred' ? ['snag'] : []),
    ...(turn.revised?.source === 'inferred' ? ['after'] : []),
  ];
  if (turnBodyChars(card) > TURN_LIMIT) {
    const trimmed = adaptTurnCard(card, { trimRounds: 6 });
    Object.assign(card, trimmed.card);
    omitted.push(...trimmed.omitted);
  }
  card.badge = badgeOf(links);
  console.log(`出图前自检：${index > 1 ? `第 ${index}/${total} 张，` : ''}一年后只看到这张图，能想起这段对话吗？→ ${memory.reason}`);
  if (!memory.ok) throw new Error(`没出图：${memory.reason}`);
  const paraphrased = Object.entries(origins).filter(([, value]) => value === '归纳').map(([key]) => key);
  if (paraphrased.length) console.log(`有 ${paraphrased.length} 块不是逐字原话，已按归纳写进内容记录；画面不显示这个标记。`);
  if (omitted.length) {
    printOmissions(omitted);
    console.log(`已自动裁剪到 ${turnBodyChars(card)} 字，没有缩小字号。`);
  }
  await mkdir(outDir(), { recursive: true });
  const createdAt = now();
  const prefix = total > 1 ? `${p2(index)}_` : '';
  const base = outBase(argv, `${prefix}${fileStamp()}_${slug(card.title)}`);
  const payload = { ...card, id: turn.id, turn, createdAt, sourceFile, sourceChars: visibleLen(source), bodyChars: turnBodyChars(card), origins, omitted, memory, formats: argv.includes('--html-only') ? ['html'] : formats, status: status || 'draft', links };
  const tx = await reserveArtifact({ workspace: WS, base, fingerprint: sha(JSON.stringify(payload)) });
  if (tx.note) console.log(tx.note);
  try {
    let finalCard = card;
    let finalPlan = adaptTurnCard(card).plan;
    const qa = {};
    const layoutOmitted = [...omitted];
    if (argv.includes('--html-only')) {
      qa.html = { status: 'html-only', findings: ['未做浏览器实测'] };
      await tx.add(`${tx.stem}.html`, buildTurnHtml(finalCard, { plan: finalPlan }), { media: 'html' });
      console.log(`HTML 已生成：${join(outDir(), `${tx.stem}.html`)}（未截图，未做浏览器实测）`);
    } else {
      if (formats.includes('png')) {
        const staged = tx.path(`${tx.stem}.png`);
        const rendered = await renderTurnPng(finalCard, staged, { scale });
        finalCard = rendered.card;
        finalPlan = rendered.plan;
        layoutOmitted.push(...rendered.omitted);
        qa.png = rendered.qa;
        if (rendered.png) {
          await tx.add(`${tx.stem}.png`, await readFile(staged), { kind: 'binary', media: 'png', widthPx: rendered.widthPx, heightPx: rendered.heightPx });
          console.log(`PNG 已生成：${join(outDir(), `${tx.stem}.png`)}  (${rendered.widthPx}x${rendered.heightPx})`);
          console.log(`画面检查：正文 ${rendered.qa.metrics.bodyChars} 字；1080 稿正文 ${rendered.qa.metrics.bodyFontPx.join('/')}px；600px 宽约 ${rendered.qa.metrics.fontAt600Px.join('/')}px。`);
        } else {
          console.log(`PNG 降级为 HTML：${join(outDir(), `${tx.stem}.html`)}（浏览器实测未通过，未假装出图）`);
        }
      }
      if (formats.includes('svg')) {
        const adapted = adaptTurnCard(finalCard, { level: finalPlan.level, trimRounds: 0 });
        finalCard = adapted.card;
        await tx.add(`${tx.stem}.svg`, buildTurnSvg(finalCard, { plan: finalPlan }), { media: 'svg' });
        console.log(`SVG 已生成：${join(outDir(), `${tx.stem}.svg`)}`);
      }
      if (formats.includes('pdf')) {
        const staged = tx.path(`${tx.stem}.pdf`);
        const rendered = await renderTurnPdf(finalCard, staged);
        finalCard = rendered.card;
        finalPlan = rendered.plan;
        layoutOmitted.push(...rendered.omitted);
        qa.pdf = rendered.qa;
        await tx.add(`${tx.stem}.pdf`, await readFile(staged), { kind: 'binary', media: 'pdf' });
        console.log(`PDF 已生成：${join(outDir(), `${tx.stem}.pdf`)}（A4 单页）`);
      }
      await tx.add(`${tx.stem}.html`, buildTurnHtml(finalCard, { plan: finalPlan }), { media: 'html' });
    }
    Object.assign(card, finalCard);
    payload.bodyChars = turnBodyChars(card);
    payload.omitted = layoutOmitted;
    payload.qa = qa;
    await tx.add(`${tx.stem}.json`, JSON.stringify(payload, null, 2), { media: 'json' });
    if (source) await tx.add(`${tx.stem}.source.md`, source, { media: 'source' });
    const published = await tx.commit();
    const artifacts = {};
    for (const file of published.files) {
      const match = file.name.match(/\.(png|svg|pdf|html)$/i);
      if (match) artifacts[match[1].toLowerCase()] = file.file;
    }
    const saved = await upsertCard({ workspace: WS, turn, card, createdAt, source, sourceFile, artifacts, qa, status, links });
    await ensureProbes(WS, { now: Date.now() });
    console.log(`卡片库：${saved.id}（${saved.status}${saved.badge ? ` · ${saved.badge}` : ''}）`);
    console.log(`内容记录：${join(outDir(), `${tx.stem}.json`)}`);
    if (source) console.log(`归档原文：${join(outDir(), `${tx.stem}.source.md`)}`);
    return saved;
  } catch (error) {
    await tx.abort(String(error.message || error));
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  checkFlags(argv, FLAGS);
  WS = workdir(argv);
  const inVal = opt(argv, 'in', '');
  const specFile = opt(argv, 'spec', '');
  const demo = argv.includes('--demo');
  if (wantsHelp(argv) || (!specFile && !demo && !inVal)) {
    console.log(`用法：node scripts/make.mjs --in 内容.md [--out 名字]\n     node scripts/make.mjs --spec 转弯图.json [--in 原文.md]\n     node scripts/make.mjs --demo\n\n默认只出一种竖图：原以为 → 撞车 → 正解 → 一句带走。\n不需要 API key。正文最多 ${TURN_LIMIT} 字；超限自动删减并打印「未上图」。\n可选：--out 名字  --scale 2  --fmt png,svg,pdf  --html-only  --status draft|confirmed|revised\n　　--supersedes 旧id  --expands 旧id  --contradicts 旧id\n　　${WORKDIR_HELP}\n产物：<工作目录>/infographics/ 与 .knowledge/cards/。`);
    return 0;
  }
  const scale = Number(opt(argv, 'scale', '2'));
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('--scale 需要是正数。');
  const formats = [...new Set(opt(argv, 'fmt', 'png,svg,pdf').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (!formats.length || formats.some((item) => !['png', 'svg', 'pdf'].includes(item))) throw new Error('--fmt 只接受 png,svg,pdf 的组合。');
  const status = opt(argv, 'status', '');
  if (status && !['draft', 'confirmed', 'revised'].includes(status)) throw new Error('--status 只接受 draft、confirmed 或 revised。');
  const links = { supersedes: linkIds(argv, 'supersedes'), expands: linkIds(argv, 'expands'), contradicts: linkIds(argv, 'contradicts') };
  const template = opt(argv, 'template', '');
  let source = '';
  let sourceFile = '';
  const jobs = [];
  if (specFile) {
    let input;
    try { input = extractJson(await readFile(resolve(specFile), 'utf8')); }
    catch (error) { throw new Error(`读不到图规格：${resolve(specFile)}\n  ${error.message}`); }
    const src = opt(argv, 'source', '') || inVal;
    if (src) { source = await readSource(src); sourceFile = resolve(src); }
    const oldShape = input && (input.template || input.form || input.layout) && (input.template || input.form || input.layout) !== TURN_LAYOUT;
    if (template || oldShape) console.log('内容不是旧的固定版式，已自动换成四块转弯图。');
    jobs.push({ input });
  } else if (demo) {
    const result = demoCard();
    source = DEMO_SOURCE;
    sourceFile = '内置示例';
    console.log('这次使用内置示例（--demo），不是你的对话。');
    jobs.push({ input: result.card });
  } else {
    source = await readSource(inVal);
    sourceFile = resolve(inVal);
    const judged = judgeCollected(collectDialogue(source), { source });
    if (!judged.turns.length) {
      console.log(judged.message);
      for (const candidate of judged.candidates.slice(0, 8)) console.log(`候选：${candidate.collision?.display || candidate.prior?.display || ''}`);
      return 0;
    }
    for (const turn of judged.turns) jobs.push({ turn, input: { title: turn.title, before: turn.prior.text, snag: turn.collision.text, after: turn.revised.text, takeaway: turn.takeaway.text } });
    console.log(judged.message);
  }
  if (visibleLen(source) > 30000) throw new Error('这段内容超过 30000 字。请先选出包含一次完整转弯的片段。');
  if (!source && !jobs.length) throw new Error('没有读到内容，不能出图。');
  const saved = [];
  for (let index = 0; index < jobs.length; index++) {
    saved.push(await renderJob(jobs[index], { argv, formats, scale, source, sourceFile, demo, links, status, index: index + 1, total: jobs.length }));
  }
  const idx = await refreshIndex(WS);
  console.log(`图集已更新：${idx.page}`);
  console.log('OK');
  return 0;
}

startCli(import.meta.url, 'make', main);
