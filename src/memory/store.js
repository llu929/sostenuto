/**
 * store.js — the write path: dedup → reinforce-or-upgrade → insert.
 *
 * The sostenuto principle in code: new observations that semantically
 * match an existing memory REINFORCE it (evidence accumulates, confidence
 * rises) instead of creating duplicates. Content is replaced only when a
 * candidate is a near-paraphrase that is substantially more complete —
 * and every replacement is logged to version_history, so provenance is
 * never lost.
 *
 * Dual-threshold design:
 *   REINFORCE (default 0.75): "same memory" — add evidence, bump confidence.
 *   UPGRADE   (default 0.88): near-paraphrase gate — only this close may a
 *             candidate replace existing content (plus length + concreteness
 *             checks). Between the two, related-but-distinct memories link
 *             without overwriting each other.
 *
 * Usage:
 *   import { createMemoryStore } from "./store.js";
 *   const store = createMemoryStore({ supabase, embed });
 *   const result = await store.upsertMany(candidates, { sourceSessionId: 42 });
 */

import {
  VALID_EPISTEMIC, VALID_TIME_SCOPE, VALID_SENSITIVITY,
  sanitizeDomainType, inferUsageGuidance, maxSensitivity, clamp, safeSlice,
} from "./guidance.js";

const DEFAULTS = {
  reinforceSimThreshold: 0.75,
  upgradeSimThreshold: 0.88,
  upgradeLengthRatio: 1.5,
  reinforceConfidenceBump: 0.04,
  maxContentLength: 4000,
};

/**
 * @param {object} deps
 * @param {object} deps.supabase  initialized Supabase client (service role)
 * @param {function} deps.embed   async (texts: string[]) => number[][]
 * @param {object} [deps.options] threshold overrides (see DEFAULTS)
 */
export function createMemoryStore({ supabase, embed, options = {} }) {
  const opts = { ...DEFAULTS, ...options };

  /**
   * Decide whether a matched candidate may replace existing content.
   * Conservative by design: most reinforces should NOT touch content.
   */
  function shouldUpgradeContent(existing, candidate, similarity) {
    if (candidate.usage_guidance?.import_policy === "frozen") return false;
    if (!existing.content) return true;
    if (similarity < opts.upgradeSimThreshold) return false;
    if (candidate.content.length < existing.content.length * opts.upgradeLengthRatio) return false;
    // Concreteness heuristic: upgrades should carry specifics — a quote or
    // named entities (Latin acronyms / CJK terms) — not just more words.
    const hasQuote = /["「『'].+["」』']/.test(candidate.content);
    const hasNamedEntity = /[A-Z]{2,}|[一-龥]{2,}/.test(candidate.content);
    return hasQuote || hasNamedEntity;
  }

  async function reinforceOrUpgrade(existingId, candidate, similarity, sourceSessionId) {
    const { data: existing, error } = await supabase
      .from("memory_objects")
      .select("id, content, evidence_refs, confidence, sensitivity, status, version_history, usage_guidance")
      .eq("id", existingId)
      .single();
    if (error) throw new Error(`fetch memory #${existingId}: ${error.message}`);

    const update = {
      evidence_refs: [...(existing.evidence_refs || []), ...(candidate.evidence_refs || [])],
      confidence: clamp((existing.confidence ?? 0.5) + opts.reinforceConfidenceBump, 0, 1),
      sensitivity: maxSensitivity(existing.sensitivity, candidate.sensitivity),
      status: "reinforced",
      last_reinforced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    let action = "reinforced";
    if (shouldUpgradeContent(existing, candidate, similarity)) {
      action = "upgraded";
      update.version_history = [
        ...(existing.version_history || []),
        {
          prev_content: existing.content,
          prev_usage_guidance: existing.usage_guidance,
          replaced_at: new Date().toISOString(),
          reason: "more complete + concrete content from a matching observation",
          source_session_id: sourceSessionId ?? null,
        },
      ];
      update.content = candidate.content;
      update.usage_guidance = { ...(existing.usage_guidance || {}), ...(candidate.usage_guidance || {}) };
    }

    const { error: updErr } = await supabase
      .from("memory_objects").update(update).eq("id", existingId);
    if (updErr) throw new Error(`update memory #${existingId}: ${updErr.message}`);
    return { action, id: existingId };
  }

  /**
   * Normalize one raw candidate (typically classifier output) into an
   * insert-ready shape. Returns null for candidates with no usable content.
   */
  function normalize(raw, { sourceSessionId, sourceSurface }) {
    const content = safeSlice((raw.content || "").trim(), opts.maxContentLength);
    if (content.length < 20) return null;

    const { domain, type } = sanitizeDomainType(raw.domain, raw.type);
    const sensitivity = VALID_SENSITIVITY.has(raw.sensitivity) ? raw.sensitivity : "low";
    const confidence = clamp(typeof raw.confidence === "number" ? raw.confidence : 0.7, 0, 1);

    const usage_guidance = raw.usage_guidance ?? inferUsageGuidance({
      type, sensitivity, confidence, content,
      valence: typeof raw.valence === "number" ? raw.valence : undefined,
      llm_arousal: typeof raw.arousal === "number" ? raw.arousal : undefined,
      source_memory_type: raw.source_memory_type,
    });

    return {
      source_session_id: sourceSessionId ?? null,
      domain,
      type,
      content,
      evidence_refs: raw.evidence
        ? [{ session_id: sourceSessionId ?? null, quote: safeSlice(String(raw.evidence), 500) }]
        : [{ session_id: sourceSessionId ?? null }],
      epistemic_status: VALID_EPISTEMIC.has(raw.epistemic_status) ? raw.epistemic_status : "inferred",
      time_scope: VALID_TIME_SCOPE.has(raw.time_scope) ? raw.time_scope : "ongoing",
      sensitivity,
      confidence,
      status: confidence >= 0.7 ? "active" : "candidate",
      source_surface: sourceSurface || "system",
      usage_guidance,
      version_history: [],
    };
  }

  /**
   * Upsert a batch of candidate memories.
   *
   * Sequential by design: each insert is visible to the next candidate's
   * dedup search, so near-duplicates within one batch collapse correctly.
   *
   * @returns {Promise<{inserted:number, reinforced:number, upgraded:number,
   *                    skipped:number, errors:Array<{candidate:string, error:string}>}>}
   */
  async function upsertMany(candidates, { sourceSessionId, sourceSurface } = {}) {
    const results = { inserted: 0, reinforced: 0, upgraded: 0, skipped: 0, errors: [] };

    const normalized = [];
    for (const raw of candidates || []) {
      const n = normalize(raw, { sourceSessionId, sourceSurface });
      if (n) normalized.push(n);
      else results.skipped++;
    }
    if (normalized.length === 0) return results;

    const vectors = await embed(normalized.map((c) => c.content));

    for (let i = 0; i < normalized.length; i++) {
      const c = normalized[i];
      const vec = vectors[i];
      if (!vec) {
        results.errors.push({ candidate: c.content.slice(0, 60), error: "no embedding" });
        continue;
      }
      try {
        const { data: overlaps, error: searchErr } = await supabase.rpc("search_memory_objects", {
          query_embedding: vec,
          match_threshold: opts.reinforceSimThreshold,
          match_count: 1,
          decay_rate: 0, // dedup is about identity, not recency
          domain_filter: [c.domain],
          status_filter: ["candidate", "active", "confirmed", "reinforced"],
        });
        if (searchErr) throw new Error(searchErr.message);

        if (overlaps && overlaps.length > 0) {
          const match = overlaps[0];
          const { action } = await reinforceOrUpgrade(match.id, c, match.similarity, sourceSessionId);
          results[action]++;
        } else {
          const { error: insErr } = await supabase
            .from("memory_objects")
            .insert({ ...c, embedding: vec });
          if (insErr) throw new Error(insErr.message);
          results.inserted++;
        }
      } catch (err) {
        results.errors.push({ candidate: c.content.slice(0, 60), error: err.message });
      }
    }

    return results;
  }

  /** Upsert a single candidate. */
  async function upsert(candidate, ctx = {}) {
    return upsertMany([candidate], ctx);
  }

  return { upsert, upsertMany };
}
