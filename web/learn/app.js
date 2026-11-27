'use strict';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const routeNames = { recall: '回忆', explain: '解释', apply: '应用', transfer: '迁移' };
const reportNames = {
  without_looking: '没看资料，凭记忆写',
  with_hint: '看了提示或资料',
  unsure: '不确定，先留下想法',
  needs_review: '需要重新学习',
};
const reportDescriptions = {
  without_looking: '提交前没有查看原命题或资料；这是你的自述，不是系统判定。',
  with_hint: '你参考了提示、笔记或资料；这不是独立回忆。',
  unsure: '答案还不成熟；保留原话，之后回来补充。',
  needs_review: '这块需要重读来源；系统会安排更近的复习。',
};
const stageNames = ['未留下提取记录', '回忆', '解释', '应用', '迁移'];
const tabs = ['review', 'graph', 'explanations', 'archive'];
const params = new URLSearchParams(location.hash.slice(1));
const token = params.get('token') || sessionStorage.getItem('make-infographic-learn-token') || '';
if (token) sessionStorage.setItem('make-infographic-learn-token', token);
if (params.has('token')) history.replaceState(null, '', location.pathname);
let state = null;
let current = null;
let busy = false;
let activeTab = 'review';

function fatal(message) {
  $('#fatal-text').textContent = message;
  $('#fatal').hidden = false;
  $('#workbench').hidden = true;
}

if (!/^[a-f0-9]{64}$/.test(token)) {
  fatal('地址里缺少有效的本机令牌。请从命令行打印的完整地址打开，包括 # 后面的内容。令牌只保存在本机。');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'x-learn-token': token, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    cache: 'no-store',
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('本地服务返回了无法读取的内容。'); }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function notice(message = '', error = false) {
  const el = $('#notice');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.hidden = !message;
}

function setBusy(value) {
  busy = value;
  document.querySelectorAll('button').forEach((button) => { button.disabled = value; });
}

function switchTab(name, focus = false) {
  activeTab = name;
  for (const tab of tabs) {
    const selected = tab === name;
    $(`#tab-${tab}`).setAttribute('aria-selected', String(selected));
    $(`#tab-${tab}`).tabIndex = selected ? 0 : -1;
    $(`#panel-${tab}`).hidden = !selected;
  }
  if (focus) $(`#tab-${name}`).focus();
  if (name !== 'review') notice();
  if (state && name === 'graph') renderGraph();
  if (state && name === 'explanations') renderTimeline();
  if (state && name === 'archive') renderArchive();
}

async function refresh() {
  state = await api('/api/state');
  if (activeTab === 'review') renderReview();
  if (activeTab === 'graph') renderGraph();
  if (activeTab === 'explanations') renderTimeline();
  if (activeTab === 'archive') renderArchive();
}

function loading(message) {
  return `<div class="empty"><h3>${esc(message)}</h3><p>正在读取本机学习记录。</p></div>`;
}

function renderReview(next = null) {
  const box = $('#review-content');
  const item = next || state?.due?.[0];
  current = item || null;
  if (!item) {
    box.innerHTML = `<div class="empty"><h3>${state?.counts?.concepts ? '现在没有到期题目' : '还没有可复习的概念'}</h3><p>${state?.counts?.concepts ? '可以查看图谱或回看自己的解释；也可以切换上面的“刷新到期”。' : '先用 make-infographic 整理一段对话并运行 learn sync，学习证据就会出现在这里。'}</p></div>`;
    return;
  }
  box.innerHTML = `
    <article class="prompt-card">
      <div class="meta"><span>${esc(item.topic || '未分类')}</span><span>${esc(routeNames[item.route] || item.route)}</span></div>
      <h3 id="prompt-title">${esc(item.probe.question)}</h3>
      <p class="hint">${esc(item.probe.instruction)}</p>
      <form id="answer-form">
        <label class="field-label" for="answer">你的解释</label>
        <textarea id="answer" name="answer" maxlength="10000" required aria-describedby="answer-help" placeholder="哪怕只有一句话，也先写下来。不要复制原命题来充当回答。"></textarea>
        <p id="answer-help" class="hint">提交后才显示原命题与证据。Ctrl / ⌘ + Enter 可提交。</p>
        <fieldset class="reports">
          <legend>提交前，你是怎样完成的？</legend>
          ${Object.entries(reportNames).map(([value, label], index) => `
            <label class="report ${index === 0 ? 'default' : ''}">
              <input type="radio" name="self_report" value="${value}" ${index === 0 ? 'checked' : ''}>
              <span><strong>${esc(label)}</strong><small>${esc(reportDescriptions[value])}</small></span>
            </label>`).join('')}
        </fieldset>
        <button class="primary" type="submit">保存我的话，查看证据</button>
      </form>
    </article>`;
  $('#answer-form').addEventListener('submit', submitAnswer);
  $('#answer').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $('#answer-form').requestSubmit(); }
  });
}

async function submitAnswer(event) {
  event.preventDefault();
  if (busy || !current) return;
  const answer = $('#answer').value.trim();
  const selfReport = new FormData(event.currentTarget).get('self_report');
  if (!answer) { notice('请先写下自己的解释。', true); $('#answer').focus(); return; }
  setBusy(true);
  notice('正在保存你的原话……');
  try {
    const result = await api('/api/answer', { method: 'POST', body: JSON.stringify({ concept_id: current.concept_id, route: current.route, answer, self_report: selfReport, prompt_id: current.probe.prompt_id }) });
    await refreshStateQuietly();
    renderReveal(result);
    notice('已保存。这里记录的是你的原话，不自动判分。');
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
}

function renderReveal(result) {
  const { event, reveal } = result;
  const sourceRows = (reveal.sources || []).map((source) => `
    <li><strong>${esc(source.layer || '来源')} · ${esc(source.provenance === 'inferred' ? '推断' : source.provenance === 'quote' ? '逐字引用' : '摘要')}</strong>
      <span class="source-ref">${esc(source.document_id)} / ${esc(source.proposition_id)}</span>
      ${(source.evidence || []).map((evidence) => `<span class="quote-ref">${esc(evidence.speaker === 'user' ? '用户' : '助手')} · 第 ${Number(evidence.turn_index) + 1} 轮 · ${esc(evidence.quote_id)}${evidence.verbatim ? ' · 原句' : ''}</span>`).join('')}
      ${(source.evidence_text || []).map((text) => `<blockquote>${esc(text)}</blockquote>`).join('')}
    </li>`).join('');
  $('#review-content').innerHTML = `
    <article class="reveal">
      <p class="kicker">已保存的学习证据</p>
      <section class="own-words"><h3>你写下的</h3><p>${esc(event.answer)}</p><span class="tag">${esc(reportNames[event.self_report] || event.self_report)}</span></section>
      <section><h3>原对话里的判断</h3><p class="proposition">${esc(reveal.text)}</p><p class="hint">对照而不是判分：它和你写的有什么差异？</p></section>
      <section><h3>来源证据</h3>${sourceRows ? `<ul class="sources">${sourceRows}</ul>` : '<p class="hint">这次记录没有附加来源证据。</p>'}</section>
      <p class="hint">概念身份：${esc(event.concept_id)} · 记录：${esc(event.event_id)}</p>
      <div class="actions"><button id="next-due" class="primary" type="button">下一道到期题</button><button id="open-explanations" class="ghost" type="button">回看我的解释</button></div>
    </article>`;
  $('#next-due').addEventListener('click', async () => {
    setBusy(true);
    try { await refresh(); renderReview(); $('#answer')?.focus(); }
    catch (error) { notice(error.message, true); }
    finally { setBusy(false); }
  });
  $('#open-explanations').addEventListener('click', () => switchTab('explanations', true));
}

async function refreshStateQuietly() {
  try { state = await api('/api/state'); } catch { /* The saved answer is still valid. */ }
}

function graphPosition(index, total) {
  const columns = Math.min(3, Math.max(1, total));
  const rows = Math.ceil(total / columns);
  return { x: 110 + (index % columns) * 300, y: 75 + Math.floor(index / columns) * 130, columns, rows };
}

function renderGraph() {
  const box = $('#graph-content');
  const concepts = [...(state?.graph?.nodes || [])].sort((a, b) => a.concept_id.localeCompare(b.concept_id));
  if (!concepts.length) {
    box.innerHTML = '<div class="empty"><h3>图谱还是空的</h3><p>同步带命题关系的对话后，这里会画出概念之间的关联。</p></div>';
    return;
  }
  const { rows } = graphPosition(0, concepts.length);
  const width = 1020;
  const height = Math.max(300, rows * 130 + 20);
  const positions = new Map(concepts.map((concept, index) => [concept.concept_id, graphPosition(index, concepts.length)]));
  const edges = (state.graph.edges || []).filter((edge) => positions.has(edge.from) && positions.has(edge.to)).map((edge) => {
    const a = positions.get(edge.from);
    const b = positions.get(edge.to);
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#c9cdd4" stroke-width="1.5"><title>${esc(edge.kind)}</title></line>`;
  }).join('');
  const nodes = concepts.map((concept, index) => {
    const { x, y } = positions.get(concept.concept_id);
    const label = [...concept.topic || concept.concept_id].slice(0, 9).join('');
    return `<g class="graph-node" transform="translate(${x},${y})" data-concept="${esc(concept.concept_id)}" tabindex="0" role="button" aria-label="查看概念：${esc(concept.topic || concept.concept_id)}，${esc(stageNames[concept.evidence_stage] || stageNames[0])}">
      <title>${esc(concept.topic || concept.concept_id)}</title>
      <circle r="25" fill="${concept.evidence_stage ? '#17181c' : '#ffffff'}"></circle>
      <text text-anchor="middle" dy="5" fill="${concept.evidence_stage ? '#ffffff' : '#17181c'}" font-size="13">${index + 1}</text>
      <text text-anchor="middle" y="46" fill="#17181c" font-size="13">${esc(label)}</text>
    </g>`;
  }).join('');
  box.innerHTML = `<div class="graph-scroll"><svg class="graph" viewBox="0 0 ${width} ${height}" role="group" aria-label="概念关系图，节点可用键盘打开">${edges}${nodes}</svg></div><p class="hint">实心节点：已有提取记录；空心节点：尚无提取记录。大小不表示重要性。</p>`;
  box.querySelectorAll('[data-concept]').forEach((node) => {
    const open = () => showConcept(node.dataset.concept);
    node.addEventListener('click', open);
    node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
  });
}

async function showConcept(conceptId) {
  const concept = state.concepts.find((item) => item.concept_id === conceptId);
  if (!concept) return;
  const detail = $('#graph-detail');
  detail.hidden = false;
  detail.tabIndex = -1;
  detail.innerHTML = `<div class="detail-head"><h3>${esc(concept.topic)}</h3><button class="quiet" id="close-concept" type="button" aria-label="关闭概念详情">关闭</button></div>
    <p>${esc(concept.kind || '概念')} · 已有记录：${esc(stageNames[concept.evidence_stage] || stageNames[0])}</p>
    <p class="hint">各路径：${Object.entries(concept.routes).map(([route, info]) => `${routeNames[route]} ${info.attempts} 次${info.due ? ' · 到期' : ''}`).join('；')}</p>
    <button class="ghost" id="practice-concept" type="button">用一道题练习这个概念</button>`;
  $('#close-concept').addEventListener('click', () => { detail.hidden = true; });
  $('#practice-concept').addEventListener('click', async () => {
    setBusy(true);
    try {
      const route = Object.keys(concept.routes).find((name) => concept.routes[name].due) || 'recall';
      current = { concept_id: conceptId, topic: concept.topic, route, probe: await api(`/api/prompt?concept_id=${encodeURIComponent(conceptId)}&route=${route}`) };
      switchTab('review', true);
      renderReview(current);
      $('#answer')?.focus();
    } catch (error) { notice(error.message, true); }
    finally { setBusy(false); }
  });
  detail.focus?.();
}

function renderTimeline() {
  const events = [...(state?.events || [])].sort((a, b) => b.seq - a.seq);
  const box = $('#timeline');
  if (!events.length) {
    box.innerHTML = '<div class="empty"><h3>还没有留下解释</h3><p>完成一次对话复习后，你的原话会按时间保存在这里。</p></div>';
    return;
  }
  box.innerHTML = `<ol class="timeline">${events.map((event) => {
    const concept = state.concepts.find((item) => item.concept_id === event.concept_id);
    return `<li><div class="meta"><time datetime="${esc(event.at)}">${esc(new Date(event.at).toLocaleString('zh-CN'))}</time><span>${esc(routeNames[event.route] || event.route)}</span></div>
      <h3>${esc(concept?.topic || event.concept_id)}</h3>
      <p class="own-words">${esc(event.answer)}</p>
      <div class="event-foot"><span class="tag">${esc(reportNames[event.self_report] || event.self_report)}</span><button class="link" type="button" data-event="${esc(event.event_id)}">查看来源证据</button></div></li>`;
  }).join('')}</ol>`;
  box.querySelectorAll('[data-event]').forEach((button) => button.addEventListener('click', () => showSource(button.dataset.event)));
}

async function showSource(eventId) {
  const dialog = $('#source-dialog');
  $('#source-content').innerHTML = '<p>正在读取这次记录对应的原对话证据……</p>';
  dialog.showModal();
  try {
    const { event, reveal } = await api(`/api/reveal?event_id=${encodeURIComponent(eventId)}`);
    $('#source-content').innerHTML = `<p class="meta">${esc(event.event_id)} · ${esc(reportNames[event.self_report] || event.self_report)}</p>
      <section><h3>你写下的</h3><p>${esc(event.answer)}</p></section>
      <section><h3>原对话里的判断</h3><p class="proposition">${esc(reveal.text)}</p></section>
      <section><h3>来源</h3><ul class="sources">${reveal.sources.map((source) => `<li><strong>${esc(source.structure_id)} / ${esc(source.proposition_id)}</strong><span class="source-ref">${esc(source.document_id)} · ${esc(source.layer)} · ${esc(source.provenance)}</span>${source.evidence.map((evidence) => `<span class="quote-ref">${esc(evidence.speaker)} · 第 ${Number(evidence.turn_index) + 1} 轮 · ${esc(evidence.quote_id)}${evidence.verbatim ? ' · 原句' : ''}</span>`).join('')}${(source.evidence_text || []).map((text) => `<blockquote>${esc(text)}</blockquote>`).join('')}</li>`).join('')}</ul></section>`;
  } catch (error) {
    $('#source-content').innerHTML = `<p role="alert">${esc(error.message)}</p>`;
  }
}

function renderArchive() {
  if (!state) return;
  const { counts, by_route, concepts, documents } = state;
  const stageCounts = [0, 0, 0, 0, 0];
  concepts.forEach((concept) => { stageCounts[concept.evidence_stage] = (stageCounts[concept.evidence_stage] || 0) + 1; });
  $('#archive-content').innerHTML = `
    <dl class="counts"><div><dt>概念</dt><dd>${counts.concepts}</dd></div><div><dt>到期</dt><dd>${counts.due}</dd></div><div><dt>学习记录</dt><dd>${counts.events}</dd></div><div><dt>来源对话</dt><dd>${documents.length}</dd></div></dl>
    <div class="archive-grid"><section><h3>按学习类型</h3><ul class="stats">${Object.entries(routeNames).map(([route, label]) => `<li><span>${label}</span><b>${by_route[route] || 0} 次</b></li>`).join('')}</ul></section>
    <section><h3>按已有记录阶段</h3><ul class="stats">${stageCounts.map((count, index) => `<li><span>${stageNames[index]}</span><b>${count} 个概念</b></li>`).join('')}</ul></section></div>
    <p class="hint">“阶段”只表示出现过哪种路径的独立回忆自述，不衡量答案质量，也不证明掌握。</p>`;
}

$('#export').addEventListener('click', async () => {
  setBusy(true);
  notice('正在整理本机学习包……');
  try {
    const bundle = await api('/api/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'learning-evidence.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice('学习包已导出到你的下载目录。');
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
});

$('#close-dialog').addEventListener('click', () => $('#source-dialog').close());
$('#source-dialog').addEventListener('click', (event) => { if (event.target === $('#source-dialog')) $('#source-dialog').close(); });

for (const tab of tabs) {
  $(`#tab-${tab}`).addEventListener('click', () => switchTab(tab));
  $(`#tab-${tab}`).addEventListener('keydown', (event) => {
    const index = tabs.indexOf(tab);
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); switchTab(tabs[next], true); }
  });
}

for (const [button, target] of [['refresh-review', 'review'], ['refresh-graph', 'graph'], ['refresh-explanations', 'explanations'], ['refresh-archive', 'archive']]) {
  $(`#${button}`).addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    notice('正在读取本机学习记录……');
    try { await refresh(); notice(); }
    catch (error) { notice(error.message, true); }
    finally { setBusy(false); }
  });
}

if (token) {
  $('#workbench').hidden = false;
  $('#fatal').hidden = true;
  (async () => {
    $('#review-content').innerHTML = loading('正在取题');
    try { await refresh(); }
    catch (error) { notice(error.message, true); $('#review-content').innerHTML = '<div class="empty"><h3>读取失败</h3><p>请确认工作台仍在运行，然后刷新页面重试。</p></div>'; }
  })();
}
