/**
 * guidance.js — usage-policy inference and input sanitization.
 *
 * Every memory object carries a `usage_guidance` policy (machine-read,
 * never dumped into prompts). When the classifier doesn't supply policy
 * fields directly, these deterministic rules infer sensible defaults
 * from type + sensitivity + confidence — no extra LLM call.
 *
 * Design notes baked into the rules:
 *   - `proactive_use` controls INITIATIVE, not access. 'no' items remain
 *     retrievable when the user explicitly anchors them (high-similarity
 *     reference); they're just never volunteered.
 *   - Sensitivity does NOT gate retrieval. High-sensitivity memories are
 *     part of the relationship and must stay findable when referenced.
 *     The gate for "don't auto-surface" is proactive_use, set by policy
 *     or curation — not a blanket sensitivity rule.
 */

// ─── Vocabularies (must match db/schema.sql CHECK constraints) ───────

export const VALID_DOMAINS = new Set([
  "user_self", "agent_self", "relational", "evidence",
]);

export const VALID_TYPES = new Set([
  "fact", "preference", "trajectory", "somatic_affective",
  "interpretive_frame", "project", "boundary", "commitment",
  "ritual", "shared_concept", "recurring_subject",
  "contradiction", "style_adjustment", "voice_note",
  "constraint", "context_note", "brief", "resume_guidance",
  "continuation", "other",
]);

export const VALID_EPISTEMIC = new Set([
  "explicit", "inferred", "co_created", "assistant_reflection", "system_generated",
]);

export const VALID_TIME_SCOPE = new Set([
  "momentary", "session", "active_project", "ongoing", "historical", "deprecated",
]);

export const VALID_SENSITIVITY = new Set(["low", "medium", "high"]);

const SENSITIVITY_RANK = { low: 0, medium: 1, high: 2 };

/**
 * Higher-ranked sensitivity wins (used when merging on reinforce).
 * Fail-safe: an unrecognized value (e.g. a legacy 'intimate' level from an
 * older schema) ranks as the MOST sensitive, so a merge can never silently
 * downgrade a level it can't classify.
 */
export function maxSensitivity(a, b) {
  return (SENSITIVITY_RANK[a] ?? 99) >= (SENSITIVITY_RANK[b] ?? 99) ? a : b;
}

export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Truncate without leaving orphan UTF-16 surrogate halves. Raw .slice()
 * can split an emoji/astral char in two, producing invalid JSON that
 * Postgres JSONB rejects.
 */
export function safeSlice(s, n) {
  if (!s || s.length <= n) return s || "";
  let out = s.slice(0, n);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

// ─── Domain/type sanitization ────────────────────────────────────────
// Classifier LLMs occasionally emit values outside the schema vocabulary
// (e.g. domain:"project"). Map common drift to valid values instead of
// failing the insert.

export function sanitizeDomainType(rawDomain, rawType) {
  let domain = rawDomain;
  let type = rawType;
  let sanitized = false;

  if (!VALID_DOMAINS.has(domain)) {
    sanitized = true;
    const d = String(domain || "").toLowerCase();
    if (["project", "infrastructure", "technical", "system", "scheduled", "upcoming", "event", "context", "background"].includes(d)) {
      domain = "relational";
      if (!type || !VALID_TYPES.has(type)) {
        if (["project", "infrastructure", "technical", "system"].includes(d)) type = "project";
        else if (["scheduled", "upcoming", "event"].includes(d)) type = "continuation";
        else type = "context_note";
      }
    } else if (d === "user") domain = "user_self";
    else if (["agent", "assistant", "ai", "companion"].includes(d)) domain = "agent_self";
    else if (["quote", "transcript"].includes(d)) domain = "evidence";
    else domain = "relational"; // safest default
  }

  if (!VALID_TYPES.has(type)) {
    sanitized = true;
    const t = String(type || "").toLowerCase();
    if (["dynamic", "pattern", "interaction"].includes(t)) type = "shared_concept";
    else if (["observation", "linguistic", "note"].includes(t)) type = "voice_note";
    else if (["scheduled", "upcoming", "event", "thread", "open_loop"].includes(t)) type = "continuation";
    else if (["principle", "rule", "guideline"].includes(t)) type = "constraint";
    else type = "other";
  }

  return { domain, type, sanitized };
}

// ─── Arousal inference ───────────────────────────────────────────────
// Russell-circumplex intensity, orthogonal to valence: 0 = calm/stable,
// 1 = acute. Used to modulate decay (high-arousal memories fade slower)
// and surfacing weight. Prefer a classifier-supplied value; this formula
// is the fallback:
//
//   arousal = 0.40·typePrior + 0.40·|valence| + 0.20·salience

const AROUSAL_TYPE_PRIOR = {
  // import-taxonomy keys (from migration exports)
  boundary: 0.6, constraint: 0.7,
  emotional_note: 0.8, emotional_pattern: 0.75,
  peak_moment: 0.9, relational: 0.7,
  ritual: 0.45, language_pattern: 0.4,
  project: 0.3, technical_decision: 0.3,
  user_self: 0.3, preference: 0.25,
  aesthetic: 0.35, open_loop: 0.5, episodic: 0.55,
  // schema-type keys
  somatic_affective: 0.7, commitment: 0.55, shared_concept: 0.55,
  trajectory: 0.4, interpretive_frame: 0.55, recurring_subject: 0.5,
  contradiction: 0.55, style_adjustment: 0.45, voice_note: 0.4,
  context_note: 0.3, brief: 0.4, resume_guidance: 0.55,
  continuation: 0.4, fact: 0.2, other: 0.3,
};

function arousalTypePrior({ type, source_memory_type }) {
  // Non-taxonomy markers fall through to the schema type.
  if (
    source_memory_type &&
    source_memory_type !== "backfill" &&
    source_memory_type !== "manual" &&
    AROUSAL_TYPE_PRIOR[source_memory_type] !== undefined
  ) {
    return AROUSAL_TYPE_PRIOR[source_memory_type];
  }
  return AROUSAL_TYPE_PRIOR[type] ?? 0.3;
}

export function inferArousal({ type, source_memory_type, valence, salience }) {
  const tp = arousalTypePrior({ type, source_memory_type });
  const vi = Math.abs(typeof valence === "number" ? valence : 0);
  const sal = typeof salience === "number" ? salience : 0.7;
  return Number(clamp(0.4 * tp + 0.4 * vi + 0.2 * sal, 0, 1).toFixed(3));
}

// ─── Usage-guidance inference ────────────────────────────────────────

/**
 * Infer a full usage_guidance object for a new memory.
 *
 * @param {object} m
 * @param {string} m.type               schema type (already sanitized)
 * @param {string} m.sensitivity        low | medium | high
 * @param {number} [m.confidence]       0..1
 * @param {string} [m.content]          used for dormancy detection on continuations
 * @param {number} [m.valence]          -1..1, classifier-supplied
 * @param {number} [m.llm_arousal]      0..1, classifier-supplied (preferred over formula)
 * @param {string} [m.source_memory_type]  original taxonomy tag from an import
 */
export function inferUsageGuidance({
  type, sensitivity, confidence, content, valence, llm_arousal, source_memory_type,
}) {
  const ug = {
    source_memory_type: source_memory_type || type,
    import_policy: "upgrade_on_better",
    stability: "stable",
    salience: clamp(confidence ?? 0.7, 0.5, 1.0),
  };

  switch (type) {
    case "resume_guidance":
      // How a fresh session should arrive — always-on orientation.
      ug.proactive_use = "yes";
      ug.live_retrieval_eligible = true;
      ug.salience = 1.0;
      ug.future_response_guidance = "Read at session start to calibrate tone. Do not quote.";
      break;
    case "boundary":
    case "constraint":
      ug.proactive_use = "only_when_relevant";
      ug.live_retrieval_eligible = false; // behavior guidance, not retrieval content
      ug.salience = 0.95;
      ug.future_response_guidance = "Silently shape behavior. Do not quote back.";
      break;
    case "context_note":
      ug.proactive_use = "no"; // background context; surfaces only on explicit anchor
      ug.live_retrieval_eligible = false;
      ug.salience = 0.85;
      ug.future_response_guidance = "Background context. Not for quoting.";
      break;
    case "style_adjustment":
      ug.proactive_use = "only_when_relevant";
      ug.live_retrieval_eligible = false;
      ug.salience = 0.9;
      ug.future_response_guidance = "Silently shape voice. Not for quoting.";
      break;
    case "continuation":
      ug.proactive_use = "only_when_relevant";
      ug.live_retrieval_eligible = !/\[dormant\]/i.test(content || "");
      ug.salience = ug.live_retrieval_eligible ? 0.75 : 0.5;
      break;
    default:
      ug.proactive_use = "only_when_relevant";
      // Default true regardless of sensitivity — see module header.
      ug.live_retrieval_eligible = true;
      break;
  }

  if (typeof valence === "number") ug.valence = clamp(valence, -1, 1);
  if (typeof llm_arousal === "number" && llm_arousal >= 0 && llm_arousal <= 1) {
    ug.arousal = Number(llm_arousal.toFixed(3));
  } else {
    ug.arousal = inferArousal({
      type, source_memory_type, valence: ug.valence, salience: ug.salience,
    });
  }

  return ug;
}
