export { resolveTemporalQuery } from './temporal-query.mjs';
import { replaceQuotedText } from './query-text.mjs';

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/’/gu, "'").replace(/\s+/gu, " ").trim();
}

function normalizeQuery(value) {
  return normalize(value).replace(/\b(what|who|where|when|why|how)'(s|re)\b/gu,
    (_, word, auxiliary) => `${word} ${auxiliary === 's' ? 'is' : 'are'}`)
    .replace(/\b(did|was|were|had)n't\b/gu, '$1 not');
}

function normalizedQueryKey(value) {
  return normalizeQuery(value).replace(/[\s，。！？、,.!?：:；;“”"'（）()【】\[\]]+/gu, "");
}

const NAMING_QUESTION_PATTERN = "(?:叫\\s*(?:什么|啥)\\s*(?:名字|名称|名)?|(?:名字|名称|名)\\s*(?:是|叫)\\s*(?:什么|啥))";
const NAMING_QUESTION_SUFFIX = new RegExp(`${NAMING_QUESTION_PATTERN}$`, "u");
const NAMING_QUESTION_SPACING = new RegExp(`\\s*${NAMING_QUESTION_PATTERN}`, "gu");
let chineseWordSegmenter;

function normalizeNamingQuestionSpacing(value) {
  return value.replace(NAMING_QUESTION_SPACING, suffix => suffix.replace(/\s+/gu, ""));
}

function stripRecallSubjectPrefix(value) {
  const subject = value.match(/^(?:我们|你们|他们|她们|它们|咱们|我|你|他|她|它|咱|还|曾经|到底)+(?:自己)?/u)?.[0];
  if (!subject) return value;
  let offset = subject.length;
  if (value.startsWith("家的", offset)) offset += 2;
  else if (value[offset] === "的") offset++;
  else if (value[offset] === "家") {
    // Bare 家 is possessive only at a word boundary.
    chineseWordSegmenter ||= new Intl.Segmenter("zh", { granularity: "word" });
    const boundary = offset + 1;
    for (const segment of chineseWordSegmenter.segment(value)) {
      const end = segment.index + segment.segment.length;
      if (end < boundary) continue;
      if (end === boundary) offset = boundary;
      break;
    }
  }
  if (value[offset] === "有") offset++;
  return value.slice(offset);
}

const ENGLISH_WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const LATIN_WORD_PATTERN = /[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{M}\p{N}_.'’-]*/gu;

export function boundedOccurrences(text, value) {
  // Apostrophe typography does not change a name. Both replacements preserve
  // UTF-16 offsets, so callers can still slice the original text safely.
  const term = normalize(value);
  const searchText = text.replace(/’/gu, "'");
  if (!term) return [];
  const indexes = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = searchText.indexOf(term, cursor);
    if (index < 0) break;
    const before = searchText[index - 1] || "";
    const after = searchText[index + term.length] || "";
    if (!ENGLISH_WORD_CHARACTER.test(before) && !ENGLISH_WORD_CHARACTER.test(after)) {
      indexes.push(index);
    }
    cursor = index + term.length;
  }
  return indexes;
}

export function requestedQueryText(query) { return normalizeQuery(query); }
export function retrievalQueryText(query) { return String(query || '').trim(); }

const ENGLISH_STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "as",
  "at", "by", "for", "from", "in", "into", "of", "on", "onto", "to",
  "with", "without", "about", "against", "between", "through", "during",
  "before", "after", "above", "below", "up", "down", "out", "off", "over",
  "under", "again", "further", "once", "here", "there",
  "i", "me", "my", "mine", "you", "your", "yours", "we", "our", "ours",
  "they", "their", "them", "he", "him", "his", "she", "her", "hers", "it", "its",
  "that", "this", "these", "those",
  "do", "does", "did", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "can", "could", "would", "will", "should", "may", "might", "must",
  "what", "when", "where", "who", "whom", "whose", "which", "why", "how",
  "please", "thanks", "thank", "hello", "hi", "hey",
]);

function normalizeEnglishLexicalTerm(value, allowStopWord = false) {
  const normalized = normalize(value)
    .replace(/(?:'s|')$/u, "")
    .replace(/^[._-]+|[._-]+$/gu, "");
  if (!normalized || (!allowStopWord && ENGLISH_STOP_WORDS.has(normalized))) return "";
  // A standalone alphabetic letter is normally the possessive tail from a
  // token such as "John's", never useful semantic evidence.  Numbers remain
  // valid because they can carry dates, counts, and versions.
  if (/^\p{Script=Latin}$/u.test(normalized)) return "";
  return normalized;
}

function englishCorePhrase(query) {
  const normalized = normalizeQuery(query);
  let text = normalized
    .replace(/[，。！？、,.!?：:；;“”「」『』"（）()【】\[\]]+/gu, " ")
    .replace(/^(?:(?:do|can|could|would)\s+you\s+(?:still\s+)?(?:remember|recall|know)|(?:please\s+)?(?:tell|remind)\s+me(?:\s+about)?)(?:\s+)?/u, "")
    .replace(/^(?:please\s+)?(?:what|when|where|who|which|why|how(?:\s+(?:long|many|much))?)\s+(?:(?:did|does|do|is|are|was|were|has|have|had|will|would|can|could|should|might|may)\s+)?/u, "")
    .replace(/\b(?:please|thanks|thank you)\b\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();

  if (/^(?:(?:i|you|we|they|he|she)\s+)?(?:say|said|do|did|happen(?:ed)?|occur(?:red)?|took place|went on|talk(?:ed)?(?:\s+about)?|chat(?:ted)?(?:\s+about)?|discuss(?:ed)?|remember)(?:\s+(?:anything|something|before))?(?:\s+(?:on|in|at|during|over|from|since|until|by)(?:\s+the)?)*$/u.test(text)) return "";
  const terms = text.match(LATIN_WORD_PATTERN) || [];
  if (!terms.some((term) => !ENGLISH_STOP_WORDS.has(term.toLowerCase()))) return "";
  return text;
}

const DEFAULT_GENERIC_QUERIES = Object.freeze([
  "在吗", "嗯", "嗯嗯", "好", "好的", "好吧", "行", "知道了", "算了",
  "继续", "然后呢", "你呢", "怎么了", "哈哈", "睡了", "几点了", "现在几点", "现在几点了",
  "hi", "hello", "hey", "ok", "okay", "thanks", "thank you", "got it", "continue",
  "what about you", "how are you",
  'what time is it', 'what is the time', 'what is the current time',
  "what is today's date", 'what is the date today', 'what date is it', 'what date is today',
  'what day is it', 'what day is today',
]);

function hasQuotedTopic(query) {
  let matched = false;
  replaceQuotedText(query, () => { matched = true; return ''; });
  return matched;
}

export function isGenericQuery(query, genericQueries = DEFAULT_GENERIC_QUERIES) {
  const key = normalizedQueryKey(query);
  if (!key) return true;
  const quoted = hasQuotedTopic(query);
  return genericQueries.some(value => normalizedQueryKey(value) === key && hasQuotedTopic(value) === quoted);
}

export function recallCorePhrases(query) {
  query = retrievalQueryText(query);
  const quotedTopics = [];
  let topicMarker = '\uE000';
  for (const match of String(query || '').matchAll(/\uE000+/gu)) {
    if (match[0].length >= topicMarker.length) topicMarker = `${match[0]}\uE000`;
  }
  const protectedQuery = replaceQuotedText(query, quote => {
    quotedTopics.push(normalize(quote.slice(1, -1)));
    return ` ${topicMarker}${quotedTopics.length - 1}\uE001 `;
  });
  const topicPattern = new RegExp(`${topicMarker}(\\d+)\uE001`, 'gu');
  const restoreTopics = text => text.replace(topicPattern,
    (marker, index) => quotedTopics[index] ?? marker).trim();
  if (!/\p{Script=Han}/u.test(query) && /\p{Script=Latin}/u.test(query)) {
    const english = englishCorePhrase(protectedQuery);
    return english ? [restoreTopics(english)].filter(Boolean) : [];
  }
  let text = normalizeNamingQuestionSpacing(normalize(protectedQuery)).replace(/[，。！？、,.!?：:；;“”「」『』"'（）()【】\[\]]+/gu, " ");
  for (const phrase of [
    "聊了些什么", "聊了什么", "聊过什么", "聊什么", "做了些什么", "干了些什么", "做了什么", "干了什么", "发生了什么", "有什么事情",
    "有什么事", "干啥了", "做啥了", "干什么", "做什么", "去了哪里", "去哪里了",
    "当时说了什么", "原话怎么说", "说过什么关于", "说过什么", "我是怎么说的", "我怎么说的", "怎么说的", "你为什么会觉得", "你为什么觉得", "为什么会觉得", "为什么觉得", "你为什么会认为", "你为什么认为", "为什么会认为", "为什么认为", "为什么会判断", "为什么判断", "为什么会说", "为什么说", "为什么会", "为什么", "为何", "怎么会",
    "有什么相反依据", "有什么相反证据", "有什么反证", "有什么反例", "相反依据", "相反证据", "反证", "反例", "有什么依据", "有什么证据", "依据是什么", "证据是什么", "怎么知道的", "怎么判断的", "怎么得出的", "凭什么", "依据", "证据",
    "你能确定", "你确定", "有没有把握", "有把握", "靠不靠谱", "可不可靠", "是否可靠", "可靠吗", "可信吗", "准确吗", "这个判断准吗", "还有没有什么例外", "有没有什么例外", "还有没有例外", "有没有例外", "是否有例外", "存在例外", "有什么漏洞",
    "是什么原因", "什么原因", "原因是什么", "由什么导致", "什么导致", "原因", "导致", "什么时候",
    "造成了什么后果", "造成什么后果", "造成了什么影响", "造成什么影响", "造成了什么", "造成什么",
    "引起了什么后果", "引起什么后果", "引起了什么影响", "引起什么影响", "引起了什么", "引起什么",
    "带来了什么后果", "带来什么后果", "带来了什么影响", "带来什么影响", "产生了什么后果", "产生什么后果", "产生了什么影响", "产生什么影响", "有什么后果", "有什么影响",
    "还记不记得", "还记得", "记不记得", "那件事情", "这件事情", "那件事", "这件事",
    "多久以前", "多久之前", "哪一天", "哪天", "几号", "上一次", "上次", "那一次", "那次",
    "那句话", "这句话", "那一句", "这一句", "那句", "这句",
    "之前", "以前", "当时", "后来", "结果", "经过", "记得", "回忆", "发生", "原话", "关于", "的话",
  ]) text = text.replaceAll(phrase, " ");
  const phrases = text.split(/\s+/u)
    .map((part) => stripRecallSubjectPrefix(part)
      .replace(/^(?:去过|去)/u, "")
      .replace(/(?:吗|呢|啊|呀|吧|了)+$/u, "")
      .replace(NAMING_QUESTION_SUFFIX, "")
      .replace(/^(?:说过|提过|聊过|谈过)(.+?)(?:的事(?:情)?)?$/u, "$1")
      .replace(/(?:是什么|是|的|吗|呢|啊|呀|吧|了)+$/u, "")
      .trim())
    .filter(Boolean);
  return phrases.filter((part) => Array.from(part).length >= 2 || (
    phrases.length === 1 && /^\p{Script=Han}$/u.test(part) && !STOP_CHARACTERS.has(part)
  )).map(restoreTopics).filter(Boolean);
}

export function planVectorQuery(query) { return { text: normalize(retrievalQueryText(query)), source: 'original' }; }

const STOP_CHARACTERS = new Set("我你他她它的是了在和也就都还又把被有去来吗呢啊呀吧这那".split(""));

function lexicalTextTerms(value, allowStopWords = false) {
  const text = normalize(value);
  const terms = new Set();
  for (const match of text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)) {
    const sequence = match[0];
    for (const width of [2, 3, 4]) {
      for (let index = 0; index + width <= sequence.length; index += 1) {
        const token = sequence.slice(index, index + width);
        if (allowStopWords || ![...token].every((character) => STOP_CHARACTERS.has(character))) terms.add(token);
      }
    }
  }
  for (const match of text.matchAll(LATIN_WORD_PATTERN)) {
    const token = normalizeEnglishLexicalTerm(match[0], allowStopWords);
    if (token) terms.add(token);
  }
  return [...terms];
}

export function lexicalTerms(value) {
  return lexicalTextTerms(value);
}

function lexicalTermSpans(queryTerms, normalizedQuery) {
  // Locate terms once. Nested and sliding n-grams over the same query span
  // represent one textual clue, even when a document repeats that clue.
  return Object.freeze(queryTerms.map((term, order) => {
    const starts = [];
    const spanText = term.replace(/[^\p{L}\p{N}]+/gu, '');
    for (let at = normalizedQuery.indexOf(spanText); spanText && at >= 0; at = normalizedQuery.indexOf(spanText, at + 1)) {
      starts.push(at);
    }
    return Object.freeze({ term, width: spanText.length, order, starts: Object.freeze(starts) });
  }).sort((left, right) => right.term.length - left.term.length || left.order - right.order));
}

// Morphology is local text matching, not an extra retrieval route. Keep the
// Chinese n-grams and English words in the same scoring/admission contract.
const ENGLISH_IRREGULAR_FORMS = new Map([
  ['be', 'am', 'is', 'are', 'was', 'were', 'been'], ['have', 'has', 'had'], ['do', 'does', 'did', 'done'],
  ['go', 'goes', 'went', 'gone'], ['come', 'came'], ['become', 'became'],
  ['choose', 'chose', 'chosen'], ['write', 'wrote', 'written'], ['speak', 'spoke', 'spoken'],
  ['take', 'took', 'taken'], ['give', 'gave', 'given'], ['get', 'got', 'gotten'],
  ['eat', 'ate', 'eaten'], ['drink', 'drank', 'drunk'], ['see', 'saw', 'seen'],
  ['buy', 'bought'], ['bring', 'brought'], ['think', 'thought'], ['teach', 'taught'],
  ['catch', 'caught'], ['feel', 'felt'], ['keep', 'kept'], ['meet', 'met'],
  ['run', 'ran'], ['swim', 'swam', 'swum'], ['sing', 'sang', 'sung'],
  ['begin', 'began', 'begun'], ['grow', 'grew', 'grown'], ['know', 'knew', 'known'],
  ['wear', 'wore', 'worn'], ['make', 'made'], ['build', 'built'], ['spend', 'spent'],
  ['send', 'sent'], ['tell', 'told'], ['hear', 'heard'], ['sit', 'sat'], ['sleep', 'slept'],
].flatMap(forms => forms.map(form => [form, forms])));

function englishTermForms(term) {
  const forms = new Set([term, ...(ENGLISH_IRREGULAR_FORMS.get(term) || [])]);
  if (/^\p{Script=Latin}{3,}$/u.test(term)) {
    if (/ies$/u.test(term)) forms.add(`${term.slice(0, -3)}y`);
    if (term.length >= 4 && /s$/u.test(term) && !/(?:ss|us|is)$/u.test(term)) forms.add(term.slice(0, -1));
    if (/(?:ches|shes|[sxz]es|oes)$/u.test(term)) {
      const base = term.slice(0, -2);
      forms.add(base);
      if (/zz$/u.test(base)) forms.add(base.slice(0, -1));
    }
    if (/(?:ed|ing)$/u.test(term)) {
      const base = term.replace(/(?:ed|ing)$/u, '');
      if (base.length >= 2) {
        if (/([b-df-hj-np-tv-z])\1$/u.test(base)) {
          // Keep letters already present in a root (call, fill, pass, add).
          // Undo productive doubling only in a consonant-vowel ending;
          // multisyllabic double-l also covers British spellings.
          forms.add(base);
          if (/[b-df-hj-np-tv-z][aeiou]([bdgmnprt])\1$/u.test(base)
            || (/ll$/u.test(base) && (base.match(/[aeiouy]+/gu) || []).length >= 2)) {
            forms.add(base.slice(0, -1));
          }
        } else if (/^[b-df-hj-np-tv-z][aeiou][b-df-hj-np-tv-z]$/u.test(base)
          && !/[wxy]$/u.test(base)) {
          // "hoping/hoped" retain the silent e; "hopping/hopped" undo
          // doubling. Treating both as "hop" invents a lexical match.
          forms.add(`${base}e`);
        } else {
          if (base.length >= 3) forms.add(base);
          forms.add(base.length === 2 && base.endsWith('y') ? `${base.slice(0, -1)}ie` : `${base}e`);
        }
        if (base.endsWith('i')) forms.add(`${base.slice(0, -1)}y`);
      }
    }
  }
  return [...forms];
}

function englishDocumentForms(document, allowedWords) {
  return new Set((document.match(LATIN_WORD_PATTERN) || [])
    .map(term => normalizeEnglishLexicalTerm(term, true))
    .filter(term => term && (!ENGLISH_STOP_WORDS.has(term) || allowedWords.has(term)))
    .flatMap(term => ENGLISH_STOP_WORDS.has(term) ? [term] : englishTermForms(term)));
}

export function prepareLexicalQuery(query, { personNames = [] } = {}) {
  query = retrievalQueryText(query);
  const phrases = recallCorePhrases(query);
  const queryText = phrases.length ? phrases.join(" ") : query;
  const literalTopics = [];
  replaceQuotedText(query, quote => { literalTopics.push(normalize(quote.slice(1, -1))); return quote; });
  const literalTerms = literalTopics.flatMap(topic => lexicalTextTerms(topic, true));
  const queryTerms = Object.freeze([...new Set([
    ...lexicalTerms(queryText),
    ...literalTerms,
    // A complete short topic is useful; arbitrary single-character n-grams
    // from a longer question are not independent lexical evidence.
    ...phrases.filter(phrase => /^\p{Script=Han}$/u.test(phrase)),
  ])]);
  const normalizedQuery = normalize(queryText).replace(/[^\p{L}\p{N}]+/gu, '');
  const text = normalize(queryText);
  const ignoredSpans = [];
  const ignoredLabels = [...personNames.map(normalize).filter(name => name.length >= 2),
    ...['为什么', '为何', '什么', '怎么', '怎样', '如何', '哪个', '哪些', '哪里', '是否', '谁']
      .filter(label => !literalTopics.some(topic => topic.includes(label)))];
  for (const name of new Set(ignoredLabels)) {
    const occurrences = /[a-z]/u.test(name) ? boundedOccurrences(text, name)
      : [...text.matchAll(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu'))].map(match => match.index);
    for (const at of occurrences) {
      ignoredSpans.push({ start: text.slice(0, at).replace(/[^\p{L}\p{N}]+/gu, '').length,
        length: name.replace(/[^\p{L}\p{N}]+/gu, '').length });
    }
  }
  const termSpans = Object.freeze(lexicalTermSpans(queryTerms, normalizedQuery).map(span => Object.freeze({
    ...span,
    scoringStarts: Object.freeze(span.starts.filter(start => !ignoredSpans.some(name => (
      Math.min(start + span.width, name.start + name.length) - Math.max(start, name.start) > 0
    )))),
  })));
  const topicTermSet = new Set(termSpans.filter(span => span.scoringStarts.length).map(span => span.term));
  const topicTerms = Object.freeze(queryTerms.filter(term => topicTermSet.has(term)));
  if (!topicTerms.length && personNames.length) return prepareLexicalQuery(query);
  const englishForms = Object.freeze(Object.fromEntries(queryTerms.filter(term => /^\p{Script=Latin}/u.test(term))
    .map(term => [term, Object.freeze(ENGLISH_STOP_WORDS.has(term) ? [term] : englishTermForms(term))])));
  return Object.freeze({ queryTerms, normalizedQuery, termSpans, topicTerms, englishForms });
}

export function lexicalScore(query, document) {
  const prepared = typeof query === 'object' && query !== null ? query : prepareLexicalQuery(query);
  const { normalizedQuery } = prepared;
  const queryTerms = prepared.topicTerms || prepared.queryTerms;
  const normalizedDocument = normalize(document).replace(/\s+/gu, "");
  const englishTerms = Object.keys(prepared.englishForms || {});
  const englishWords = englishTerms.length ? englishDocumentForms(normalize(document), new Set(englishTerms)) : null;
  let score = 0;
  let admissionScore = 0;
  let admissionOverlap = 0;
  const occupied = new Uint8Array(normalizedQuery.length);
  const selected = new Set();
  const spans = prepared.termSpans || lexicalTermSpans(queryTerms, normalizedQuery);
  for (const { term, width = term.length, starts, scoringStarts = starts } of spans) {
    const forms = prepared.englishForms?.[term];
    if (forms ? !forms.some(form => englishWords.has(form)) : !normalizedDocument.includes(term)) continue;
    // Keep configured admission thresholds separate from ranking credit;
    // overlapping hits must not inflate the final relevance score.
    admissionOverlap += 1;
    admissionScore += Math.max(1, Array.from(term).length - 1);
    const start = scoringStarts.find(at => !occupied.subarray(at, at + width).some(Boolean));
    if (start === undefined) continue;
    occupied.fill(1, start, start + width);
    selected.add(term);
    score += Math.max(1, Array.from(term).length - 1);
  }
  const matchedTerms = queryTerms.filter(term => selected.has(term));
  const overlap = matchedTerms.length;
  const exactPhrase = queryTerms.length > 0
    && (normalizedQuery.length >= 2 || /^\p{Script=Han}$/u.test(normalizedQuery))
    && (normalizedDocument.includes(normalizedQuery) || (queryTerms.length === 1 && englishWords
      && prepared.englishForms[queryTerms[0]]?.some(form => englishWords.has(form))))
    && (!englishWords || queryTerms.every(term => !prepared.englishForms?.[term]
      || prepared.englishForms[term].some(form => englishWords.has(form))));
  if (exactPhrase) { score += 8; admissionScore += 8; }
  return { score, overlap, exactPhrase, queryTerms, matchedTerms, admissionScore, admissionOverlap };
}

export function lexicalCoverage(match) {
  return match.exactPhrase ? 1
    : Math.min(1, match.overlap / Math.max(1, match.queryTerms.length));
}
