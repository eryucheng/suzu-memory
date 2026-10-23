import { DEFAULT_MEMORY_TIME_ZONE, dateKeyInTimeZone } from '@suzu-memory/core';

function validDate(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() + 1 === Number(month) && date.getUTCDate() === Number(day)
    ? date.toISOString().slice(0, 10) : null;
}

export function addCalendarDays(day, amount) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function monday(day) {
  return addCalendarDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
}

function monthRange(year, month) {
  const startDate = validDate(year, month, 1);
  if (!startDate) return null;
  const next = new Date(Date.UTC(Number(year), Number(month), 1)).toISOString().slice(0, 10);
  return { startDate, endDate: addCalendarDays(next, -1) };
}

function shiftMonths(day, amount) {
  const date = new Date(`${day}T12:00:00Z`);
  const dayOfMonth = date.getUTCDate();
  date.setUTCMonth(date.getUTCMonth() + amount, 1);
  const range = monthRange(date.getUTCFullYear(), date.getUTCMonth() + 1);
  return `${range.startDate.slice(0, 8)}${String(Math.min(dayOfMonth, Number(range.endDate.slice(8)))).padStart(2, '0')}`;
}

function yearRange(year) { return { startDate: `${year}-01-01`, endDate: `${year}-12-31` }; }
function window(startDate, endDate = startDate) { return { startDate, endDate }; }

function result(text, match, coreWindow, {
  precision = 'exact', toleranceWindow = coreWindow, kind = null, ordering = 'relevance',
} = {}) {
  return {
    matched: true, precision,
    kind: kind || (coreWindow?.startDate === coreWindow?.endDate ? 'day' : 'range'),
    expression: match[0],
    startDate: coreWindow?.startDate ?? null, endDate: coreWindow?.endDate ?? null,
    coreWindow, toleranceWindow, ordering,
    remainingQuery: `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`.replace(/\s+/gu, ' ').trim(),
  };
}

function unmatched(text) {
  return { matched: false, precision: null, kind: null, expression: '', startDate: null,
    endDate: null, coreWindow: null, toleranceWindow: null, ordering: 'relevance', remainingQuery: text };
}

const MONTHS = Object.freeze({ january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 });
const WEEKDAYS = Object.freeze({ monday: 0, tuesday: 1, wednesday: 2, thursday: 3,
  friday: 4, saturday: 5, sunday: 6 });

function integer(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  const match = value.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u);
  return match ? (digits[match[1]] || 1) * 10 + (digits[match[2]] || 0) : digits[value] ?? NaN;
}

function contextYear(text, match, today) {
  const prefix = text.slice(0, match.index);
  const suffix = text.slice(match.index + match[0].length);
  const explicit = prefix.match(/(\d{4})年\s*$/u);
  if (explicit) return Number(explicit[1]);
  const cn = prefix.match(/(前年|去年|今年|明年)\s*$/u);
  const en = prefix.match(/\b(last|previous|this|current|next)\s+year\s+(?:(?:on|in|during)\s+)?$/iu)
    || suffix.match(/^\s+(last|previous|this|current|next)\s+year\b/iu);
  const label = cn?.[1] || en?.[1]?.toLowerCase();
  if (!label) return null;
  const offset = label === '前年' ? -2 : ['去年', 'last', 'previous'].includes(label) ? -1
    : ['明年', 'next'].includes(label) ? 1 : 0;
  return Number(today.slice(0, 4)) + offset;
}

function recallDate(today, month, day, year = null) {
  if (year !== null) return validDate(year, month, day);
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = validDate(Number(today.slice(0, 4)) - offset, month, day);
    if (date && date <= today) return date;
  }
  return null;
}

function includeYearQualifier(text, match) {
  const prefix = text.slice(0, match.index).match(/(?:前年|去年|今年|明年)\s*$/u);
  if (!prefix) return match;
  return Object.assign([prefix[0] + match[0]], { index: match.index - prefix[0].length });
}

function relativeAmount(text, match, today, value, unit) {
  const isFew = value.includes('几');
  const decade = value.endsWith('十几') ? integer(value.slice(0, -1)) : null;
  const bounds = isFew ? decade !== null ? [decade + 1, decade + 9, decade, decade + 12] : [2, 6, 1, 9] : null;
  const amount = integer(value);
  if (!bounds && (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000)) return unmatched(text);
  const shift = (n) => unit === 'month' ? shiftMonths(today, -n)
    : unit === 'year' ? shiftMonths(today, -12 * n) : addCalendarDays(today, -n * (unit === 'week' ? 7 : 1));
  if (bounds) {
    const [near, far, toleranceNear, toleranceFar] = bounds;
    // Natural-language "a few days/weeks ago" has its own recalled-past window.
    const core = unit === 'day' && value === '几' ? window(addCalendarDays(today, -6), addCalendarDays(today, -2))
      : window(shift(far), shift(near));
    const tolerance = unit === 'day' && value === '几' ? window(addCalendarDays(today, -10), addCalendarDays(today, -1))
      : unit === 'week' && value === '几' ? window(addCalendarDays(today, -60), addCalendarDays(today, -7))
      : window(shift(toleranceFar), shift(toleranceNear));
    return result(text, match, core, { precision: 'vague', toleranceWindow: tolerance });
  }
  const center = shift(amount);
  const coreDays = { day: 1, week: 3, month: 15, year: 45 }[unit];
  const toleranceDays = { day: 3, week: 7, month: 31, year: 90 }[unit];
  return result(text, match, window(addCalendarDays(center, -coreDays), [addCalendarDays(center, coreDays), today].sort()[0]), {
    precision: 'approximate',
    toleranceWindow: window(addCalendarDays(center, -toleranceDays), [addCalendarDays(center, toleranceDays), today].sort()[0]),
  });
}

export function resolveTemporalQuery(query, now = new Date(), timeZone = DEFAULT_MEMORY_TIME_ZONE) {
  const text = String(query || '');
  const today = dateKeyInTimeZone(now, timeZone);
  if (!today) throw new Error('now 不是有效时间。');
  let match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})[日号]?/u)
    || text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/u);
  if (match) {
    const date = validDate(match[1], match[2], match[3]);
    return date ? result(text, match, window(date)) : unmatched(text);
  }
  match = text.match(/(\d{1,2})月(\d{1,2})[日号]/u);
  if (match) {
    const date = recallDate(today, match[1], match[2], contextYear(text, match, today));
    return date ? result(text, includeYearQualifier(text, match), window(date)) : unmatched(text);
  }
  const months = Object.keys(MONTHS).join('|');
  match = text.match(new RegExp(`\\b(${months})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'iu'))
    || text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+(${months})(?:,?\\s+(\\d{4}))?\\b`, 'iu'));
  if (match) {
    const monthFirst = MONTHS[match[1].toLowerCase()];
    const date = recallDate(today, monthFirst || MONTHS[match[2].toLowerCase()], monthFirst ? match[2] : match[1],
      match[3] ? Number(match[3]) : contextYear(text, match, today));
    return date ? result(text, match, window(date)) : unmatched(text);
  }
  match = text.match(/(上上|上个|上|这个|这|本|下个|下)周末/u);
  if (match) {
    const offset = match[1].startsWith('上上') ? -2 : match[1].startsWith('上') ? -1 : match[1].startsWith('下') ? 1 : 0;
    const start = addCalendarDays(monday(today), offset * 7 + 5);
    return result(text, match, window(start, addCalendarDays(start, 1)));
  }
  match = text.match(/(上上|上个|上|这个|这|本|下个|下)(?:周|星期|礼拜)([一二三四五六日天])/u);
  if (match) {
    const offset = match[1].startsWith('上上') ? -2 : match[1].startsWith('上') ? -1 : match[1].startsWith('下') ? 1 : 0;
    const day = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }[match[2]];
    return result(text, match, window(addCalendarDays(monday(today), offset * 7 + day)));
  }
  match = text.match(/(?:(前年|去年|今年|明年|\d{4}年)\s*)?(上半年|下半年|年底|年末)/u);
  if (match) {
    const endOfYear = ['年底', '年末'].includes(match[2]);
    const startMonth = endOfYear ? 11 : match[2] === '上半年' ? 1 : 7;
    const explicitYear = match[1];
    const year = explicitYear ? /^\d/u.test(explicitYear) ? Number(explicitYear.slice(0, -1))
      : Number(today.slice(0, 4)) + ({ 前年: -2, 去年: -1, 今年: 0, 明年: 1 }[explicitYear])
      : Number(recallDate(today, startMonth, 1).slice(0, 4));
    const core = window(monthRange(year, startMonth).startDate, monthRange(year, endOfYear ? 12 : startMonth + 5).endDate);
    return result(text, match, core, endOfYear ? { precision: 'vague',
      toleranceWindow: window(monthRange(year, 10).startDate, core.endDate) } : {});
  }
  // A named calendar period has exact boundaries; an elapsed amount is approximate.
  match = text.match(/(前年|去年|今年|明年|\d{4}年)(?:([一二三四五六七八九十\d]+)月|(春天|春季|夏天|夏季|秋天|秋季|冬天|冬季))?/u);
  if (match) {
    const year = /^\d/u.test(match[1]) ? Number(match[1].slice(0, -1))
      : Number(today.slice(0, 4)) + ({ 前年: -2, 去年: -1, 今年: 0, 明年: 1 }[match[1]]);
    if (match[2]) {
      const range = monthRange(year, integer(match[2]));
      return range ? result(text, match, range) : unmatched(text);
    }
    if (match[3]) {
      const startMonth = { 春: 3, 夏: 6, 秋: 9, 冬: 12 }[match[3][0]];
      return result(text, match, window(monthRange(year, startMonth).startDate,
        monthRange(year + (startMonth === 12 ? 1 : 0), (startMonth + 1) % 12 + 1).endDate));
    }
    return result(text, match, yearRange(year));
  }
  match = text.match(/(上上|上个|上|这个|这|本|下个|下)(周|星期|礼拜|个月|月)/u);
  if (match) {
    const offset = match[1].startsWith('上上') ? -2 : match[1].startsWith('上') ? -1 : match[1].startsWith('下') ? 1 : 0;
    if (match[2].includes('月')) {
      const shifted = shiftMonths(today, offset);
      return result(text, match, monthRange(shifted.slice(0, 4), shifted.slice(5, 7)));
    }
    const start = addCalendarDays(monday(today), offset * 7);
    return result(text, match, window(start, addCalendarDays(start, 6)));
  }
  match = text.match(/春天|春季|夏天|夏季|秋天|秋季|冬天|冬季/u);
  if (match) {
    const startMonth = { 春: 3, 夏: 6, 秋: 9, 冬: 12 }[match[0][0]];
    const start = recallDate(today, startMonth, 1);
    const year = Number(start.slice(0, 4));
    return result(text, match, window(start,
      monthRange(year + (startMonth === 12 ? 1 : 0), (startMonth + 1) % 12 + 1).endDate));
  }
  match = text.match(/半(?:个)?(月|年)前/u);
  if (match) return relativeAmount(text, match, today, match[1] === '月' ? '15' : '6', match[1] === '月' ? 'day' : 'month');
  match = text.match(/(?<![零〇一二两三四五六七八九十百\d])(\d+|[二三四五六七八九]?十几|几|[一二两三四五六七八九十]+)(?:个)?(天|周|星期|礼拜|月|年)前/u);
  if (match) return relativeAmount(text, match, today, match[1], { 天: 'day', 周: 'week', 星期: 'week', 礼拜: 'week', 月: 'month', 年: 'year' }[match[2]]);
  match = text.match(/前些天|前段时间|前阵子/u);
  if (match) {
    if (match[0] === '前些天') return relativeAmount(text, match, today, '几', 'day');
    return result(text, match, window(addCalendarDays(today, -42), addCalendarDays(today, -7)), {
      precision: 'vague', toleranceWindow: window(addCalendarDays(today, -90), addCalendarDays(today, -1)),
    });
  }
  match = text.match(/前几(天|周|个月|年)/u);
  if (match) return relativeAmount(text, match, today, '几', { 天: 'day', 周: 'week', 个月: 'month', 年: 'year' }[match[1]]);
  match = text.match(/这几天|这两天|最近|近来/u);
  if (match) {
    const recent = ['最近', '近来'].includes(match[0]);
    return result(text, match, window(addCalendarDays(today, recent ? -14 : -3), today), {
      precision: 'vague', toleranceWindow: window(addCalendarDays(today, recent ? -30 : -5), today),
      ordering: recent ? 'recent' : 'relevance',
    });
  }
  match = text.match(/\b(\d+)\s+(days?|weeks?|months?|years?)\s+ago\b/iu);
  if (match) return relativeAmount(text, match, today, match[1], match[2].toLowerCase().replace(/s$/u, ''));
  match = text.match(/\b(last|previous|this|current|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu);
  if (match) {
    const offset = ['last', 'previous'].includes(match[1].toLowerCase()) ? -1 : match[1].toLowerCase() === 'next' ? 1 : 0;
    return result(text, match, window(addCalendarDays(monday(today), offset * 7 + WEEKDAYS[match[2].toLowerCase()])));
  }
  match = text.match(/\b(last|previous|this|current|next)\s+(weekend|week|month|year)\b/iu);
  if (match) {
    const offset = ['last', 'previous'].includes(match[1].toLowerCase()) ? -1 : match[1].toLowerCase() === 'next' ? 1 : 0;
    const unit = match[2].toLowerCase();
    if (unit === 'week' || unit === 'weekend') {
      const start = addCalendarDays(monday(today), offset * 7 + (unit === 'weekend' ? 5 : 0));
      return result(text, match, window(start, addCalendarDays(start, unit === 'weekend' ? 1 : 6)));
    }
    const shifted = shiftMonths(today, offset);
    return result(text, match, unit === 'month' ? monthRange(shifted.slice(0, 4), shifted.slice(5, 7))
      : yearRange(Number(today.slice(0, 4)) + offset));
  }
  match = text.match(new RegExp(`\\b(?:in|during)\\s+(${months})(?:\\s+and\\s+(${months}))?(?:\\s+(\\d{4}))?\\b`, 'iu'));
  if (match) {
    const first = MONTHS[match[1].toLowerCase()];
    const last = match[2] ? MONTHS[match[2].toLowerCase()] : first;
    const date = recallDate(today, first, 1, match[3] ? Number(match[3]) : contextYear(text, match, today));
    const year = Number(date.slice(0, 4));
    return result(text, match, window(monthRange(year, first).startDate, monthRange(year + (last < first ? 1 : 0), last).endDate));
  }
  for (const [label, offset] of [['大前天', -3], ['前天', -2], ['昨天', -1], ['今天', 0], ['明天', 1], ['后天', 2],
    ['day before yesterday', -2], ['day after tomorrow', 2], ['yesterday', -1], ['today', 0], ['tomorrow', 1]]) {
    const en = /^[a-z]/iu.test(label);
    match = text.match(new RegExp(en ? `\\b${label}\\b` : label, en ? 'iu' : 'u'));
    if (!match || (en && /\b(?:after|before|by|since|until)\s*$/iu.test(text.slice(0, match.index)))) continue;
    return result(text, match, window(addCalendarDays(today, offset)));
  }
  match = text.match(/上一次|上次|\blast time\b/iu);
  if (match) return result(text, match, null, { precision: 'vague', kind: 'latest', ordering: 'latest' });
  match = text.match(/很久以前|很久之前|以前|之前|\ba long time ago\b/iu);
  if (match && !/(?:在这|在那|这件事|那件事)\s*$/u.test(text.slice(0, match.index))) {
    return result(text, match, null, { precision: 'vague', kind: 'unbounded' });
  }
  return unmatched(text);
}
