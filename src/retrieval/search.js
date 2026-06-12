/**
 * search.js — time-decayed semantic retrieval across three memory sources.
 *
 * One query fans out in parallel to:
 *   1. session summaries     (search_summaries RPC)
 *   2. session key points    (search_key_points RPC)
 *   3. memory objects        (search_memory_objects RPC)
 *
 * Results merge on decayed score: similarity × e^(−λ·age_days). The
 * default decay (0.03) keeps a month-old match at ~40% of its raw score —
 * recency matters, but the deep past stays findable.
 *
 * The proactive_use gate (initiative ≠ access) is enforced here:
 *   - 'yes' / 'only_when_relevant' → surface at the normal threshold
 *   - 'no' → surface ONLY on explicit anchor: similarity ≥ anchorThreshold
 *     (default 0.65). The user clearly referencing a memory is consent to
 *     recall it; incidental similarity is not. Calibration note: query-type
 *     embeddings score systematically lower than document-vs-document —
 *     with voyage-3-large, verbatim references land ~0.79, close paraphrases
 *     ~0.68, topical fishing ~0.56. Recalibrate if you change models.
 */

const DEFAULTS = {
  matchThreshold: 0.3,
  decayRate: 0.03,
  limit: 3,
  anchorThreshold: 0.65,
  shortQueryChars: 30,
};

/**
 * Cheap pre-filter: skip retrieval on greetings, emoji-only messages,
 * and other low-content turns — saves an embed call and avoids noise.
 */
export function isSubstantiveQuery(text, { shortQueryChars = DEFAULTS.shortQueryChars } = {}) {
  const trimmed = (text || "").trim();
  if (trimmed.length < shortQueryChars) return false;
  const stripped = trimmed.replace(/[\p{Emoji}\p{P}\s]/gu, "");
  return stripped.length >= 8;
}

/**
 * Search all three sources, merge, dedupe, return top results.
 *
 * @param {object} deps
 * @param {object} deps.supabase
 * @param {function} deps.embedQuery  async (text) => number[]
 * @param {object} args
 * @param {string} args.query
 * @param {number} [args.limit]
 * @param {number[]} [args.excludeSessionIds]  sessions already present in the
 *        prompt's recent-memory block — avoids double-injection
 * @returns {Promise<Array>} mixed result objects, each tagged with
 *        type: 'summary' | 'key_point' | 'memory_object'
 */
export async function searchMemories({ supabase, embedQuery }, args) {
  const {
    query,
    limit = DEFAULTS.limit,
    excludeSessionIds = [],
    matchThreshold = DEFAULTS.matchThreshold,
    decayRate = DEFAULTS.decayRate,
    anchorThreshold = DEFAULTS.anchorThreshold,
  } = args;

  if (!query || !query.trim()) return [];
  const queryEmbedding = await embedQuery(query);

  const [summariesRes, keyPointsRes, memoryObjectsRes] = await Promise.all([
    supabase.rpc("search_summaries", {
      query_embedding: queryEmbedding,
      match_threshold: matchThreshold,
      match_count: limit * 2,
      decay_rate: decayRate,
    }),
    supabase.rpc("search_key_points", {
      query_embedding: queryEmbedding,
      match_threshold: matchThreshold,
      match_count: limit * 2,
      decay_rate: decayRate,
    }),
    supabase.rpc("search_memory_objects", {
      query_embedding: queryEmbedding,
      match_threshold: matchThreshold,
      match_count: limit * 2,
      decay_rate: decayRate,
      status_filter: ["active", "confirmed", "reinforced"],
    }),
  ]);

  for (const [name, res] of [
    ["search_summaries", summariesRes],
    ["search_key_points", keyPointsRes],
    ["search_memory_objects", memoryObjectsRes],
  ]) {
    if (res.error) console.error(`[sostenuto] ${name} failed:`, res.error.message);
  }

  const exclude = new Set(excludeSessionIds);

  const summaries = (summariesRes.data || [])
    .filter((r) => !exclude.has(r.session_id))
    .map((r) => ({ ...r, type: "summary" }));

  const keyPoints = (keyPointsRes.data || [])
    .filter((r) => !exclude.has(r.session_id))
    .map((r) => ({ ...r, type: "key_point" }));

  // Memory objects are session-independent durable knowledge — they bypass
  // the session-exclude filter but respect the proactive_use anchor gate.
  const memoryObjects = (memoryObjectsRes.data || [])
    .filter((r) => Number.isFinite(r.decayed_score))
    .filter((r) => {
      const pu = r.usage_guidance?.proactive_use;
      if (pu === "no") return r.similarity >= anchorThreshold;
      return true;
    })
    .map((r) => ({
      type: "memory_object",
      memory_object_id: r.id,
      session_id: r.source_session_id ?? 0,
      content: r.content,
      similarity: r.similarity,
      age_days: 0, // durable knowledge: age isn't display-meaningful
      decayed_score: r.decayed_score,
      created_at: r.last_reinforced_at ?? null,
      domain: r.domain,
      object_type: r.type,
      status: r.status,
      confidence: r.confidence,
    }));

  const merged = [...summaries, ...keyPoints, ...memoryObjects]
    .sort((a, b) => b.decayed_score - a.decayed_score);

  // Dedupe: one result per session (summary vs its own key point — keep the
  // higher-scoring), one per memory object id.
  const seenSessions = new Set();
  const seenObjects = new Set();
  const out = [];
  for (const r of merged) {
    if (r.type === "memory_object") {
      if (seenObjects.has(r.memory_object_id)) continue;
      seenObjects.add(r.memory_object_id);
    } else {
      if (seenSessions.has(r.session_id)) continue;
      seenSessions.add(r.session_id);
    }
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Render search results as a compact prompt block. Returns null when empty.
 */
export function formatSemanticBlock(results, { header = "## Related past context" } = {}) {
  if (!results || results.length === 0) return null;
  const lines = results.map((r) => {
    if (r.type === "memory_object") {
      const tag = r.domain && r.object_type ? `[${r.domain}/${r.object_type}]` : "[memory]";
      return `- ${tag} ${r.content}`;
    }
    const days = Math.max(1, Math.round(r.age_days));
    const ago = days === 1 ? "1 day ago" : `${days} days ago`;
    if (r.type === "key_point" && r.key_point_type) {
      return `- ${ago} (${r.key_point_type}): ${r.content}`;
    }
    return `- ${ago}: ${r.content}`;
  });
  return `${header}\n${lines.join("\n")}`;
}
