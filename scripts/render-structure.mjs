import { writeFile } from 'node:fs/promises';
import { launchBrowser, closeBrowser } from './browser.mjs';
import { VISUAL_SYNTAX, shapeFor, lineFor } from './visual-syntax.mjs';

export const CANVAS_W = 1200;
const FONT = '"Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif';
const COLORS = Object.freeze({
  blue: '#2f5cff', blueBg: '#edf2ff', orange: '#a86400', orangeBg: '#fff7e9',
  red: '#b42318', redBg: '#fff0ec', gray: '#8b93a5', grayBg: '#f5f7fc',
  ink: '#17181c', white: '#ffffff', line: '#dce2ee', muted: '#5c626e',
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

function levelOf(proposition, structure) {
  if (structure.backbone?.includes(proposition.id)) return VISUAL_SYNTAX.levels.backbone;
  if (proposition.layer === 'background') return VISUAL_SYNTAX.levels.background;
  return VISUAL_SYNTAX.levels.branch;
}

function nodeGeometry(proposition, x, y, w = 300) {
  const shape = shapeFor(proposition);
  const level = levelOf(proposition, proposition.__structure);
  const fontSize = shape === 'diamond' ? Math.min(26, level.fontSize) : shape === 'circle' ? Math.min(32, level.fontSize) : level.fontSize;
  const textWidth = shape === 'diamond' ? w * 0.58 : w - 48;
  const lines = wrapText(proposition.text, textWidth, fontSize);
  const lineHeight = fontSize + 12;
  const h = Math.max(shape === 'diamond' ? 170 : 132, 64 + lines.length * lineHeight);
  return { proposition, x, y, w, h, lines, shape, fontSize, lineHeight, fontWeight: level.weight, strokeWidth: level.width, tone: toneOf(proposition, proposition.__structure) };
}

function attachStructure(structure) {
  return structure.propositions.map((proposition) => ({ ...proposition, __structure: structure }));
}

function chainLayout(propositions, view = {}, startY = 220) {
  if (propositions.length <= 4) {
    const count = propositions.length;
    const w = count <= 3 ? 300 : 260;
    const gap = count <= 3 ? 90 : 42;
    const totalW = count * w + (count - 1) * gap;
    const startX = (CANVAS_W - totalW) / 2;
    const nodes = propositions.map((proposition, index) => nodeGeometry(proposition, startX + index * (w + gap), startY, w));
    const bottom = Math.max(...nodes.map((node) => node.y + node.h), startY + 200);
    return { nodes, height: bottom + 80, takeaway: view.target?.startsWith('branch:') ? propositions[0]?.text || '' : propositions.at(-1)?.text || '' };
  }
  const nodes = [];
  let y = startY;
  for (const proposition of propositions) {
    const node = nodeGeometry(proposition, (CANVAS_W - 680) / 2, y, 680);
    nodes.push(node);
    y += node.h + 70;
  }
  return { nodes, height: y + 40, takeaway: view.target?.startsWith('branch:') ? propositions[0]?.text || '' : propositions.at(-1)?.text || '' };
}

function treeLayout(propositions, relations, { offsetX = 0, offsetY = 0, availableWidth = CANVAS_W } = {}) {
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
  const depth = new Map(roots.map((id) => [id, 0]));
  const queue = [...roots];
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
  let y = offsetY;
  for (const d of [...levels.keys()].sort((a, b) => a - b)) {
    const group = levels.get(d);
    const gap = group.length > 1 ? 24 : 0;
    const w = Math.max(180, Math.min(300, (availableWidth - 80 - gap * (group.length - 1)) / group.length));
    const totalW = group.length * w + (group.length - 1) * gap;
    let x = offsetX + (availableWidth - totalW) / 2;
    let rowHeight = 0;
    for (const id of group) {
      const node = nodeGeometry(byId.get(id), x, y, w);
      nodes.push(node);
      rowHeight = Math.max(rowHeight, node.h);
      x += w + gap;
    }
    y += rowHeight + 64;
  }
  return { nodes, height: y - offsetY + 40 };
}

function circularLayout(propositions, structure, startY = 220) {
  const degree = new Map(propositions.map((item) => [item.id, 0]));
  for (const relation of structure.relations || []) {
    if (degree.has(relation.from)) degree.set(relation.from, degree.get(relation.from) + 1);
    if (degree.has(relation.to)) degree.set(relation.to, degree.get(relation.to) + 1);
  }
  const ordered = [...propositions].sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0));
  const maxH = Math.max(...ordered.map((item) => nodeGeometry(item, 0, 0).h), 132);
  const radiusX = 390;
  const radiusY = Math.max(300, maxH * ordered.length / 3.2);
  const centerX = CANVAS_W / 2;
  const centerY = startY + radiusY;
  const nodes = ordered.map((proposition, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / ordered.length;
    return nodeGeometry(proposition, centerX + Math.cos(angle) * radiusX - 150, centerY + Math.sin(angle) * radiusY - maxH / 2, 300);
  });
  return { nodes, height: centerY + radiusY + maxH / 2 + 80, takeaway: '' };
}

function matrixLayout(propositions, startY = 220) {
  const nodes = [];
  const cols = propositions.length <= 4 ? 2 : 3;
  const w = cols === 2 ? 420 : 300;
  const gap = 40;
  const totalW = cols * w + (cols - 1) * gap;
  const startX = (CANVAS_W - totalW) / 2;
  let y = startY;
  for (let index = 0; index < propositions.length; index += cols) {
    const row = propositions.slice(index, index + cols);
    let rowHeight = 0;
    row.forEach((proposition, col) => {
      const node = nodeGeometry(proposition, startX + col * (w + gap), y, w);
      nodes.push(node);
      rowHeight = Math.max(rowHeight, node.h);
    });
    y += rowHeight + 48;
  }
  return { nodes, height: y + 40, takeaway: '' };
}

function componentsOf(structure, ids) {
  const allowed = new Set(ids);
  const adjacency = new Map(ids.map((id) => [id, []]));
  for (const relation of structure.relations || []) {
    if (!allowed.has(relation.from) || !allowed.has(relation.to)) continue;
    adjacency.get(relation.from).push(relation.to);
    adjacency.get(relation.to).push(relation.from);
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
  return groups;
}

function forestLayout(structure, view, startY = 220) {
  const byId = new Map(attachStructure(structure).map((item) => [item.id, item]));
  const groups = componentsOf(structure, view.props.propositionIds || []);
  const nodes = [];
  const colWidth = 360;
  const gap = 30;
  let rowY = startY;
  let rowHeight = 0;
  groups.forEach((group, index) => {
    const col = index % 3;
    if (col === 0 && index > 0) { rowY += rowHeight + 50; rowHeight = 0; }
    const props = group.map((id) => byId.get(id));
    const relations = (structure.relations || []).filter((relation) => group.includes(relation.from) && group.includes(relation.to));
    const laid = treeLayout(props, relations, { offsetX: 30 + col * (colWidth + gap), offsetY: rowY, availableWidth: colWidth });
    nodes.push(...laid.nodes);
    rowHeight = Math.max(rowHeight, laid.height);
  });
  return { nodes, height: rowY + rowHeight + 40, takeaway: '' };
}

function atlasLayout(structure, view, startY = 220) {
  const byId = new Map(attachStructure(structure).map((item) => [item.id, item]));
  const backboneIds = structure.backbone?.length ? structure.backbone : structure.propositions.map((item) => item.id);
  const branchIds = structure.propositions.map((item) => item.id).filter((id) => !backboneIds.includes(id));
  const count = backboneIds.length;
  const w = count <= 4 ? 260 : 220;
  const gap = count <= 4 ? 30 : 18;
  const totalW = count * w + (count - 1) * gap;
  const startX = (CANVAS_W - totalW) / 2;
  const topBranches = branchIds.slice(0, 4);
  const bottomBranches = branchIds.slice(4, 8);
  const nodes = topBranches.map((id, index) => nodeGeometry(byId.get(id), startX + index * (w + gap), startY, w));
  const topHeight = Math.max(...nodes.map((node) => node.h), 0);
  const backboneY = startY + topHeight + 90;
  const backbone = backboneIds.map((id, index) => nodeGeometry(byId.get(id), startX + index * (w + gap), backboneY, w));
  nodes.push(...backbone);
  const backboneHeight = Math.max(...backbone.map((node) => node.h), 0);
  const bottomY = backboneY + backboneHeight + 100;
  const bottom = bottomBranches.map((id, index) => nodeGeometry(byId.get(id), startX + index * (w + gap), bottomY, w));
  nodes.push(...bottom);
  return { nodes, height: Math.max(...nodes.map((node) => node.y + node.h), bottomY) + 80, takeaway: backboneIds.at(-1) ? byId.get(backboneIds.at(-1))?.text || '' : '' };
}

function layout(structure, view, startY) {
  const byId = new Map(attachStructure(structure).map((item) => [item.id, item]));
  const propositions = (view.props.propositionIds || []).map((id) => byId.get(id)).filter(Boolean);
  const relations = (structure.relations || []).filter((relation) => view.props.propositionIds.includes(relation.from) && view.props.propositionIds.includes(relation.to));
  if (view.props?.layout === 'atlas') return atlasLayout(structure, view, startY);
  if (view.graphic === 'turn-band') {
    const roles = ['原以为', '撞车', '正解', '一句带走'];
    propositions.forEach((proposition, index) => { proposition.__viewRole = roles[index] || '命题'; });
    return chainLayout(propositions, view, startY);
  }
  if (view.graphic === 'flow') return chainLayout(propositions, view, startY);
  if (view.graphic === 'tree') return structure.topo === 'forest' ? forestLayout(structure, view, startY) : treeLayout(propositions, relations, { offsetY: startY });
  if (view.graphic === 'matrix') return matrixLayout(propositions, startY);
  return circularLayout(propositions, structure, startY);
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

function boundaryPoint(node, toward) {
  const c = center(node);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  if (node.shape === 'circle') {
    const scale = 1 / Math.sqrt((dx * dx) / ((node.w / 2) ** 2) + (dy * dy) / ((node.h / 2) ** 2));
    return { x: c.x + dx * scale, y: c.y + dy * scale };
  }
  if (node.shape === 'diamond') {
    const scale = 1 / (Math.abs(dx) / (node.w / 2) + Math.abs(dy) / (node.h / 2));
    return { x: c.x + dx * scale, y: c.y + dy * scale };
  }
  const scale = 1 / Math.max(Math.abs(dx) / (node.w / 2), Math.abs(dy) / (node.h / 2));
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

function edgePath(from, to, kind, view) {
  const a = boundaryPoint(from, center(to));
  const b = boundaryPoint(to, center(from));
  if (view?.props?.layout === 'atlas' || kind === '条件') {
    const midY = (a.y + b.y) / 2;
    return { d: `M ${a.x} ${a.y} L ${a.x} ${midY} L ${b.x} ${midY} L ${b.x} ${b.y}`, label: { x: (a.x + b.x) / 2, y: midY } };
  }
  return { d: `M ${a.x} ${a.y} L ${b.x} ${b.y}`, label: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

function nodeSvg(node) {
  const { x, y, w, h, shape, tone, lines, proposition } = node;
  const common = `fill="${tone.fill}" stroke="${tone.stroke}" stroke-width="${node.strokeWidth}"`;
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
  return `${shapeSvg}<text data-node-id="${esc(proposition.id)}" x="${x + w / 2}" y="${firstY}" text-anchor="middle" font-family="${FONT}" font-size="${node.fontSize}" font-weight="${node.fontWeight}" fill="${tone.ink}">${text}</text><text x="${x + w - 14}" y="${y + 22}" text-anchor="end" font-family="${FONT}" font-size="15" font-weight="700" fill="${tone.fill === COLORS.ink ? '#ffd666' : tone.stroke}">${role} · ${esc(proposition.id.split('_')[0])} · ${badge}</text>`;
}

function headerSvg(structure, view) {
  const kicker = structure.authoring_mode === 'auto-candidate' ? '自动候选 · 待复核' : 'AI 对话 · 知识结构';
  const headline = view.props.headline || view.props.title || structure.topic;
  const headlineLines = wrapText(headline, 1060, 54);
  const subheadLines = view.props.subhead ? wrapText(view.props.subhead, 1060, 22) : [];
  const headlineHeight = headlineLines.length * 64;
  const subheadHeight = subheadLines.length * 30;
  const height = 50 + headlineHeight + subheadHeight + 28;
  const headlineText = headlineLines.map((line, index) => `<tspan x="70" dy="${index ? 64 : 0}">${esc(line)}</tspan>`).join('');
  const subheadText = subheadLines.map((line, index) => `<tspan x="70" dy="${index ? 30 : 0}">${esc(line)}</tspan>`).join('');
  return {
    height,
    svg: `<text x="70" y="38" font-family="${FONT}" font-size="16" font-weight="800" letter-spacing="2" fill="${COLORS.blue}">${kicker}</text><text x="70" y="102" font-family="${FONT}" font-size="54" font-weight="850" fill="${COLORS.ink}">${headlineText}</text>${subheadLines.length ? `<text x="70" y="${102 + headlineHeight + 8}" font-family="${FONT}" font-size="22" font-weight="600" fill="${COLORS.muted}">${subheadText}</text>` : ''}<line x1="70" y1="${height}" x2="1130" y2="${height}" stroke="${COLORS.line}" stroke-width="2"/>`,
  };
}

function evidenceSvg(structure, view, startY) {
  const rows = [];
  let y = startY;
  for (const id of view.props.propositionIds || []) {
    const proposition = structure.propositions.find((item) => item.id === id);
    const quotes = view.props.evidence?.[id] || [];
    if (!proposition || !quotes.length) continue;
    const blocks = quotes.map((quote) => {
      const data = typeof quote === 'string' ? { text: quote } : quote;
      const lines = wrapText(data.text || '', 1000, 17);
      const attribution = [data.speaker, Number.isInteger(data.turn_index) ? `第 ${data.turn_index + 1} 轮` : '', data.quote_id].filter(Boolean).join(' · ');
      return { lines, attribution, height: 24 + lines.length * 23 + 10 };
    });
    const height = 34 + blocks.reduce((sum, item) => sum + item.height, 0);
    let blockY = y + 44;
    const body = blocks.map((block) => {
      const start = blockY;
      blockY += block.height;
      return `<text x="92" y="${start}" font-family="${FONT}" font-size="14" font-weight="700" fill="${COLORS.gray}">${esc(block.attribution)}</text>${block.lines.map((line, index) => `<text x="92" y="${start + 24 + index * 23}" font-family="${FONT}" font-size="17" fill="${COLORS.ink}">${esc(line)}</text>`).join('')}`;
    }).join('');
    rows.push(`<rect x="70" y="${y}" width="1060" height="${height}" rx="12" fill="#f8fafc" stroke="${COLORS.line}"/><text x="92" y="${y + 24}" font-family="${FONT}" font-size="14" font-weight="800" fill="${COLORS.blue}">${esc(proposition.id.split('_')[0])} · 证据</text>${body}`);
    y += height + 14;
  }
  return { height: rows.length ? y - startY + 20 : 0, svg: rows.join('') };
}

function takeawaySvg(text, startY) {
  if (!text) return { height: 0, svg: '' };
  const lines = wrapText(text, 1000, 28);
  const height = 52 + lines.length * 36;
  return {
    height: height + 24,
    svg: `<rect x="70" y="${startY}" width="1060" height="${height}" rx="16" fill="${COLORS.ink}"/><text x="96" y="${startY + 28}" font-family="${FONT}" font-size="16" font-weight="800" fill="#ffd666">结论</text>${lines.map((line, index) => `<text x="96" y="${startY + 66 + index * 36}" font-family="${FONT}" font-size="28" font-weight="750" fill="#fff">${esc(line)}</text>`).join('')}`,
  };
}

function gapsSvg(structure, startY) {
  let y = startY;
  const rows = [];
  for (const gap of structure.gaps || []) {
    const missing = gap.missing.includes('关系证据不足') ? '一条关系缺少明确原句，未画入图中' : gap.missing;
    const why = String(gap.why || '');
    const lines = wrapText(`缺口：${missing}——${why}`, 1000, 17);
    const height = 24 + lines.length * 23;
    rows.push(`<rect x="70" y="${y}" width="1060" height="${height}" rx="10" fill="#fff" stroke="${COLORS.orange}" stroke-dasharray="8 6"/>${lines.map((line, index) => `<text x="90" y="${y + 28 + index * 23}" font-family="${FONT}" font-size="17" fill="${COLORS.orange}">${esc(line)}</text>`).join('')}`);
    y += height + 12;
  }
  return { height: rows.length ? y - startY + 16 : 0, svg: rows.join('') };
}

export function buildStructureSvg(structure, view) {
  const header = headerSvg(structure, view);
  const startY = header.height + 46;
  const laid = layout(structure, view, startY);
  const byId = new Map(laid.nodes.map((node) => [node.proposition.id, node]));
  const relationIds = new Set(view.props.relationIds || []);
  const relations = (structure.relations || []).filter((relation) => relationIds.has(relation.id) && byId.has(relation.from) && byId.has(relation.to));
  const defs = ['blue', 'gray', 'orange', 'red'].map((color) => `<marker id="arrow-${color}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${COLORS[color]}"/></marker>`).join('');
  const edges = relations.map((relation) => {
    const from = byId.get(relation.from);
    const to = byId.get(relation.to);
    const style = edgeStyle(relation.kind);
    const path = edgePath(from, to, relation.kind, view);
    const label = `<g><rect x="${path.label.x - 38}" y="${path.label.y - 17}" width="76" height="30" rx="15" fill="#fff" stroke="${style.color}"/><text x="${path.label.x}" y="${path.label.y + 4}" text-anchor="middle" font-family="${FONT}" font-size="15" font-weight="700" fill="${style.color}">${esc(relation.kind)}</text></g>`;
    if (style.bracket) {
      const a = boundaryPoint(from, center(to));
      const b = boundaryPoint(to, center(from));
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length * 14;
      const ny = dx / length * 14;
      return `<path data-edge-id="${esc(relation.id)}" data-kind="包含" d="M ${a.x + nx} ${a.y + ny} L ${b.x + nx} ${b.y + ny} M ${a.x + nx} ${a.y + ny} L ${a.x - nx} ${a.y - ny} M ${b.x + nx} ${b.y + ny} L ${b.x - nx} ${b.y - ny}" fill="none" stroke="${style.color}" stroke-width="${style.width}"/>`;
    }
    return `<path data-edge-id="${esc(relation.id)}" data-kind="${esc(relation.kind)}" d="${path.d}" fill="none" stroke="${style.color}" stroke-width="${style.width}"${style.dash ? ` stroke-dasharray="${style.dash}"` : ''} marker-end="url(#arrow-${style.marker})"${style.double ? ' marker-start="url(#arrow-gray)"' : ''}/>${label}`;
  }).join('');
  let y = laid.height + 30;
  const takeaway = takeawaySvg(laid.takeaway, y);
  y += takeaway.height;
  const evidence = evidenceSvg(structure, view, y);
  y += evidence.height;
  const gaps = gapsSvg(structure, y);
  y += gaps.height;
  const height = Math.max(900, y + 50);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${height}" viewBox="0 0 ${CANVAS_W} ${height}" role="img" aria-label="${esc(view.props.title || structure.topic)}"><defs>${defs}</defs><rect width="100%" height="100%" fill="#fff"/>${header.svg}<text x="1130" y="38" text-anchor="end" font-family="${FONT}" font-size="18" fill="${COLORS.gray}">@han5810xy · make-infographic</text>${edges}${laid.nodes.map(nodeSvg).join('')}${takeaway.svg}<g data-evidence>${evidence.svg}</g><g data-gaps>${gaps.svg}</g></svg>`;
}

export function buildStructureHtml(structure, view, { navigation = null } = {}) {
  const svg = buildStructureSvg(structure, view);
  const links = navigation?.views?.length
    ? `<nav class="view-nav" aria-label="结构视图">${navigation.views.map((item) => `<a href="${esc(item.href)}"${item.id === view.id ? ' aria-current="page"' : ''}>${esc(item.title)}</a>`).join('')}<a href="${esc(navigation.source || 'index.html')}">来源对话</a><a href="${esc(navigation.evidence || 'index.html')}">证据索引</a><a href="index.html">返回图集</a></nav>`
    : '';
  const status = structure.degradation?.html_only ? '<p class="status">本页为 HTML 输出，未做浏览器截图。</p>' : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(view.props.title || structure.topic)}</title><style>*{box-sizing:border-box}html,body{margin:0;background:#eef2f8}body{font-family:${FONT}}main{max-width:1200px;margin:auto;background:#fff;padding:0 0 24px}.view-nav{display:flex;flex-wrap:wrap;gap:10px;padding:14px 20px;border-bottom:1px solid ${COLORS.line};background:#f8fafc}.view-nav a{color:${COLORS.blue};font-size:13px;text-decoration:none}.view-nav a[aria-current]{font-weight:800}.status{padding:10px 20px;background:#fff7e9;color:#7a4a00;font-size:13px}svg{display:block;width:100%;height:auto}</style></head><body><main>${links}${status}${svg}</main></body></html>`;
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
