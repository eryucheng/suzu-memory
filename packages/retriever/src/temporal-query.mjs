import { DEFAULT_MEMORY_TIME_ZONE, dateKeyInTimeZone } from '@suzu-memory/core';
import { maskQuotedText, maskRejectedRequests, queryConnectorLength } from './query-text.mjs';

const TEMPORAL_SPAN = Symbol('temporal-span');
const DATE_EXCLUSION = /(?:不是|并非|除了|除去|排除|不在|而非|\b(?:not|except(?:\s+for)?|excluding|other than|rather than|instead of|with the exception of)\b(?:\s+(?:on|in|during))?(?:\s+the)?)\s*/iu;
const DATE_EXCLUSION_PREFIX = new RegExp(`(?:${DATE_EXCLUSION.source})$`, DATE_EXCLUSION.flags);

function validDate(year, month, day) {
  if (!Number.isInteger(Number(year)) || Number(year) < 1 || Number(year) > 9999) return null;
  const date = new Date(Date.UTC(2000, Number(month) - 1, Number(day)));
  date.setUTCFullYear(Number(year));
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
  const end = new Date(`${startDate}T12:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return { startDate, endDate: end.toISOString().slice(0, 10) };
}

function shiftMonths(day, amount) {
  if (!Number.isInteger(amount)) {
    const whole = Math.trunc(amount), direction = Math.sign(amount);
    const near = shiftMonths(day, whole), far = shiftMonths(day, whole + direction);
    const days = Math.abs(Date.parse(`${far}T12:00:00Z`) - Date.parse(`${near}T12:00:00Z`)) / 86400000;
    return addCalendarDays(near, direction * Math.round(days * Math.abs(amount - whole)));
  }
  const date = new Date(`${day}T12:00:00Z`);
  const dayOfMonth = date.getUTCDate();
  date.setUTCMonth(date.getUTCMonth() + amount, 1);
  const range = monthRange(date.getUTCFullYear(), date.getUTCMonth() + 1);
  return `${range.startDate.slice(0, 8)}${String(Math.min(dayOfMonth, Number(range.endDate.slice(8)))).padStart(2, '0')}`;
}

function yearRange(year) { return { startDate: validDate(year, 1, 1), endDate: validDate(year, 12, 31) }; }
function window(startDate, endDate) { return { startDate, endDate: arguments.length === 1 ? startDate : endDate }; }

function validWindow(value) {
  return value && [value.startDate, value.endDate].every(day => typeof day === 'string'
    && /^\d{4}-\d{2}-\d{2}$/u.test(day) && validDate(...day.split('-')) === day)
    && value.startDate <= value.endDate;
}

function seasonRange(year, startMonth) {
  return window(monthRange(year, startMonth)?.startDate,
    monthRange(year + (startMonth === 12 ? 1 : 0), (startMonth + 1) % 12 + 1)?.endDate);
}

function result(text, match, coreWindow, {
  precision = 'exact', toleranceWindow = coreWindow, kind = null, ordering = 'relevance',
} = {}) {
  if (coreWindow ? !validWindow(coreWindow) || !validWindow(toleranceWindow)
    : !['latest', 'unbounded'].includes(kind)) return unmatched(text);
  if (partialTemporalSpan(text, match)) return unmatched(text);
  const span = { start: match.index, end: match.index + match[0].length };
  const exclusion = text.slice(0, match.index).match(DATE_EXCLUSION_PREFIX);
  if (exclusion) {
    return { ...unmatched(text), [TEMPORAL_SPAN]: { start: exclusion.index, end: span.end, excluded: true } };
  }
  return {
    [TEMPORAL_SPAN]: span,
    matched: true, precision,
    kind: kind || (coreWindow?.startDate === coreWindow?.endDate ? 'day' : 'range'),
    expression: match[0],
    startDate: coreWindow?.startDate ?? null, endDate: coreWindow?.endDate ?? null,
    coreWindow, toleranceWindow, ordering,
  };
}

function unmatched(text) {
  return { matched: false, precision: null, kind: null, expression: '', startDate: null,
    endDate: null, coreWindow: null, toleranceWindow: null, ordering: 'relevance', remainingQuery: text };
}

const MONTHS = Object.freeze({ january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 });
const WEEKDAYS = Object.freeze({ monday: 0, tuesday: 1, wednesday: 2, thursday: 3,
  friday: 4, saturday: 5, sunday: 6 });
const MONTH_PATTERN = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const ENGLISH_YEAR_SUFFIX = /^\s+(?:(?:of|in)\s+)?(\d{4}|(?:last|previous|this|current|next)\s+year)\b/iu;
const ENGLISH_MONTH_POSITION = new RegExp(`\\b(?:the\\s+)?(first|second|third|fourth|fifth|last)\\s+(day|week|${Object.keys(WEEKDAYS).join('|')})\\s+(?:of|in)\\s+(?:(last|previous|this|current|next)\\s+)?(${MONTH_PATTERN})\\.?(?:,?\\s+(?:of\\s+)?(\\d{4}))?\\b`, 'iu');
const CHINESE_MONTH_POSITION = /(?:(前年|去年|今年|明年|\d{4}年)\s*)?(?:([一二三四五六七八九十\d]{1,3})月|(上上个月|上个月|这个月|本月|下个月))(?:的)?(最后(?:一个|一|个)?|第([一二三四五六七八九十\d]+)(?:个)?)(?:(周|星期|礼拜)([一二三四五六日天])?|(天|日))/u;

const DAY_ENDPOINT = [
  '\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}',
  '(?:(?:前年|去年|今年|明年|\\d{4}年)\\s*)?\\d{1,2}月\\d{1,2}[日号]',
  `(?:${Object.keys(MONTHS).join('|')})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+(?:(?:of|in)\\s+)?(?:\\d{4}|(?:last|previous|this|current|next)\\s+year))?`,
  `\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${Object.keys(MONTHS).join('|')})\\.?(?:,?\\s+(?:(?:of|in)\\s+)?(?:\\d{4}|(?:last|previous|this|current|next)\\s+year))?`,
].join('|');
const BOUNDED_DAY_RANGE = new RegExp(`(?:(from|between)\\s+|从\\s*)?(${DAY_ENDPOINT})\\s*(to|through|until|and|到|至|[–—-])\\s*(${DAY_ENDPOINT})(?!\\d)`, 'iu');
const QUALIFIED_ENDPOINT_YEAR = /\d{4}|\b(?:last|previous|this|current|next)\s+year\b|前年|去年|今年|明年/iu;

function boundedDayRange(text, now, timeZone) {
  const match = text.match(BOUNDED_DAY_RANGE);
  if (!match || match[3].toLowerCase() === 'and' && match[1]?.toLowerCase() !== 'between') return null;
  // Endpoint substrings contain one calendar date and no range connector, so
  // reuse the authoritative resolver without introducing another date parser.
  const left = resolveTemporalQuery(match[2], now, timeZone), right = resolveTemporalQuery(match[4], now, timeZone);
  if (![left, right].every(part => part.matched && part.precision === 'exact' && part.kind === 'day')) return unmatched(text);
  let start = left.startDate, end = right.endDate;
  const leftYear = QUALIFIED_ENDPOINT_YEAR.test(match[2]), rightYear = QUALIFIED_ENDPOINT_YEAR.test(match[4]);
  const crossesYear = end.slice(5) < start.slice(5);
  if (!leftYear && rightYear) start = validDate(Number(end.slice(0, 4)) - Number(crossesYear), ...start.slice(5).split('-'));
  else if (leftYear && !rightYear) end = validDate(Number(start.slice(0, 4)) + Number(crossesYear), ...end.slice(5).split('-'));
  else if (!leftYear && !rightYear && end < start) end = validDate(Number(start.slice(0, 4)) + 1, ...end.slice(5).split('-'));
  return result(text, match, window(start, end));
}

const TEMPORAL_ENDPOINT = `(?:${Object.keys(MONTHS).join('|')}|${Object.keys(WEEKDAYS).join('|')}|(?:last|next|this|previous|current)\\s+(?:week|month|year)|yesterday|today|tomorrow|\\d{4}[-/.]|\\d{1,2}(?:st|nd|rd|th)?\\b|\\d{1,2}月)`;
const CONNECTED_TEMPORAL_ENDPOINT = new RegExp(`^\\s*(?:to|through|until|or|and|[,–—-]|到|至|或|和)\\s*(?=${TEMPORAL_ENDPOINT})`, 'iu');

function partialTemporalSpan(text, match) {
  const prefix = text.slice(0, match.index), suffix = text.slice(match.index + match[0].length);
  // Unsupported ranges, alternatives and open boundaries must not silently
  // turn into a positive constraint on their first endpoint. Ordinary topic
  // retrieval remains available when no complete window can be represented.
  if (/\b(?:between|since|until|by)\s*$/iu.test(prefix)
    || /\bfrom\s*$/iu.test(prefix) && !/\bago$/iu.test(match[0])
    || /\b(?:before|after)\s*$/iu.test(prefix) && !/\bbefore\s+and\s+after\s*$/iu.test(prefix)
    || /(?:从|自|早于|晚于|截至|截止到?)\s*$/u.test(prefix)) return true;
  if (CONNECTED_TEMPORAL_ENDPOINT.test(suffix)) return true;
  return /^\s*(?:之前|以前|之后|以后|以来|为止|起)/u.test(suffix)
    || /^\s*(?:前|后)(?!后|前)/u.test(suffix);
}

function integer(value) {
  if (/^\d+(?:,\d{3})*(?:\.\d+)?$/u.test(value)) return Number(value.replaceAll(',', ''));
  const words = String(value).toLowerCase().replace(/-/gu, ' ').split(/\s+/u).filter(word => word !== 'and');
  const english = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
    fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  if (words.length === 2 && ['a', 'one'].includes(words[0]) && words[1] === 'thousand') return 1000;
  if (words.every(word => Object.hasOwn(english, word) || word === 'hundred')) {
    return words.reduce((sum, word) => word === 'hundred' ? Math.max(1, sum) * 100 : sum + english[word], 0);
  }
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  const match = value.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u);
  return match ? (digits[match[1]] || 1) * 10 + (digits[match[2]] || 0) : digits[value] ?? NaN;
}

const ENGLISH_UNIT_NUMBER = '(?:one|two|three|four|five|six|seven|eight|nine)';
const ENGLISH_UNDER_HUNDRED = `(?:${ENGLISH_UNIT_NUMBER}|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -]${ENGLISH_UNIT_NUMBER})?)`;
const ENGLISH_AMOUNT = `(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?|a couple(?: of)?|a few|few|several|a|an|(?:${ENGLISH_UNIT_NUMBER}|a) hundred(?: (?:and )?${ENGLISH_UNDER_HUNDRED})?|(?:one|a) thousand|${ENGLISH_UNDER_HUNDRED})(?:\\s+and\\s+(?:a\\s+)?half)?`;

function englishAmount(value) {
  const text = value.toLowerCase();
  if (/^(?:a few|few|several)$/u.test(text)) return '几';
  if (/^a couple(?: of)?$/u.test(text)) return '2';
  const half = /\s+and\s+(?:a\s+)?half$/u.test(text);
  const whole = text.replace(/\s+and\s+(?:a\s+)?half$/u, '');
  return String(integer(whole) + (half ? 0.5 : 0));
}

function partialEnglishAmount(text, match) {
  // Do not reinterpret the tail of an unsupported or larger quantity as an
  // independent duration ("one thousand and five" must not become five).
  return /[\d.,\-]$/u.test(text.slice(0, match.index))
    || new RegExp(`\\b(?:${ENGLISH_UNDER_HUNDRED}|hundred|thousand|million|billion)(?:\\s+and)?\\s+$`, 'iu')
      .test(text.slice(0, match.index));
}

function contextYear(text, match, today) {
  const prefix = text.slice(0, match.index);
  const suffix = text.slice(match.index + match[0].length);
  const explicit = prefix.match(/(\d{4})年\s*$/u);
  if (explicit) return Number(explicit[1]);
  const englishYear = prefix.match(/\b(\d{4})(?:\s+(?:on|in|during))?\s*$/u);
  if (englishYear) return Number(englishYear[1]);
  const suffixYear = suffix.match(ENGLISH_YEAR_SUFFIX)?.[1];
  if (/^\d{4}$/u.test(suffixYear || '')) return Number(suffixYear);
  const cn = prefix.match(/(前年|去年|今年|明年)\s*$/u);
  const en = prefix.match(/\b(last|previous|this|current|next)\s+year\s+(?:(?:on|in|during)\s+)?$/iu);
  const label = cn?.[1] || en?.[1]?.toLowerCase() || suffixYear?.toLowerCase().split(/\s/u)[0];
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
  const prefix = text.slice(0, match.index).match(/(?:前年|去年|今年|明年)\s*$|\b(?:\d{4}|(?:last|previous|this|current|next)\s+year)(?:\s+(?:on|in|during))?\s*$/iu);
  const suffix = text.slice(match.index + match[0].length).match(ENGLISH_YEAR_SUFFIX);
  return Object.assign([`${prefix?.[0] || ''}${match[0]}${suffix?.[0] || ''}`], { index: match.index - (prefix?.[0].length || 0) });
}

function positionedCalendarDay(text, today) {
  const english = text.match(ENGLISH_MONTH_POSITION);
  const match = english || text.match(CHINESE_MONTH_POSITION);
  if (!match) return null;
  if (english && /\b(?:second|third|fourth|fifth)(?:[ -]+to)?[ -]+$/iu.test(text.slice(0, match.index))) return unmatched(text);
  let month, year = null, position, weekday = null, unit;
  if (english) {
    month = MONTHS[match[4].toLowerCase()];
    position = match[1].toLowerCase() === 'last' ? 'last'
      : ['first', 'second', 'third', 'fourth', 'fifth'].indexOf(match[1].toLowerCase()) + 1;
    unit = match[2].toLowerCase();
    weekday = WEEKDAYS[unit] ?? null;
    year = match[5] ? Number(match[5]) : contextYear(text, match, today);
    if (year === null && match[3]) {
      year = Number(today.slice(0, 4));
      const range = monthRange(year, month), label = match[3].toLowerCase();
      if (['last', 'previous'].includes(label) && range.endDate >= today) year--;
      if (label === 'next' && range.startDate <= today) year++;
    }
  } else {
    position = match[4].startsWith('最后') ? 'last' : integer(match[5]);
    unit = match[8] ? 'day' : match[7] ? 'weekday' : 'week';
    weekday = match[7] ? { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }[match[7]] : null;
    if (match[3]) {
      if (match[1]) return unmatched(text);
      const shifted = shiftMonths(today, match[3].startsWith('上上') ? -2 : match[3].startsWith('上') ? -1 : match[3].startsWith('下') ? 1 : 0);
      year = Number(shifted.slice(0, 4));
      month = Number(shifted.slice(5, 7));
    } else {
      month = integer(match[2]);
      if (match[1]) year = /^\d/u.test(match[1]) ? Number(match[1].slice(0, -1))
        : Number(today.slice(0, 4)) + ({ 前年: -2, 去年: -1, 今年: 0, 明年: 1 }[match[1]]);
    }
  }
  // A week within a month has ambiguous boundaries. Do not reinterpret it as
  // "last week" relative to today or silently broaden it to the entire month.
  if (unit === 'week') return unmatched(text);
  const currentYear = Number(today.slice(0, 4));
  for (let offset = 0; offset <= (year === null ? 8 : 0); offset++) {
    const selectedYear = year ?? currentYear - offset;
    const range = monthRange(selectedYear, month);
    if (!range) return unmatched(text);
    const lastDay = Number(range.endDate.slice(8));
    let day = position === 'last' ? lastDay : position;
    if (weekday !== null) {
      const boundary = position === 'last' ? range.endDate : range.startDate;
      const dayOfWeek = (new Date(`${boundary}T12:00:00Z`).getUTCDay() + 6) % 7;
      day = position === 'last' ? lastDay - (dayOfWeek - weekday + 7) % 7
        : 1 + (weekday - dayOfWeek + 7) % 7 + (position - 1) * 7;
    }
    const date = day >= 1 && day <= lastDay ? validDate(selectedYear, month, day) : null;
    if (date && (year !== null || date <= today)) return result(text, includeYearQualifier(text, match), window(date));
  }
  return unmatched(text);
}

function relativeAmount(text, match, today, value, unit) {
  const isFew = value.includes('几');
  const decade = value.endsWith('十几') ? integer(value.slice(0, -1)) : null;
  const bounds = isFew ? decade !== null ? [decade + 1, decade + 9, decade, decade + 12] : [2, 6, 1, 9] : null;
  const amount = integer(value);
  if (!bounds && (!Number.isFinite(amount) || amount <= 0 || amount > 1000)) return unmatched(text);
  if (!bounds && !Number.isInteger(amount)) {
    if (unit === 'year') return relativeAmount(text, match, today, String(amount * 12), 'month');
    if (unit === 'week') return relativeAmount(text, match, today, String(amount * 7), 'day');
    if (unit === 'month') {
      const whole = Math.floor(amount);
      const near = shiftMonths(today, -whole), far = shiftMonths(today, -whole - 1);
      const elapsed = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${near}T12:00:00Z`)) / 86400000
        + (Date.parse(`${near}T12:00:00Z`) - Date.parse(`${far}T12:00:00Z`)) / 86400000 * (amount - whole);
      return relativeAmount(text, match, today, String(Math.round(elapsed)), 'day');
    }
  }
  const shift = (n) => unit === 'month' ? shiftMonths(today, -n)
    : unit === 'year' ? shiftMonths(today, -12 * n) : addCalendarDays(today, -Math.round(n * (unit === 'week' ? 7 : 1)));
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
  let grammar = maskQuotedText(maskRejectedRequests(text));
  const scanExclusions = DATE_EXCLUSION.test(grammar);
  const excluded = [];
  let selected = null;
  for (;;) {
    const parsed = resolveTemporalText(grammar, now, timeZone);
    const span = parsed[TEMPORAL_SPAN];
    if (!span) break;
    if (span.excluded) {
      span.end += queryConnectorLength(text.slice(span.end));
      excluded.push(span);
    } else if (!selected) selected = parsed;
    // Ordinary single-window queries retain the existing one-pass path.
    // Corrections also inspect trailing exclusions after the selected date.
    if (!scanExclusions) break;
    grammar = `${grammar.slice(0, span.start)}${' '.repeat(span.end - span.start)}${grammar.slice(span.end)}`;
  }
  if (!selected) return unmatched(text);
  const { [TEMPORAL_SPAN]: span, ...resolved } = selected;
  let remainingQuery = text;
  for (const removed of [span, ...excluded]) {
    remainingQuery = `${remainingQuery.slice(0, removed.start)}${' '.repeat(removed.end - removed.start)}${remainingQuery.slice(removed.end)}`;
  }
  return {
    ...resolved,
    expression: text.slice(span.start, span.end),
    remainingQuery: remainingQuery.replace(/\s+/gu, ' ').trim(),
  };
}

function resolveTemporalText(text, now, timeZone) {
  const today = dateKeyInTimeZone(now, timeZone);
  if (!today) throw new Error('now 不是有效时间。');
  const dayRange = boundedDayRange(text, now, timeZone);
  if (dayRange) return dayRange;
  const positionedDay = positionedCalendarDay(text, today);
  if (positionedDay) return positionedDay;
  let match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})[日号]?/u)
    || text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/u);
  if (match) {
    const date = validDate(match[1], match[2], match[3]);
    return date ? result(text, includeYearQualifier(text, match), window(date)) : unmatched(text);
  }
  const seasonMonths = { spring: 3, summer: 6, autumn: 9, fall: 9, winter: 12 };
  match = [...text.matchAll(/\b(?:(last|previous|this|current|next)\s+|(?:in|during)\s+(?:the\s+)?)?(spring|summer|autumn|fall|winter)(?:\s+(?:of\s+)?(\d{4})|\s+(last|previous|this|current|next)\s+year)?\b/giu)]
    .find(value => value[1] || value[3] || value[4] || /^(?:in|during)\b/iu.test(value[0]));
  if (match) {
    const label = match[1]?.toLowerCase();
    const startMonth = seasonMonths[match[2].toLowerCase()];
    let year = match[3] ? Number(match[3]) : contextYear(text, match, today);
    const currentYear = Number(today.slice(0, 4));
    const range = y => seasonRange(y, startMonth);
    if (year === null) {
      year = currentYear;
      if (['last', 'previous'].includes(label)) {
        if (range(year).endDate >= today) year--;
      } else if (label === 'next') {
        if (range(year).startDate <= today) year++;
      } else if (!label && range(year).startDate > today) year--;
    }
    if (match[4]) year = currentYear + (['last', 'previous'].includes(match[4].toLowerCase()) ? -1
      : match[4].toLowerCase() === 'next' ? 1 : 0);
    return result(text, includeYearQualifier(text, match), range(year));
  }
  match = text.match(/\b(?:the\s+)?(first|second)\s+half\s+of\s+(?:(last|previous|this|current|next)\s+year|(\d{4}))\b/iu)
    || text.match(/\b(?:the\s+)?end\s+of\s+(?:(last|previous|this|current|next)\s+year|(\d{4}))\b/iu);
  if (match) {
    const half = ['first', 'second'].includes(match[1]?.toLowerCase());
    const label = match[half ? 2 : 1]?.toLowerCase();
    const explicitYear = match[half ? 3 : 2];
    const year = explicitYear ? Number(explicitYear) : Number(today.slice(0, 4))
      + (['last', 'previous'].includes(label) ? -1 : label === 'next' ? 1 : 0);
    const startMonth = half ? match[1].toLowerCase() === 'first' ? 1 : 7 : 11;
    const core = window(monthRange(year, startMonth)?.startDate, monthRange(year, half ? startMonth + 5 : 12)?.endDate);
    return result(text, match, core, half ? {} : { precision: 'vague',
      toleranceWindow: window(monthRange(year, 10)?.startDate, core.endDate) });
  }
  match = text.match(/(\d{1,2})月(\d{1,2})[日号]/u);
  if (match) {
    const date = recallDate(today, match[1], match[2], contextYear(text, match, today));
    return date ? result(text, includeYearQualifier(text, match), window(date)) : unmatched(text);
  }
  const months = MONTH_PATTERN;
  match = text.match(new RegExp(`\\b(${months})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(?:(?:of|in)\\s+)?(\\d{4}))?\\b`, 'iu'))
    || text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${months})\\.?(?:,?\\s+(?:(?:of|in)\\s+)?(\\d{4}))?\\b`, 'iu'));
  if (match) {
    const monthFirst = MONTHS[match[1].toLowerCase()];
    const date = recallDate(today, monthFirst || MONTHS[match[2].toLowerCase()], monthFirst ? match[2] : match[1],
      match[3] ? Number(match[3]) : contextYear(text, match, today));
    return date ? result(text, includeYearQualifier(text, match), window(date)) : unmatched(text);
  }
  match = text.match(new RegExp(`\\b(?:(?:in|during|from|between)\\s+)?(${months})\\.?(?:\\s+(?:of\\s+)?(\\d{4}))?\\s+(?:and|to|through|-)\\s+(${months})\\.?(?:\\s+(?:of\\s+)?(\\d{4}))?\\b`, 'iu'));
  if (match) {
    const first = MONTHS[match[1].toLowerCase()], last = MONTHS[match[3].toLowerCase()];
    const qualifiedYear = contextYear(text, match, today);
    const firstYear = match[2] ? Number(match[2]) : match[4] ? Number(match[4]) - (last < first ? 1 : 0)
      : qualifiedYear ?? Number(recallDate(today, first, 1).slice(0, 4));
    const lastYear = match[4] ? Number(match[4]) : firstYear + (last < first ? 1 : 0);
    const firstRange = monthRange(firstYear, first), lastRange = monthRange(lastYear, last);
    if (!firstRange || !lastRange || lastRange.endDate < firstRange.startDate) return unmatched(text);
    return result(text, includeYearQualifier(text, match), window(firstRange.startDate, lastRange.endDate));
  }
  match = text.match(new RegExp(`\\b(?:(?:in|during)\\s+)?(${months})\\.?\\s+(?:of\\s+)?(\\d{4})\\b`, 'iu'));
  if (match) {
    const range = monthRange(Number(match[2]), MONTHS[match[1].toLowerCase()]);
    return range ? result(text, includeYearQualifier(text, match), range) : unmatched(text);
  }
  match = text.match(new RegExp(`\\b(last|previous|this|current|next)\\s+(${months})\\.?\\b`, 'iu'));
  if (match) {
    const label = match[1].toLowerCase(), month = MONTHS[match[2].toLowerCase()];
    let year = Number(today.slice(0, 4));
    const current = monthRange(year, month);
    if (['last', 'previous'].includes(label) && current.endDate >= today) year--;
    if (label === 'next' && current.startDate <= today) year++;
    return result(text, match, monthRange(year, month));
  }
  match = text.match(new RegExp(`\\b(?:in|during)\\s+(${months})\\.?\\b`, 'iu'));
  if (match) {
    const date = recallDate(today, MONTHS[match[1].toLowerCase()], 1, contextYear(text, match, today));
    return result(text, includeYearQualifier(text, match), monthRange(date.slice(0, 4), date.slice(5, 7)));
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
    const core = window(monthRange(year, startMonth)?.startDate, monthRange(year, endOfYear ? 12 : startMonth + 5)?.endDate);
    return result(text, match, core, endOfYear ? { precision: 'vague',
      toleranceWindow: window(monthRange(year, 10)?.startDate, core.endDate) } : {});
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
      return result(text, match, seasonRange(year, startMonth));
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
      monthRange(year + (startMonth === 12 ? 1 : 0), (startMonth + 1) % 12 + 1)?.endDate));
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
  match = text.match(/\b(?:half (?:a|an) (month|year)|a fortnight) ago\b/iu);
  if (match) return relativeAmount(text, match, today, match[1]?.toLowerCase() === 'year' ? '6'
    : match[1] ? '15' : '2', match[1]?.toLowerCase() === 'year' ? 'month' : match[1] ? 'day' : 'week');
  match = text.match(new RegExp(`\\b(${ENGLISH_AMOUNT})\\s+(days?|weeks?|months?|years?)(\\s+and\\s+(?:a\\s+)?half)?\\s+ago\\b`, 'iu'));
  if (match) {
    if (partialEnglishAmount(text, match)) return unmatched(text);
    const value = englishAmount(match[1]);
    if (match[3] && (value === '几' || /half$/iu.test(match[1]))) return unmatched(text);
    return relativeAmount(text, match, today, match[3] ? String(Number(value) + 0.5) : value,
      match[2].toLowerCase().replace(/s$/u, ''));
  }
  match = text.match(new RegExp(`\\b(?:(?:in|over|during)\\s+)?(?:the\\s+)?(?:last|past)\\s+(${ENGLISH_AMOUNT})\\s+(days?|weeks?|months?|years?)\\b`, 'iu'));
  if (match) {
    const value = match[1].toLowerCase();
    const unit = match[2].toLowerCase().replace(/s$/u, '');
    const parsedAmount = englishAmount(value);
    const count = parsedAmount === '几' ? 3 : Number(parsedAmount);
    if (!Number.isFinite(count) || count <= 0 || count > 1000) return unmatched(text);
    const shift = n => unit === 'month' || unit === 'year' ? shiftMonths(today, -n * (unit === 'year' ? 12 : 1))
      : addCalendarDays(today, -n * (unit === 'week' ? 7 : 1));
    return result(text, match, window(shift(count), today), { precision: 'vague', ordering: 'recent',
      toleranceWindow: window(shift(count * 2), today) });
  }
  match = text.match(/\b(?:these days|(?:in |over )?the (?:last|past) (?:few|couple of) days|recently|lately|a while ago|some time ago)\b/iu);
  if (match) {
    const earlier = /ago$/iu.test(match[0]);
    const recent = /^(?:recently|lately)$/iu.test(match[0]);
    return result(text, match, window(addCalendarDays(today, earlier ? -42 : recent ? -14 : -3),
      earlier ? addCalendarDays(today, -7) : today), { precision: 'vague', ordering: recent ? 'recent' : 'relevance',
      toleranceWindow: window(addCalendarDays(today, earlier ? -90 : recent ? -30 : -5), earlier ? addCalendarDays(today, -1) : today) });
  }
  match = text.match(/\b(last|previous|this|current|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu);
  if (match) {
    const label = match[1].toLowerCase();
    const weekday = addCalendarDays(monday(today), WEEKDAYS[match[2].toLowerCase()]);
    // English "last Monday" is the preceding occurrence, not necessarily
    // Monday in the previous calendar week. "This Monday" names this week.
    const day = ['last', 'previous'].includes(label) ? weekday < today ? weekday : addCalendarDays(weekday, -7)
      : label === 'next' ? weekday > today ? weekday : addCalendarDays(weekday, 7) : weekday;
    return result(text, match, window(day));
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
  match = text.match(/\b(?:in|during)\s+(\d{4})\b/iu);
  if (match) return result(text, match, yearRange(Number(match[1])));
  for (const [label, offset] of [['大前天', -3], ['前天', -2], ['昨天', -1], ['今天', 0], ['明天', 1], ['后天', 2],
    ['day before yesterday', -2], ['day after tomorrow', 2], ['yesterday', -1], ['today', 0], ['tomorrow', 1]]) {
    const en = /^[a-z]/iu.test(label);
    match = text.match(new RegExp(en ? `\\b${label}\\b` : label, en ? 'iu' : 'u'));
    if (!match || (en && /\b(?:after|before|by|since|until)\s*$/iu.test(text.slice(0, match.index)))) continue;
    return result(text, match, window(addCalendarDays(today, offset)));
  }
  match = text.match(/上一次|上次|\blast time\b/iu);
  if (match) return result(text, match, null, { precision: 'vague', kind: 'latest', ordering: 'latest' });
  match = text.match(/很久以前|很久之前|以前|之前|\b(?:a long time ago|in the past|back then|previously|formerly)\b/iu);
  if (match && !/(?:在这|在那|这件事|那件事)\s*$/u.test(text.slice(0, match.index))) {
    return result(text, match, null, { precision: 'vague', kind: 'unbounded' });
  }
  return unmatched(text);
}
