import { executionEventSourceView } from '@suzu-memory/core';
import { buildCompanionExtractionRequest } from './processing-stages.mjs';
import { logicalArchiveEventId } from './archive-windows.mjs';

export const DEFAULT_LENGTH_ARCHIVE_POLICY = Object.freeze({
  maximumCoreCharacters: 12_000, maximumContextCharacters: 12_000, maximumRequestCharacters: 64_000,
});

const sourceOf = row => row.metadata?.eventSource || {};

// Fragment rows remain one indivisible source message. No source text is lost
// to meet a request budget, and no partial fragment group reaches extraction.
function logicalGroups(rows) {
  const groups = [];
  for (let index = 0; index < rows.length;) {
    const fragment = rows[index].metadata?.suzuMemoryFragment;
    const group = rows.slice(index, index + (fragment?.count || 1));
    if (fragment && (fragment.index !== 1 || group.length !== fragment.count
      || group.some((row, n) => row.metadata?.suzuMemoryFragment?.parentEventId !== fragment.parentEventId
        || row.metadata.suzuMemoryFragment.index !== n + 1))) break;
    groups.push(group);
    index += group.length;
  }
  return groups;
}

async function roundEnds(groups, resolveReply, maximum, reverse = false) {
  const ends = [];
  const seen = new Set();
  for (let step = 0; step < groups.length; step++) {
    const index = reverse ? groups.length - step - 1 : step;
    const row = groups[index].at(-1);
    const reply = await resolveReply(row);
    if (reply?.complete && (sourceOf(row).eventId || logicalArchiveEventId(row)) === reply.lastEventId && !seen.has(reply.id)) {
      seen.add(reply.id);
      ends.push(index + 1);
      if (ends.length >= maximum) break;
    }
  }
  return ends.sort((a, b) => a - b);
}

const characters = rows => rows.reduce((sum, row) => sum + String(row.content?.text || '').length, 0);

async function planLengthChunk({ pending, previous, resolveReply, measure, maximumCoreCharacters,
  maximumRequestCharacters = 64_000, maximumContextCharacters = maximumCoreCharacters, flush = false, scanFull = false }) {
  for (const value of [maximumCoreCharacters, maximumRequestCharacters, maximumContextCharacters]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Archive character limits must be positive integers.');
  }
  const groups = logicalGroups(pending);
  if (!groups.length) return { status: pending.length ? 'blocked' : 'skipped',
    reason: pending.length ? 'incomplete-logical-event' : 'no-pending-events',
    inputEventIds: pending.length ? [pending[0].id] : [], eventsProcessed: 0 };
  const total = characters(groups.flat());
  if (!flush && !scanFull && total < maximumCoreCharacters) return {
    status: 'waiting', reason: 'content-length', characters: total, maximumCoreCharacters, eventsProcessed: 0,
  };
  const ends = await roundEnds(groups, resolveReply, groups.length);
  let count = 0, size = 0;
  while (count < groups.length && (count === 0 || size + characters(groups[count]) <= maximumCoreCharacters)) {
    size += characters(groups[count++]);
  }
  count = ends.filter(end => end <= count).at(-1) || count;
  const followingEnd = ends.find(end => end > count);
  // Waiting for an ordinary following round is bounded by the next batch's
  // character budget. A long ongoing round cannot grow the waiting tail forever.
  if (!flush && !scanFull && followingEnd === undefined && total < maximumCoreCharacters * 2) {
    return { status: 'waiting', reason: 'following-round', characters: total, maximumCoreCharacters, eventsProcessed: 0 };
  }
  const historyStart = previous.findIndex(row => !row.metadata?.suzuMemoryFragment || row.metadata.suzuMemoryFragment.index === 1);
  const history = logicalGroups(previous.slice(historyStart < 0 ? previous.length : historyStart));
  const historyEnds = await roundEnds(history, resolveReply, 2, true);
  let beforeGroups = historyEnds.length ? history.slice(historyEnds.at(-2) || 0, historyEnds.at(-1)) : [];
  let afterGroups = groups.slice(count, followingEnd ?? groups.length);
  // Read-only overlap is optional when a whole source message cannot fit. Core
  // messages are never truncated or turned into duplicate evidence.
  while (beforeGroups.length && characters(beforeGroups.flat()) > maximumContextCharacters) beforeGroups.shift();
  while (afterGroups.length && characters(afterGroups.flat()) > maximumContextCharacters) afterGroups.pop();
  let before = beforeGroups.flat(), after = afterGroups.flat();
  const requestCharacters = (n, preceding = before, following = after) => measure({
    events: groups.slice(0, n).flat(), previousContextEvents: preceding, continuationGuidanceEvents: following,
  });
  if (requestCharacters(count) > maximumRequestCharacters) after = [];
  if (requestCharacters(count) > maximumRequestCharacters) before = [];
  if (requestCharacters(count) > maximumRequestCharacters) {
    let low = 0, high = count;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (requestCharacters(middle, [], []) <= maximumRequestCharacters) low = middle;
      else high = middle - 1;
    }
    count = ends.filter(end => end <= low).at(-1) || low;
    if (!count) return { status: 'blocked', reason: 'input-event-exceeds-character-limit',
      inputEventIds: groups[0].map(row => row.id), maximumRequestCharacters,
      estimatedRequestCharacters: requestCharacters(1, [], []), eventsProcessed: 0 };
  }
  return { status: 'ready', reason: flush ? 'flush' : 'content-length', events: groups.slice(0, count).flat(),
    previousContextEvents: before, continuationGuidanceEvents: after,
    coreCharacters: characters(groups.slice(0, count).flat()), maximumCoreCharacters,
    estimatedRequestCharacters: requestCharacters(count), maximumRequestCharacters };
}

export async function planReplyChunk({ pending, previous = [], resolveReply, measure,
  coreRounds = 5, maximumRequestTokens = 16_384, scanFull = false, maximumCoreCharacters = null,
  maximumRequestCharacters, maximumContextCharacters, flush = false }) {
  if (maximumCoreCharacters !== null) return planLengthChunk({ pending, previous, resolveReply, measure,
    maximumCoreCharacters, maximumRequestCharacters, maximumContextCharacters, flush, scanFull });
  const groups = logicalGroups(pending);
  if (!groups.length) return { status: pending.length ? 'blocked' : 'skipped',
    reason: pending.length ? 'incomplete-logical-event' : 'no-pending-events',
    inputEventIds: pending.length ? [pending[0].id] : [], eventsProcessed: 0 };
  const ends = await roundEnds(groups, resolveReply, coreRounds + 1);
  // A bounded reverse read may start in the middle of an older fragment group.
  const historyStart = previous.findIndex(row => !row.metadata?.suzuMemoryFragment || row.metadata.suzuMemoryFragment.index === 1);
  const history = logicalGroups(previous.slice(historyStart < 0 ? previous.length : historyStart));
  const historyEnds = await roundEnds(history, resolveReply, 2, true);
  let before = historyEnds.length ? history.slice(historyEnds.at(-2) || 0, historyEnds.at(-1)).flat() : [];
  const target = ends[coreRounds - 1] ?? groups.length;
  const followingEnd = ends[coreRounds];
  let after = followingEnd ? groups.slice(target, followingEnd).flat() : [];
  const requestTokens = (count, preceding = before, following = after) => measure({
    events: groups.slice(0, count).flat(), previousContextEvents: preceding, continuationGuidanceEvents: following,
  });
  const complete = followingEnd !== undefined;
  // While waiting, measure all accumulated material, including an unfinished
  // following round. A long ongoing conversation may trigger the token guard.
  const waitingTokens = complete ? requestTokens(target) : requestTokens(groups.length, before, []);
  if (!complete && !scanFull && waitingTokens < maximumRequestTokens) {
    return { status: 'waiting', reason: 'reply-rounds', completedRounds: ends.length,
      requiredRounds: coreRounds + 1, estimatedRequestTokens: waitingTokens, eventsProcessed: 0 };
  }
  let count = target;
  let reason = 'reply-rounds';
  if (!complete || requestTokens(count) > maximumRequestTokens) {
    reason = waitingTokens >= maximumRequestTokens ? 'token-limit' : 'input-window-limit';
    // Find the longest complete-message prefix that fits without overlap first.
    let low = 0, high = target;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (requestTokens(middle, [], []) <= maximumRequestTokens) low = middle;
      else high = middle - 1;
    }
    count = low;
    if (!count) return { status: 'blocked', reason: 'input-event-exceeds-token-limit',
      inputEventIds: groups[0].map(row => row.id), maximumRequestTokens,
      estimatedRequestTokens: requestTokens(1, [], []), eventsProcessed: 0 };
    // Prefer a completed reply boundary over cutting a reply's bubbles apart.
    count = ends.filter(end => end <= count).at(-1) || count;
    const nextEnd = ends.find(end => end > count);
    after = nextEnd ? groups.slice(count, nextEnd).flat() : [];
    // Full overlap rounds are optional only when the upper bound forces it.
    if (requestTokens(count) > maximumRequestTokens) after = [];
    if (requestTokens(count) > maximumRequestTokens) before = [];
  }
  return { status: 'ready', reason, events: groups.slice(0, count).flat(),
    previousContextEvents: before, continuationGuidanceEvents: after,
    estimatedRequestTokens: requestTokens(count), maximumRequestTokens };
}

export async function selectReplyChunk({ repository, agentId, identity, systemPrompt, timeZone, policy }) {
  const eligibleIds = executionEventSourceView(repository, agentId)?.inputIds ?? null;
  const scope = { hostId: policy.hostId, sessionId: policy.sessionId, sourceOrder: !policy.hostId, eligibleIds };
  const page = repository.listInputEvents(agentId, { ...scope, statuses: ['pending'], limit: 500 });
  const previous = page.items.length ? repository.listInputEvents(agentId, { statuses: ['archived'], limit: 500,
    ...scope, descending: true, beforeSourceEvent: page.items[0] }).items
    .filter(row => row.processing_disposition !== 'quarantined').reverse() : [];
  return planReplyChunk({ pending: page.items, previous, scanFull: page.total > page.items.length,
    ...policy, measure: selection => {
      const request = buildCompanionExtractionRequest({
      ...selection, identity, systemPrompt, timeZone,
      }).request;
      return policy.maximumCoreCharacters != null
        ? String(request.input).length + request.systemPrompt.length + JSON.stringify(request.schema).length + 100
        : policy.estimateRequestTokens(request);
    } });
}
