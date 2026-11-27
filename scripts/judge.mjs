import { clipAtBoundary, stableQuoteId, stableTurnId, validateTurn, visibleLen } from './contract.mjs';
import { cuesOf, cleanDisplay } from './collect.mjs';

const STRONG_CORRECTION = /不是|其实|更准确|准确说|理解错|搞错|说反|问题出在|不能把|别把|相反|反而|不等于|并非|而非|更正|纠正一下|\bnot\b|actually|wrong|incorrect|instead|rather than|switching|changing|the problem|the issue/i;
const STOP = /[的了呢吗吧啊呀哦，。！？；：、,.!?;:\s“”‘’（）()《》〈〉「」『』\[\]—…]/g;
const normalize = (value) => String(value ?? '').toLowerCase().replace(STOP, '');
const compact = (value) => normalize(value);

function bigrams(value) {
  const chars = [...compact(value)];
  const out = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}
function overlap(a, b) {
  const left = bigrams(a);
  const right = new Set(bigrams(b));
  if (!left.length) return 0;
  let hit = 0;
  for (const item of left) if (right.has(item)) hit++;
  return hit / left.length;
}
function sharedBigramCount(a, b) {
  const right = new Set(bigrams(b));
  let count = 0;
  for (const item of bigrams(a)) if (right.has(item)) count++;
  return count;
}
const TOPIC_ANCHORS = ['定时', 'cron', 'diary', 'pages', 'docs/', 'web/index', '箭头', '卡片', '转折', '结论', '相似度', 'hook', 'conclusion', '字节', '哈希', '矩阵', '溢出', '测试', '布局', '版本', '证据', '原文', '规则', '版式', '流程', '入口'];
function strongTopic(a, b) {
  const x = compact(a);
  const y = compact(b);
  if (!x || !y) return false;
  if (TOPIC_ANCHORS.some((anchor) => x.includes(compact(anchor)) && y.includes(compact(anchor)))) return true;
  const numbersA = x.match(/\d+(?:\.\d+)?/g) || [];
  const numbersB = new Set(y.match(/\d+(?:\.\d+)?/g) || []);
  if (numbersA.some((number) => numbersB.has(number))) return true;
  if ((x.includes(y) || y.includes(x)) && Math.min(x.length, y.length) >= 4) return true;
  return overlap(a, b) >= 0.3;
}
function topicLinked(a, b, c) {
  return strongTopic(a, b) || strongTopic(a, c) || strongTopic(b, c)
    || sharedBigramCount(a, b) >= 5 || sharedBigramCount(a, c) >= 5 || sharedBigramCount(b, c) >= 5;
}

const hasStance = (item) => item?.cues.includes('belief') || item?.cues.includes('proposal')
  || /必须|不许|不需要|前提|规则|约束|做一个|做一次|已把|我推荐|I recommend|I propose|must|should|requirement|再加|新增|自动总结|定时|生成一张|改程序|相似度|阈值|打回|重写|验收|转折带|结论说|写着|被判成/i.test(item?.display || '');
const hasUserChallenge = (item) => item?.cues.includes('challenge') || item?.cues.includes('correction')
  || /不要|不是|必须|应该|只能|改|矛盾|不一致|没抓到|有出入|减法|不是加法|反对|不接受|不允许|but|however|wrong|incorrect|doesn't|does not|\bnot\b/i.test(item?.display || '');
const hasStrongUserChallenge = (item) => /不要|不是|矛盾|不一致|减法|不是加法|反对|不接受|不允许|wrong|incorrect|doesn't|does not|\bnot\b/i.test(item?.display || '');
const hasAssistantClaim = (item) => item?.cues.includes('claim')
  || /推荐|已把|只有|没分|不再|结论|规则|判断|认为|发现|得出|确认|承诺|计划|只能|必须|默认|入口|流程|原则|只许|漏了|判成|做一次反向对照|做虚|做错|误判|承认|I recommend|the rule|the test|the metric/i.test(item?.display || '');
const hasAssistantAdmission = (item) => /你说得对|我承认|我把.{0,40}(?:做虚|做错|误判|漏|搞错)|确实(?:是|有)|对，我|我之前的.{0,30}(?:错|不对|误)/i.test(item?.display || '');
const hasAssistantDiagnosis = (item) => item?.cues.includes('self_correction') || item?.cues.includes('correction')
  || /wrong|incorrect|my |not the|不是|没抓到|矛盾|误伤|测量错误|测试环境|溢出来自|明写|打不进|只允许|没有偷偷|有出入|漏了|问题|缺口|明明|被推翻/i.test(item?.display || '');
const hasStrongDiagnosis = (item) => item?.cues.includes('self_correction')
  || /wrong test|wrong metric|my mistake|I was wrong|my measurement|my assertion|not the code|不是站点本身|没抓到|自相矛盾|矛盾|误伤|测量错误|测试环境问题|溢出来自|明写|打不进|只允许|没有偷偷|有出入|漏了两种|名不副实|缺口|real bug|real defect|明明|被推翻|判保守|误判|漏判|dilutes|slips through|fails? to|无法|达不到|失效|不准|不够/i.test(item?.display || '');
const hasAssistantAction = (item) => item?.cues.includes('action')
  || /而是|我现在|我会|I will|we will|will use|will keep|改为|改成|移到|收回|保留|同步|只留|要么|按事实|别承诺|硬规则|才会|自动|不等于|才是|意味着|替代|switching|changing|fixing|instead|correct|replace|回头看|判保守|重判|改判|不是\s*bug|可复现|重做|重排|补上|随机把|延后|默认入口|退到实验|正确做法(?:是|：)/i.test(item?.display || '');
const hasStrongProposal = (item) => /我准备|我打算|我建议|我反对|我不同意|不道德|不太道德|不合理|不太合理|不能接受|应该|不该|宁可|宁愿|不需要|前提|必须|不许|做一个|做一次|规则|要求|再加|新增|自动总结|定时|生成一张|改程序|相似度|阈值|打回|重写|验收|I recommend|I propose|I want|we should|must|should|the rule|requirement/i.test(item?.display || '');
const SUBSTANTIVE_REPLACEMENT = /switching|changing|改为|改成|收回|移到|只留|保留|同步|变成硬规则|按事实|别承诺|不是\s*bug|可复现|重做|重排|新增一层|我会(?:把|让)|我现在(?:把|先)|要么|自动换|退到实验|旧版式|默认入口|实验入口|不放宽|不缩字号|内容不删|随机把|延后|延迟引入|正确(?:的)?用法|正确做法(?:是|：)|不要拿|而不是继续|而非|实测上把|压到|显著降低|不等于|才是|替代|回头看|判保守|重判|改判/i;
const GENERIC_FIX = /\b(?:fixing|fixed|fix|repair|repairing)\b|修复|修正|改完|修完|重跑|检查|验证|测试/i;
const hasSubstantiveReplacement = (item) => SUBSTANTIVE_REPLACEMENT.test(item?.display || '');
const isGenericFix = (item) => GENERIC_FIX.test(item?.display || '') && !hasSubstantiveReplacement(item);

function expandEvidence(evidence) {
  const out = [];
  const commaSplit = /回头看|判保守|误判|漏判|明明|被推翻|测量错误|我的错|搞错|说反|其实不是|wrong test|wrong metric|not the code|不是站点本身|没抓到|没有偷偷/i;
  for (const item of evidence) {
    let parts = [item.text];
    if (visibleLen(item.display) > 24) {
      const chunks = [];
      let start = 0;
      for (const match of item.text.matchAll(/——|—|；|;/g)) {
        chunks.push(item.text.slice(start, match.index + match[0].length));
        start = match.index + match[0].length;
      }
      chunks.push(item.text.slice(start));
      parts = chunks.map((part) => part.trim()).filter((part) => visibleLen(cleanDisplay(part)) >= 4);
      if (commaSplit.test(item.display)) {
        parts = parts.flatMap((part) => {
          const clauses = [];
          let offset = 0;
          for (const match of part.matchAll(/[，,]/g)) {
            clauses.push(part.slice(offset, match.index + 1).trim());
            offset = match.index + 1;
          }
          clauses.push(part.slice(offset).trim());
          return clauses.filter((clause) => visibleLen(cleanDisplay(clause)) >= 4);
        });
      }
    }
    if (parts.length <= 1) {
      out.push(item);
      continue;
    }
    for (const text of parts) {
      const display = cleanDisplay(text);
      const clause = {
        ...item,
        text,
        display,
        quote_id: stableQuoteId({ speaker: item.speaker, turnIndex: item.turn_index, text }),
      };
      const cues = new Set(cuesOf(text));
      if (hasAssistantAction(clause)) cues.add('action');
      if (hasAssistantDiagnosis(clause)) cues.add('correction');
      if (hasAssistantClaim(clause)) cues.add('claim');
      if (hasStrongDiagnosis(clause)) cues.add('self_correction');
      clause.cues = [...cues];
      out.push(clause);
    }
  }
  return out;
}

function blockFrom(item, confidence) {
  return { text: item.display, quote: item.text, source: item.speaker, confidence };
}
function subEvidence(parent, text) {
  const quote = String(text ?? '').trim();
  const display = cleanDisplay(quote);
  const item = { ...parent, text: quote, display };
  return {
    ...item,
    quote_id: stableQuoteId({ speaker: parent.speaker, turnIndex: parent.turn_index, text: quote }),
    cues: [...new Set([
      ...cuesOf(quote),
      ...(hasAssistantAction(item) ? ['action'] : []),
      ...(hasAssistantDiagnosis(item) ? ['correction'] : []),
      ...(hasAssistantClaim(item) ? ['claim'] : []),
      ...(hasStrongDiagnosis(item) ? ['self_correction'] : []),
    ])],
  };
}
function contextualPrior(evidence, current) {
  if (current.speaker !== 'user') return current;
  const index = evidence.findIndex((item) => item.quote_id === current.quote_id);
  const previous = evidence[index - 1];
  if (!previous || previous.speaker !== 'user' || previous.turn_index !== current.turn_index) return current;
  if (visibleLen(current.display) >= 18 && !/不道德|不合理|准备写|想说|打算/.test(current.display)) return current;
  return subEvidence(current, `${previous.text}${current.text}`);
}
function replyWithRevised(evidence, reply) {
  const index = evidence.findIndex((item) => item.quote_id === reply.quote_id);
  const previous = evidence[index - 1];
  if (previous && previous.speaker === reply.speaker && previous.turn_index === reply.turn_index
    && visibleLen(reply.display) < 14 && /^(?:重做|重跑|这条|这是|补上|修好)/i.test(reply.display)) {
    const parts = [reply.text];
    let cursor = index - 1;
    let combined = reply;
    while (cursor >= 0 && parts.length < 4) {
      const item = evidence[cursor];
      if (item.speaker !== reply.speaker || item.turn_index !== reply.turn_index) break;
      parts.unshift(item.text);
      combined = subEvidence(reply, parts.join(''));
      if (hasStrongDiagnosis(item) || visibleLen(combined.display) >= 48) break;
      cursor--;
    }
    return combined;
  }
  const next = evidence[index + 1];
  if (next && next.speaker === reply.speaker && next.turn_index === reply.turn_index
    && /[，,]$/.test(reply.text) && /^(?:要么|或者|否则)/.test(next.display)) {
    return subEvidence(reply, `${reply.text}${next.text}`);
  }
  if (next && next.speaker === reply.speaker && next.turn_index === reply.turn_index) {
    if (visibleLen(reply.display) < 8) return next;
    if (next.cues.includes('action') && !reply.cues.includes('action')) return next;
    if (next.cues.includes('action') && /相对有效|可行|折中|实测|正确|改为|应该|应当|instead|rather than|switching|changing|should|must|correct|replace/i.test(next.display)
      && /不要|不能|不是|别用|不建议|\bnot\b|wrong|incorrect/i.test(reply.display)) return next;
  }
  return reply;
}

function collisionWithDiagnosis(evidence, collision) {
  if (!collision || !/^(?:不是|其实不是|不对|错了)[。！!?]?$/.test(cleanDisplay(collision.display))) return collision;
  const index = evidence.findIndex((item) => item.quote_id === collision.quote_id);
  const next = evidence[index + 1];
  if (next && next.speaker === collision.speaker && next.turn_index === collision.turn_index
    && (hasAssistantDiagnosis(next) || /不会让|不会使|不能证明|不代表|不等于/.test(next.display)) && !hasAssistantAction(next)) {
    return subEvidence(collision, `${collision.text}${next.text}`);
  }
  return collision;
}

function inferredPrior(question, confidence = 0.58) {
  const text = question.display;
  let match = text.match(/(?:为什么|为啥)(?:大家|人们|你|我)?(?:都)?(?:把|将)?(.{2,24}?)(?:当|看成|理解成|当作)(.{2,24}?)(?:[？?]|$)/);
  if (match) {
    const subject = match[1].replace(/^(?:大家|人们|你|我)/, '').trim();
    const assumed = match[2].replace(/[？?。！？]+$/, '').trim();
    return { text: `你以为${subject}是${assumed}`, quote: '', source: 'inferred', confidence, inference: `从你后面的问法看，你以为过：${subject}是${assumed}` };
  }
  match = text.match(/(.{2,28}?)不是(.{2,28}?)吗[？?]?/);
  if (match) {
    const subject = match[1].trim();
    const assumed = match[2].replace(/[？?。！？]+$/, '').trim();
    return { text: `你以为${subject}是${assumed}`, quote: '', source: 'inferred', confidence: Math.min(confidence, 0.52), inference: `从你后面的反问看，你以为过：${subject}是${assumed}` };
  }
  match = text.match(/\bwhy\s+(?:do|does|did|is|are)\s+(.{2,60}?)\s+(?:mean|refer to|stand for)\s+(.{2,60}?)[?.!?]?$/i);
  if (match) return { text: `You assumed ${match[1].trim()} means ${match[2].trim()}`, quote: '', source: 'inferred', confidence: 0.5, inference: `From your later question, you may have assumed: ${match[1].trim()} means ${match[2].trim()}` };
  return null;
}

function extractNegated(sentence) {
  const text = sentence.display;
  let match = text.match(/不是(.{2,70}?)(?:，|,)(?:而是|就是|是)(.{2,110})/);
  if (match) return { negated: match[1].trim(), revised: match[2].trim() };
  match = text.match(/(.{2,60}?)不是(.{2,70}?)(?:，|,)(?:而是|就是|是)(.{2,110})/);
  if (match) return { negated: `${match[1].trim()}不是${match[2].trim()}`, revised: match[3].trim() };
  match = text.match(/\bnot\s+(.{2,80}?)(?:,|\s+but\s+|\s+instead\s+)(.{2,120})/i);
  if (match) return { negated: match[1].trim(), revised: match[2].trim() };
  match = text.match(/(.{2,80}?)\s+rather than\s+(.{2,120})/i);
  if (match) return { negated: match[1].trim(), revised: match[2].trim() };
  return null;
}
function findPrior(evidence, current, negated) {
  const needle = compact(negated);
  if (needle.length < 3) return null;
  const earlier = evidence.filter((item) => item.turn_index < current.turn_index)
    .filter((item) => !(item.cues.includes('request') && !item.cues.includes('belief') && /[？?]/.test(item.text)));
  const scored = earlier.map((item) => {
    const hay = compact(item.display);
    let score = hay.includes(needle) ? 1 : overlap(item.display, negated);
    if (item.speaker === 'user') score += 0.08;
    if (current.turn_index - item.turn_index === 1) score += 0.05;
    return { item, score };
  }).filter((entry) => entry.score >= 0.42).sort((a, b) => b.score - a.score || b.item.turn_index - a.item.turn_index);
  return scored[0]?.item || null;
}

function makeTakeaway(candidate, evidence) {
  const revisedIndex = evidence.findIndex((item) => item.quote_id === candidate.revised.quote_id);
  const after = evidence.slice(revisedIndex + 1, revisedIndex + 8);
  const conclusion = after.find((item) => /结论|记住|核心|一句话|真正|规则|所以|带走|宁可|宁愿|不编造|不补|不等于|不是证据|才是|跟着.{0,8}(?:走|调)|取决于|conclusion|remember|takeaway|the real|instead|therefore|so the|not evidence|does not prove/i.test(item.display)
    && overlap(item.display, candidate.revised.display) < 0.6 && visibleLen(item.display) <= 60);
  if (conclusion) return { text: clipAtBoundary(conclusion.display, 40), kind: '口诀' };
  return { text: clipAtBoundary(candidate.revised.display, 40), kind: '口诀' };
}
function makeTitle(candidate) {
  const parsed = extractNegated(candidate.revised);
  let value = parsed?.revised || candidate.revised.display;
  value = value.replace(/^(?:其实|更准确地说|准确地说|正确答案是|问题不在|问题出在|应改为|应该改为|正确做法是|正确做法：|actually|instead|switching to|changing to)/i, '').trim();
  value = value.replace(/^[，,。：:\s]+/, '').trim();
  return clipAtBoundary(value, 24) || '一次判断的改变';
}
function toTurn(candidate, collected, now) {
  const confidence = Math.max(0, Math.min(1, candidate.score / 100));
  const collision = collisionWithDiagnosis(collected.evidence || [], candidate.collision);
  const evidence = [candidate.prior, collision, candidate.revised].filter((item) => item && item.quote_id)
    .map((item) => ({ quote_id: item.quote_id, speaker: item.speaker, turn_index: item.turn_index, text: item.text }));
  const unique = [...new Map(evidence.map((item) => [item.quote_id, item])).values()];
  const turn = {
    id: '',
    title: makeTitle(candidate),
    prior: candidate.prior?.quote_id ? blockFrom(candidate.prior, confidence) : { ...candidate.prior, confidence },
    collision: blockFrom(collision, confidence),
    revised: blockFrom(candidate.revised, confidence),
    takeaway: makeTakeaway(candidate, collected.evidence),
    evidence: unique,
    provenance: candidate.revised.cues.includes('citation') ? 'corpus' : 'model',
    created_at: now,
    source_hash: collected.source_hash,
  };
  turn.id = stableTurnId(turn);
  return turn;
}

function candidateScore(prior, collision, revised, { allowAdjacency = false, directChallenge = false } = {}) {
  const topic = topicLinked(prior.display, collision.display, revised.display);
  const adjacentAlternative = allowAdjacency && collision.speaker === 'assistant' && revised.speaker === 'assistant'
    && collision.turn_index === revised.turn_index && hasSubstantiveReplacement(revised)
    && /这条|它|这个|刚才|之前|我一开始|回头看|判保守|误判|漏判/.test(`${collision.display}${revised.display}`);
  if (!topic && !adjacentAlternative && !directChallenge) return 0;
  const proximity = Math.max(0, 8 - Math.abs(revised.turn_index - prior.turn_index) * 2);
  return 50 + (hasStance(prior) || hasAssistantClaim(prior) ? 8 : 0)
    + (hasUserChallenge(collision) || hasAssistantDiagnosis(collision) ? 12 : 0)
    + (hasAssistantAction(revised) ? 12 : 0) + (topic ? 18 : 0) + proximity
    + (hasSubstantiveReplacement(revised) ? 16 : 0) - (isGenericFix(revised) ? 18 : 0)
    + (/逐像素|相似度|阈值|必须|不许|不需要|前提/.test(prior.display) ? 4 : 0)
    + (/逐像素|空白带|像素一致/.test(prior.display) ? 8 : 0)
    - (/^任务：|^#\s*任务|按 A → B → C/.test(prior.display) ? 12 : 0)
    - (/自己定|做完报告|不要问我/.test(prior.display) ? 10 : 0)
    - (/^图线必须|^每轮|^修复了|^-\s/.test(prior.display) ? 8 : 0)
    + (/相对有效|可行|折中|实测|正确|改为|switching|changing|instead|rather than/i.test(revised.display) ? 10 : 0);
}

export function judgeCollected(collected, { now = new Date().toISOString(), threshold = 64, source = collected.raw_source || '' } = {}) {
  const evidence = expandEvidence(collected.evidence || []);
  const isExternalBriefing = (item) => {
    if (item?.speaker !== 'user') return false;
    const utterance = (collected.utterances || []).find((entry) => entry.turn_index === item.turn_index);
    return /外部已实测|按外部实测|外部测试报告|背景：外部|实测结果如下/.test(utterance?.text || '');
  };
  const considered = [];
  const accepted = [];
  const add = (candidate) => {
    considered.push(candidate);
    const progressOnly = /^(?:implementing|continuing|next\b|now\b|接下来|下一步|现在把|先修|先跑|继续|加一条|新增一条|补一条)/i.test(candidate.revised?.display || '');
    const recapOnly = /同样的标题|测试全过|回归全过|已改完|改完了/.test(candidate.revised?.display || '');
    if ((progressOnly && !hasSubstantiveReplacement(candidate.revised)) || recapOnly) {
      candidate.accepted = false;
      candidate.reject_reason = '这是实施进度，不是旧判断被替换。';
      return;
    }
    if (candidate.score < threshold) {
      candidate.accepted = false;
      candidate.reject_reason = candidate.reject_reason || '证据强度不足，留在候选表里供人判断。';
      return;
    }
    const turn = toTurn(candidate, collected, now);
    const errors = validateTurn(turn, source);
    if (errors.length) {
      candidate.accepted = false;
      candidate.reject_reason = errors.join('；');
      return;
    }
    candidate.accepted = true;
    candidate.turn_id = turn.id;
    accepted.push(turn);
  };

  // assistant claim -> user challenge/correction -> assistant replacement
  for (const prior of evidence.filter((item) => item.speaker === 'assistant' && hasAssistantClaim(item))) {
    const options = [];
    for (const collision of evidence.filter((item) => item.speaker === 'user' && item.turn_index > prior.turn_index && item.turn_index <= prior.turn_index + 2 && hasUserChallenge(item))) {
      const contextualCollision = contextualPrior(evidence, collision);
      for (const reply of evidence.filter((item) => item.speaker === 'assistant' && item.turn_index > collision.turn_index && item.turn_index <= collision.turn_index + 4)) {
        const revised = replyWithRevised(evidence, reply);
        if (!hasAssistantAction(revised)) continue;
        const directChallenge = hasStrongUserChallenge(contextualCollision) && hasSubstantiveReplacement(revised);
        let score = candidateScore(prior, contextualCollision, revised, { directChallenge });
        if (/减法|不是加法|收敛|只保留/i.test(contextualCollision.display)
          && /旧版式代码|完整移到实验目录/i.test(revised.display)) score += 20;
        if (score) options.push({ type: 'assistant-claim-challenged', score, prior, collision: contextualCollision, revised, reason: '助手先给出判断，用户用异议或规则纠正，助手随后替换实现。' });
      }
    }
    options.sort((a, b) => b.score - a.score);
    if (options.length) add(options[0]);
  }

  // user challenge -> assistant admits the earlier claim was incomplete -> replacement
  for (const collision of evidence.filter((item) => item.speaker === 'user' && hasStrongUserChallenge(item))) {
    const contextualCollision = contextualPrior(evidence, collision);
    const options = [];
    for (const admission of evidence.filter((item) => item.speaker === 'assistant' && item.turn_index > collision.turn_index && item.turn_index <= collision.turn_index + 2 && hasAssistantAdmission(item) && hasAssistantClaim(item))) {
      for (const reply of evidence.filter((item) => item.speaker === 'assistant' && item.turn_index >= admission.turn_index && item.turn_index <= admission.turn_index + 1 && hasAssistantAction(item))) {
        const revised = replyWithRevised(evidence, reply);
        if (!hasSubstantiveReplacement(revised)) continue;
        const score = candidateScore(admission, contextualCollision, revised, { directChallenge: true });
        if (score) options.push({ type: 'user-challenge-admitted', score, prior: admission, collision: contextualCollision, revised, reason: '用户指出方向不对，助手承认先前的识别或判断有缺口，并当场换成硬规则。' });
      }
    }
    options.sort((a, b) => b.score - a.score);
    if (options.length) add(options[0]);
  }

  // user stance/requirement -> assistant diagnosis -> assistant replacement
  for (const current of evidence.filter((item) => item.speaker === 'user' && hasStance(item))) {
    if (isExternalBriefing(current)) continue;
    const prior = contextualPrior(evidence, current);
    if (!prior.cues.includes('belief') && !hasStrongProposal(prior)) continue;
    const options = [];
    for (const collision of evidence.filter((item) => item.speaker === 'assistant' && item.turn_index > current.turn_index && item.turn_index <= current.turn_index + 6)) {
      const collisionIndex = evidence.findIndex((item) => item.quote_id === collision.quote_id);
      const directCorrection = (prior.cues.includes('belief') && /不是(?:你|这|它)|你的.{0,20}(?:不对|错)|其实|搞错|理解错|不能把|不要把|问题出在|不是.{0,30}而是|^不是[。！!?]?$|不要用|wrong|incorrect|rather than|\bnot\b/i.test(collision.display))
        || (hasStrongProposal(prior) && /你的|你说|问题出在|不能把|不要把|不要用|其实|搞错|理解错|不是.{0,30}而是|wrong|incorrect|rather than|\bnot\b/i.test(collision.display));
      for (const reply of evidence.filter((item, index) => item.speaker === 'assistant' && index >= collisionIndex && item.turn_index <= collision.turn_index + 4)) {
        const revised = replyWithRevised(evidence, reply);
        if (!hasAssistantAction(revised) || revised.quote_id === collision.quote_id || revised.cues.includes('request') || /[？?]$/.test(revised.display)) continue;
        const proposalAlternative = hasStrongProposal(prior) && /折中|相对有效|问题出在|问题在|有问题|不对|错在|错了|我的错|搞错|理解错|缺口|限制|范围|(?<!能)不能|instead|rather than|switching|changing/.test(collision.display);
        if (!hasStrongDiagnosis(collision) && !directCorrection && !proposalAlternative) continue;
        if (!directCorrection && !proposalAlternative && !hasSubstantiveReplacement(revised)) continue;
        const priorCollisionLinked = strongTopic(prior.display, collision.display) || sharedBigramCount(prior.display, collision.display) >= 5;
        const platformConstraint = /只允许|不允许|不支持/.test(collision.display) && hasSubstantiveReplacement(revised);
        const metricCorrection = /dilutes|slips through|wrong test|wrong metric|measurement|阈值|相似度/.test(collision.display) && hasSubstantiveReplacement(revised);
        const explicitRevisionReference = /这跟你说的|与你说的|你前面说的|你之前说的|按你的要求/.test(revised.display)
          && /依赖|安装|Node|pnpm|npm|库|README/i.test(collision.display)
          && hasSubstantiveReplacement(revised) && (strongTopic(collision.display, revised.display) || sharedBigramCount(collision.display, revised.display) >= 5);
        const explicitAddress = /^不是[。！!?]?$|其实不是|不是.{0,30}而是|你说(?:得对|不对|错|误解|要求)|你要求|你写|不要用|不能把|wrong test|wrong metric|my mistake|I was wrong/i.test(collision.display);
        if (/^我没把|^我只保留|^我没有/.test(revised.display) && !explicitAddress) continue;
        if (visibleLen(prior.display) > 160 && !directCorrection && !proposalAlternative && !platformConstraint && !metricCorrection && !explicitRevisionReference) continue;
        if (!priorCollisionLinked && !proposalAlternative && !platformConstraint && !metricCorrection && !explicitRevisionReference && !(directCorrection && explicitAddress)) continue;
        let score = candidateScore(prior, collision, revised, { allowAdjacency: true, directChallenge: directCorrection || proposalAlternative || platformConstraint || metricCorrection || explicitRevisionReference });
        if (/正确做法(?:是|：)/.test(revised.display)) score += 20;
        if (platformConstraint && /web\/index|单页|页面|网站/.test(prior.display)) score += 10;
        if (score) options.push({ type: 'user-claim-corrected', score, prior, collision, revised, reason: '用户先给出判断或要求，助手指出它的问题，并改成可执行规则。' });
      }
    }
    options.sort((a, b) => b.score - a.score);
    if (options.length) add(options[0]);
  }

  // explicit reference back to a user-stated assumption, with a dependency diagnosis in between
  for (let revisedIndex = 0; revisedIndex < evidence.length; revisedIndex++) {
    const revised = evidence[revisedIndex];
    if (revised.speaker !== 'assistant') continue;
    const reference = revised.display.match(/(?:这跟你说的|与你说的|你前面说的)「([^」]+)」/);
    if (!reference) continue;
    const needle = compact(reference[1]);
    if (needle.length < 4) continue;
    let prior = evidence.slice(0, revisedIndex).reverse().find((item) => item.speaker === 'user'
      && compact(item.display).includes(needle));
    if (!prior) continue;
    const priorIndex = evidence.findIndex((item) => item.quote_id === prior.quote_id);
    if (visibleLen(prior.display) > 160) {
      const position = prior.text.indexOf(reference[1]);
      if (position >= 0) {
        const starts = ['。', '；', '\n'].map((mark) => prior.text.lastIndexOf(mark, position)).filter((index) => index >= 0);
        const ends = ['。', '；', '\n'].map((mark) => prior.text.indexOf(mark, position)).filter((index) => index >= 0);
        const start = starts.length ? Math.max(...starts) + 1 : 0;
        const end = ends.length ? Math.min(...ends) + 1 : prior.text.length;
        const excerpt = prior.text.slice(start, end).trim();
        if (visibleLen(cleanDisplay(excerpt)) <= 160) prior = subEvidence(prior, excerpt);
      }
    }
    const collision = evidence.slice(priorIndex + 1, revisedIndex).reverse().find((item) => item.speaker === 'assistant'
      && /依赖|安装|Node|pnpm|npm|库|README/i.test(item.display) && hasStrongDiagnosis(item));
    if (!collision) continue;
    const score = candidateScore(prior, collision, revised, { directChallenge: true });
    if (score) add({ type: 'explicit-assumption-reference', score, prior, collision, revised, reason: '助手明确回指用户先前说过的安装前提，并用真实依赖限制替换它。' });
  }

  // user claim -> later user contradiction -> assistant repair
  for (let currentIndex = 0; currentIndex < evidence.length; currentIndex++) {
    const current = evidence[currentIndex];
    if (current.speaker !== 'user' || !hasStance(current) || isExternalBriefing(current)) continue;
    const prior = contextualPrior(evidence, current);
    const options = [];
    for (let collisionIndex = currentIndex + 1; collisionIndex < evidence.length; collisionIndex++) {
      const collision = evidence[collisionIndex];
      if (collision.speaker !== 'user' || collision.turn_index > current.turn_index + 5 || !hasUserChallenge(collision)) continue;
      if (/全量检查|检查另外|有没有|有就改|没有就报/.test(collision.display)) continue;
      if (!/其实不是|其实我|但其实|但是|然而|可是|不过|相反|反而|不是|矛盾|不一致|搞错|理解错|更正|纠正|之前|现在才|后来才发现|self-contradiction/i.test(collision.display)) continue;
      for (const reply of evidence.filter((item, index) => item.speaker === 'assistant' && index > collisionIndex
        && item.turn_index <= collision.turn_index + 2 && hasAssistantAction(item))) {
        const score = candidateScore(prior, collision, reply);
        if (score) options.push({ type: 'user-self-contradiction', score, prior, collision, revised: reply, reason: '用户后面的说法推翻或限定自己前面的要求，助手随后修复。' });
      }
    }
    options.sort((a, b) => b.score - a.score);
    if (options.length) add(options[0]);
  }

  // assistant claim -> assistant diagnosis -> assistant repair
  for (let collisionIndex = 0; collisionIndex < evidence.length; collisionIndex++) {
    const collision = evidence[collisionIndex];
    if (collision.speaker !== 'assistant' || !hasStrongDiagnosis(collision)) continue;
    const priors = evidence.map((item, index) => ({ item, index }))
      .filter(({ item, index }) => item.speaker === 'assistant' && index < collisionIndex && index >= collisionIndex - 8
        && item.turn_index >= collision.turn_index - 20 && hasAssistantClaim(item))
      .map(({ item, index }) => ({ item, score: overlap(item.display, collision.display)
        + Math.max(0, 20 - (collision.turn_index - item.turn_index)) * 0.01 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    const replies = evidence.map((item, index) => ({ item, index }))
      .filter(({ item, index }) => item.speaker === 'assistant' && index >= collisionIndex
        && item.turn_index <= collision.turn_index + 2 && hasAssistantAction(item)
        && hasSubstantiveReplacement(item) && !isGenericFix(item));
    const options = [];
    for (const { item: prior } of priors) {
      const priorCollisionLinked = strongTopic(prior.display, collision.display) || sharedBigramCount(prior.display, collision.display) >= 4;
      for (const { item: reply } of replies) {
        const revised = replyWithRevised(evidence, reply);
        if (!hasSubstantiveReplacement(revised) || isGenericFix(revised) || visibleLen(revised.display) < 6 || revised.quote_id === collision.quote_id) continue;
        const ownDiagnosis = /我|我的|我们|我们的|刚才|之前|其实|原来|漏|误|错|没抓到|不平等|那条|这条|不是站点|不是代码|回头看|判保守|误判|漏判/i.test(`${prior.display}${collision.display}`);
        if (/被推翻|明明/.test(collision.display) && !/判成|分类|普通|我/.test(prior.display)) continue;
        const retrospective = /回头看|判保守|误判|漏判|这条|刚才|之前|我一开始/i.test(`${collision.display}${revised.display}`);
        if (!ownDiagnosis || (!priorCollisionLinked && !retrospective)) continue;
        const score = candidateScore(prior, collision, revised, { allowAdjacency: true });
        if (score) options.push({ type: 'assistant-self-correction', score, prior, collision, revised, reason: '助手先前的判断被自己发现的问题推翻，并明确改正。' });
      }
    }
    options.sort((a, b) => b.score - a.score);
    if (options.length) add(options[0]);
  }

  // retrospective reclassification: the diagnosis can appear before the quoted prior in one sentence
  for (let revisedIndex = 0; revisedIndex < evidence.length; revisedIndex++) {
    const revised = evidence[revisedIndex];
    if (revised.speaker !== 'assistant' || !/回头看|判保守|重判|改判|误判|漏判/.test(revised.display)) continue;
    const nearby = evidence.slice(Math.max(0, revisedIndex - 5), revisedIndex)
      .filter((item) => item.speaker === 'assistant' && item.turn_index === revised.turn_index);
    const prior = [...nearby].reverse().find((item) => hasAssistantClaim(item) && /判成|分类成|归为|当成|看作/.test(item.display));
    const collision = [...nearby].reverse().find((item) => hasStrongDiagnosis(item) && /明明|被推翻|矛盾|误判|漏判/.test(item.display));
    if (!prior || !collision || prior.quote_id === collision.quote_id) continue;
    const score = candidateScore(prior, collision, revised, { directChallenge: true });
    if (score) add({ type: 'retrospective-reclassification', score, prior, collision, revised, reason: '助手回头承认自己上次分类保守，并明确改判。' });
  }

  // No exact prior: infer only from a leading question and mark it explicitly.
  for (const question of evidence.filter((item) => item.speaker === 'user' && /[？?]/.test(item.text))) {
    const inferred = inferredPrior(question);
    if (!inferred) continue;
    const reply = evidence.find((item) => item.speaker === 'assistant' && item.turn_index > question.turn_index && item.turn_index <= question.turn_index + 2 && STRONG_CORRECTION.test(item.display) && !item.cues.includes('request'));
    if (!reply) continue;
    const revised = replyWithRevised(evidence, reply);
    add({ type: 'inferred-prior', score: 68, prior: inferred, collision: reply, revised, reason: '没有更早的原话，只能从用户后面的问法推断 prior，并显式标记。' });
  }

  const usedQuotes = new Set(considered.flatMap((item) => [item.prior?.quote_id, item.collision?.quote_id, item.revised?.quote_id]).filter(Boolean));
  for (const item of evidence.filter((entry) => entry.cues.includes('correction') && !usedQuotes.has(entry.quote_id)).slice(0, 12)) {
    considered.push({ type: 'explanation-near-miss', score: 20, accepted: false, collision: item, revised: item, reject_reason: '只有概念澄清，没有参与者先前的判断被推翻；留在候选表里供人判断。' });
  }

  const ranked = accepted.map((turn) => ({ turn, candidate: considered.find((item) => item.turn_id === turn.id) }))
    .sort((a, b) => b.candidate.score - a.candidate.score || a.turn.evidence[0].turn_index - b.turn.evidence[0].turn_index);
  const byCollision = new Map();
  for (const entry of ranked) {
    const key = entry.candidate.collision?.quote_id || entry.turn.id;
    const previous = byCollision.get(key);
    if (!previous || entry.candidate.score > previous.candidate.score) byCollision.set(key, entry);
  }
  const seen = new Set();
  const turns = [];
  for (const { turn } of [...byCollision.values()].sort((a, b) => b.candidate.score - a.candidate.score)) {
    const key = turn.revised.quote;
    if (seen.has(key)) continue;
    seen.add(key);
    turns.push(turn);
    if (turns.length >= 8) break;
  }
  return {
    stage: 'judge',
    status: turns.length ? 'turns' : 'no-turn',
    message: turns.length ? `找到 ${turns.length} 个转弯，已拆成 ${turns.length} 张独立卡片。` : '这段对话里没有转弯，只有讲解。',
    turns,
    candidates: considered.map(({ turn_id, ...candidate }) => ({ ...candidate, accepted: !!turn_id && turns.some((turn) => turn.id === turn_id) })),
    stats: { considered: considered.length, accepted: turns.length, rejected: considered.length - turns.length },
  };
}
