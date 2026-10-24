import { dateKeyInTimeZone, isStatefulMemoryKind } from '@suzu-memory/core';

const DAY_MS = 86_400_000;
const dayNumber = day => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
const clean = value => String(value ?? '').trim();
const isState = node => isStatefulMemoryKind(node.kind)
  || !['', 'not_applicable', 'unspecified'].includes(clean(node.state_family));

function calendarDate(value, timeZone) {
  const text = clean(value);
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? text : dateKeyInTimeZone(text, timeZone);
}

export function memoryCalendarDate(node, timeZone) {
  if (node.metadata?.sourceTimeKnown === false) return '';
  if (node.kind === 'utterance') return calendarDate(node.event_start || node.recorded_at, timeZone);
  if (isState(node)) return calendarDate(node.known_at || node.valid_from, timeZone);
  const eventDate = calendarDate(node.event_date || node.event_start, timeZone);
  return eventDate || (['event', 'episode'].includes(node.kind) ? '' : calendarDate(node.known_at || node.recorded_at, timeZone));
}

export function temporalAffinity(date, temporal) {
  const core = temporal?.coreWindow;
  const tolerance = temporal?.toleranceWindow;
  if (!date || !core || !tolerance) return 0;
  const day = dayNumber(date);
  const start = dayNumber(core.startDate), end = dayNumber(core.endDate);
  const lower = dayNumber(tolerance.startDate), upper = dayNumber(tolerance.endDate);
  if (!Number.isFinite(day) || day < lower || day > upper) return 0;
  if (day < start) return (day - lower) / Math.max(1, start - lower) * (temporal.ordering === 'recent' ? 0.5 : 1);
  if (day > end) return (upper - day) / Math.max(1, upper - end);
  return temporal.ordering === 'recent' ? 0.5 + 0.5 * (day - start) / Math.max(1, end - start) : 1;
}

function dateOrder(candidate, timeZone) {
  const date = candidate.temporalRanking?.date ?? memoryCalendarDate(candidate.node, timeZone);
  const node = candidate.node;
  const instant = node.kind === 'utterance' ? node.event_start || node.recorded_at
    : isState(node) ? node.known_at || node.valid_from : node.event_start;
  return [date || '', Number.isFinite(Date.parse(instant)) ? Date.parse(instant) : 0];
}

// A topicless, unbounded past query should cover the history rather than spend
// every available slot on the most recent burst of conversation.
function historicalCoverage(candidates, limit) {
  const remaining = [...candidates].sort((a, b) => Number(b.node.importance || 0) - Number(a.node.importance || 0)
    || a.temporalRanking.date.localeCompare(b.temporalRanking.date) || clean(a.node.id).localeCompare(clean(b.node.id)));
  const selected = [];
  const selectedDays = [];
  while (remaining.length && selected.length < limit) {
    let best = 0, bestDistance = -1;
    if (selectedDays.length) for (let index = 0; index < remaining.length; index++) {
      const day = dayNumber(remaining[index].temporalRanking.date);
      const distance = Math.min(...selectedDays.map(previous => Math.abs(previous - day)));
      if (distance > bestDistance) { best = index; bestDistance = distance; }
    }
    const [candidate] = remaining.splice(best, 1);
    selected.push(candidate);
    selectedDays.push(dayNumber(candidate.temporalRanking.date));
  }
  const ids = new Set(selected.map(candidate => candidate.node.id));
  return [...selected, ...candidates.filter(candidate => !ids.has(candidate.node.id))];
}

export function rankTemporalCandidates(candidates, temporal, { timeZone, temporalWeight = 0.35, topicless = false, today,
  maximumReturnedCandidates = 5, maximumChainMemories = 3 } = {}) {
  if (!temporal?.matched) return candidates;
  const weight = Number.isFinite(Number(temporalWeight)) ? Math.max(0, Number(temporalWeight)) : 0.35;
  const unique = new Map();
  for (const candidate of candidates) {
    if (temporal.ordering === 'latest' && today && memoryCalendarDate(candidate.node, timeZone) > today) continue;
    const existing = unique.get(candidate.node.id);
    if (!existing || Number(candidate.score) > Number(existing.score)) unique.set(candidate.node.id, candidate);
  }
  const ranked = [...unique.values()].map(candidate => {
    const date = memoryCalendarDate(candidate.node, timeZone);
    const timeScore = temporalAffinity(date, temporal);
    const topicScore = candidate.temporalRanking?.topicScore ?? Number(candidate.score);
    const adjustment = temporal.precision === 'exact' ? weight * timeScore : topicScore * weight * timeScore;
    const routeMatches = (candidate.routeMatches || []).filter(route => route.route !== 'temporal');
    if (!topicless && temporal.coreWindow) routeMatches.push({ route: 'temporal', strength: temporal.precision,
      independentlyAdmissible: false, rawScore: timeScore, normalizedScore: timeScore, contribution: adjustment });
    return { ...candidate, score: topicless ? timeScore : temporal.precision === 'exact'
      ? topicScore + adjustment : topicScore * (1 + weight * timeScore), routeMatches,
      routeContributions: { ...candidate.routeContributions, temporal: topicless ? timeScore : adjustment },
      temporalRanking: { date, precision: temporal.precision, topicScore, timeScore, weight,
        withinTolerance: Boolean(date && temporal.toleranceWindow
          && date >= temporal.toleranceWindow.startDate && date <= temporal.toleranceWindow.endDate) } };
  }).sort((a, b) => {
    const [leftDay, leftInstant] = dateOrder(a, timeZone);
    const [rightDay, rightInstant] = dateOrder(b, timeZone);
    const byDate = rightDay.localeCompare(leftDay) || rightInstant - leftInstant;
    return (topicless || temporal.ordering === 'latest' ? byDate : b.score - a.score)
      || Number(b.node.importance || 0) - Number(a.node.importance || 0)
      || byDate || clean(a.node.id).localeCompare(clean(b.node.id));
  });
  return topicless && temporal.kind === 'unbounded'
    ? historicalCoverage(ranked, Math.max(1, Number(maximumReturnedCandidates) || 0, Number(maximumChainMemories) || 0))
    : ranked;
}

export function temporalOverviewCandidates(nodes, temporal, options) {
  const today = options.today;
  let eligible = nodes.filter(node => !['topic', 'reflection'].includes(node.kind)
    && memoryCalendarDate(node, options.timeZone) && memoryCalendarDate(node, options.timeZone) <= today);
  if (temporal.toleranceWindow) eligible = eligible.filter(node => {
    const date = memoryCalendarDate(node, options.timeZone);
    return date >= temporal.toleranceWindow.startDate && date <= temporal.toleranceWindow.endDate;
  });
  return rankTemporalCandidates(eligible.map(node => ({ node, score: 1,
    lexical: { score: 0, overlap: 0, exactPhrase: false, queryTerms: [], matchedTerms: [] },
    entityScore: 0, similarity: null, admission: 'temporal-overview', routeContributions: {},
    routeMatches: [{ route: 'temporal', strength: temporal.precision, independentlyAdmissible: true,
      rawScore: temporalAffinity(memoryCalendarDate(node, options.timeZone), temporal), normalizedScore: 1, contribution: 1 }],
  })), temporal, { ...options, topicless: true });
}
