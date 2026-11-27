export const VISUAL_SYNTAX = Object.freeze({
  shapes: Object.freeze({
    定义: 'circle',
    条件: 'diamond',
    例子: 'hexagon',
    主张: 'rect',
    因果: 'rect',
    对比: 'rect',
    步骤: 'rect',
    例外: 'rect',
    数据: 'rect',
    inferred: 'dashed-rect',
    gap: 'dashed-rect',
  }),
  lines: Object.freeze({
    因果: Object.freeze({ color: '#2f5cff', dash: '', marker: 'arrow', width: 4 }),
    支持: Object.freeze({ color: '#2f5cff', dash: '9 7', marker: 'arrow', width: 3 }),
    对比: Object.freeze({ color: '#8b93a5', dash: '4 6', marker: 'double-arrow', width: 3 }),
    包含: Object.freeze({ color: '#8b93a5', dash: '', marker: 'bracket', width: 3 }),
    条件: Object.freeze({ color: '#a86400', dash: '12 7', marker: 'arrow', width: 3 }),
    转折: Object.freeze({ color: '#a86400', dash: '5 6', marker: 'arrow', width: 3 }),
    反驳: Object.freeze({ color: '#b42318', dash: '8 6', marker: 'arrow', width: 4 }),
    递进: Object.freeze({ color: '#2f5cff', dash: '', marker: 'arrow', width: 4 }),
  }),
  colors: Object.freeze({
    backbone: '#2f5cff',
    backboneBg: '#edf2ff',
    conflict: '#a86400',
    conflictBg: '#fff7e9',
    background: '#8b93a5',
    backgroundBg: '#f5f7fc',
    overturned: '#b42318',
    overturnedBg: '#fff0ec',
    result: '#17181c',
    paper: '#ffffff',
  }),
  levels: Object.freeze({
    backbone: Object.freeze({ width: 4, fontSize: 34, weight: 700 }),
    branch: Object.freeze({ width: 2, fontSize: 30, weight: 600 }),
    background: Object.freeze({ width: 1, fontSize: 28, weight: 500 }),
  }),
  badges: Object.freeze({ quote: '原话', summary: '归纳', inferred: '推断' }),
});

export function shapeFor(proposition) {
  if (proposition.provenance === 'inferred') return VISUAL_SYNTAX.shapes.inferred;
  return VISUAL_SYNTAX.shapes[proposition.kind] || VISUAL_SYNTAX.shapes.主张;
}

export function lineFor(kind) {
  return VISUAL_SYNTAX.lines[kind] || VISUAL_SYNTAX.lines.支持;
}
