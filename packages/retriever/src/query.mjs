export { resolveTemporalQuery } from './temporal-query.mjs';
import { maskQuotedText, maskRejectedRequests, replaceQuotedText } from './query-text.mjs';

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

function cleanActor(role, key, names = []) {
  return {
    role: String(role || "").trim(),
    key: String(key || "").trim(),
    names: [...new Set((Array.isArray(names) ? names : [names])
      .map((value) => normalize(value))
      .filter((value) => value && /\p{L}/u.test(value)))],
  };
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

function englishQuestionSubjectPrefix(prefix) {
  return /\b(?:(?:did|does|do|am|is|are|was|were|has|have|had|will|would|can|could|should|might|may)(?:\s+not|n['’]t)?|(?:ca|wo)n['’]t)\s*$/u.test(prefix)
    || /(?:^|\b)(?:what|when|where|why|how|which)\s*$/u.test(prefix);
}

function englishSubjectPriority(prefix) {
  if (!prefix.trim()) return 1;
  const clause = prefix.split(/[,;.!?]|\b(?:and|or|compared (?:with|to))\s+(?=(?:what|who|when|where|why|how|which|do|does|did|is|are|was|were|has|have|had|will|would|can|could|should|might|may)\b)/u).at(-1);
  if (ENGLISH_SPEECH_QUESTION.test(clause)) return 0;
  if (/^\s*(?:what|when|where|why|how|which)\s*$/u.test(clause)) return 1;
  const auxiliaries = clause.match(/\b(?:(?:did|does|do|am|is|are|was|were|has|have|had|will|would|can|could|should|might|may)(?:n['’]t)?|(?:ca|wo)n['’]t)\b/gu) || [];
  if (!englishQuestionSubjectPrefix(clause) || auxiliaries.length !== 1) return 0;
  const preamble = clause.slice(0, clause.lastIndexOf(auxiliaries[0])).trim();
  if (/^(?:who|which\s+(?:person|one|speaker|participant|friend))\b/u.test(preamble)
    && !/^(?:who|which\s+(?:person|one|speaker|participant|friend))$/u.test(preamble)) return 0;
  // An earlier finite predicate introduces a reported/object clause. Its
  // embedded "is/was" cannot identify the subject of the original question.
  if (!ENGLISH_STATE_QUESTION_PREAMBLE.test(preamble)
    && (preamble.match(LATIN_WORD_PATTERN) || []).some(word => englishDirectSubjectSuffix(` ${word}`))) return 0;
  return 2;
}

function englishDirectSubjectSuffix(suffix) {
  return /^(?:\s+)(?:is|are|was|were|has|have|had|will|would|can|could|should|might|may|did|does|do|likes?|loves?|hates?|prefers?|thinks?|believes?|feels?|wants?|plans?|decides?|decided|promises?|said|says|told|tells|went|goes|moved|moves|visited|visits|researched|researches|painted|paints|ate|eats|read|reads|watched|watches|played|plays|bought|buys|attended|attends|received|receives|cleaned|cleans|saw|sees|met|meets|worked|works|studied|studies|lived|lives)\b/u.test(suffix);
}

const ENGLISH_STATE_NOUN = '(?:identity|relationships?|status|preferences?|favou?rites?|likes?|dislikes?|interests?|habits?|goals?|plans?|promises?|commitments?|values?|abilit(?:y|ies)|capabilit(?:y|ies)|skills?|beliefs?|opinions?|views?|self[- ]concept|personality|disposition|temperament|health|mood|feelings?|name|age|birthday|education|school|university|college|major|job|occupation|conditions?)';
const ENGLISH_STATE_PHRASE = `(?:(?:current|previous|former|old|new|past)\\s+)?${ENGLISH_STATE_NOUN}\\b`;
const ENGLISH_POSSESSIVE_STATE_SUFFIX = new RegExp(`^(?:'s|’s)\\s+${ENGLISH_STATE_PHRASE}`, 'u');
const ENGLISH_STATE_SUFFIX = new RegExp(`^\\s+${ENGLISH_STATE_PHRASE}`, 'u');
const ENGLISH_STATE_FOCUS = new RegExp(`^${ENGLISH_STATE_PHRASE}`, 'u');
const ENGLISH_STATE_PREFIX = new RegExp(`\\b${ENGLISH_STATE_NOUN}\\b`, 'u');
const ENGLISH_STATE_QUESTION_PREAMBLE = new RegExp(`^(?:what|which|whose|how many|how much)\\s+${ENGLISH_STATE_PHRASE}$`, 'u');
const ENGLISH_COMPARISON_PREFIX = /\b(?:compared (?:with|to)|versus|vs\.?)\s*$/u;

function englishStateFocus(prefix, suffix) {
  // Classify this subject's predicate, not state words anywhere in its object
  // clause ("Caroline helped Melanie with her job" is an event).
  const predicate = suffix.trim().replace(/^(?:(?:am|is|are|was|were|be|been|being|has|have|had|do|does|did|will|would|can|could|should|might|may|not|never|still|always|often|usually|really|a|an|the)\s+|use(?:d)?\s+to\s+)*/u, '');
  if (/^(?:likes?|liked|loves?|loved|hates?|hated|prefers?|preferred|thinks?|thought|believes?|believed|feels?|felt|wants?|wanted|plans?|planned|decides?|decided|promises?|promised|interested\s+in)\b/u.test(predicate)) return 'state';
  return ENGLISH_STATE_PREFIX.test(prefix) || ENGLISH_STATE_FOCUS.test(predicate) ? 'state' : 'event';
}

function englishSubjectMatches(text, actor, {
  pronouns = [],
  possessives = [],
  comparisonPronouns = [],
} = {}) {
  const matches = [];
  const seen = new Set();
  const comparedPronouns = new Set(comparisonPronouns.map(normalize));
  const tokens = [...new Set([
    ...(actor?.names || []),
    ...(Array.isArray(pronouns) ? pronouns : [pronouns]).map(normalize),
    ...comparedPronouns,
  ].filter(Boolean))];
  for (const token of tokens) {
    for (const index of boundedOccurrences(text, token)) {
      const prefix = text.slice(0, index);
      const suffix = text.slice(index + token.length);
      const comparison = ENGLISH_COMPARISON_PREFIX.test(prefix);
      if (comparedPronouns.has(token) && !comparison) continue;
      const direct = comparison || englishQuestionSubjectPrefix(prefix) || englishDirectSubjectSuffix(suffix);
      const possessiveState = actor?.names?.includes(token) && ENGLISH_POSSESSIVE_STATE_SUFFIX.test(suffix);
      if (!direct && !possessiveState) continue;
      const key = `${index}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        index,
        priority: englishSubjectPriority(prefix),
        comparison,
        named: actor?.names?.includes(token) || false,
        basis: text.slice(index, index + token.length),
        focus: possessiveState ? "state" : englishStateFocus(prefix, suffix),
      });
    }
  }
  for (const possessive of [...new Set((Array.isArray(possessives) ? possessives : [possessives])
    .map(normalize).filter(Boolean))]) {
    for (const index of boundedOccurrences(text, possessive)) {
      const suffix = text.slice(index + possessive.length);
      if (!ENGLISH_STATE_SUFFIX.test(suffix)) continue;
      const key = `${index}:${possessive}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        index,
        priority: englishSubjectPriority(text.slice(0, index)),
        comparison: ENGLISH_COMPARISON_PREFIX.test(text.slice(0, index)),
        basis: text.slice(index, index + possessive.length),
        focus: "state",
      });
    }
  }
  return matches;
}

function englishSharedNameMatch(text, speaker, addressee, separators = [" and ", " & ", "'s and "]) {
  const pairs = [];
  for (const left of [...(speaker?.names || []), 'i', 'my']) {
    for (const right of [...(addressee?.names || []), 'you', 'your']) {
      for (const separator of separators) {
        pairs.push(`${left}${separator}${right}`, `${right}${separator}${left}`);
      }
    }
  }
  for (const pair of [...new Set(pairs)]) {
    for (const index of boundedOccurrences(text, pair)) {
      const prefix = text.slice(0, index);
      const suffix = text.slice(index + pair.length);
      if (
        englishQuestionSubjectPrefix(prefix)
        || englishDirectSubjectSuffix(suffix)
        || (!prefix.trim() && /^\s+(?:together|both)\b/u.test(suffix))
      ) {
        return { index, priority: englishSubjectPriority(prefix), basis: text.slice(index, index + pair.length) };
      }
    }
  }
  return null;
}

const HISTORICAL_STATE_CUE = /(?:以前|之前|过去|从前|曾经|当时|那时候|原来|\b(?:previously|formerly|earlier|before|previous|former|past)\b|\b(?:in the past|use(?:d)? to|at the time|back then|in those days|once)\b|\b(?:did|was|were|had)\b|\b(?:last|previous)\s+(?:week|month|year)\b)/u;
const CURRENT_STATE_CUE = /(?:现在|目前|当前|如今|今天|\b(?:now|currently|current|today)\b)/u;

export function asksForHistoricalState(text, { temporal = null, today = '' } = {}) {
  // Ignore quoted titles and explicitly rejected question scopes, while
  // preserving negated past facts ("didn't like") and genuine comparisons.
  const scope = requestedQueryText(text)
    .replace(/^(?:before\s+(?:you\s+)?(?:answer(?:ing)?|respond(?:ing)?|repl(?:y|ying))\b[^,;.!?]*[,;]|(?:在)?(?:回答|回复)(?:我)?(?:之)?前[，,；;])\s*/u, '')
    .replace(/\bnot\s+(?:asking|talking|inquiring|referring)\b[^,;.!?]*/gu, ' ')
    .replace(/\b(?:not|rather than|instead of)\s+(?:(?:my|your|our|the)\s+)?(?:old|previous|former|past|earlier|before|back then)\b[^,;.!?]*/gu, ' ')
    .replace(/(?:不是|并非|不要|别|不必)(?:在)?(?:问|说|讲|讨论|回忆|提)[^，。！？,;.!?]*/gu, ' ');
  const windowInScope = Boolean(temporal?.matched && temporal.coreWindow && today
    && (!temporal.expression || scope.includes(normalizeQuery(temporal.expression))));
  if (windowInScope && temporal.coreWindow.startDate < today) return true;
  let main;
  if (/\p{Script=Han}/u.test(scope)) {
    const clauses = scope.split(/[，。！？,;.!?；]/u).map(part => part.trim()).filter(Boolean);
    main = clauses.findLast(part => /(?:什么|哪|吗|么|如何|怎样|是否|是不是|为何|为什么)/u.test(part)) || clauses.at(-1) || '';
  } else {
    main = scope.split(/[,;.!?]\s*(?=(?:what|who|when|where|why|how|which|do|does|did|is|are|was|were|has|have|had|can|could|will|would)\b)/u)
      .at(-1).split(/[,;.!?]|\b(?:as|although|though|whereas)\b/u)[0];
  }
  if (CURRENT_STATE_CUE.test(main) && !HISTORICAL_STATE_CUE.test(main)) return false;
  // The calendar resolver has already excluded rejected dates. Reuse its
  // remaining request so those dates cannot reintroduce historical state.
  if (windowInScope && typeof temporal.remainingQuery === 'string') return asksForHistoricalState(temporal.remainingQuery);
  return HISTORICAL_STATE_CUE.test(scope);
}

function subjectPredicateMatches(text, pronoun) {
  const escaped = pronoun.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const speech = new RegExp(`${escaped}(?:自己)?(?:对|关于|针对)[^，。！？,;.!?]*?(?:的原话|怎么说|说过什么)`, "gu");
  const patterns = [
    new RegExp(`${escaped}(?:自己)?(?:家的?|的)\\s*[\\p{Script=Han}]{1,24}${NAMING_QUESTION_PATTERN}`, "gu"),
    new RegExp(`${escaped}(?:自己)?(?:上上周[一二三四五六日天]?|上周[一二三四五六日天]?|这周[一二三四五六日天]?|本周[一二三四五六日天]?|昨天|今天|前天|最近|以前|之前|现在|后来|当时|上次|曾经|小时候|童年时?|平时|通常|一直|总是|有时|偶尔|最|更|比较|特别|非常|很|\\d{1,2}月|\\d{1,2}号|\\d{1,2}日|\\s){0,4}(?:并非|不是|从未|从来没有|还没(?:有)?|没(?:有)?|未|不)?(?:喜欢|偏爱|讨厌|不喜欢|觉得|认为|相信|想要|计划|决定|答应|承诺|会|能|做过|干过|去过|吃过|看过|玩过|说过|学过|读过|经历过|住过|工作|学习|去了|去|做了|做|吃了|吃|看了|看|玩了|玩|说了|说|在|有)`, "gu"),
    new RegExp(`${escaped}(?:是)?怎么说(?:的|过)?`, "gu"),
    speech,
    new RegExp(`${escaped}的(?:喜好|偏好|习惯|计划|目标|能力|身份|经历|原话|观点|看法|想法|选择|工作|住址|生日|本科|教育|学历|学校|院校|大学|专业|职业|职位|单位|公司|家乡|籍贯|住所|住处|姓名|名字|年龄|童年|求学经历|阅读经历|生平)`, "gu"),
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => {
    const basis = match[0];
    const stateFocused = pattern !== speech && /(?:喜欢|偏爱|讨厌|不喜欢|觉得|认为|相信|想要|计划|决定|答应|承诺|喜好|偏好|习惯|目标|能力|身份|观点|看法|想法)/u.test(basis);
    return {
      index: Number(match.index),
      basis,
      speech: pattern === speech,
      focus: stateFocused ? "state" : "event",
    };
  })).filter(match => acceptsChineseSubject(text.slice(0, match.index)));
}

function acceptsChineseSubject(prefix) {
  const clause = prefix.split(/[，。！？,;.!?；]|(?:但是|而且|并且|同时|以及|还有|而)(?=[我你])/u).at(-1);
  // A reported preference holder is not the speaker of the containing
  // question, including questions whose speaker is explicitly unknown.
  return !/(?:说|讲|提到|提过|告诉|听说|表示)(?:过|了|道)?/u.test(clause)
    && !/(?:谁|哪位|哪个人)[^，。！？,;.!?]*(?:知道|听过|记得|发现|认为|觉得)/u.test(clause);
}

export function resolveQuerySubject(query, {
  speakerRole = "user",
  speakerKey = "user",
  speakerNames = [],
  addresseeRole = "agent",
  addresseeKey = "",
  addresseeNames = [],
  temporal = null,
  today = '',
} = {}) {
  const text = normalizeNamingQuestionSpacing(normalize(query));
  const speaker = cleanActor(speakerRole, speakerKey, speakerNames);
  const addressee = cleanActor(addresseeRole, addresseeKey, addresseeNames);
  const none = (reason = "no-explicit-subject") => ({
    matched: false,
    mode: "none",
    role: "",
    key: "",
    basis: "",
    reason,
  });
  if (!text) return none("empty-query");

  const conversationalFrame = /^(?:请)?你(?:还)?(?:记不记得|记得|知不知道|知道|能不能告诉我|告诉我|回忆一下|想不想得起来)(?:一下)?/u;
  const englishConversationalFrame = /^(?:(?:do|can|could|would)\s+you\s+(?:still\s+)?(?:remember|recall|know)|(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:please\s+)?(?:tell|remind)\s+me(?:\s+about)?|(?:why|what)\s+do\s+you\s+(?:think|believe|guess)\s+(?!about\b|of\b)(?:that\s+)?)(?:\s+)?/u;
  const content = normalizeNamingQuestionSpacing(requestedQueryText(query))
    .replace(conversationalFrame, "")
    .replace(englishConversationalFrame, "")
    .trim();
  const historicalState = asksForHistoricalState(content, { temporal, today });
  const subordinateEnd = content.match(/^(?:when|while|although|though|if|unless|since|because|after|before)\b[^,;.!?]*[,;]\s*/u)?.[0].length || 0;
  // Only a leading subject or an unambiguous inverted question can impose a
  // hard constraint. A name inside reported/object clauses is insufficient.
  const acceptsEnglishSubject = match => match && match.priority > 0 && match.index >= subordinateEnd;
  const allNamedMatches = [
    ...englishSubjectMatches(content, speaker).map(match => ({ ...match, actor: speaker })),
    ...englishSubjectMatches(content, addressee).map(match => ({ ...match, actor: addressee })),
    ...englishSubjectMatches(content, { ...speaker, names: [] }, { pronouns: ['i'], possessives: ['my'], comparisonPronouns: ['me', 'mine'] })
      .map(match => ({ ...match, actor: speaker })),
    ...englishSubjectMatches(content, { ...addressee, names: [] }, { pronouns: ['you'], possessives: ['your'], comparisonPronouns: ['yours'] })
      .map(match => ({ ...match, actor: addressee })),
  ];
  const namedMatches = allNamedMatches.filter(acceptsEnglishSubject)
    .sort((left, right) => right.priority - left.priority || left.index - right.index);
  if (allNamedMatches.some(compared => compared.comparison && namedMatches.some(subject => (
    subject.actor.role !== compared.actor.role || subject.actor.key !== compared.actor.key
  )))) return none('multiple-explicit-subjects');
  const alternatives = englishSharedNameMatch(content, speaker, addressee, [" or ", "'s or ", ' versus ']);
  if (acceptsEnglishSubject(alternatives)) return none('multiple-explicit-subjects');
  if (!/^(?:what|who|when|where|why|how|which|do|does|did|is|are|was|were|has|have|had|will|would|can|could|should|might|may)\b/u.test(content)
    && new Set(allNamedMatches.filter(match => match.index >= subordinateEnd)
      .map(match => `${match.actor.role}\u001f${match.actor.key}`)).size > 1) {
    return none('multiple-explicit-subjects');
  }
  const sharedFromNames = [englishSharedNameMatch(content, speaker, addressee),
    ...englishSubjectMatches(content, { names: [] }, { pronouns: ['we'], possessives: ['our'] }),
  ].filter(acceptsEnglishSubject).sort((left, right) => right.priority - left.priority || left.index - right.index)[0];
  if (sharedFromNames && (!namedMatches.length || sharedFromNames.priority > namedMatches[0].priority
    || (sharedFromNames.priority === namedMatches[0].priority && sharedFromNames.index <= namedMatches[0].index))) {
    if (!speaker.role || !speaker.key || !addressee.role || !addressee.key) {
      return none("perspective-missing-key");
    }
    return {
      matched: true,
      mode: "shared",
      role: "shared",
      key: "",
      basis: sharedFromNames.basis,
      reason: "configured-shared-name-subject",
      members: [speaker, addressee],
    };
  }
  if (new Set(namedMatches.map(match => `${match.actor.role}\u001f${match.actor.key}`)).size > 1) {
    return none('multiple-explicit-subjects');
  }
  if (namedMatches.length) {
    const selected = namedMatches[0];
    if (!selected.actor.role || !selected.actor.key) return none("perspective-missing-key");
    return {
      matched: true,
      mode: "personal",
      role: selected.actor.role,
      key: selected.actor.key,
      basis: selected.basis,
      focus: selected.focus,
      stateTime: selected.focus === "state" && historicalState
        ? "historical"
        : selected.focus === "state" ? "current" : "not-applicable",
      reason: selected.named ? "configured-name-subject" : "explicit-subject-predicate",
    };
  }
  const relationshipPerspective = [
    {
      match: content.match(/我(?:自己)?(?:把|将)你(?:当成|视为|看作|看成)/u),
      actor: speaker,
    },
    {
      match: content.match(/你(?:自己)?(?:把|将)我(?:当成|视为|看作|看成)/u),
      actor: addressee,
    },
  ].find((item) => item.match);
  if (relationshipPerspective) {
    if (!relationshipPerspective.actor.role || !relationshipPerspective.actor.key) {
      return none("perspective-missing-key");
    }
    return {
      matched: true,
      mode: "personal",
      role: relationshipPerspective.actor.role,
      key: relationshipPerspective.actor.key,
      basis: relationshipPerspective.match[0],
      focus: "state",
      stateTime: historicalState
        ? "historical"
        : "current",
      reason: "explicit-relationship-perspective",
    };
  }
  const chineseMatches = [
    ...subjectPredicateMatches(content, "我").map((match) => ({ ...match, actor: speaker })),
    ...subjectPredicateMatches(content, "你").map((match) => ({ ...match, actor: addressee })),
  ];
  const matches = chineseMatches.filter(match => !chineseMatches.some(outer => outer.speech
    && outer.index < match.index && match.index < outer.index + outer.basis.length))
    .sort((left, right) => left.index - right.index || right.basis.length - left.basis.length);
  const sharedSubject = [...content.matchAll(/(?:我们俩|我们|咱们|咱俩|我(?:和|跟|与|及|、)你|你(?:和|跟|与|及|、)我|一起)/gu)]
    .find(match => acceptsChineseSubject(content.slice(0, match.index)));
  if (new Set(matches.map(match => `${match.actor.role}\u001f${match.actor.key}`)).size > 1) {
    return none('multiple-explicit-subjects');
  }
  if (sharedSubject && (!matches.length || sharedSubject.index <= matches[0].index)) {
    if (!speaker.role || !speaker.key || !addressee.role || !addressee.key) return none("perspective-missing-key");
    return {
      matched: true,
      mode: "shared",
      role: "shared",
      key: "",
      basis: sharedSubject[0],
      reason: "explicit-shared-subject",
      members: [speaker, addressee],
    };
  }
  if (matches.length) {
    const selected = matches[0];
    if (!selected.actor.role || !selected.actor.key) return none("perspective-missing-key");
    return {
      matched: true,
      mode: "personal",
      role: selected.actor.role,
      key: selected.actor.key,
      basis: selected.basis,
      focus: selected.focus,
      stateTime: selected.focus === "state" && historicalState
        ? "historical"
        : selected.focus === "state" ? "current" : "not-applicable",
      reason: "explicit-subject-predicate",
    };
  }
  return none();
}

function isEvidenceReviewText(text) {
  return /(?:你(?:能)?确定|有(?:没有)?把握|靠不靠谱|可不可靠|是否可靠|可靠吗|可信(?:吗|不)|准确(?:吗|不)|这个判断准(?:吗|不)|(?:有|存在|有没有|还有没有)(?:什么)?例外|是否有例外|有什么漏洞|\bare you sure\b|\bis (?:that|this) reliable\b|\bhow reliable\b|\bany exceptions?\b|\bis there (?:an|any) exception\b|\bwhat(?:'s| is) (?:the )?exception\b|\bwhat(?:'s| is) (?:the )?weakness\b)/iu.test(text);
}

export function requestedQueryText(query) {
  return normalizeQuery(maskQuotedText(maskRejectedRequests(query)))
    .replace(/^[，。；！？,:;!?\s]+/u, '')
    .trim();
}

export function retrievalQueryText(query) {
  const requested = maskRejectedRequests(query).trim();
  // A bare follow-up still needs its antecedent: declining an explanation
  // does not exclude the event whose aftermath the user is asking about.
  return isContinuationQuery(requested)
    ? maskRejectedRequests(query, { preserveReferences: true }).trim()
    : requested;
}

const ENGLISH_SPEECH_SUBJECT = '\\b(?:who|which (?:person|speaker|participant))';
const ENGLISH_SPEECH_ADVERBS = '(?:\\s+(?:ever|never|already|previously|once|just|actually|not)){0,3}';
const ENGLISH_SPEECH_QUESTION = new RegExp(`${ENGLISH_SPEECH_SUBJECT}(?:(?:\\s+(?:has|have|had)(?:n't)?)?${ENGLISH_SPEECH_ADVERBS}\\s+(?:said|says|told|tells|mentioned|mentions)|\\s+(?:is|are|was|were)${ENGLISH_SPEECH_ADVERBS}\\s+(?:saying|telling|mentioning))\\b`, 'u');

function recallIntentForText(text) {
  if (isEvidenceReviewText(text)) {
    return "evidence-review";
  }
  if (/(?:反证|反例|相反(?:的)?(?:依据|证据)|不支持(?:这个|这一|该)?(?:结论|判断|看法)?(?:的)?(?:依据|证据)|\bcounter(?:example|evidence)\b|\bevidence against\b|\bcontradict(?:s|ory|ing)?\b)/iu.test(text)) {
    return "counterevidence";
  }
  if (/(?:依据|证据|怎么(?:知道|判断|得出)|凭什么|(?:你)?为什么(?:会)?(?:觉得|认为|判断|说)|\bwhat(?:'s| is) (?:the )?evidence\b|\bwhat makes you (?:think|believe)\b|\bhow do you know\b|\bwhy do you (?:think|believe)\b|\bbased on what\b)/iu.test(text)) {
    return "evidence";
  }
  if (ENGLISH_SPEECH_QUESTION.test(text)
    || /(?:原话|哪句话|那句话|怎么说的|说过什么|当时说了什么|原句|(?:谁|哪位|哪个人)(?:曾经|以前|之前|当时|昨天|今天|最近|最先|曾|还|先)?(?:说|讲|提|告诉)|\bexact (?:words|wording)\b|\bwhat did .{0,48}\bsay\b|\bwhat were .{0,48}(?:exact )?words\b|\bquote\b)/iu.test(text)) {
    return "utterance";
  }
  if (/(?:那件事|这件事|发生了什么|后来|结果|经过|那次|上次|当时|以前|之前|记得|回忆|什么时候|哪天|几号|去过|来过|\bwhat happened\b|\bwhen did\b|\bwhere did\b|\bwhat did\b|\bdo you (?:remember|recall)\b|\bpreviously\b|\bbefore\b|\bafter\b|\blater\b|\blast time\b)/iu.test(text)) {
    return "event";
  }
  return "auto";
}

export function classifyRecallIntent(query) {
  return recallIntentForText(requestedQueryText(query));
}

export function classifyRepresentationIntent(query) {
  const text = requestedQueryText(query);
  if (
    isEvidenceReviewText(text)
    || /(?:你|系统)(?:是)?(?:为什么|为何|怎么)(?:会)?(?:觉得|认为|判断|推断)|(?:你|系统)根据什么(?:判断|推断|得出)|为什么会被(?:判断|推断|认为)|\bwhy do you (?:think|believe)\b|\bwhy (?:does|do) (?:the )?system (?:think|believe)\b|\bwhat makes (?:you|the system) (?:think|believe)\b/iu.test(text)
  ) {
    return "evaluated";
  }
  return "any";
}

export function classifyRelationshipQueryIntent(query) {
  const text = requestedQueryText(query);
  if (
    /(?:(?:什么|哪种|怎样|怎么(?:样)?)(?:的)?关系|(?:当成|视为|看作|看成|算作?|属于)(?:什么|哪种)(?:关系|人)|(?:恋人|爱人|伴侣|老婆|老公|夫妻|情侣|男朋友|女朋友|男友|女友|朋友|家人)(?:关系)?(?:吗|么|呢|吧|$))/u.test(text)
    || /\b(?:what (?:is|was|are|were) .{0,60}relationship|are .{1,60} (?:friends|dating|a couple|partners)|(?:am i|are you|is .{1,40}) (?:your|my|our|their|his|her) (?:friend|partner|boyfriend|girlfriend|husband|wife)|how (?:do|does) .{0,40}(?:see|regard|think of) .{0,40})\b/u.test(text)
  ) return "role";
  if (/(?:一个人的|只属于|专属|独占|排他|只能是我|只能属于|\b(?:exclusive|exclusivity|only (?:mine|yours)|belong (?:only )?to me)\b)/u.test(text)) return "exclusivity";
  if (/(?:懂我|理解我|了解我|最懂|被理解|\b(?:understand(?:s|ing)? (?:me|you|us)|know me (?:best|well)|feel understood)\b)/u.test(text)) return "understanding";
  if (/(?:爱我|喜欢我|对我.{0,4}(?:感情|喜欢|爱意)|有感情|\b(?:(?:love|like)s? (?:me|you)|feelings? for (?:me|you)|feel about (?:me|you)|affection)\b)/u.test(text)) return "affection";
  return "any";
}

export function classifyLifecycleCompletionIntent(query) {
  const text = requestedQueryText(query);
  const asksForOutcome = /(?:吗|么|没(?:有)?|是否|是不是|怎么样了|怎样了|如何了|后来呢|结果呢)(?:[？?。！!]*)$/u.test(text)
    || /(?:后来|最后|最终).{0,12}(?:怎么样|怎样|如何|结果)/u.test(text)
    || /^(?:did|has|have|had|is|was|were|are)\b/u.test(text)
    || /\b(?:what happened to|how did .{0,60}(?:turn out|end)|what (?:was|is) the (?:outcome|status)|yet)\b/u.test(text);
  if (!asksForOutcome) return { matched: false, target: "" };
  const target = /(?:取消|放弃|不再继续|\b(?:cancel(?:led|ed)?|abandon(?:ed)?|call(?:ed)? off|give up|gave up|drop(?:ped)? (?:it|the plan))\b)/u.test(text)
    ? "cancelled"
    : /(?:修好|修完|换好|完成|做完|办完|解决|恢复|结束|到货|闭环|\b(?:finish(?:ed)?|complet(?:e|ed)|fix(?:ed)?|repair(?:ed)?|resolv(?:e|ed)|done|arriv(?:e|ed)|turn out|outcome)\b)/u.test(text)
      ? "completed"
      : "";
  return { matched: Boolean(target), target };
}

export function classifyChainIntent(query, temporal = { matched: false, remainingQuery: "" }) {
  const text = requestedQueryText(query);
  if (["evidence-review", "counterevidence", "evidence", "utterance"].includes(recallIntentForText(text))) {
    return { mode: "none", direction: "both" };
  }
  const followUp = chainFollowUp(text);
  if (followUp) return followUp;
  // In a naming question, 为 belongs to the verb phrase: 称呼他为 + 什么.
  // Preserve an earlier 为什么 so genuine questions about the reason remain causal.
  const causalText = text.replace(/((?:称呼|称作|称|叫作|叫做|命名|改名|认定|认作|视)[^,，;；?？。！!]{0,12})为什么(?=(?:呢|啊|呀)?(?:[?？。！!]|$))/gu, '$1什么');
  if (/(?:为什么|为何|怎么会|原因(?:是什么|呢)?|什么(?:原因|导致|造成|引起)|由什么(?:导致|造成|引起)|\bwhy\b|\bhow come\b|\bwhat caused\b|\bwhat (?:was|is) the reason\b|\bbecause of what\b)/iu.test(causalText)) {
    return { mode: "causal", direction: "backward" };
  }
  if (/(?:导致(?:了)?什么|造成(?:了)?什么|引起(?:了)?什么|带来(?:了)?什么(?:后果|影响)?|有什么(?:后果|影响)|产生(?:了)?什么(?:后果|影响)|\bwhat (?:did|does) .{0,48}(?:cause|lead to|result in)\b|\bwhat happened as a result\b|\bwhat (?:was|is) the (?:result|outcome|effect)\b)/iu.test(text)) {
    return { mode: "causal", direction: "forward" };
  }
  if (/(?:还(?:会|能|让你)?想起|联想到|相关的|类似的|还有哪些|还有什么|还有呢|再说点|再说一点|\bwhat else(?: is related)?\b|\banything similar\b|\bwhat does that remind you of\b)/iu.test(text)) {
    return { mode: "associative", direction: "both" };
  }
  const backward = /(?:^(?:再)?(?:往前|之前|前面)(?:呢|发生了什么)?$|在这之前|在那之前|此前|前面发生|之前发生|前因|\bwhat happened before\b|\bwhat came before\b|\bprior to that\b)/iu.test(text);
  const forward = /(?:后来|之后|接着|然后|结果|后续|发展下去|接下来|\bwhat happened next\b|\bwhat happened after\b|\band then\b|\bafter that\b|\blater on\b)/iu.test(text);
  const whole = /(?:整个经过|完整经过|从头|前因后果|来龙去脉|前后发生|\bthe whole story\b|\bfrom the beginning\b|\bwhat happened before and after\b)/iu.test(text);
  if (whole || backward || forward) {
    return {
      mode: "timeline",
      direction: whole || (backward && forward) ? "both" : backward ? "backward" : "forward",
    };
  }
  if (temporal.matched && !recallCorePhrases(temporal.remainingQuery).length) {
    return { mode: "date", direction: "both" };
  }
  return { mode: "none", direction: "both" };
}

// English must receive the same treatment as Chinese here: grammatical glue
// cannot become retrieval evidence.  In particular, a name plus "a" / "the"
// must never count as the two-term lexical match that independently admits a
// memory into ranking.
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
  if (classifyRecallIntent(query) === 'utterance') {
    text = text.replace(/^.+?\s+(?:say|said|mention(?:ed)?|tell|told)\s+(?:about|regarding|concerning)\s+/u, '');
  }
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

export function planVectorQuery(query) {
  const original = normalize(retrievalQueryText(query));
  const coreText = recallCorePhrases(query).join(" ").trim();
  if (coreText && coreText !== original) {
    return {
      text: coreText,
      source: "core-phrase",
    };
  }
  return {
    text: original,
    source: "original",
  };
}

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

function chainFollowUp(query) {
  const text = normalizeQuery(query).replace(/[？?。.!！]+$/gu, '').trim();
  if (/^(?:and then|then what|what happened (?:next|after that)|(?:再)?往后(?:呢|发生了什么)?|(?:后来|之后|然后|接着|结果|后续)(?:呢|怎么样|发生了什么)?)$/u.test(text)) {
    return { mode: 'timeline', direction: 'forward' };
  }
  if (/^(?:what happened before|(?:再)?(?:往前|之前|前面)(?:呢|发生了什么)?)$/u.test(text)) {
    return { mode: 'timeline', direction: 'backward' };
  }
  if (/^(?:what else|anything else|还有呢|还有什么|再说点|再说一点)$/u.test(text)) {
    return { mode: 'associative', direction: 'both' };
  }
  return null;
}

export function isContinuationQuery(query) {
  if (hasQuotedTopic(query)) return false;
  if (chainFollowUp(query)) return true;
  const english = normalize(query).replace(/[?.!]+$/gu, "").trim();
  if (/^(?:what about that|why|how (?:so|come)|are you sure|how do you know|any exceptions|what(?:['’]s| is) (?:the )?evidence|what were (?:the )?exact words)$/u.test(english)) {
    return true;
  }
  const key = normalizedQueryKey(query);
  if (!key || key.length > 18) return false;
  return [
    /^(?:那|这)(?:件事|件事情|一次|次|个)?(?:后来|之后|然后|结果|前面|之前|原话)?(?:呢|怎么样|怎么说的)?$/u,
    /^(?:为什么|为何|怎么会|什么原因|原因(?:是什么|呢)?)$/u,
    /^(?:那|这)?(?:有|还有)?(?:什么)?(?:依据|证据)(?:呢|吗)?$/u,
    /^(?:那|这)?(?:有|还有)?(?:什么)?(?:反证|反例|相反(?:的)?(?:依据|证据))(?:呢|吗)?$/u,
    /^(?:那|这|这个判断|这个结论)?(?:你)?(?:能)?(?:确定|有把握|靠不靠谱|可不可靠|是否可靠|可靠|可信|准确|准|有没有例外|是否有例外|存在例外|有什么漏洞)(?:呢|吗)?$/u,
    /^(?:那|这)?(?:是)?怎么(?:知道|判断|得出)(?:的)?$/u,
    /^(?:那|这)?凭什么$/u,
    /^(?:那|这)?(?:当时)?(?:具体)?(?:怎么说的|说了什么|原话(?:呢|是什么)?)$/u,
    /^(?:那|这|这件事|那件事)?(?:后来)?(?:导致|造成|引起)(?:了)?什么(?:后果|影响)?$/u,
    /^(?:那|这|这件事|那件事)?(?:有|产生|带来)(?:了)?什么(?:后果|影响)$/u,
  ].some((pattern) => pattern.test(key));
}

function continuationIds(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))];
}

export function resolveContinuationAnchors(query, trace = {}) {
  if (!isContinuationQuery(query)) {
    return {
      memoryIds: [],
      focusRole: "none",
      reason: "not-continuation",
      sourceTraceId: "",
    };
  }

  const metadata = trace?.metadata && typeof trace.metadata === "object"
    ? trace.metadata
    : {};
  const typed = metadata.continuationFocuses
    && typeof metadata.continuationFocuses === "object"
    ? metadata.continuationFocuses
    : null;
  const sourceTraceId = String(trace?.id ?? "").trim();
  const legacyMemoryIds = continuationIds([
    metadata.continuationMemoryId,
    metadata.focusMemoryId,
    trace?.selectedIds?.at?.(-1),
  ]).slice(0, 1);

  if (!typed) {
    return {
      memoryIds: legacyMemoryIds,
      focusRole: legacyMemoryIds.length ? "legacy" : "none",
      reason: legacyMemoryIds.length ? "legacy-single-focus" : "no-focus",
      sourceTraceId,
    };
  }

  const primaryMemoryId = continuationIds(typed.primaryMemoryId)[0] || "";
  const chainMemoryId = continuationIds(typed.chainMemoryId)[0] || primaryMemoryId;
  const representationMemoryIds = continuationIds(typed.representationMemoryIds);
  const recallIntent = classifyRecallIntent(query);
  const representationIntent = classifyRepresentationIntent(query);
  const chainIntent = classifyChainIntent(query);

  if (representationIntent === "evaluated" && representationMemoryIds.length) {
    return {
      memoryIds: continuationIds([primaryMemoryId, ...representationMemoryIds]).slice(0, 3),
      focusRole: "representation-set",
      reason: "evaluated-representation-follow-up",
      sourceTraceId,
    };
  }
  if (["evidence", "counterevidence", "evidence-review", "utterance"].includes(recallIntent)) {
    const memoryIds = continuationIds(primaryMemoryId || legacyMemoryIds[0]).slice(0, 1);
    return {
      memoryIds,
      focusRole: memoryIds.length ? "primary" : "none",
      reason: memoryIds.length ? `${recallIntent}-primary-follow-up` : "no-focus",
      sourceTraceId,
    };
  }
  if (["timeline", "causal", "associative"].includes(chainIntent.mode)) {
    const memoryIds = continuationIds(chainMemoryId || legacyMemoryIds[0]).slice(0, 1);
    return {
      memoryIds,
      focusRole: memoryIds.length ? "chain-tail" : "none",
      reason: memoryIds.length ? `${chainIntent.mode}-chain-follow-up` : "no-focus",
      sourceTraceId,
    };
  }
  const memoryIds = continuationIds(primaryMemoryId || legacyMemoryIds[0]).slice(0, 1);
  return {
    memoryIds,
    focusRole: memoryIds.length ? "primary" : "none",
    reason: memoryIds.length ? "generic-primary-follow-up" : "no-focus",
    sourceTraceId,
  };
}
