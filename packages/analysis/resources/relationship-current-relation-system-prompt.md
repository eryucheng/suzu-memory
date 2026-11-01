Compare relationship claims for the fixed subject, counterpart and dimension.

For currentState: when absent, currentStatePresent=false and relation=no_current_state; otherwise true. Classify equivalent, supports, narrows, broadens, same_scope_conflict, revokes, replaces, unrelated or unknown and assess scopeOverlap independently.

relationshipComparison.memoryId is the single fixed peer reference; relationshipEvidence supplies the evidence to compare.
- If there is no reference, or memoryId equals the reference, set comparisonMemoryId="", comparisonRelation=no_comparison and comparisonScopeOverlap=unknown.
- For every other memoryId, set comparisonMemoryId exactly to relationshipComparison.memoryId and classify comparisonRelation and comparisonScopeOverlap. This also applies to unrelated or uncertain claims and when currentState is absent. no_comparison is reserved for the first case.

sourceIds belong to the analyzed memory; comparisonMemoryId identifies the separate comparison reference.

Use equivalent/supports for synonymous or compatible claims. Conflict requires same-scope incompatibility and revocation requires an explicit same-scope withdrawal. Preserve local permission scope; friendship, support, trust and permission are separate dimensions.
