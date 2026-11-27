import { writeFile } from 'node:fs/promises';
import { launchBrowser, closeBrowser } from './browser.mjs';
import { TURN_LABELS, turnBodyChars, visibleLen } from './turn-card.mjs';

export const WIDTH = 1080;
export const HEIGHT = 1560;
export const VALIDATION_WIDTHS = Object.freeze([375, 768, 1080]);
export const TYPE_SCALE = Object.freeze({ title: 54, body: 38, label: 24, meta: 18 });
export const FONT_STEPS = Object.freeze([38, 36, 34, 33]);
const BLOCKS = ['before', 'snag', 'after', 'takeaway'];
const TRIM_WEIGHT = Object.freeze({ before: 0.7, snag: 0.8, after: 1, takeaway: 0.9 });
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function trimAtBoundary(value, amount) {
  const chars = [...String(value)];
  if (chars.length <= amount) return { text: '', omitted: chars.join('') };
  const cut = chars.length - amount;
  const window = chars.slice(Math.max(0, cut - 14), cut);
  const boundary = Math.max(window.lastIndexOf('。'), window.lastIndexOf('；'), window.lastIndexOf('，'), window.lastIndexOf('：'));
  const actualCut = boundary >= 0 ? Math.max(1, cut - 13 + boundary) : cut;
  const kept = chars.slice(0, actualCut).join('').replace(/[，。；：、,.!?;:\s]+$/, '');
  const omitted = chars.slice([...kept].length).join('').replace(/^[，。；：、,.!?;:\s]+/, '');
  if (/[A-Za-z0-9_]$/.test(kept) && /^[A-Za-z0-9_]/.test(omitted)) {
    const words = kept.match(/[A-Za-z0-9_]+$/);
    if (words) {
      const whole = `${words[0]}${omitted.match(/^[A-Za-z0-9_]+/)?.[0] || ''}`;
      const shortened = kept.slice(0, -words[0].length);
      if (shortened) return { text: shortened.replace(/[，。；：、,.!?;:\s]+$/, ''), omitted: `${whole}${omitted.slice((omitted.match(/^[A-Za-z0-9_]+/)?.[0] || '').length)}` };
    }
  }
  return { text: kept, omitted };
}

export function adaptTurnCard(input, { level = 0, trimRounds = 0, problemBlocks = [] } = {}) {
  const card = { ...input };
  const omitted = [];
  const step = Math.max(0, Math.min(FONT_STEPS.length - 1, level));
  const allowed = Array.isArray(problemBlocks) && problemBlocks.length ? new Set(problemBlocks) : null;
  for (let round = 0; round < trimRounds; round++) {
    const target = BLOCKS.filter((key) => (!allowed || allowed.has(key)) && visibleLen(card[key]) > 20)
      .sort((a, b) => TRIM_WEIGHT[a] - TRIM_WEIGHT[b] || visibleLen(card[b]) - visibleLen(card[a]))[0];
    if (!target) break;
    const trimmed = trimAtBoundary(card[target], 12);
    if (!trimmed.omitted) break;
    card[target] = trimmed.text;
    omitted.push({ block: TURN_LABELS[target], text: trimmed.omitted, reason: '排版高度不足，按信息权重裁剪' });
  }
  return {
    card,
    omitted,
    plan: {
      level: step,
      bodyFontPx: FONT_STEPS[step],
      narrow: step >= 2,
      minHeightPx: HEIGHT,
    },
  };
}

export function buildTurnHtml(card, { height = HEIGHT, plan } = {}) {
  const bodyFont = plan?.bodyFontPx || TYPE_SCALE.body;
  const narrow = plan?.narrow ? ' data-layout="narrow"' : '';
  const minHeight = Math.max(720, Number(height) || HEIGHT);
  const block = (key) => {
    const label = TURN_LABELS[key];
    const inferred = Array.isArray(card.inferredBlocks) && card.inferredBlocks.includes(key);
    return `<section class="turn-block ${key}" data-turn-block="${key}"><div class="turn-label">${label}${inferred ? '<span class="inference">推断</span>' : ''}</div><div class="turn-text" data-body-text="${key}">${esc(card[key])}</div></section>`;
  };
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(card.title)}</title><style>
  :root{--ink:#17181c;--muted:#5c626e;--brand:#2f5cff;--line:#dce2ee;--paper:#fff;--wash:#f5f7fc;--warn:#a86400;--warn-bg:#fff7e9;--body:${bodyFont}px;--title:clamp(32px,5vw,54px);--label:clamp(18px,2.23vw,24px);--meta:clamp(13px,1.67vw,18px);--pad-x:clamp(20px,5.93vw,64px);--pad-y:clamp(28px,5.56vw,60px);--gap:clamp(12px,2.04vw,22px);--block-x:clamp(18px,2.96vw,32px);--block-y:clamp(18px,2.41vw,26px);--radius:clamp(10px,1.48vw,16px)}
  *{box-sizing:border-box;margin:0;padding:0}html,body{background:#fff}body{font-family:"Microsoft YaHei","PingFang SC","Noto Sans SC","Source Han Sans SC",sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}
  #canvas{position:relative;width:100%;max-width:1080px;min-height:max(720px,${(minHeight / WIDTH * 100).toFixed(3)}vw);margin:0 auto;padding:var(--pad-y) var(--pad-x) calc(var(--pad-y) + 34px);background:var(--paper);display:flex;flex-direction:column;overflow:visible}
  .signature{position:absolute;right:var(--pad-x);bottom:clamp(14px,2.41vw,26px);font-size:var(--meta);line-height:1.2;font-weight:500;color:#8a8f98;letter-spacing:.2px}
  .badge{position:absolute;right:var(--pad-x);top:var(--pad-y);max-width:42%;background:#fff7e9;color:#a86400;border:1px solid #efd6aa;border-radius:999px;padding:clamp(5px,.6vw,7px) clamp(9px,1vw,12px);font-size:var(--meta);line-height:1.2;font-weight:700}
  h1{font-size:var(--title);line-height:1.22;font-weight:800;letter-spacing:-.5px;overflow-wrap:normal;word-break:normal;line-break:strict;text-wrap:balance;flex:0 0 auto;padding-right:${card.badge ? '32%' : '0'}}
  .turn-body{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto;gap:var(--gap);margin-top:clamp(22px,3.15vw,34px);flex:0 0 auto}
  .turn-block{border:1px solid var(--line);border-left:clamp(5px,.74vw,8px) solid #aab3c3;border-radius:var(--radius);padding:var(--block-y) var(--block-x);background:var(--wash);min-width:0}
  .turn-label{font-size:var(--label);line-height:1.2;font-weight:800;letter-spacing:2px;color:var(--muted);margin-bottom:clamp(9px,1.3vw,14px)}
  .inference{display:inline-block;margin-left:10px;padding:2px 7px;border:1px solid #efd6aa;border-radius:999px;background:#fff7e9;color:#a86400;font-size:clamp(11px,1.3vw,15px);line-height:1.2;font-weight:700;letter-spacing:0;vertical-align:2px}
  .turn-text{font-size:var(--body);line-height:1.38;font-weight:600;overflow-wrap:normal;word-break:normal;line-break:strict;text-wrap:pretty;white-space:normal}
  .snag{background:var(--warn-bg);border-color:#efd6aa;border-left-color:var(--warn)}.snag .turn-label{color:var(--warn)}
  .after{background:#edf2ff;border-color:#ccd8ff;border-left-color:var(--brand)}.after .turn-label{color:var(--brand)}
  .takeaway{background:var(--ink);border-color:var(--ink);color:#fff}.takeaway .turn-label{color:#ffd666}.takeaway .turn-text{text-wrap:balance}
  #canvas[data-layout="narrow"]{--pad-x:clamp(18px,4vw,42px);--pad-y:clamp(24px,4vw,44px);--gap:clamp(10px,1.4vw,15px);--block-x:clamp(16px,2.2vw,24px);--block-y:clamp(15px,1.8vw,20px)}
  @page{size:A4;margin:10mm}
  </style></head><body><main id="canvas"${narrow}>${card.badge ? `<div class="badge">${esc(card.badge)}</div>` : ''}<h1 data-title>${esc(card.title)}</h1><div class="turn-body">${BLOCKS.map(block).join('')}</div><div class="signature">@han5810xy · make-infographic</div></main></body></html>`;
}

export async function measureTurnPage(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#canvas');
    const cr = canvas.getBoundingClientRect();
    const textRect = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      return { x: r.left - cr.left, y: r.top - cr.top, w: r.width, h: r.height };
    };
    const lineInfo = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      const widths = rects.map((r) => r.width);
      return {
        lines: rects.length || 1,
        lastLineRatio: widths.length ? Math.round((widths[widths.length - 1] / Math.max(...widths)) * 100) / 100 : 1,
      };
    };
    const blocks = [...document.querySelectorAll('[data-turn-block]')].map((el) => {
      const text = el.querySelector('[data-body-text]');
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(text);
      return {
        key: el.dataset.turnBlock,
        label: el.querySelector('.turn-label').textContent.trim(),
        text: text.textContent.trim(),
        rect: { x: r.left - cr.left, y: r.top - cr.top, w: r.width, h: r.height },
        textRect: textRect(text),
        font: parseFloat(style.fontSize),
        lineHeight: parseFloat(style.lineHeight),
        scrollW: text.scrollWidth,
        clientW: text.clientWidth,
        scrollH: text.scrollHeight,
        clientH: text.clientHeight,
        emphasized: text.querySelectorAll('strong,em').length,
        ...lineInfo(text),
      };
    });
    const title = document.querySelector('[data-title]');
    const titleStyle = getComputedStyle(title);
    const labelStyle = getComputedStyle(document.querySelector('.turn-label'));
    const metaStyle = getComputedStyle(document.querySelector('.signature'));
    const c = document.createElement('canvas').getContext('2d');
    const font = getComputedStyle(document.body).fontFamily;
    c.font = `24px ${font}`;
    const han = c.measureText('记忆结构').width;
    const tofu = c.measureText('\uE000\uE001\uE002\uE003').width;
    return {
      canvas: { w: cr.width, h: cr.height },
      canvasScrollW: canvas.scrollWidth,
      canvasClientW: canvas.clientWidth,
      title: title.textContent.trim(),
      titleRect: textRect(title),
      titleLines: lineInfo(title).lines,
      typeScale: [parseFloat(titleStyle.fontSize), parseFloat(getComputedStyle(document.querySelector('.turn-text')).fontSize), parseFloat(labelStyle.fontSize), parseFloat(metaStyle.fontSize)],
      blocks,
      pageText: document.body.innerText,
      fontOk: han > 0 && Math.abs(han - tofu) > 1,
    };
  });
}

export function judgeTurn(obs, card, { width = WIDTH, minFontAt600 = 18 } = {}) {
  const findings = [];
  const problemBlocks = [];
  const flag = (key, message) => { findings.push(message); if (key) problemBlocks.push(key); };
  if (obs.blocks.length !== 4) findings.push(`画面应有四块，实测 ${obs.blocks.length} 块。`);
  for (const b of obs.blocks) {
    if (!b.text.trim()) flag(b.key, `「${b.label}」是空的。`);
    if (b.font * 600 / width < minFontAt600) flag(b.key, `「${b.label}」缩到 600px 后只有 ${(b.font * 600 / width).toFixed(1)}px。`);
    if (b.scrollW > b.clientW + 1 || b.scrollH > b.clientH + 1) flag(b.key, `「${b.label}」文字溢出。`);
    if (b.textRect.x < b.rect.x - 1 || b.textRect.y < b.rect.y - 1 || b.textRect.x + b.textRect.w > b.rect.x + b.rect.w + 1 || b.textRect.y + b.textRect.h > b.rect.y + b.rect.h + 1)
      flag(b.key, `「${b.label}」文字超出色块。`);
    if (b.lines > 1 && b.lastLineRatio < 0.28) flag(b.key, `「${b.label}」最后一行太短，像孤行。`);
    if (/^[，。！？；：、,.!?;:]/.test(b.text)) flag(b.key, `「${b.label}」行首是标点。`);
    if (/[“「『（【]$/.test(b.text)) flag(b.key, `「${b.label}」行尾留着未闭合的引号或括号。`);
    if (b.emphasized > 1) flag(b.key, `「${b.label}」强调超过一处。`);
  }
  if (obs.canvasScrollW > obs.canvasClientW + 1) findings.push('画布有横向溢出。');
  if (obs.titleRect.x < -1 || obs.titleRect.y < -1 || obs.titleRect.x + obs.titleRect.w > width + 1) findings.push('标题超出画布。');
  if (!obs.fontOk) findings.push('中文字体没有正常加载。');
  if (new Set(obs.typeScale.map((n) => Math.round(n))).size < 3) findings.push('字号阶梯不足四级。');
  if (/\b(?:units|relations|coverage)\b|差别｜|依据｜|归纳｜/i.test(obs.pageText)) findings.push('画面出现内部字段名。');
  if (/…|\.{3,}|。{3,}/.test(obs.pageText)) findings.push('画面出现省略号。');
  const chars = turnBodyChars(card);
  if (chars > 300) findings.push(`可见正文 ${chars} 字，超过 300 字。`);
  return {
    findings,
    problemBlocks: [...new Set(problemBlocks)],
    metrics: {
      width,
      height: Math.round(obs.canvas.h),
      bodyChars: chars,
      bodyFontPx: obs.blocks.map((b) => b.font),
      fontAt600Px: obs.blocks.map((b) => Math.round(b.font * 600 / width * 10) / 10),
      lines: obs.blocks.map((b) => b.lines),
      lastLineRatio: obs.blocks.map((b) => b.lastLineRatio),
      typeScale: obs.typeScale,
    },
  };
}

async function fitInBrowser(page, card, width) {
  let last = null;
  let previousProblems = [];
  for (let level = 0; level < FONT_STEPS.length; level++) {
    previousProblems = [];
    for (let trimRounds = 0; trimRounds <= 6; trimRounds++) {
      const adapted = adaptTurnCard(card, { level, trimRounds, problemBlocks: previousProblems });
      await page.setContent(buildTurnHtml(adapted.card, { plan: adapted.plan }), { waitUntil: 'load' });
      await page.evaluateHandle('document.fonts.ready');
      const obs = await measureTurnPage(page);
      const qa = judgeTurn(obs, adapted.card, { width });
      previousProblems = qa.problemBlocks;
      last = { ...adapted, obs, qa };
      if (!qa.findings.length) return last;
    }
  }
  return last;
}

export async function renderTurnPng(card, outPath, { scale = 2, height = HEIGHT } = {}) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height, deviceScaleFactor: scale });
    const fitted = await fitInBrowser(page, card, WIDTH);
    if (fitted.qa.findings.length) {
      const htmlPath = outPath.replace(/\.png$/i, '.html');
      await writeFile(htmlPath, buildTurnHtml(fitted.card, { height, plan: fitted.plan }), 'utf8');
      return { png: false, htmlPath, degraded: true, card: fitted.card, plan: fitted.plan, omitted: fitted.omitted, qa: fitted.qa };
    }
    await page.screenshot({ path: outPath, fullPage: false });
    return { png: true, widthPx: WIDTH * scale, heightPx: Math.round(fitted.obs.canvas.h) * scale, card: fitted.card, plan: fitted.plan, omitted: fitted.omitted, qa: fitted.qa };
  } finally {
    await closeBrowser(browser);
  }
}

function textUnits(value) {
  return [...String(value)].map((char) => ({ char, width: /[\u2E80-\u9FFF\uF900-\uFAFF]/.test(char) ? 1 : /[A-Za-z0-9]/.test(char) ? 0.56 : 0.42 }));
}

function wrapSvgText(value, maxWidth, fontSize) {
  const lines = [];
  let line = '';
  let width = 0;
  for (const unit of textUnits(value)) {
    const next = unit.width * fontSize;
    if (line && width + next > maxWidth) {
      lines.push(line);
      line = unit.char;
      width = next;
    } else {
      line += unit.char;
      width += next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

export function buildTurnSvg(card, { plan } = {}) {
  const width = WIDTH;
  const padX = plan?.narrow ? 42 : 64;
  const padY = plan?.narrow ? 44 : 60;
  const gap = plan?.narrow ? 15 : 22;
  const bodyFont = plan?.bodyFontPx || TYPE_SCALE.body;
  const titleLines = wrapSvgText(card.title, width - padX * 2 - (card.badge ? 240 : 0), TYPE_SCALE.title);
  const lineHeight = Math.round(bodyFont * 1.38);
  const wrapped = Object.fromEntries(BLOCKS.map((key) => [key, wrapSvgText(card[key], width - padX * 2 - 64, bodyFont)]));
  const blockHeights = Object.fromEntries(BLOCKS.map((key) => [key, 26 + 29 + 14 + wrapped[key].length * lineHeight + 26]));
  const bodyHeight = BLOCKS.reduce((sum, key) => sum + blockHeights[key], 0) + gap * 3;
  const height = Math.max(HEIGHT, padY + titleLines.length * 66 + 34 + bodyHeight + 96);
  const colors = {
    before: { bg: '#f5f7fc', border: '#dce2ee', accent: '#aab3c3', text: '#17181c', label: '#5c626e' },
    snag: { bg: '#fff7e9', border: '#efd6aa', accent: '#a86400', text: '#17181c', label: '#a86400' },
    after: { bg: '#edf2ff', border: '#ccd8ff', accent: '#2f5cff', text: '#17181c', label: '#2f5cff' },
    takeaway: { bg: '#17181c', border: '#17181c', accent: '#17181c', text: '#ffffff', label: '#ffd666' },
  };
  let y = padY;
  const title = titleLines.map((line, index) => `<text x="${padX}" y="${y + 54 + index * 66}" font-size="54" font-weight="800" fill="#17181c">${esc(line)}</text>`).join('');
  y += titleLines.length * 66 + 34;
  const blocks = BLOCKS.map((key) => {
    const c = colors[key];
    const h = blockHeights[key];
    const textY = y + 26 + 29 + 14 + bodyFont;
    const lines = wrapped[key].map((line, index) => `<text x="${padX + 32}" y="${textY + index * lineHeight}" font-size="${bodyFont}" font-weight="600" fill="${c.text}">${esc(line)}</text>`).join('');
    const inferred = Array.isArray(card.inferredBlocks) && card.inferredBlocks.includes(key);
    const svg = `<g data-turn-block="${key}"><rect x="${padX}" y="${y}" width="${width - padX * 2}" height="${h}" rx="16" fill="${c.bg}" stroke="${c.border}"/><rect x="${padX}" y="${y}" width="8" height="${h}" rx="4" fill="${c.accent}"/><text x="${padX + 32}" y="${y + 26 + 24}" font-size="24" font-weight="800" letter-spacing="2" fill="${c.label}">${TURN_LABELS[key]}</text>${inferred ? `<g><rect x="${padX + 108}" y="${y + 20}" width="62" height="30" rx="15" fill="#fff7e9" stroke="#efd6aa"/><text x="${padX + 139}" y="${y + 41}" text-anchor="middle" font-size="15" font-weight="700" fill="#a86400">推断</text></g>` : ''}${lines}</g>`;
    y += h + gap;
    return svg;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(card.title)}"><rect width="100%" height="100%" fill="#fff"/><style>text{font-family:"Microsoft YaHei","PingFang SC","Noto Sans SC","Source Han Sans SC",sans-serif}</style>${card.badge ? `<g><rect x="${width - padX - Math.min(300, [...card.badge].length * 18 + 24)}" y="${padY}" width="${Math.min(300, [...card.badge].length * 18 + 24)}" height="38" rx="19" fill="#fff7e9" stroke="#efd6aa"/><text x="${width - padX - 12}" y="${padY + 25}" text-anchor="end" font-size="18" font-weight="700" fill="#a86400">${esc(card.badge)}</text></g>` : ''}${title}${blocks}<text x="${width - padX}" y="${height - 26}" text-anchor="end" font-size="18" font-weight="500" fill="#8a8f98">@han5810xy · make-infographic</text></svg>`;
}

export async function renderTurnPdf(card, outPath) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
    const fitted = await fitInBrowser(page, card, WIDTH);
    const scale = Math.min(0.66, 1030 / Math.max(1, fitted.obs.canvas.h));
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, preferCSSPageSize: true, scale });
    return { pdf: true, card: fitted.card, plan: fitted.plan, omitted: fitted.omitted, qa: fitted.qa, scale };
  } finally {
    await closeBrowser(browser);
  }
}

export async function validateTurnWidths(card, { widths = VALIDATION_WIDTHS, screenshotDir = '' } = {}) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const results = [];
    for (const width of widths) {
      await page.setViewport({ width, height: 1200, deviceScaleFactor: 1 });
      const fitted = await fitInBrowser(page, card, width);
      if (screenshotDir) {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(screenshotDir, { recursive: true });
        await page.screenshot({ path: `${screenshotDir.replace(/[\\/]$/, '')}/${width}.png`, fullPage: true });
      }
      results.push({ width, ...fitted.qa, card: fitted.card, omitted: fitted.omitted });
    }
    return { pass: results.every((item) => !item.findings.length), results };
  } finally {
    await closeBrowser(browser);
  }
}
