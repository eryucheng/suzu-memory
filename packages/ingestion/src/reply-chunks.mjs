import { executionEventSourceView } from '@suzu-memory/core';
import { buildCompanionExtractionRequest } from './processing-stages.mjs';

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
    if (reply?.complete && sourceOf(row).eventId === reply.lastEventId && !seen.has(reply.id)) {
      seen.add(reply.id);
      ends.push(index + 1);
      if (ends.length >= maximum) break;
    }
  }
  return ends.sort((a, b) => a - b);
}

export async function planReplyChunk({ pending, previous = [], resolveReply, measure,
  coreRounds = 5, maximumRequestTokens = 16_384, scanFull = false }) {
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
  const page = repository.listInputEvents(agentId, { statuses: ['pending'], limit: 500, sourceOrder: true, eligibleIds });
  const previous = page.items.length ? repository.listInputEvents(agentId, { statuses: ['archived'], limit: 500,
    sourceOrder: true, descending: true, beforeSourceEvent: page.items[0], eligibleIds }).items
    .filter(row => row.processing_disposition !== 'quarantined').reverse() : [];
  return planReplyChunk({ pending: page.items, previous, scanFull: page.total > page.items.length,
    ...policy, measure: selection => policy.estimateRequestTokens(buildCompanionExtractionRequest({
      ...selection, identity, systemPrompt, timeZone,
    }).request) });
}
