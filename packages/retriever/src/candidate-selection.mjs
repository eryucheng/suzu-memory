const clean = value => String(value ?? '').trim();

function candidateRelevanceScore(candidate) {
  const value = Number(candidate?.score);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function candidateRecordedTimestamp(candidate) {
  const value = Date.parse(candidate?.node?.recorded_at || "");
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

export function fuseCandidateLanes(structuredCandidates, episodicCandidates, maximum) {
  const limit = Math.max(0, Math.trunc(Number(maximum) || 0));
  const byMemoryId = new Map();
  const addLane = (values, retrievalLane) => {
    values.forEach((candidate, index) => {
      const normalized = {
        ...candidate,
        retrievalLane: candidate.node.kind === "utterance" ? "episodic-evidence"
          : clean(candidate.retrievalLane) || retrievalLane || "structured-memory",
        laneRank: index + 1,
      };
      const existing = byMemoryId.get(candidate.node.id);
      if (!existing || candidateRelevanceScore(normalized) > candidateRelevanceScore(existing)) {
        if (existing && normalized.admission === 'convergence-only' && existing.admission !== 'convergence-only') {
          normalized.admission = existing.admission;
        }
        byMemoryId.set(candidate.node.id, normalized);
      } else if (existing.admission === 'convergence-only' && normalized.admission !== 'convergence-only') {
        byMemoryId.set(candidate.node.id, { ...existing, admission: normalized.admission });
      }
    });
  };
  addLane(structuredCandidates, "structured-memory");
  addLane(episodicCandidates, "episodic-evidence");

  // Candidate rank must express relevance, rather than alternate a structured
  // summary and raw evidence. The two lanes already use the same hybrid score
  // construction; the separate presentation formatter still decides how much
  // conclusion/evidence text reaches the model in an ordinary conversation.
  return [...byMemoryId.values()]
    .sort((left, right) => (
      candidateRelevanceScore(right) - candidateRelevanceScore(left)
      || Number(right.node.importance || 0) - Number(left.node.importance || 0)
      || candidateRecordedTimestamp(right) - candidateRecordedTimestamp(left)
      || clean(left.node.id).localeCompare(clean(right.node.id))
    ))
    .slice(0, limit);
}

export function normalizedEvidenceLimit(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(0, Math.floor(Number(fallback) || 0));
  return Math.max(0, Math.floor(numeric));
}
