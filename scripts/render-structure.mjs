import { writeFile } from 'node:fs/promises';
import { launchBrowser, closeBrowser } from './browser.mjs';
import { VISUAL_SYNTAX, shapeFor, lineFor } from './visual-syntax.mjs';

export const CANVAS_W = 1200;
const FONT = '"Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif';
const COLORS = Object.freeze({
  blue: '#2f5cff', blueBg: '#edf2ff', orange: '#a86400', orangeBg: '#fff7e9',
  red: '#b42318', redBg: '#fff0ec', gray: '#8b93a5', grayBg: '#f5f7fc',
  ink: '#17181c', white: '#ffffff', line: '#dce2ee',
});
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function charWidth(char) {
  if (/[\u2E80-\u9FFF\uF900-\uFAFF]/.test(char)) return 1;
  if (/[A-Za-z0-9]/.test(char)) return 0.58;
  return 0.42;
}

export function wrapText(text, maxWidth, fontSize = 30) {
  const plain = String(text || '').replace(/\*\*/g, '').replace(/`/g, '');
  const tokens = plain.match(/[A-Za-z0-9@./%+\-]+|\s|[^\s]/g) || [];
  const lines = [];
  let line = '';
  let width = 0;
  for (const token of tokens) {
    const tokenWidth = [...token].reduce((sum, char) => sum + charWidth(char), 0) * fontSize;
    if (line && width + tokenWidth > maxWidth) {
      lines.push(line.trimEnd());
      line = token.trimStart();
      width = [...line].reduce((sum, char) => sum + charWidth(char), 0) * fontSize;
    } else {
      line += token;
      width += tokenWidth;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  if (lines.length > 1 && [...lines.at(-1)].length === 1) {
    const previous = [...lines[lines.length - 2]];
    lines[lines.length - 2] = previous.slice(0, -1).join('');
    lines[lines.length - 1] = previous.at(-1) + lines[lines.length - 1];
  }
  return lines.length ? lines : [''];
}

function shapeOf(proposition) {
  return shapeFor(proposition);
}

function toneOf(proposition, structure) {
  const refuted = (structure.relations || []).some((relation) => relation.kind === '反驳' && relation.from === proposition.id);
  const corrected = (structure.relations || []).some((relation) => relation.kind === '反驳' && relation.to === proposition.id);
  if (refuted) return { fill: COLORS.redBg, stroke: COLORS.red, ink: COLORS.red };
  if (corrected) return { fill: COLORS.blueBg, stroke: COLORS.blue, ink: COLORS.ink };
  if (proposition.kind === '例外' || (structure.relations || []).some((relation) => relation.kind === '转折' && relation.to === proposition.id)) return { fill: COLORS.orangeBg, stroke: COLORS.orange, ink: COLORS.ink };
  if (structure.backbone?.includes(proposition.id)) {
    const index = structure.backbone.indexOf(proposition.id);
    if (index === structure.backbone.length - 1) return { fill: COLORS.ink, stroke: COLORS.ink, ink: COLORS.white };
    return { fill: COLORS.blueBg, stroke: COLORS.blue, ink: COLORS.ink };
  }
  return { fill: COLORS.grayBg, stroke: COLORS.gray, ink: COLORS.ink };
}

function nodeGeometry(proposition, x, y, w = 300) {
  const shape = shapeOf(proposition);
  const fontSize = shape === 'diamond' ? 26 : shape === 'circle' ? 32 : 34;
  const textWidth = shape === 'diamond' ? w * 0.58 : w - 48;
  const lines = wrapText(proposition.text, textWidth, fontSize);
  const lineHeight = fontSize + 12;
  const h = Math.max(shape === 'diamond' ? 170 : 132, 64 + lines.length * lineHeight);
  return { proposition, x, y, w, h, lines, shape, fontSize, lineHeight, tone: toneOf(proposition, proposition.__structure) };
}

function attachStructure(structure) {
  return structure.propositions.map((proposition) => ({ ...proposition, __structure: structure }));
}

function chainLayout(propositions, view = {}) {
  if (propositions.length <= 4) {
    const count = propositions.length;
    const w = count <= 3 ? 300 : 260;
    const gap = count <= 3 ? 90 : 42;
    const totalW = count * w + (count - 1) * gap;
    const startX = (CANVAS_W - totalW) / 2;
    const nodes = propositions.map((proposition, index) => nodeGeometry(proposition, startX + index * (w + gap), 250, w));
    const evidence = nodes.map((node) => {
      const quotes = view.props?.evidence?.[node.proposition.id] || [];
      const lines = quotes.length ? wrapText(quotes[0], node.w - 36, 17) : [];
      const h = lines.length ? 54 + lines.length * 25 : 0;
      return { propositionId: node.proposition.id, x: node.x, y: node.y + node.h + 42, w: node.w, h, lines };
    });
    const bottom = Math.max(...evidence.map((item) => item.y + item.h), 600);
    return { nodes, evidence, height: bottom + 190, takeaway: view.target?.startsWith('branch:') ? propositions[0]?.text || '' : propositions.at(-1)?.text || '' };
  }
  const nodes = [];
  const evidence = [];
  let y = 150;
  for (const proposition of propositions) {
    const node = nodeGeometry(proposition, (CANVAS_W - 340) / 2, y, 340);
    nodes.push(node);
    const quotes = view.props?.evidence?.[proposition.id] || [];
    const lines = quotes.length ? wrapText(quotes[0], 640, 17) : [];
    const h = lines.length ? 50 + lines.length * 24 : 0;
    evidence.push({ propositionId: proposition.id, x: (CANVAS_W - 680) / 2, y: node.y + node.h + 28, w: 680, h, lines });
    y = node.y + node.h + 70 + h;
  }
  return { nodes, evidence, height: y + 150, takeaway: view.target?.startsWith('branch:') ? propositions[0]?.text || '' : propositions.at(-1)?.text || '' };
}

function treeLayout(propositions, relations) {
  const ids = propositions.map((item) => item.id);
  const incoming = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  for (const relation of relations) {
    if (!incoming.has(relation.from) || !incoming.has(relation.to)) continue;
    const from = relation.kind === '包含' ? relation.to : relation.from;
    const to = relation.kind === '包含' ? relation.from : relation.to;
    incoming.set(to, incoming.get(to) + 1);
    outgoing.get(from).push(to);
  }
  const roots = ids.filter((id) => incoming.get(id) === 0);
  const rootId = roots[0] || ids[0];
  const depth = new Map([[rootId, 0]]);
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift();
    for (const next of outgoing.get(current) || []) {
      if (!depth.has(next)) { depth.set(next, depth.get(current) + 1); queue.push(next); }
    }
  }
  for (const id of ids) if (!depth.has(id)) depth.set(id, 1);
  const levels = new Map();
  for (const id of ids) {
    const d = depth.get(id);
    if (!levels.has(d)) levels.set(d, []);
    levels.get(d).push(id);
  }
  const byId = new Map(propositions.map((item) => [item.id, item]));
  const nodes = [];
  let y = 140;
  for (const d of [...levels.keys()].sort((a, b) => a - b)) {
    const group = levels.get(d);
    const gap = 28;
    const totalW = group.length * 300 + (group.length - 1) * gap;
    let x = (CANVAS_W - totalW) / 2;
    for (const id of group) {
      nodes.push(nodeGeometry(byId.get(id), x, y));
      x += 300 + gap;
    }
    y += 190;
  }
  return { nodes, height: y + 80 };
}

function circularLayout(propositions, cycle = false) {
  const nodes = [];
  const radiusX = 390;
  const radiusY = 430;
  const centerX = CANVAS_W / 2;
  const centerY = 620;
  propositions.forEach((proposition, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / propositions.length;
    const node = nodeGeometry(proposition, centerX + Math.cos(angle) * radiusX - 150, centerY + Math.sin(angle) * radiusY - 58, 300);
    nodes.push(node);
  });
  return { nodes, height: 1220, cycle };
}

function matrixLayout(propositions) {
  const nodes = [];
  const cols = propositions.length <= 4 ? 2 : 3;
  const w = cols === 2 ? 420 : 300;
  const gap = 40;
  const totalW = cols * w + (cols - 1) * gap;
  const startX = (CANVAS_W - totalW) / 2;
  propositions.forEach((proposition, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    nodes.push(nodeGeometry(proposition, startX + col * (w + gap), 160 + row * 230, w));
  });
  return { nodes, height: 160 + Math.ceil(propositions.length / cols) * 230 + 80 };
}

function forestLayout(structure, view) {
  const ids = view.props.propositionIds;
  const byId = new Map(attachStructure(structure).map((item) => [item.id, item]));
  const adjacency = new Map(ids.map((id) => [id, []]));
  for (const relation of structure.relations || []) {
    if (ids.includes(relation.from) && ids.includes(relation.to)) {
      adjacency.get(relation.from).push(relation.to);
      adjacency.get(relation.to).push(relation.from);
    }
  }
  const seen = new Set();
  const groups = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const group = [];
    const queue = [id];
    seen.add(id);
    while (queue.length) {
      const current = queue.shift();
      group.push(current);
      for (const next of adjacency.get(current) || []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    groups.push(group);
  }
  const nodes = [];
  groups.forEach((group, groupIndex) => {
    const x = 60 + groupIndex * (360 + 30);
    let y = 160;
    for (const id of group) {
      const node = nodeGeometry(byId.get(id), x, y, 300);
      nodes.push(node);
      y += node.h + 55;
    }
  });
  return { nodes, height: Math.max(700, ...nodes.map((node) => node.y + node.h)) + 100 };
}

function atlasLayout(structure, view) {
  const byId = new Map(attachStructure(structure).map((item) => [item.id, item]));
  const backboneIds = structure.backbone?.length ? structure.backbone : structure.propositions.map((item) => item.id);
  const branchIds = structure.propositions.map((item) => item.id).filter((id) => !backboneIds.includes(id));
  const count = backboneIds.length;
  const w = count <= 4 ? 260 : 220;
  const gap = count <= 4 ? 30 : 18;
  const totalW = count * w + (count - 1) * gap;
  const startX = (CANVAS_W - totalW) / 2;
  const nodes = backboneIds.map((id, index) => nodeGeometry(byId.get(id), startX + index * (w + gap), 390, w));
  const topBranches = branchIds.slice(0, 4);
  const bottomBranches = branchIds.slice(4, 8);
  topBranches.forEach((id, index) => nodes.push(nodeGeometry(byId.get(id), startX + index * (w + gap), 170, w)));
  bottomBranches.forEach((id, index) => nodes.push(nodeGeometry(byId.get(id), startX + index * (w + gap), 790, w)));
  const evidence = nodes.filter((node) => backboneIds.includes(node.proposition.id)).map((node) => {
    const quotes = view.props?.evidence?.[node.proposition.id] || [];
    const lines = quotes.length ? wrapText(quotes[0], node.w - 36, 16) : [];
    const h = lines.length ? 50 + lines.length * 23 : 0;
    return { propositionId: node.proposition.id, x: node.x, y: node.y + node.h + 34, w: node.w, h, lines };
  });
  const bottom = Math.max(...nodes.map((node) => node.y + node.h), ...evidence.map((item) => item.y + item.h), 700);
  return { nodes, evidence, height: bottom + 190, takeaway: backboneIds.at(-1) ? byId.get(backboneIds.at(-1))?.text || '' : '' };
}

function layout(structure, view) {
  const byId = new Map(attachStructure(structure).map((item) => [item.id, item]));
  const propositions = (view.props.propositionIds || []).map((id) => byId.get(id)).filter(Boolean);
  const relations = (structure.relations || []).filter((relation) => view.props.propositionIds.includes(relation.from) && view.props.propositionIds.includes(relation.to));
  if (view.props?.layout === 'atlas') return atlasLayout(structure, view);
  if (view.graphic === 'turn-band') {
    const roles = ['原以为', '撞车', '正解', '一句带走'];
    propositions.forEach((proposition, index) => { proposition.__viewRole = roles[index] || '命题'; });
    return chainLayout(propositions, view);
  }
  if (view.graphic === 'flow') return chainLayout(propositions, view);
  if (view.graphic === 'tree') return structure.topo === 'forest' ? forestLayout(structure, view) : treeLayout(propositions, relations);
  if (view.graphic === 'matrix') return matrixLayout(propositions);
  return circularLayout(propositions, structure.topo === 'cycle');
}

function edgeStyle(kind) {
  const line = lineFor(kind);
  return {
    color: line.color,
    dash: line.dash,
    marker: kind === '包含' ? '' : kind === '对比' ? 'gray' : kind === '条件' || kind === '转折' ? 'orange' : kind === '反驳' ? 'red' : 'blue',
    double: kind === '对比',
    bracket: kind === '包含',
    width: line.width,
  };
}

function center(node) { return { x: node.x + node.w / 2, y: node.y + node.h / 2 }; }

function edgePath(from, to, kind, view) {
  const a = center(from);
  const b = center(to);
  if (view?.props?.layout === 'atlas') {
    const midY = (a.y + b.y) / 2;
    return `M ${a.x} ${a.y} L ${a.x} ${midY} L ${b.x} ${midY} L ${b.x} ${b.y}`;
  }
  if (kind === '条件') {
    const midY = (a.y + b.y) / 2;
    return `M ${a.x} ${a.y} L ${a.x} ${midY} L ${b.x} ${midY} L ${b.x} ${b.y}`;
  }
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
}

function nodeSvg(node) {
  const { x, y, w, h, shape, tone, lines, proposition } = node;
  const common = `fill="${tone.fill}" stroke="${tone.stroke}" stroke-width="3"`;
  let shapeSvg = '';
  if (shape === 'circle') shapeSvg = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${common}/>`;
  else if (shape === 'diamond') shapeSvg = `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" ${common}/>`;
  else if (shape === 'hexagon') shapeSvg = `<polygon points="${x + 24},${y} ${x + w - 24},${y} ${x + w},${y + h / 2} ${x + w - 24},${y + h} ${x + 24},${y + h} ${x},${y + h / 2}" ${common}/>`;
  else shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" ${common}${proposition.provenance === 'inferred' ? ' stroke-dasharray="10 7"' : ''}/>`;
  const firstY = y + (h - lines.length * node.lineHeight) / 2 + node.fontSize;
  const text = lines.map((line, index) => `<tspan x="${x + w / 2}" dy="${index ? node.lineHeight : 0}">${esc(line)}</tspan>`).join('');
  const badge = proposition.provenance === 'quote' ? '原话' : proposition.provenance === 'summary' ? '归纳' : '推断';
  const structure = proposition.__structure;
  const refuted = structure?.relations?.some((relation) => relation.kind === '反驳' && relation.from === proposition.id);
  const corrected = structure?.relations?.some((relation) => relation.kind === '反驳' && relation.to === proposition.id);
  const role = proposition.__viewRole || (refuted ? '旧判断' : corrected ? '纠正' : structure?.backbone?.includes(proposition.id) ? '主干' : '分支');
  return `${shapeSvg}<text data-node-id="${esc(proposition.id)}" x="${x + w / 2}" y="${firstY}" text-anchor="middle" font-family="${FONT}" font-size="${node.fontSize}" font-weight="700" fill="${tone.ink}">${text}</text><text x="${x + w - 14}" y="${y + 22}" text-anchor="end" font-family="${FONT}" font-size="15" font-weight="700" fill="${tone.fill === COLORS.ink ? '#ffd666' : tone.stroke}">${role} · ${esc(proposition.id.split('_')[0])} · ${badge}</text>`;
}

export function buildStructureSvg(structure, view) {
  const { nodes, height: layoutHeight, evidence = [], takeaway = '' } = layout(structure, view);
  const byId = new Map(nodes.map((node) => [node.proposition.id, node]));
  const relationIds = new Set(view.props.relationIds || []);
  const relations = (structure.relations || []).filter((relation) => relationIds.has(relation.id) && byId.has(relation.from) && byId.has(relation.to));
  const defs = ['blue', 'gray', 'orange', 'red'].map((color) => `<marker id="arrow-${color}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${COLORS[color]}"/></marker>`).join('');
  const edges = relations.map((relation) => {
    const from = byId.get(relation.from);
    const to = byId.get(relation.to);
    const style = edgeStyle(relation.kind);
    const d = edgePath(from, to, relation.kind, view);
    const a = center(from); const b = center(to);
    const label = `<g><rect x="${(a.x + b.x) / 2 - 38}" y="${(a.y + b.y) / 2 - 17}" width="76" height="30" rx="15" fill="#fff" stroke="${style.color}"/><text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="15" font-weight="700" fill="${style.color}">${esc(relation.kind)}</text></g>`;
    if (style.bracket) {
      return `<path data-edge-id="${esc(relation.id)}" data-kind="包含" d="M ${a.x} ${a.y - 18} L ${b.x} ${b.y - 18} M ${a.x} ${a.y - 18} L ${a.x} ${a.y + 18} M ${b.x} ${b.y - 18} L ${b.x} ${b.y + 18}" fill="none" stroke="${style.color}" stroke-width="3"/>`;
    }
    return `<path data-edge-id="${esc(relation.id)}" data-kind="${esc(relation.kind)}" d="${d}" fill="none" stroke="${style.color}" stroke-width="${style.width}"${style.dash ? ` stroke-dasharray="${style.dash}"` : ''} marker-end="url(#arrow-${style.marker})"${style.double ? ' marker-start="url(#arrow-gray)"' : ''}/>${label}`;
  }).join('');
  const gaps = (structure.gaps || []).slice(0, 3);
  const gapHeight = gaps.length ? 70 + gaps.length * 54 : 0;
  const height = Math.max(layoutHeight, 900) + gapHeight;
  const evidenceSvg = evidence.filter((item) => item.lines.length).map((item) => {
    const node = byId.get(item.propositionId);
    const connector = node ? `<line x1="${node.x + node.w / 2}" y1="${node.y + node.h}" x2="${item.x + item.w / 2}" y2="${item.y}" stroke="${COLORS.line}" stroke-width="2"/>` : '';
    const lines = item.lines.map((line, index) => `<tspan x="${item.x + 18}" dy="${index ? 25 : 0}">${esc(line)}</tspan>`).join('');
    return `${connector}<rect x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" rx="12" fill="#f8fafc" stroke="${COLORS.line}"/><text x="${item.x + 18}" y="${item.y + 26}" font-family="${FONT}" font-size="14" font-weight="800" fill="${COLORS.gray}">证据</text><text x="${item.x + 18}" y="${item.y + 52}" font-family="${FONT}" font-size="17" fill="${COLORS.muted || '#5c626e'}">${lines}</text>`;
  }).join('');
  const takeawaySvg = takeaway ? `<rect x="70" y="${layoutHeight - 130}" width="1060" height="90" rx="16" fill="${COLORS.ink}"/><text x="96" y="${layoutHeight - 92}" font-family="${FONT}" font-size="16" font-weight="800" fill="#ffd666">结论</text><text x="96" y="${layoutHeight - 58}" font-family="${FONT}" font-size="28" font-weight="750" fill="#fff">${esc(takeaway)}</text>` : '';
  const gapSvg = gaps.length ? `<g>${gaps.map((gap, index) => {
    const missing = gap.missing.includes('关系证据不足') ? '一条关系缺少明确原句，未画入图中' : gap.missing;
    const why = String(gap.why || '').replace(/r\d+_[a-f0-9]+：/g, '').replace(/关系原句没有|原句没有讲述/g, '原句不足以说明');
    return `<rect x="70" y="${height - gapHeight + 30 + index * 54}" width="1060" height="44" rx="10" fill="#fff" stroke="${COLORS.orange}" stroke-dasharray="8 6"/><text x="90" y="${height - gapHeight + 58 + index * 54}" font-family="${FONT}" font-size="18" fill="${COLORS.orange}">缺口：${esc(missing)}——${esc(why)}</text>`;
  }).join('')}</g>` : '';
  const titleSvg = view.props.headline
    ? `<text x="70" y="98" font-family="${FONT}" font-size="54" font-weight="850" fill="${COLORS.ink}">${esc(view.props.headline)}</text><text x="70" y="142" font-family="${FONT}" font-size="22" font-weight="600" fill="#5c626e">${esc(view.props.subhead || structure.topic)}</text><line x1="70" y1="168" x2="1130" y2="168" stroke="${COLORS.line}" stroke-width="2"/>`
    : `<text x="70" y="98" font-family="${FONT}" font-size="46" font-weight="850" fill="${COLORS.ink}">${esc(view.props.title || structure.topic)}</text><line x1="70" y1="126" x2="1130" y2="126" stroke="${COLORS.line}" stroke-width="2"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${height}" viewBox="0 0 ${CANVAS_W} ${height}" role="img" aria-label="${esc(view.props.title || structure.topic)}"><defs>${defs}</defs><rect width="100%" height="100%" fill="#fff"/><text x="70" y="38" font-family="${FONT}" font-size="16" font-weight="800" letter-spacing="2" fill="${COLORS.blue}">AI 对话 · 知识结构</text>${titleSvg}<text x="1130" y="38" text-anchor="end" font-family="${FONT}" font-size="18" fill="${COLORS.gray}">@han5810xy · make-infographic</text>${edges}${evidenceSvg}${nodes.map(nodeSvg).join('')}${takeawaySvg}${gapSvg}</svg>`;
}

export function buildStructureHtml(structure, view) {
  const svg = buildStructureSvg(structure, view);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(view.props.title || structure.topic)}</title><style>*{box-sizing:border-box}html,body{margin:0;background:#eef2f8}body{font-family:${FONT}}main{max-width:1200px;margin:auto;background:#fff}svg{display:block;width:100%;height:auto}</style></head><body><main>${svg}</main></body></html>`;
}

export async function renderStructurePng(structure, view, outPath, { scale = 2 } = {}) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: CANVAS_W, height: 1200, deviceScaleFactor: scale });
    await page.setContent(buildStructureHtml(structure, view), { waitUntil: 'load' });
    const box = await page.$eval('svg', (element) => ({ width: element.viewBox.baseVal.width, height: element.viewBox.baseVal.height }));
    await page.setViewport({ width: CANVAS_W, height: box.height, deviceScaleFactor: scale });
    await page.screenshot({ path: outPath, fullPage: false });
    return { png: true, width: CANVAS_W * scale, height: box.height * scale };
  } finally {
    await closeBrowser(browser);
  }
}
