import { sourceHash, stableQuoteId, visibleLen } from './contract.mjs';

const SPEAKER_ALIASES = new Map([
  ['用户', 'user'], ['我', 'user'], ['问', 'user'], ['提问', 'user'], ['Q', 'user'],
  ['助手', 'assistant'], ['AI', 'assistant'], ['Qoder', 'assistant'], ['答', 'assistant'], ['回答', 'assistant'], ['A', 'assistant'],
]);

const CUE_PATTERNS = Object.freeze({
  belief: /以为|觉得|我认为|我相信|默认|理解成|理解为|意思是|是不是|难道|我一直|原来|先前|之前|本来的理解|必须|不许|不需要|前提|I thought|I assumed|I believed|we assumed|my understanding|the rule was|the requirement|must be|should be/i,
  revision: /其实|原来如此|搞错|说反|理解错|更正|纠正一下|前面那句|我刚才|我之前|我本来|现在觉得|更准确|准确地说|问题出在|不能把|别把|不等于|并非|而非|不是.{0,40}而是|不是.{0,40}，是|actually|instead|rather than|wrong|incorrect|switching|changing|revised|correction|the real|should be/i,
  correction: /不是|其实|更准确|准确说|理解错|搞错|反了|应当|应该|而是|问题出在|区别在于|不能把|别把|不要|别用|不能|不建议|相反|反而|不等于|并非|而非|\bnot\b|actually|wrong|incorrect|instead|rather than|should|must|the problem|the issue|fix|changing|switching/i,
  contrast: /但|但是|然而|可是|不过|相反|反而|其实/i,
  request: /讲一下|解释一下|什么是|是什么意思|怎么做|如何|出图|继续|详细讲讲/i,
  proposal: /我准备|我想|我打算|我建议|我觉得|我以为|我相信|我反对|我不同意|不道德|不太道德|不合理|不太合理|不能接受|应该|不该|宁可|宁愿|I recommend|I propose|I want|we should|must|should|the rule|requirement/i,
  challenge: /等等|不可靠|哪来的|是不是|难道|太激进|不合适|不道德|不合理|不同意|反对|担心|出处|证据|问题出在|名不副实|\bbut\b|however|doesn't|does not|wrong|incorrect|contradict|conflict|the problem|the issue|why|how/i,
  claim: /给出|结论|关键|核心|意味着|等于|只能|必须|应当|应该|默认|建议|本质上|正确|规则|公理|recommend|rule|requirement|means|must|should|conclusion|claim|the test|the metric/i,
  self_correction: /缺口|名不副实|漏了|搞错|说反|理解错|更正|纠正一下|自相矛盾|不对|错了|其实不是|更准确|还发现.{0,20}(?:问题|缺口|错误)|my mistake|I was wrong|wrong test|wrong metric|real bug|real defect|the problem|the issue|switching|fixing|incorrect/i,
  action: /我会|改为|改成|必须|应该|应当|修正|补齐|现在是|正确用法|正确的用法|不要拿|不要|别用|不能|不建议|可行|折中|做法|相对有效|真正|说明|实测|区分|合适|不合适|不等于|才是|意味着|替代|switching|changing|fixing|should|must|instead|revised|correct|replace|use|implement/i,
  citation: /出处|参考文献|doi|https?:\/\/|\([12]\d{3}\)|\b[A-Z][A-Za-z]+ et al\./i,
});

export function cleanDisplay(text) {
  return String(text)
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/^\s*>\s*/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.、])\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cuesOf(text) {
  return Object.entries(CUE_PATTERNS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
}

function splitSentences(text) {
  const out = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const chineseEnd = /[。！？!?]/.test(char);
    const englishEnd = char === '.' && (index + 1 >= text.length || /\s/.test(text[index + 1])) && !/\d/.test(text[index - 1] || '');
    if (!chineseEnd && !englishEnd) continue;
    let end = index + 1;
    while (end < text.length && /[。！？!?]/.test(text[end])) end++;
    const quote = text.slice(start, end).trim();
    if (visibleLen(quote) >= 2) out.push({ quote, text: cleanDisplay(quote), cues: cuesOf(quote) });
    start = end;
    index = end - 1;
  }
  const tail = text.slice(start).trim();
  if (visibleLen(tail) >= 2) out.push({ quote: tail, text: cleanDisplay(tail), cues: cuesOf(tail) });
  return out;
}

function parseUtterances(source) {
  const lines = String(source).replace(/\r\n/g, '\n').split('\n');
  const utterances = [];
  let current = null;
  let sawMarker = false;

  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    if (text) utterances.push({ speaker: current.speaker, turn_index: utterances.length, text });
    current = null;
  };
  const start = (speaker, remainder = '') => {
    flush();
    sawMarker = true;
    current = { speaker, lines: remainder ? [remainder] : [] };
  };

  for (const line of lines) {
    if (!current && /^\s*#\s*(?:Title:|Source JSONL:|Source user lines:|Extraction:|m1-private-)/i.test(line)) continue;
    const block = line.match(/^\s*={2,}\s*(USER|ASSISTANT)(?:\s+\d+)?\s*={2,}\s*$/i);
    if (block) {
      start(block[1].toLowerCase() === 'user' ? 'user' : 'assistant');
      continue;
    }
    const heading = line.match(/^\s*#{1,6}\s*(用户|助手|AI|Qoder|我|你|问|提问|答|回答|Q|A)\s*:?\s*$/i);
    if (heading) {
      start(SPEAKER_ALIASES.get(heading[1]) || (heading[1] === '我' ? 'user' : 'assistant'));
      continue;
    }
    const bold = line.match(/^\s*\*\*(用户|助手|AI|Qoder|我|你|问|提问|答|回答|Q|A)(?:（第?\s*\d+\s*轮）|\(第?\s*\d+\s*轮\))?\*\*\s*[:：]?\s*(.*)$/i);
    if (bold) {
      start(SPEAKER_ALIASES.get(bold[1]) || 'assistant', bold[2]);
      continue;
    }
    const plain = line.match(/^\s*(用户|助手|AI|Qoder|我|你|问|提问|答|回答|Q|A)\s*[:：]\s*(.*)$/i);
    if (plain) {
      start(SPEAKER_ALIASES.get(plain[1]) || 'assistant', plain[2]);
      continue;
    }
    if (!current) current = { speaker: 'assistant', lines: [] };
    current.lines.push(line);
  }
  flush();
  if (!utterances.length && source.trim()) {
    utterances.push({ speaker: 'assistant', turn_index: 0, text: source.trim() });
  }
  return { utterances, sawMarker };
}

export function collectDialogue(source) {
  const raw = String(source ?? '').replace(/\r\n/g, '\n');
  const { utterances, sawMarker } = parseUtterances(raw);
  const evidence = [];
  for (const utterance of utterances) {
    for (const sentence of splitSentences(utterance.text)) {
      evidence.push({
        quote_id: stableQuoteId({ speaker: utterance.speaker, turnIndex: utterance.turn_index, text: sentence.quote }),
        speaker: utterance.speaker,
        turn_index: utterance.turn_index,
        text: sentence.quote,
        display: sentence.text,
        cues: sentence.cues,
      });
    }
  }
  return {
    stage: 'collect',
    raw_source: raw,
    source_hash: sourceHash(raw),
    source_chars: visibleLen(raw),
    speaker_markers: sawMarker,
    utterances,
    evidence,
    candidates: evidence.filter((item) => item.cues.some((cue) => ['belief', 'revision', 'correction', 'contrast', 'proposal', 'challenge', 'claim', 'self_correction', 'action'].includes(cue))),
    stats: {
      utterances: utterances.length,
      user_utterances: utterances.filter((u) => u.speaker === 'user').length,
      assistant_utterances: utterances.filter((u) => u.speaker === 'assistant').length,
      sentences: evidence.length,
      cue_candidates: evidence.filter((item) => item.cues.length).length,
    },
  };
}
