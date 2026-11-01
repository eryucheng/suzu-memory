import { fuseCandidateLanes } from './candidate-selection.mjs';
import { lexicalTerms } from './query.mjs';
import { utteranceStatements } from './query-text.mjs';
import { createSeedLexicalScorer } from './seed-routes.mjs';

const clean = value => String(value || '').normalize('NFKC').toLowerCase().trim();
const occurrenceKey = node => [node.world_id, node.world_frame, node.subject_role, node.subject_key,
  node.kind === 'utterance' ? node.metadata?.speaker : '', node.event_date, node.event_start,
  node.valid_from, node.valid_to, node.evidence_mode, node.representation_layer, node.temporal_state,
  node.state_family, node.state_phase].join('\u001f');

function createEvidenceCoverage(database, agentId, eligibleMemoryIds, options) {
  const depthLimit = Math.max(1, Math.trunc(Number(options.maximumChainDepth) || 3));
  const children = new Map(), direct = new Map(), resolved = new Map();
  const stats = { queries: 0, edgeRows: 0, sourceRows: 0 };
  let read;
  function load(ids, withChildren) {
    const sourceIds = ids.filter(id => !direct.has(id));
    const edgeIds = withChildren ? ids.filter(id => !children.has(id)) : [];
    if (!sourceIds.length && !edgeIds.length) return;
    read ||= database.prepare(`
      SELECT memory_id AS parent, source_id AS target, 0 AS is_edge FROM memory_sources
        WHERE memory_id IN (SELECT value FROM json_each(?))
      UNION ALL
      SELECT from_memory_id, to_memory_id, 1 FROM memory_edges INDEXED BY memory_edges_from
        WHERE agent_id = ? AND from_memory_id IN (SELECT value FROM json_each(?)) AND relation = 'supported_by'
      UNION ALL
      SELECT to_memory_id, from_memory_id, 1 FROM memory_edges INDEXED BY memory_edges_to
        WHERE agent_id = ? AND to_memory_id IN (SELECT value FROM json_each(?)) AND relation IN ('supports_topic', 'part_of_episode')
    `);
    const edges = JSON.stringify(edgeIds);
    const rows = read.all(JSON.stringify(sourceIds), agentId, edges, agentId, edges);
    stats.queries++;
    for (const id of sourceIds) direct.set(id, new Set());
    for (const id of edgeIds) children.set(id, new Set());
    for (const row of rows) {
      if (!row.is_edge) {
        stats.sourceRows++;
        direct.get(row.parent).add(row.target);
      } else {
        stats.edgeRows++;
        if (eligibleMemoryIds.has(row.target)) children.get(row.parent).add(row.target);
      }
    }
  }
  return { stats, direct, resolved,
    sourcesFor(ids) {
      const pending = [...new Set(ids)].filter(id => eligibleMemoryIds.has(id) && !resolved.has(id))
        .map(id => ({ id, frontier: [id], seen: new Set([id]), sources: new Set() }));
      // Resolve each root to the same depth, independent of other candidates
      // or cache warm-up order. Shared rows are read only once per selection.
      for (let depth = 0; depth <= depthLimit && pending.some(item => item.frontier.length); depth++) {
        const frontier = [...new Set(pending.flatMap(item => item.frontier))];
        load(frontier, depth < depthLimit);
        for (const item of pending) {
          const next = [];
          for (const id of item.frontier) {
            for (const source of direct.get(id)) item.sources.add(source);
            if (depth === depthLimit) continue;
            for (const child of children.get(id)) {
              if (item.seen.has(child)) continue;
              item.seen.add(child);
              next.push(child);
            }
          }
          item.frontier = next;
        }
      }
      for (const item of pending) resolved.set(item.id, item.sources);
      return ids.map(id => resolved.get(id) || new Set());
    }
  };
}

function overlap(left, right) {
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const term of left) if (right.has(term)) common++;
  return common / Math.max(left.size, right.size);
}

function cosine(left, right) {
  if (!left?.length || left.length !== right?.length) return 0;
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? Math.max(0, dot / Math.sqrt(leftNorm * rightNorm)) : 0;
}

/** Choose complete evidence units after discovery. Record limits apply here,
 * not to graph seeds; neighboring dialogue never bypasses this selection. */
export function selectRankedContext({
  database, agentId, candidates, eligibleMemoryIds,
  preparedQuery, scoreLexical = createSeedLexicalScorer(preparedQuery), embeddingVectors = new Map(), maximum, stateView = null, options = {},
}) {
  const pool = fuseCandidateLanes(candidates, [], Number.MAX_SAFE_INTEGER);
  const byId = new Map(pool.map(candidate => [candidate.node.id, candidate]));
  const excluded = new Set(Array.isArray(options.excludedMemoryIds) ? options.excludedMemoryIds : []);
  const coverage = createEvidenceCoverage(database, agentId, eligibleMemoryIds, options);
  const allowed = node => node && eligibleMemoryIds.has(node.id);
  const features = new Map();
  const describe = node => {
    if (!features.has(node.id)) {
      const text = clean(node.kind === 'utterance' ? utteranceStatements(node.content).text : node.content);
      features.set(node.id, { key: occurrenceKey(node), text,
        identityKnown: Boolean((node.subject_role && node.subject_role !== 'unknown' && node.subject_key)
          || (node.kind === 'utterance' && node.metadata?.speaker)),
        world: [node.world_id, node.world_frame].join('\u001f'),
        terms: new Set(lexicalTerms(text)), vector: embeddingVectors.get(node.id) });
    }
    return features.get(node.id);
  };
  // One indexed lookup per question-bearing candidate. Only a forward reply
  // from this agent/snapshot can complete the exchange.
  const nextReply = database.prepare(`
    SELECT node.* FROM memory_edges AS edge
    JOIN memory_nodes AS node ON node.id = edge.to_memory_id AND node.agent_id = edge.agent_id
    WHERE edge.agent_id = ? AND edge.from_memory_id = ? AND edge.relation = 'followed_by'
      AND edge.weight >= 0.65 AND node.kind = 'utterance' AND node.status = 'active'
    ORDER BY edge.weight DESC, node.event_start, node.id LIMIT 20
  `);
  const units = [], replyReads = new Set();
  let replyRows = 0;
  for (const candidate of pool) {
    const node = candidate.node;
    if (!allowed(node)) continue;
    if (node.kind !== 'utterance') {
      const current = stateView?.current(node, { includeClosed: true });
      units.push({ nodes: current && current.id !== node.id && allowed(current)
        ? maximum === 1 ? [current] : [current, node] : [node], relevance: candidate.score });
      continue;
    }
    const parts = scoreLexical.dialogue(node);
    const needsReply = parts.hasQuestion && (!parts.text.trim()
      || parts.questionRelevance > parts.statementRelevance);
    if (!needsReply) {
      units.push({ nodes: [node], relevance: candidate.score });
      continue;
    }
    replyReads.add(node.id);
    const rows = nextReply.all(agentId, node.id);
    replyRows += rows.length;
    const reply = rows.find(row => allowed(row)
      && row.world_id === node.world_id && row.world_frame === node.world_frame
      && (row.subject_role !== node.subject_role || row.subject_key !== node.subject_key));
    if (!reply) {
      // Original wording can itself be requested. Preserve speaker and
      // punctuation so the reader can interpret the utterance.
      units.push({ nodes: [node], relevance: candidate.score });
      continue;
    }
    const parsed = byId.get(reply.id)?.node || { ...reply, metadata: JSON.parse(reply.metadata_json || '{}') };
    // With a one-record budget, retain the available answer rather than
    // spending the only slot on the question we already have in the query.
    units.push({ nodes: maximum === 1 ? [parsed] : [node, parsed],
      relevance: Math.max(candidate.score, byId.get(reply.id)?.score || 0) });
  }
  const selected = new Map(), decisions = [], remaining = new Set(units), similarities = new Map();
  let prunedComparisons = 0;
  const similarity = (node, other) => {
    const key = [node.id, other.id].sort().join('\u001f');
    if (similarities.has(key)) return similarities.get(key);
    const left = describe(node), right = describe(other);
    if (left.world !== right.world) return 0;
    if (left.identityKnown && left.key === right.key && left.text && left.text === right.text) return 1;
    // Related subject matter is not duplicate information. A shared source
    // is required before semantic similarity lowers a distinct fact's rank.
    const textOverlap = overlap(left.terms, right.terms);
    const contentSimilarity = left.vector && right.vector
      ? (textOverlap + cosine(left.vector, right.vector)) / 2 : textOverlap;
    const sharedEvidence = contentSimilarity > 0
      ? overlap(...coverage.sourcesFor([node.id, other.id])) : 0;
    const value = sharedEvidence * contentSimilarity;
    similarities.set(key, value);
    return value;
  };
  while (remaining.size && selected.size < maximum) {
    let best = null;
    for (const unit of remaining) {
      const fresh = unit.nodes.filter(node => !selected.has(node.id) && !excluded.has(node.id));
      if (!fresh.length || selected.size + fresh.length > maximum) continue;
      // Redundancy only lowers nonnegative relevance. Keep equal upper
      // bounds in the comparison so the existing tie order stays intact.
      if (best && unit.relevance >= 0 && unit.relevance < best.utility) {
        prunedComparisons++;
        continue;
      }
      // Identical wording for the same holder/world adds no new information.
      // Other overlap only lowers priority; different facts are never deleted.
      const duplicate = fresh.every(node => [...selected.values()].some(other => {
        const a = describe(node), b = describe(other);
        return a.identityKnown && a.key === b.key && a.text && a.text === b.text;
      }));
      if (duplicate) continue;
      const redundancy = fresh.reduce((sum, node) => sum + Math.max(0,
        ...[...selected.values()].map(other => similarity(node, other))), 0) / fresh.length;
      const utility = unit.relevance * (1 - redundancy / 2);
      if (!best || utility > best.utility) best = { unit, fresh, redundancy, utility };
    }
    if (!best) break;
    remaining.delete(best.unit);
    for (const node of best.fresh) selected.set(node.id, node);
    decisions.push({ memoryIds: best.fresh.map(node => node.id), relevance: best.unit.relevance,
      redundancy: best.redundancy, utility: best.utility });
  }
  return { nodes: [...selected.values()], audit: {
    candidateCount: pool.length, unitCount: units.length, selectedRecordCount: selected.size,
    coverageQueries: coverage.stats.queries, coverageEdgeRows: coverage.stats.edgeRows, coverageSourceRows: coverage.stats.sourceRows,
    coverageMemoryCount: coverage.direct.size, coverageRootCount: coverage.resolved.size, prunedComparisons,
    replyLookupCount: replyReads.size, replyRows, decisions,
  } };
}
