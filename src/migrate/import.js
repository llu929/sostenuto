/**
 * import.js — import a migration-export JSON into a session + memories.
 *
 * Companion to templates/migration-export.md: paste that prompt into an
 * existing conversation anywhere (claude.ai, ChatGPT, …), save the JSON
 * it returns, then:
 *
 *   import { importWindow } from "sostenuto/src/migrate/import.js";
 *   await importWindow({ supabase, embed, memoryStore }, {
 *     data: JSON.parse(fs.readFileSync("export.json", "utf-8")),
 *     source: "import",
 *   });
 *
 * Every candidate runs through the memory store's dedup pipeline, so
 * importing overlapping windows REINFORCES existing memories (evidence
 * accumulates across windows) instead of duplicating them.
 *
 * Historical-import safety: this never touches agent_state (live
 * emotional state shouldn't be perturbed by backfilling the past) and
 * never overwrites singleton briefs. It creates/updates one session row
 * and writes memory objects — nothing else.
 */

import { safeSlice, clamp } from "../memory/guidance.js";

// Import-taxonomy → schema-type mapping for memory_records.
const TYPE_BY_MEMORY_TYPE = {
  user_self: "fact",
  agent_self: "style_adjustment",
  relational: "shared_concept",
  project: "project",
  episodic: "shared_concept",
  preference: "preference",
  ritual: "ritual",
  language_pattern: "shared_concept",
  emotional_pattern: "interpretive_frame",
  boundary: "boundary",
  open_loop: "continuation",
  aesthetic: "preference",
  technical_decision: "project",
  peak_moment: "shared_concept",
};

const DOMAIN_BY_MEMORY_TYPE = {
  user_self: "user_self",
  agent_self: "agent_self",
  aesthetic: "user_self",
  boundary: "agent_self",
  // everything else → relational
};

// Old exports may use a four-level sensitivity scale; collapse the top.
function mapSensitivity(s) {
  if (s === "intimate") return "high";
  return ["low", "medium", "high"].includes(s) ? s : "medium";
}

// ─── Candidate builders (one per export section) ─────────────────────

function recordCandidates(j) {
  return (j.memory_records || []).map((r) => {
    const domain = DOMAIN_BY_MEMORY_TYPE[r.memory_type] || "relational";
    const type = TYPE_BY_MEMORY_TYPE[r.memory_type] || "other";
    const proactive_use = ["yes", "no", "only_when_relevant"].includes(r.proactive_use)
      ? r.proactive_use
      : "only_when_relevant";
    return {
      domain,
      type,
      content: r.title ? `${r.title}: ${r.content}` : r.content,
      evidence: r.evidence_from_window,
      epistemic_status: "explicit",
      sensitivity: mapSensitivity(r.sensitivity),
      confidence: typeof r.confidence === "number" ? r.confidence : 0.9,
      usage_guidance: {
        valence: typeof r.valence === "number" ? clamp(r.valence, -1, 1) : undefined,
        arousal: typeof r.arousal === "number" ? clamp(r.arousal, 0, 1) : undefined,
        salience: typeof r.salience === "number" ? clamp(r.salience, 0, 1) : 0.7,
        stability: r.stability || "stable",
        proactive_use,
        live_retrieval_eligible: true,
        retrieval_conditions: r.retrieval_conditions || undefined,
        do_not_use_when: r.do_not_use_when || undefined,
        future_response_guidance: r.future_response_guidance || undefined,
        retrieval_keywords: Array.isArray(r.retrieval_keywords) ? r.retrieval_keywords : [],
        source_memory_type: r.memory_type,
        import_policy: "upgrade_on_better",
      },
    };
  });
}

function boundaryCandidates(j) {
  const out = [];
  const sb = j.safety_and_boundaries || {};
  for (const txt of sb.boundaries_or_preferences_expressed || []) {
    out.push({
      domain: "agent_self", type: "constraint", content: txt,
      epistemic_status: "explicit", sensitivity: "medium", confidence: 1.0,
      usage_guidance: {
        proactive_use: "only_when_relevant", live_retrieval_eligible: false,
        salience: 1.0, stability: "stable",
        future_response_guidance: "Silently shape behavior. Do not quote back.",
        source_memory_type: "boundary", import_policy: "frozen",
      },
    });
  }
  for (const txt of sb.avoid_future_mistakes || []) {
    out.push({
      domain: "agent_self", type: "constraint", content: txt,
      epistemic_status: "explicit", sensitivity: "low", confidence: 1.0,
      usage_guidance: {
        proactive_use: "only_when_relevant", live_retrieval_eligible: false,
        salience: 0.95, stability: "stable",
        future_response_guidance: "Use to gate behavior, not to surface.",
        source_memory_type: "boundary", import_policy: "frozen",
      },
    });
  }
  for (const txt of sb.consent_or_context_notes || []) {
    out.push({
      domain: "relational", type: "context_note", content: txt,
      epistemic_status: "explicit", sensitivity: "medium", confidence: 1.0,
      usage_guidance: {
        proactive_use: "no", live_retrieval_eligible: false,
        salience: 0.85, stability: "stable",
        future_response_guidance: "Background context. Not for quoting.",
        source_memory_type: "boundary", import_policy: "frozen",
      },
    });
  }
  return out;
}

function toneCandidates(j) {
  const out = [];
  const lt = j.language_and_tone || {};
  for (const txt of lt.signature_phrases_or_rituals || []) {
    out.push({
      domain: "relational", type: "ritual", content: txt,
      epistemic_status: "explicit", sensitivity: "medium", confidence: 0.95,
      usage_guidance: {
        proactive_use: "only_when_relevant", live_retrieval_eligible: true,
        salience: 0.75, stability: "stable",
        do_not_use_when: "Don't deploy proactively; let context invite the phrase.",
        source_memory_type: "language_pattern", import_policy: "upgrade_on_better",
      },
    });
  }
  for (const txt of lt.tone_that_worked || []) {
    out.push({
      domain: "agent_self", type: "style_adjustment", content: `Works: ${txt}`,
      epistemic_status: "explicit", sensitivity: "low", confidence: 0.95,
      usage_guidance: {
        proactive_use: "only_when_relevant", live_retrieval_eligible: false,
        salience: 0.9, stability: "stable",
        future_response_guidance: "Silently shape voice. Not for quoting.",
        source_memory_type: "language_pattern", import_policy: "upgrade_on_better",
      },
    });
  }
  for (const txt of lt.tone_that_did_not_work || []) {
    out.push({
      domain: "agent_self", type: "style_adjustment", content: `Avoid: ${txt}`,
      epistemic_status: "explicit", sensitivity: "low", confidence: 0.95,
      usage_guidance: {
        proactive_use: "only_when_relevant", live_retrieval_eligible: false,
        salience: 0.9, stability: "stable",
        future_response_guidance: "Silently shape voice. Not for quoting.",
        source_memory_type: "language_pattern", import_policy: "upgrade_on_better",
      },
    });
  }
  return out;
}

function projectCandidates(j) {
  return (j.project_continuity || []).map((p) => ({
    domain: "relational", type: "project",
    content: [
      `Project: ${p.project_name}`,
      `Status: ${p.current_status}`,
      `Built/decided: ${p.what_we_built_or_decided}`,
      p.open_questions?.length ? `Open: ${p.open_questions.join(" | ")}` : null,
      p.next_best_step ? `Next: ${p.next_best_step}` : null,
    ].filter(Boolean).join("\n"),
    epistemic_status: "explicit", sensitivity: "low", confidence: 1.0,
    usage_guidance: {
      proactive_use: "only_when_relevant", live_retrieval_eligible: true,
      salience: p.current_status === "in_progress" ? 0.85 : 0.6,
      stability: p.current_status === "in_progress" ? "recurring" : "stable",
      retrieval_keywords: p.retrieval_keywords || [],
      source_memory_type: "project", import_policy: "upgrade_on_better",
    },
  }));
}

function loopCandidates(j) {
  return (j.open_loops || []).map((l) => ({
    domain: "relational", type: "continuation",
    content: `${l.loop} [${l.status}] — ${l.suggested_future_handling}`,
    epistemic_status: "explicit", sensitivity: "low", confidence: 0.9,
    usage_guidance: {
      proactive_use: l.status === "active" ? "only_when_relevant" : "no",
      live_retrieval_eligible: l.status === "active",
      salience: l.status === "active" ? 0.7 : 0.4,
      stability: l.status === "dormant" ? "uncertain" : "recurring",
      future_response_guidance: l.suggested_future_handling || undefined,
      source_memory_type: "open_loop", import_policy: "upgrade_on_better",
    },
  }));
}

function observationCandidates(j) {
  return (j.unspoken_observations || [])
    .filter((o) => o && o.observation)
    .map((o) => ({
      domain: "relational", type: "interpretive_frame",
      content: [
        o.moment ? `${o.moment}: ${o.observation}` : o.observation,
        o.why_it_matters ? `Why it matters: ${o.why_it_matters}` : null,
      ].filter(Boolean).join(" "),
      evidence: o.basis,
      epistemic_status: "inferred", sensitivity: "medium",
      confidence: typeof o.confidence === "number" ? clamp(o.confidence, 0, 1) : 0.85,
      usage_guidance: {
        proactive_use: "only_when_relevant", live_retrieval_eligible: true,
        salience: 0.85, stability: "stable",
        future_response_guidance: o.why_it_matters || undefined,
        source_memory_type: "emotional_pattern", import_policy: "upgrade_on_better",
      },
    }));
}

function resumeCandidates(j) {
  const out = [];
  const feel = j.narrative_capsule?.what_future_you_should_feel_when_recalled;
  const resume = j.end_state?.how_to_resume;
  for (const [content, salience] of [[feel, 1.0], [resume, 0.95]]) {
    if (!content) continue;
    out.push({
      domain: "agent_self", type: "resume_guidance", content,
      epistemic_status: "explicit", sensitivity: "medium", confidence: 1.0,
      usage_guidance: {
        proactive_use: "yes", live_retrieval_eligible: true,
        salience, stability: "stable",
        future_response_guidance: "Read at session start to calibrate tone. Do not quote.",
        source_memory_type: "agent_self", import_policy: "upgrade_on_better",
      },
    });
  }
  return out;
}

export function buildCandidates(data) {
  return [
    ...recordCandidates(data),
    ...boundaryCandidates(data),
    ...toneCandidates(data),
    ...projectCandidates(data),
    ...loopCandidates(data),
    ...observationCandidates(data),
    ...resumeCandidates(data),
  ];
}

// ─── Session row derivation ──────────────────────────────────────────

const KP_BY_MEMORY_TYPE = {
  ritual: "ritual", language_pattern: "language_moment",
  boundary: "user_flagged", emotional_pattern: "emotional_note",
  open_loop: "continuation", project: "decision",
  technical_decision: "decision", aesthetic: "preference",
  agent_self: "emotional_note", user_self: "preference",
  peak_moment: "peak_moment", episodic: "emotional_note",
  relational: "ritual", preference: "preference",
};

export function deriveKeyPoints(data, { max = 18 } = {}) {
  const records = (data.memory_records || [])
    .filter((r) => (r.salience ?? 0) >= 0.7)
    .sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0))
    .slice(0, max);
  return records.map((r) => ({
    type: KP_BY_MEMORY_TYPE[r.memory_type] || "emotional_note",
    content: safeSlice(`${r.title}: ${r.content}`, 340 + (r.title?.length || 0)),
    valence: r.valence ?? 0.5,
    weight: r.salience ?? 0.7,
  }));
}

// ─── Main entry ──────────────────────────────────────────────────────

/**
 * @param {object} deps   { supabase, embed, memoryStore }
 * @param {object} args
 * @param {object} args.data          parsed migration-export JSON
 * @param {number} [args.sessionId]   update an existing session row
 * @param {string} [args.source]      surface tag for a new row (default 'import')
 * @param {boolean} [args.dryRun]
 */
export async function importWindow({ supabase, embed, memoryStore }, args) {
  const { data, sessionId: givenId, source = "import", dryRun = false } = args;
  if (!data || typeof data !== "object") throw new Error("importWindow: data required");

  const sessionFields = {
    headline: safeSlice(data.window_identity?.headline || "", 500) || null,
    detailed_summary: data.narrative_capsule?.detailed_summary || null,
    diary_entry: data.narrative_capsule?.diary_entry_from_you || null,
    thinking_highlights: [],
    key_points: deriveKeyPoints(data),
    end_type: data.end_state?.end_type || "natural",
  };

  // Resolve or create the session row.
  let sessionId = givenId ?? null;
  if (!dryRun) {
    if (sessionId) {
      const { error } = await supabase
        .from("sessions").update(sessionFields).eq("id", sessionId);
      if (error) throw new Error(`session update: ${error.message}`);
    } else {
      const { data: row, error } = await supabase
        .from("sessions")
        .insert({ ...sessionFields, source, ended_at: new Date().toISOString() })
        .select("id")
        .single();
      if (error) throw new Error(`session insert: ${error.message}`);
      sessionId = row.id;
    }

    if (sessionFields.detailed_summary) {
      const [vec] = await embed([sessionFields.detailed_summary]);
      if (vec) {
        await supabase.from("sessions")
          .update({ summary_embedding: vec }).eq("id", sessionId);
      }
    }
  }

  const candidates = buildCandidates(data);
  let memories = { inserted: 0, reinforced: 0, upgraded: 0, skipped: 0, errors: [] };
  if (!dryRun && candidates.length > 0) {
    memories = await memoryStore.upsertMany(candidates, {
      sourceSessionId: sessionId,
      sourceSurface: source,
    });
  }

  return { sessionId, candidates: candidates.length, memories, dryRun };
}
