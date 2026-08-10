function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function normalizedQueryKey(value) {
  return normalize(value).replace(/[\s，。！？、,.!?：:；;“”"'（）()【】\[\]]+/gu, "");
}

function validDateKey(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() + 1 !== Number(month)
    || date.getUTCDate() !== Number(day)
  ) return null;
  return date.toISOString().slice(0, 10);
}

function localDateKey(now, timeZone) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error("now 不是有效时间。");
  try {
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return validDateKey(values.year, values.month, values.day);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function addDateKeyDays(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

function mondayOfDateKey(dateKey) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  return addDateKeyDays(dateKey, -((date.getUTCDay() + 6) % 7));
}

function monthRange(year, month) {
  const startDate = validDateKey(year, month, 1);
  if (!startDate) return null;
  const nextMonth = new Date(Date.UTC(Number(year), Number(month), 1));
  const endDate = addDateKeyDays(nextMonth.toISOString().slice(0, 10), -1);
  return { startDate, endDate };
}

function offsetMonthRange(dateKey, offset) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + Number(offset), 1);
  return monthRange(date.getUTCFullYear(), date.getUTCMonth() + 1);
}

function offsetYearRange(dateKey, offset) {
  const year = Number(dateKey.slice(0, 4)) + Number(offset);
  return {
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
  };
}

const ENGLISH_MONTHS = Object.freeze({
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
});

const ENGLISH_WEEKDAYS = Object.freeze({
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
});

function chineseInteger(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  const ten = value.indexOf("十");
  if (ten >= 0) {
    const tens = ten === 0 ? 1 : digits[value[ten - 1]];
    const ones = ten === value.length - 1 ? 0 : digits[value[ten + 1]];
    return Number.isFinite(tens) && Number.isFinite(ones) ? tens * 10 + ones : Number.NaN;
  }
  return digits[value] ?? Number.NaN;
}

function temporalResult(query, match, startDate, endDate = startDate, kind = "day") {
  return {
    matched: true,
    kind,
    expression: match[0],
    startDate,
    endDate,
    remainingQuery: `${query.slice(0, match.index)} ${query.slice(match.index + match[0].length)}`
      .replace(/\s+/gu, " ")
      .trim(),
  };
}

export function resolveTemporalQuery(query, now = new Date(), timeZone = "Asia/Shanghai") {
  const text = String(query || "");
  const today = localDateKey(now, timeZone);
  let match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})[日号]?/u)
    || text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/u);
  if (match) {
    const date = validDateKey(match[1], match[2], match[3]);
    if (date) return temporalResult(text, match, date);
  }
  match = text.match(/(\d{1,2})月(\d{1,2})[日号]/u);
  if (match) {
    const date = validDateKey(today.slice(0, 4), match[1], match[2]);
    if (date) return temporalResult(text, match, date);
  }
  const englishMonthNames = Object.keys(ENGLISH_MONTHS).join("|");
  match = text.match(new RegExp(`\\b(${englishMonthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "iu"))
    || text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+(${englishMonthNames})(?:,?\\s+(\\d{4}))?\\b`, "iu"));
  if (match) {
    const monthFirst = ENGLISH_MONTHS[String(match[1]).toLowerCase()];
    const month = monthFirst || ENGLISH_MONTHS[String(match[2]).toLowerCase()];
    const day = monthFirst ? match[2] : match[1];
    const year = match[3] || today.slice(0, 4);
    const date = validDateKey(year, month, day);
    if (date) return temporalResult(text, match, date);
  }
  match = text.match(/(上上|上个|上|本|这|这个|下个|下)周末/u);
  if (match) {
    const offset = match[1].startsWith("上上") ? -2
      : match[1].startsWith("上") ? -1
        : match[1].startsWith("下") ? 1 : 0;
    const saturday = addDateKeyDays(mondayOfDateKey(today), offset * 7 + 5);
    return temporalResult(text, match, saturday, addDateKeyDays(saturday, 1), "range");
  }
  match = text.match(/(上上|上个|上|本|这|这个|下个|下)(?:周|星期|礼拜)([一二三四五六日天])/u);
  if (match) {
    const offset = match[1].startsWith("上上") ? -2
      : match[1].startsWith("上") ? -1
        : match[1].startsWith("下") ? 1 : 0;
    const weekday = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }[match[2]];
    return temporalResult(
      text,
      match,
      addDateKeyDays(mondayOfDateKey(today), offset * 7 + weekday),
    );
  }
  match = text.match(/(\d+|[一二两三四五六七八九十]+)天前/u);
  if (match) {
    const days = chineseInteger(match[1]);
    if (Number.isFinite(days) && days > 0) {
      return temporalResult(text, match, addDateKeyDays(today, -days));
    }
  }
  match = text.match(/\b(\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago\b/iu);
  if (match) {
    const amount = Number(match[1]);
    if (Number.isFinite(amount) && amount > 0) {
      const unit = match[2].toLowerCase();
      if (/^month/u.test(unit)) {
        const range = offsetMonthRange(today, -amount);
        return temporalResult(text, match, range.startDate, range.endDate, "range");
      }
      if (/^year/u.test(unit)) {
        const range = offsetYearRange(today, -amount);
        return temporalResult(text, match, range.startDate, range.endDate, "range");
      }
      const days = /^week/u.test(unit) ? amount * 7 : amount;
      return temporalResult(text, match, addDateKeyDays(today, -days));
    }
  }
  match = text.match(/\b(last|previous|this|current|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu);
  if (match) {
    const period = match[1].toLowerCase();
    const offset = ["last", "previous"].includes(period) ? -1 : period === "next" ? 1 : 0;
    const weekday = ENGLISH_WEEKDAYS[match[2].toLowerCase()];
    return temporalResult(
      text,
      match,
      addDateKeyDays(mondayOfDateKey(today), offset * 7 + weekday),
    );
  }
  match = text.match(/\b(last|previous|this|current|next)\s+(weekend|week|month|year)\b/iu);
  if (match) {
    const period = match[1].toLowerCase();
    const offset = ["last", "previous"].includes(period) ? -1 : period === "next" ? 1 : 0;
    const unit = match[2].toLowerCase();
    if (unit === "weekend") {
      const saturday = addDateKeyDays(mondayOfDateKey(today), offset * 7 + 5);
      return temporalResult(text, match, saturday, addDateKeyDays(saturday, 1), "range");
    }
    if (unit === "week") {
      const monday = addDateKeyDays(mondayOfDateKey(today), offset * 7);
      return temporalResult(text, match, monday, addDateKeyDays(monday, 6), "range");
    }
    const range = unit === "month" ? offsetMonthRange(today, offset) : offsetYearRange(today, offset);
    return temporalResult(text, match, range.startDate, range.endDate, "range");
  }
  match = text.match(new RegExp(`\\b(?:in|during)\\s+(${englishMonthNames})\\s+and\\s+(${englishMonthNames})(?:\\s+(\\d{4}))?\\b`, "iu"));
  if (match) {
    const year = match[3] || today.slice(0, 4);
    const firstMonth = ENGLISH_MONTHS[match[1].toLowerCase()];
    const secondMonth = ENGLISH_MONTHS[match[2].toLowerCase()];
    const firstRange = monthRange(year, firstMonth);
    const secondRange = monthRange(Number(year) + (secondMonth < firstMonth ? 1 : 0), secondMonth);
    if (firstRange && secondRange) {
      return temporalResult(text, match, firstRange.startDate, secondRange.endDate, "range");
    }
  }
  match = text.match(new RegExp(`\\b(?:in|during)\\s+(${englishMonthNames})(?:\\s+(\\d{4}))?\\b`, "iu"));
  if (match) {
    const range = monthRange(match[2] || today.slice(0, 4), ENGLISH_MONTHS[match[1].toLowerCase()]);
    if (range) return temporalResult(text, match, range.startDate, range.endDate, "range");
  }
  for (const [label, offset] of [
    ["大前天", -3],
    ["前天", -2],
    ["昨天", -1],
    ["今天", 0],
    ["明天", 1],
    ["后天", 2],
    ["day before yesterday", -2],
    ["day after tomorrow", 2],
    ["yesterday", -1],
    ["today", 0],
    ["tomorrow", 1],
  ]) {
    const english = /^[a-z]/iu.test(label);
    match = text.match(new RegExp(english ? `\\b${label}\\b` : label, english ? "iu" : "u"));
    if (match) {
      const prefix = text.slice(0, match.index);
      if (english && /\b(?:after|before|by|since|until)\s*$/iu.test(prefix)) continue;
      return temporalResult(text, match, addDateKeyDays(today, offset));
    }
  }
  return {
    matched: false,
    kind: null,
    expression: "",
    startDate: null,
    endDate: null,
    remainingQuery: text,
  };
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

function boundedOccurrences(text, value) {
  const term = normalize(value);
  if (!term) return [];
  const indexes = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = text.indexOf(term, cursor);
    if (index < 0) break;
    const before = text[index - 1] || "";
    const after = text[index + term.length] || "";
    if (!ENGLISH_WORD_CHARACTER.test(before) && !ENGLISH_WORD_CHARACTER.test(after)) {
      indexes.push(index);
    }
    cursor = index + term.length;
  }
  return indexes;
}

function englishQuestionSubjectPrefix(prefix) {
  return /\b(?:did|does|do|is|are|was|were|has|have|had|will|would|can|could|should|might|may)\s*$/u.test(prefix)
    || /(?:^|\b)(?:what|when|where|why|how|which)\s*$/u.test(prefix);
}

function englishDirectSubjectSuffix(suffix) {
  return /^(?:\s+)(?:is|are|was|were|has|have|had|will|would|can|could|should|might|may|did|does|do|likes?|loves?|hates?|prefers?|thinks?|believes?|feels?|wants?|plans?|decides?|decided|promises?|said|says|told|tells|went|goes|moved|moves|visited|visits|researched|researches|painted|paints|ate|eats|read|reads|watched|watches|played|plays|bought|buys|attended|attends|received|receives|cleaned|cleans|saw|sees|met|meets|worked|works|studied|studies|lived|lives)\b/u.test(suffix);
}

function englishPossessiveStateSuffix(suffix) {
  return /^(?:'s|’s)\s+(?:identity|relationship|relationship\s+status|status|preference|preferences|favorite|favourite|habit|habits|goal|goals|value|values|ability|abilities|opinion|opinions|view|views|name|age|birthday|education|school|university|college|major|job|occupation|condition)\b/u.test(suffix);
}

function englishStateFocus(prefix, suffix) {
  return /\b(?:like|love|hate|prefer|think|believe|feel|want|plan|decide|promise|identity|relationship|status|preference|favorite|favourite|habit|goal|value|ability|opinion|view|name|age|birthday|education|school|university|college|major|job|occupation|condition)\b/iu.test(
    `${prefix.slice(-48)} ${suffix.slice(0, 96)}`,
  ) ? "state" : "event";
}

function englishSubjectMatches(text, actor, {
  pronouns = [],
  possessives = [],
} = {}) {
  const matches = [];
  const seen = new Set();
  const tokens = [...new Set([
    ...(actor?.names || []),
    ...(Array.isArray(pronouns) ? pronouns : [pronouns]).map(normalize),
  ].filter(Boolean))];
  for (const token of tokens) {
    for (const index of boundedOccurrences(text, token)) {
      const prefix = text.slice(0, index);
      const suffix = text.slice(index + token.length);
      const direct = englishQuestionSubjectPrefix(prefix) || englishDirectSubjectSuffix(suffix);
      const possessiveState = actor?.names?.includes(token) && englishPossessiveStateSuffix(suffix);
      if (!direct && !possessiveState) continue;
      const key = `${index}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        index,
        basis: text.slice(index, index + token.length),
        focus: possessiveState ? "state" : englishStateFocus(prefix, suffix),
      });
    }
  }
  for (const possessive of [...new Set((Array.isArray(possessives) ? possessives : [possessives])
    .map(normalize).filter(Boolean))]) {
    for (const index of boundedOccurrences(text, possessive)) {
      const suffix = text.slice(index + possessive.length);
      if (!/^\s+(?:identity|relationship|relationship\s+status|status|preference|preferences|favorite|favourite|habit|habits|goal|goals|value|values|ability|abilities|opinion|opinions|view|views|name|age|birthday|education|school|university|college|major|job|occupation|condition)\b/u.test(suffix)) continue;
      const key = `${index}:${possessive}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        index,
        basis: text.slice(index, index + possessive.length),
        focus: "state",
      });
    }
  }
  return matches;
}

function englishSharedNameMatch(text, speaker, addressee) {
  const pairs = [];
  for (const left of speaker?.names || []) {
    for (const right of addressee?.names || []) {
      for (const separator of [" and ", " & "]) {
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
        || /\b(?:together|both)\b/u.test(suffix)
      ) {
        return { index, basis: text.slice(index, index + pair.length) };
      }
    }
  }
  return null;
}

function historicalStateCue(text) {
  return /(?:以前|之前|过去|从前|曾经|当时|那时候|原来|\bpreviously\b|\bin the past\b|\bused to\b|\bformerly\b|\bat the time\b|\bonce\b)/iu.test(text);
}

function subjectPredicateMatches(text, pronoun) {
  const escaped = pronoun.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const patterns = [
    new RegExp(`${escaped}(?:自己)?(?:上上周[一二三四五六日天]?|上周[一二三四五六日天]?|这周[一二三四五六日天]?|本周[一二三四五六日天]?|昨天|今天|前天|最近|以前|之前|现在|后来|当时|上次|曾经|小时候|童年时?|平时|通常|一直|总是|有时|偶尔|最|更|比较|特别|非常|很|\\d{1,2}月|\\d{1,2}号|\\d{1,2}日|\\s){0,4}(?:喜欢|偏爱|讨厌|不喜欢|觉得|认为|相信|想要|计划|决定|答应|承诺|会|能|做过|干过|去过|吃过|看过|玩过|说过|学过|读过|经历过|住过|工作|学习|去了|去|做了|做|吃了|吃|看了|看|玩了|玩|说了|说|在|有)`, "gu"),
    new RegExp(`${escaped}(?:是)?怎么说(?:的|过)?`, "gu"),
    new RegExp(`${escaped}的(?:喜好|偏好|习惯|计划|目标|能力|经历|原话|观点|看法|想法|选择|工作|住址|生日|本科|教育|学历|学校|院校|大学|专业|职业|职位|单位|公司|家乡|籍贯|住所|住处|姓名|名字|年龄|童年|求学经历|阅读经历|生平)`, "gu"),
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => {
    const basis = match[0];
    const stateFocused = /(?:喜欢|偏爱|讨厌|不喜欢|觉得|认为|相信|想要|计划|决定|答应|承诺|喜好|偏好|习惯|目标|能力|观点|看法|想法)/u.test(basis);
    return {
      index: Number(match.index),
      basis,
      focus: stateFocused ? "state" : "event",
    };
  }));
}

export function resolveQuerySubject(query, {
  speakerRole = "user",
  speakerKey = "user",
  speakerNames = [],
  addresseeRole = "agent",
  addresseeKey = "",
  addresseeNames = [],
} = {}) {
  const text = normalize(query);
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
  const englishConversationalFrame = /^(?:(?:do|can|could|would)\s+you\s+(?:still\s+)?(?:remember|recall|know)|(?:please\s+)?(?:tell|remind)\s+me(?:\s+about)?)(?:\s+)?/u;
  const content = text.replace(conversationalFrame, "")
    .replace(englishConversationalFrame, "")
    .trim();
  const sharedFromNames = englishSharedNameMatch(content, speaker, addressee);
  if (sharedFromNames) {
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
  const namedMatches = [
    ...englishSubjectMatches(content, speaker).map((match) => ({ ...match, actor: speaker })),
    ...englishSubjectMatches(content, addressee).map((match) => ({ ...match, actor: addressee })),
  ].sort((left, right) => right.index - left.index || right.basis.length - left.basis.length);
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
      stateTime: selected.focus === "state" && historicalStateCue(content)
        ? "historical"
        : selected.focus === "state" ? "current" : "not-applicable",
      reason: "configured-name-subject",
    };
  }
  if (/[“”"]/u.test(text)) return none("quoted-language");
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
      stateTime: historicalStateCue(content)
        ? "historical"
        : "current",
      reason: "explicit-relationship-perspective",
    };
  }
  const englishSharedMatches = englishSubjectMatches(content, { names: [] }, {
    pronouns: ["we"],
    possessives: ["our"],
  });
  if (englishSharedMatches.length) {
    if (!speaker.role || !speaker.key || !addressee.role || !addressee.key) {
      return none("perspective-missing-key");
    }
    return {
      matched: true,
      mode: "shared",
      role: "shared",
      key: "",
      basis: englishSharedMatches[0].basis,
      reason: "explicit-shared-subject",
      members: [speaker, addressee],
    };
  }
  const matches = [
    ...subjectPredicateMatches(content, "我").map((match) => ({ ...match, actor: speaker })),
    ...subjectPredicateMatches(content, "你").map((match) => ({ ...match, actor: addressee })),
    ...englishSubjectMatches(content, { ...speaker, names: [] }, {
      pronouns: ["i"],
      possessives: ["my"],
    }).map((match) => ({ ...match, actor: speaker })),
    ...englishSubjectMatches(content, { ...addressee, names: [] }, {
      pronouns: ["you"],
      possessives: ["your"],
    }).map((match) => ({ ...match, actor: addressee })),
  ].sort((left, right) => right.index - left.index || right.basis.length - left.basis.length);
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
      stateTime: selected.focus === "state" && historicalStateCue(content)
        ? "historical"
        : selected.focus === "state" ? "current" : "not-applicable",
      reason: "explicit-subject-predicate",
    };
  }
  if (/(?:我们|咱们|咱俩|我们俩|一起)/u.test(content)) {
    if (!speaker.role || !speaker.key || !addressee.role || !addressee.key) {
      return none("perspective-missing-key");
    }
    return {
      matched: true,
      mode: "shared",
      role: "shared",
      key: "",
      basis: content.match(/(?:我们|咱们|咱俩|我们俩|一起)/u)?.[0] || "",
      reason: "explicit-shared-subject",
      members: [speaker, addressee],
    };
  }
  return none();
}

function isEvidenceReviewText(text) {
  return /(?:你(?:能)?确定|有(?:没有)?把握|靠不靠谱|可不可靠|是否可靠|可靠吗|可信(?:吗|不)|准确(?:吗|不)|这个判断准(?:吗|不)|(?:有|存在|有没有|还有没有)(?:什么)?例外|是否有例外|有什么漏洞|\bare you sure\b|\bis (?:that|this) reliable\b|\bhow reliable\b|\bany exceptions?\b|\bis there (?:an|any) exception\b|\bwhat(?:'s| is) (?:the )?exception\b|\bwhat(?:'s| is) (?:the )?weakness\b)/iu.test(text);
}

export function classifyRecallIntent(query) {
  const text = normalize(query);
  if (isEvidenceReviewText(text)) {
    return "evidence-review";
  }
  if (/(?:反证|反例|相反(?:的)?(?:依据|证据)|不支持(?:这个|这一|该)?(?:结论|判断|看法)?(?:的)?(?:依据|证据)|\bcounter(?:example|evidence)\b|\bevidence against\b|\bcontradict(?:s|ory|ing)?\b)/iu.test(text)) {
    return "counterevidence";
  }
  if (/(?:依据|证据|怎么(?:知道|判断|得出)|凭什么|(?:你)?为什么(?:会)?(?:觉得|认为|判断|说)|\bwhat(?:'s| is) (?:the )?evidence\b|\bwhat makes you (?:think|believe)\b|\bhow do you know\b|\bwhy do you (?:think|believe)\b|\bbased on what\b)/iu.test(text)) {
    return "evidence";
  }
  if (/(?:原话|哪句话|那句话|怎么说的|说过什么|当时说了什么|原句|\bexact (?:words|wording)\b|\bwhat did .{0,48}\bsay\b|\bwhat were .{0,48}(?:exact )?words\b|\bquote\b)/iu.test(text)) {
    return "utterance";
  }
  if (/(?:那件事|这件事|发生了什么|后来|结果|经过|那次|上次|当时|以前|之前|记得|回忆|什么时候|哪天|几号|去过|来过|\bwhat happened\b|\bwhen did\b|\bwhere did\b|\bwhat did\b|\bdo you (?:remember|recall)\b|\bpreviously\b|\bbefore\b|\bafter\b|\blater\b|\blast time\b)/iu.test(text)) {
    return "event";
  }
  return "auto";
}

export function classifyRepresentationIntent(query) {
  const text = normalize(query);
  if (
    isEvidenceReviewText(text)
    || /(?:你|系统)(?:是)?(?:为什么|为何|怎么)(?:会)?(?:觉得|认为|判断|推断)|(?:你|系统)根据什么(?:判断|推断|得出)|为什么会被(?:判断|推断|认为)|\bwhy do you (?:think|believe)\b|\bwhy (?:does|do) (?:the )?system (?:think|believe)\b|\bwhat makes (?:you|the system) (?:think|believe)\b/iu.test(text)
  ) {
    return "evaluated";
  }
  return "any";
}

export function classifyRelationshipQueryIntent(query) {
  const text = normalize(query);
  if (
    /(?:(?:什么|哪种|怎样|怎么(?:样)?)(?:的)?关系|(?:当成|视为|看作|看成|算作?|属于)(?:什么|哪种)(?:关系|人)|(?:恋人|爱人|伴侣|老婆|老公|夫妻|情侣|男朋友|女朋友|男友|女友|朋友|家人)(?:关系)?(?:吗|么|呢|吧|$))/u.test(text)
  ) return "role";
  if (/(?:一个人的|只属于|专属|独占|排他|只能是我|只能属于)/u.test(text)) return "exclusivity";
  if (/(?:懂我|理解我|了解我|最懂|被理解)/u.test(text)) return "understanding";
  if (/(?:爱我|喜欢我|对我.{0,4}(?:感情|喜欢|爱意)|有感情)/u.test(text)) return "affection";
  return "any";
}

export function classifyLifecycleCompletionIntent(query) {
  const text = normalize(query);
  const asksForOutcome = /(?:吗|么|没(?:有)?|是否|是不是|怎么样了|怎样了|如何了|后来呢|结果呢)(?:[？?。！!]*)$/u.test(text)
    || /(?:后来|最后|最终).{0,12}(?:怎么样|怎样|如何|结果)/u.test(text);
  if (!asksForOutcome) return { matched: false, target: "" };
  const target = /(?:取消|放弃|不再继续)/u.test(text)
    ? "cancelled"
    : /(?:修好|修完|换好|完成|做完|办完|解决|恢复|结束|到货|闭环)/u.test(text)
      ? "completed"
      : "";
  return { matched: Boolean(target), target };
}

export function classifyChainIntent(query, temporal = { matched: false, remainingQuery: "" }) {
  const text = normalize(query);
  if (isEvidenceReviewText(text)) {
    return { mode: "none", direction: "both" };
  }
  if (/(?:反证|反例|相反(?:的)?(?:依据|证据)|不支持(?:这个|这一|该)?(?:结论|判断|看法)?(?:的)?(?:依据|证据)|依据|证据|怎么(?:知道|判断|得出)|凭什么|(?:你)?为什么(?:会)?(?:觉得|认为|判断|说)|原话|哪句话|那句话|怎么说的|说过什么|原句|\bcounter(?:example|evidence)\b|\bevidence against\b|\bwhat(?:'s| is) (?:the )?evidence\b|\bhow do you know\b|\bwhy do you (?:think|believe)\b|\bexact (?:words|wording)\b|\bwhat did .{0,48}\bsay\b|\bquote\b)/iu.test(text)) {
    return { mode: "none", direction: "both" };
  }
  if (/(?:为什么|为何|怎么会|原因(?:是什么|呢)?|什么(?:原因|导致|造成|引起)|由什么(?:导致|造成|引起)|\bwhy did\b|\bwhat caused\b|\bwhat (?:was|is) the reason\b|\bbecause of what\b)/iu.test(text)) {
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

function normalizeEnglishLexicalTerm(value) {
  const normalized = normalize(value)
    .replace(/[’]/gu, "'")
    .replace(/(?:'s|')$/u, "");
  if (!normalized || ENGLISH_STOP_WORDS.has(normalized)) return "";
  // A standalone alphabetic letter is normally the possessive tail from a
  // token such as "John's", never useful semantic evidence.  Numbers remain
  // valid because they can carry dates, counts, and versions.
  if (/^[a-z]$/u.test(normalized)) return "";
  return normalized;
}

function englishCorePhrase(query) {
  const normalized = normalize(query);
  if (!/[a-z]/iu.test(normalized) || /\p{Script=Han}/u.test(normalized)) return "";
  let text = normalized
    .replace(/[，。！？、,.!?：:；;“”"（）()【】\[\]]+/gu, " ")
    .replace(/^(?:(?:do|can|could|would)\s+you\s+(?:still\s+)?(?:remember|recall|know)|(?:please\s+)?(?:tell|remind)\s+me(?:\s+about)?)(?:\s+)?/u, "")
    .replace(/^(?:please\s+)?(?:what|when|where|who|which|why|how(?:\s+(?:long|many|much))?)\s+(?:(?:did|does|do|is|are|was|were|has|have|had|will|would|can|could|should|might|may)\s+)?/u, "")
    .replace(/\b(?:please|thanks|thank you)\b\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  const terms = text.match(/[a-z0-9][a-z0-9'’-]*/giu) || [];
  if (!terms.some((term) => !ENGLISH_STOP_WORDS.has(term.toLowerCase()))) return "";
  return text;
}

const DEFAULT_GENERIC_QUERIES = Object.freeze([
  "在吗", "嗯", "嗯嗯", "好", "好的", "好吧", "行", "知道了", "算了",
  "继续", "然后呢", "你呢", "怎么了", "哈哈", "睡了", "几点了", "现在几点", "现在几点了",
  "hi", "hello", "hey", "ok", "okay", "thanks", "thank you", "got it", "continue",
  "what about you", "how are you",
]);

export function isGenericQuery(query, genericQueries = DEFAULT_GENERIC_QUERIES) {
  const key = normalizedQueryKey(query);
  if (!key) return true;
  return new Set(genericQueries.map(normalizedQueryKey)).has(key);
}

export function recallCorePhrases(query) {
  const english = englishCorePhrase(query);
  if (english) return [english];
  let text = normalize(query).replace(/[，。！？、,.!?：:；;“”"'（）()【】\[\]]+/gu, " ");
  for (const phrase of [
    "做了些什么", "干了些什么", "做了什么", "干了什么", "发生了什么", "有什么事情",
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
  return text.split(/\s+/u)
    .map((part) => part
      .replace(/^(?:我|你|他|她|它|我们|你们|他们|还|曾经|到底)+(?:自己)?(?:的)?(?:有)?/u, "")
      .replace(/^(?:去过|去)/u, "")
      .replace(/(?:是什么|是|的|吗|呢|啊|呀|吧|了)+$/u, "")
      .trim())
    .filter((part) => Array.from(part).length >= 2);
}

export function planVectorQuery(query) {
  const original = normalize(query);
  const coreText = recallCorePhrases(original).join(" ").trim();
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

export function lexicalTerms(value) {
  const text = normalize(value);
  const terms = new Set();
  for (const match of text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)) {
    const sequence = match[0];
    for (const width of [2, 3, 4]) {
      for (let index = 0; index + width <= sequence.length; index += 1) {
        const token = sequence.slice(index, index + width);
        if (![...token].every((character) => STOP_CHARACTERS.has(character))) terms.add(token);
      }
    }
  }
  for (const match of text.matchAll(/[a-z0-9][a-z0-9_.'’-]*/gu)) {
    const token = normalizeEnglishLexicalTerm(match[0]);
    if (token) terms.add(token);
  }
  return [...terms];
}

export function lexicalScore(query, document) {
  const phrases = recallCorePhrases(query);
  const queryText = phrases.length ? phrases.join(" ") : query;
  const queryTerms = lexicalTerms(queryText);
  const normalizedDocument = normalize(document).replace(/\s+/gu, "");
  let score = 0;
  let overlap = 0;
  const matchedTerms = [];
  for (const term of queryTerms) {
    if (!normalizedDocument.includes(term)) continue;
    overlap += 1;
    matchedTerms.push(term);
    score += Math.max(1, Array.from(term).length - 1);
  }
  const normalizedQuery = normalize(queryText).replace(/[^\p{L}\p{N}]+/gu, "");
  const exactPhrase = normalizedQuery.length >= 2 && normalizedDocument.includes(normalizedQuery);
  if (exactPhrase) score += 8;
  return { score, overlap, exactPhrase, queryTerms, matchedTerms };
}

export function isContinuationQuery(query) {
  const english = normalize(query).replace(/[?.!]+$/gu, "").trim();
  if (/^(?:and then|what happened next|what happened after that|what about that|why|what(?:'s| is) (?:the )?evidence|what were (?:the )?exact words)$/u.test(english)) {
    return true;
  }
  const key = normalizedQueryKey(query);
  if (!key || key.length > 18) return false;
  return [
    /^(?:后来|之后|然后|接着|结果|后续)(?:呢|怎么样|发生了什么)?$/u,
    /^(?:再)?(?:往后|往前|之前|前面)(?:呢|发生了什么)?$/u,
    /^(?:还有呢|还有什么|再说点|再说一点)$/u,
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
