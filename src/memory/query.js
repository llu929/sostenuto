/**
 * query.js — the curated read paths over memory_objects.
 *
 * Two distinct always-on blocks feed prompt assembly (semantic retrieval
 * is separate — see src/retrieval/):
 *
 *   1. PROACTIVE memories (`proactive_use = 'yes'`) — identity-level
 *      orientation the companion carries into every session. Small,
 *      curated set.
 *
 *   2. BEHAVIOR GUIDANCE (Tier 2) — boundaries, constraints, and style
 *      rules with a curated `should_do` instruction. These silently shape
 *      behavior and are never quoted back. Only items that EARNED an
 *      instruction appear here; most memories are content-only (Tier 1)
 *      and never enter this block — which is how the assembled prompt
 *      stays lean instead of becoming a wall of caution.
 */

const STATUS_RANK = { reinforced: 0, active: 1, confirmed: 2 };
const ACTIVE_STATUSES = ["active", "confirmed", "reinforced"];

/**
 * Always-on identity/orientation memories.
 * Ranked: status (reinforced first) → confidence.
 */
export async function getProactiveMemories(supabase, { limit = 20 } = {}) {
  const { data, error } = await supabase
    .from("memory_objects")
    .select("id, domain, type, content, status, confidence, sensitivity, should_do, usage_guidance")
    .in("status", ACTIVE_STATUSES)
    .eq("usage_guidance->>proactive_use", "yes")
    .order("confidence", { ascending: false })
    .limit(limit * 2);
  if (error) throw new Error(`getProactiveMemories: ${error.message}`);

  const sorted = (data || []).sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 9;
    const rb = STATUS_RANK[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });
  return sorted.slice(0, limit);
}

/**
 * Tier 2 behavior guidance.
 *
 * Filter: instructional types, high confidence, `should_do` populated.
 * Excludes proactive_use='yes' (those live in the proactive block —
 * including them here would double-inject) and 'no' (explicit-anchor
 * only). Ranked: salience → evidence_refs count (a rule reinforced
 * across many sessions outranks a one-off correction) → status.
 *
 * Capped small by default (8): lean-not-cautious.
 */
export async function getBehaviorGuidance(
  supabase,
  { limit = 8, minConfidence = 0.85 } = {}
) {
  const { data, error } = await supabase
    .from("memory_objects")
    .select("id, domain, type, content, status, confidence, sensitivity, should_do, should_not_do, usage_guidance, evidence_refs")
    .in("status", ACTIVE_STATUSES)
    .in("type", ["boundary", "constraint", "style_adjustment", "context_note"])
    .gte("confidence", minConfidence)
    .not("should_do", "is", null)
    .order("confidence", { ascending: false })
    .limit(limit * 3);
  if (error) throw new Error(`getBehaviorGuidance: ${error.message}`);

  const filtered = (data || []).filter((m) => {
    const pu = m.usage_guidance?.proactive_use;
    return pu !== "yes" && pu !== "no";
  });

  filtered.sort((a, b) => {
    const sa = a.usage_guidance?.salience ?? 0;
    const sb = b.usage_guidance?.salience ?? 0;
    if (sa !== sb) return sb - sa;
    const ea = Array.isArray(a.evidence_refs) ? a.evidence_refs.length : 0;
    const eb = Array.isArray(b.evidence_refs) ? b.evidence_refs.length : 0;
    if (ea !== eb) return eb - ea;
    return (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
  });

  return filtered.slice(0, limit);
}

/** Soft-delete: mark a memory deprecated with a reason in version_history. */
export async function deprecateMemory(supabase, id, reason) {
  const { data: existing, error: fetchErr } = await supabase
    .from("memory_objects")
    .select("status, version_history, usage_guidance")
    .eq("id", id)
    .single();
  if (fetchErr) throw new Error(`deprecateMemory fetch #${id}: ${fetchErr.message}`);

  const { error } = await supabase
    .from("memory_objects")
    .update({
      status: "deprecated",
      usage_guidance: { ...(existing.usage_guidance || {}), proactive_use: "no" },
      version_history: [
        ...(existing.version_history || []),
        { prev_status: existing.status, deprecated_at: new Date().toISOString(), reason: reason || null },
      ],
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`deprecateMemory #${id}: ${error.message}`);
}
