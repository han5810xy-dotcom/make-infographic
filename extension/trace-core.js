(() => {
  const SPEAKERS = Object.freeze(['user', 'assistant', 'system']);
  const SOURCE_TYPES = Object.freeze(['qwen-extension', 'skill', 'import']);

  function hash(value) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    const text = String(value ?? '');
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `tr_${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
  }

  function cleanText(value) {
    return String(value ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  }

  function roleOf(value) {
    const text = String(value || '').toLowerCase();
    if (/assistant|ai|model|助手|人工智能/.test(text)) return 'assistant';
    if (/system|系统/.test(text)) return 'system';
    return 'user';
  }

  function makeTurn(speaker, text, index, thinking = '') {
    const turn = { index, speaker: SPEAKERS.includes(speaker) ? speaker : 'user', text: cleanText(text), thinking: cleanText(thinking), created_at: null };
    return turn;
  }

  function finalizeTurns(turns) {
    return turns
      .map((turn, index) => makeTurn(turn.speaker, turn.text, index, turn.thinking))
      .filter((turn) => turn.text || turn.thinking)
      .map((turn, index) => ({ ...turn, index }));
  }

  function parseMarkdown(input, meta = {}) {
    const source = cleanText(input);
    const lines = source.split('\n');
    const turns = [];
    let current = null;
    for (const line of lines) {
      const marker = line.match(/^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(用户|助手|系统|User|Assistant|System|USER|ASSISTANT|SYSTEM)(?:\s*[（(]\s*(?:第\s*)?\d+\s*[轮轮]?\s*[）)])?(?:\*\*|__)?\s*[:：]?\s*(.*)$/);
      const equals = line.match(/^\s*={2,}\s*(用户|助手|系统|User|Assistant|System|USER|ASSISTANT|SYSTEM)(?:\s+\d+)?\s*={2,}\s*(.*)$/);
      if (marker || equals) {
        if (current) turns.push(current);
        const match = marker || equals;
        current = makeTurn(roleOf(match[1]), match[2] || '', turns.length);
        continue;
      }
      const thinking = line.match(/^\s*(?:思考|思考过程|Thinking|Reasoning)\s*[:：]\s*(.*)$/i);
      if (thinking) {
        if (!current || current.speaker !== 'assistant') {
          if (current) turns.push(current);
          current = makeTurn('assistant', '', turns.length);
        }
        current.thinking = [current.thinking, thinking[1]].filter(Boolean).join('\n');
        continue;
      }
      if (!current) current = makeTurn('user', '', 0);
      current.text = [current.text, line].filter(Boolean).join('\n');
    }
    if (current) turns.push(current);
    const normalized = finalizeTurns(turns.length ? turns : [makeTurn('user', source, 0)]);
    return {
      schema_version: 'trace.v1',
      id: hash(normalized.map((turn) => `${turn.speaker}\u0000${turn.text}\u0000${turn.thinking}`).join('\u0001')),
      source: { type: meta.type || 'import', url: meta.url || '', title: meta.title || '', captured_at: meta.captured_at || new Date().toISOString() },
      turns: normalized,
      attachments: Array.isArray(meta.attachments) ? meta.attachments : [],
    };
  }

  function parseJson(input, meta = {}) {
    let data = input;
    if (typeof data === 'string') data = JSON.parse(data);
    if (Array.isArray(data)) data = { messages: data };
    if (data?.schema_version === 'trace.v1' && Array.isArray(data.turns)) {
      const turns = finalizeTurns(data.turns);
      return {
        schema_version: 'trace.v1',
        id: data.id || hash(turns.map((turn) => `${turn.speaker}\u0000${turn.text}\u0000${turn.thinking}`).join('\u0001')),
        source: { type: data.source?.type || meta.type || 'import', url: data.source?.url || meta.url || '', title: data.source?.title || meta.title || '', captured_at: data.source?.captured_at || meta.captured_at || new Date().toISOString() },
        turns,
        attachments: Array.isArray(data.attachments) ? data.attachments : [],
      };
    }
    const messages = data?.messages || data?.data?.messages || data?.conversation?.messages || data?.turns;
    if (!Array.isArray(messages)) throw new Error('JSON 里找不到 messages 或 turns 数组。');
    const turns = messages.map((message, index) => {
      const role = message.role || message.speaker || (message.type === 'human' ? 'user' : 'assistant');
      const content = message.content ?? message.text ?? message.message ?? '';
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part.text || '').join('\n') : JSON.stringify(content);
      const thinking = message.thinking || message.reasoning || message.reasoning_content || '';
      return makeTurn(roleOf(role), text, index, thinking);
    });
    const normalized = finalizeTurns(turns);
    return {
      schema_version: 'trace.v1',
      id: hash(normalized.map((turn) => `${turn.speaker}\u0000${turn.text}\u0000${turn.thinking}`).join('\u0001')),
      source: { type: meta.type || 'import', url: data.url || meta.url || '', title: data.title || meta.title || '', captured_at: data.captured_at || meta.captured_at || new Date().toISOString() },
      turns: normalized,
      attachments: Array.isArray(data.attachments) ? data.attachments : [],
    };
  }

  function normalizeTrace(input, meta = {}) {
    if (input && typeof input === 'object') return parseJson(input, meta);
    const text = String(input ?? '');
    if (/^\s*[\[{]/.test(text)) {
      try { return parseJson(text, meta); } catch {}
    }
    return parseMarkdown(text, meta);
  }

  function traceToMarkdown(trace, { includeThinking = true } = {}) {
    const labels = { user: '用户', assistant: '助手', system: '系统' };
    return trace.turns.map((turn) => {
      const head = `${labels[turn.speaker] || '用户'}：`;
      const thinking = includeThinking && turn.thinking ? `思考：${turn.thinking}\n` : '';
      return `${head}\n${thinking}${turn.text}`;
    }).join('\n\n');
  }

  function validateTrace(trace) {
    const errors = [];
    if (!trace || trace.schema_version !== 'trace.v1') errors.push('schema_version 必须是 trace.v1');
    if (!trace.id || !/^tr_[a-f0-9]{16}$/.test(trace.id)) errors.push('Trace id 不合法');
    if (!SOURCE_TYPES.includes(trace.source?.type)) errors.push('source.type 不合法');
    if (!Array.isArray(trace.turns) || !trace.turns.length) errors.push('turns 不能为空');
    for (const turn of trace.turns || []) {
      if (!SPEAKERS.includes(turn.speaker)) errors.push(`第 ${turn.index} 轮 speaker 不合法`);
      if (!Number.isInteger(turn.index) || turn.index < 0) errors.push('turn.index 必须是非负整数');
      if (!turn.text && !turn.thinking) errors.push(`第 ${turn.index} 轮没有正文或可见思考`);
    }
    return errors;
  }

  function captureQwen(document, location, options = {}) {
    const selectors = [
      '[data-role="user"]',
      '[data-role="assistant"]',
      '[data-testid*="message"]',
      '[class*="chat-message"]',
      '[class*="message-item"]',
      '[class*="message-bubble"]',
      '[class*="bubble"]',
    ].join(',');
    const all = [...document.querySelectorAll(selectors)];
    const nodes = all.filter((node) => !all.some((other) => other !== node && other.contains(node)));
    const turns = [];
    for (const node of nodes) {
      const roleAttr = node.getAttribute('data-role') || node.getAttribute('data-speaker') || '';
      const classText = `${node.className || ''} ${node.getAttribute('data-testid') || ''}`;
      const speaker = roleOf(`${roleAttr} ${classText}`);
      const clone = node.cloneNode(true);
      const thinkingNodes = [...clone.querySelectorAll('[class*="thinking"], [class*="reasoning"], [class*="thought"], [data-testid*="thinking"], details')];
      const thinking = thinkingNodes.map((item) => item.textContent || '').join('\n').trim();
      for (const item of thinkingNodes) item.remove();
      for (const item of clone.querySelectorAll('button, script, style, svg, [aria-hidden="true"]')) item.remove();
      const text = (clone.innerText || clone.textContent || '').trim();
      if (text || thinking) turns.push(makeTurn(speaker, text, turns.length, thinking));
    }
    if (!turns.length) {
      const selection = String(document.getSelection?.() || '').trim();
      const main = document.querySelector('main') || document.body;
      const text = selection || (main?.innerText || main?.textContent || '').trim();
      if (text) return parseMarkdown(text, { type: 'qwen-extension', url: location.href, title: document.title });
    }
    const normalized = finalizeTurns(turns);
    return {
      schema_version: 'trace.v1',
      id: hash(normalized.map((turn) => `${turn.speaker}\u0000${turn.text}\u0000${turn.thinking}`).join('\u0001')),
      source: { type: 'qwen-extension', url: location.href, title: document.title, captured_at: new Date().toISOString() },
      turns: normalized,
      attachments: Array.isArray(options.attachments) ? options.attachments : [],
    };
  }

  const api = { hash, cleanText, roleOf, makeTurn, finalizeTurns, parseMarkdown, parseJson, normalizeTrace, traceToMarkdown, validateTrace, captureQwen };
  if (typeof globalThis !== 'undefined') globalThis.TraceCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
