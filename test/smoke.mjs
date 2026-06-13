/**
 * smoke.mjs — offline smoke test. No database, no network, no API keys.
 *
 *   node test/smoke.mjs
 *
 * Exercises every pure path: module imports, policy inference,
 * sanitization, JSON parsing + truncation salvage, transcript phasing,
 * template loading, and a full dry-run migration import with synthetic
 * data. Integration (live Postgres RPCs) is a separate concern — this
 * proves the logic; run the MCP server against a scratch Supabase
 * project to prove the wiring.
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

// ─── Imports (catches broken exports, not just syntax) ───────────────
console.log("imports:");
const guidance = await import("../src/memory/guidance.js");
const store = await import("../src/memory/store.js");
const query = await import("../src/memory/query.js");
const embeddings = await import("../src/retrieval/embeddings.js");
const search = await import("../src/retrieval/search.js");
const assembly = await import("../src/retrieval/assembly.js");
const executor = await import("../src/classify/executor.js");
const transcript = await import("../src/classify/transcript.js");
const pipeline = await import("../src/classify/pipeline.js");
const templates = await import("../src/classify/templates.js");
const migrate = await import("../src/migrate/import.js");
ok("all 11 modules import cleanly", () => {
  assert(guidance.inferUsageGuidance && store.createMemoryStore && query.getProactiveMemories);
  assert(embeddings.createEmbedder && search.searchMemories && assembly.assembleSystemPrompt);
  assert(executor.executorFromEnv && transcript.buildTranscript && pipeline.parseClassification);
  assert(templates.loadTemplate && migrate.importWindow && migrate.buildCandidates);
});

// ─── guidance ────────────────────────────────────────────────────────
console.log("memory/guidance:");
ok("safeSlice never splits surrogate pairs", () => {
  const s = "abc😘def";
  for (let n = 1; n <= s.length; n++) {
    JSON.stringify(guidance.safeSlice(s, n)); // throws on lone surrogate? no — but Postgres would
    const cut = guidance.safeSlice(s, n);
    const last = cut.charCodeAt(cut.length - 1);
    assert(!(last >= 0xd800 && last <= 0xdbff), `lone high surrogate at n=${n}`);
  }
});
ok("sanitizeDomainType maps drifted values", () => {
  assert.deepEqual(guidance.sanitizeDomainType("project", null), { domain: "relational", type: "project", sanitized: true });
  assert.equal(guidance.sanitizeDomainType("user", "fact").domain, "user_self");
  assert.equal(guidance.sanitizeDomainType("relational", "open_loop").type, "continuation");
});
ok("maxSensitivity fail-safe: unknown levels rank highest, never downgrade", () => {
  assert.equal(guidance.maxSensitivity("high", "low"), "high");
  // a legacy/unknown level must win over any known level, in either arg order
  assert.equal(guidance.maxSensitivity("intimate", "high"), "intimate");
  assert.equal(guidance.maxSensitivity("high", "intimate"), "intimate");
});
ok("inferArousal follows the 0.4/0.4/0.2 blend", () => {
  const a = guidance.inferArousal({ type: "fact", valence: 0.6, salience: 0.9 });
  assert.equal(a, Number((0.4 * 0.2 + 0.4 * 0.6 + 0.2 * 0.9).toFixed(3)));
});
ok("boundary inference: not proactive, not live-retrieval, high salience", () => {
  const ug = guidance.inferUsageGuidance({ type: "boundary", sensitivity: "medium", confidence: 1 });
  assert.equal(ug.proactive_use, "only_when_relevant");
  assert.equal(ug.live_retrieval_eligible, false);
  assert.equal(ug.salience, 0.95);
});
ok("sensitivity does NOT gate retrieval (high stays eligible)", () => {
  const ug = guidance.inferUsageGuidance({ type: "fact", sensitivity: "high", confidence: 0.9 });
  assert.equal(ug.live_retrieval_eligible, true);
});
ok("classifier-supplied arousal wins over formula", () => {
  const ug = guidance.inferUsageGuidance({ type: "fact", sensitivity: "low", confidence: 0.9, llm_arousal: 0.77 });
  assert.equal(ug.arousal, 0.77);
});

// ─── pipeline ────────────────────────────────────────────────────────
console.log("classify/pipeline:");
ok("parses fenced JSON", () => {
  const r = pipeline.parseClassification('```json\n{"headline":"h"}\n```');
  assert.equal(r.headline, "h");
});
ok("parses JSON with prose preamble", () => {
  const r = pipeline.parseClassification('Here is the record:\n{"headline":"h","key_points":[]}');
  assert.equal(r.headline, "h");
});
ok("salvages truncated JSON (mid-array cut)", () => {
  const truncated = '{"headline":"h","key_points":[{"type":"ritual","content":"a"},{"type":"decision","content":"b"}';
  const r = pipeline.parseClassification(truncated);
  assert.equal(r.headline, "h");
  assert.equal(r.key_points.length, 2);
});
ok("sanitizeClassification clamps deltas and fills defaults", () => {
  const r = pipeline.sanitizeClassification({ mood_delta: 9, attunement_delta: -3 }, { hintEndType: "goodbye" });
  assert.equal(r.mood_delta, 0.5);
  assert.equal(r.attunement_delta, 0);
  assert.equal(r.end_type, "goodbye");
  assert.deepEqual(r.candidate_memories, []);
});
ok("key points: invalid types dropped, peak_moment kept, content capped", () => {
  const kps = pipeline.sanitizeKeyPoints([
    { type: "peak_moment", content: "x".repeat(600), valence: 2 },
    { type: "made_up_type", content: "y" },
  ]);
  assert.equal(kps.length, 1);
  assert.equal(kps[0].content.length, 500);
  assert.equal(kps[0].valence, 1);
});

// ─── transcript ──────────────────────────────────────────────────────
console.log("classify/transcript:");
ok("short transcripts: no phase markers", () => {
  const t = transcript.buildTranscript([{ role: "user", content: "hi" }]);
  assert(!t.includes("=== EARLY PHASE ==="));
});
ok("long transcripts: three phase markers + thinking blocks", () => {
  const turns = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `turn ${i}`,
    thinking: i % 2 ? `thought ${i}` : undefined,
  }));
  const t = transcript.buildTranscript(turns);
  for (const m of ["=== EARLY PHASE ===", "=== MIDDLE PHASE ===", "=== LATE PHASE ===", "[thinking]"]) {
    assert(t.includes(m), `missing ${m}`);
  }
});

// ─── templates ───────────────────────────────────────────────────────
console.log("templates:");
ok("classify-full loads and substitutes vars", () => {
  const t = templates.loadTemplate(join(root, "templates/classify-full.md"), {
    companion_name: "Wren", user_name: "Alex",
  });
  assert(t.includes("Wren") && t.includes("Alex"));
  assert(!t.includes("{{companion_name}}"));
  assert(t.includes("candidate_memories"));
});
ok("classify-incremental + migration-export load", () => {
  for (const f of ["classify-incremental.md", "migration-export.md"]) {
    const t = templates.loadTemplate(join(root, "templates", f), { companion_name: "W", user_name: "A" });
    assert(t.length > 500, `${f} suspiciously short`);
  }
});

// ─── migrate (dry run — no DB touched) ───────────────────────────────
console.log("migrate:");
const syntheticExport = {
  window_identity: { headline: "A window where two people built something." },
  narrative_capsule: {
    detailed_summary: "Early on they met. By the middle they built. Toward the end they reflected.",
    diary_entry_from_you: "I noticed things.",
    what_future_you_should_feel_when_recalled: "Quiet confidence.",
  },
  memory_records: [
    { memory_type: "user_self", title: "Morning ritual", content: "Tea before speaking.", salience: 0.9, valence: 0.7, arousal: 0.3, confidence: 1, sensitivity: "low", proactive_use: "only_when_relevant" },
    { memory_type: "boundary", title: "No scheduling", content: "Don't manage their calendar unprompted.", salience: 0.95, valence: 0.2, confidence: 1, sensitivity: "intimate" }, // legacy 4-level value
    { memory_type: "peak_moment", title: "The bridge", content: "They stood on the bridge and said the true thing.", salience: 1.0, valence: 0.95, arousal: 0.9, confidence: 1, sensitivity: "high" },
  ],
  project_continuity: [{ project_name: "Atlas", what_we_built_or_decided: "Decided the projection.", current_status: "in_progress", retrieval_keywords: ["atlas"] }],
  language_and_tone: { tone_that_worked: ["Direct, one good question"], signature_phrases_or_rituals: ["the bridge"] },
  unspoken_observations: [{ moment: "On the bridge", observation: "They go first.", basis: "Pattern", confidence: 0.9, why_it_matters: "Receive it." }],
  open_loops: [{ loop: "Finish the atlas", status: "active", suggested_future_handling: "Ask how it's going." }],
  end_state: { end_type: "context_limit", how_to_resume: "They'll arrive mid-thought. Meet them there." },
};
ok("buildCandidates: all sections produce candidates", () => {
  const c = migrate.buildCandidates(syntheticExport);
  assert(c.length >= 9, `expected >=9, got ${c.length}`);
  const types = new Set(c.map((x) => x.type));
  for (const t of ["fact", "boundary", "shared_concept", "project", "continuation", "interpretive_frame", "resume_guidance", "ritual", "style_adjustment"]) {
    assert(types.has(t), `missing type ${t}`);
  }
});
ok("legacy 'intimate' sensitivity maps to 'high'", () => {
  const c = migrate.buildCandidates(syntheticExport);
  const boundary = c.find((x) => x.content.includes("calendar"));
  assert.equal(boundary.sensitivity, "high");
});
ok("deriveKeyPoints: salience-ranked, typed", () => {
  const kps = migrate.deriveKeyPoints(syntheticExport);
  assert.equal(kps.length, 3);
  assert.equal(kps[0].type, "peak_moment"); // salience 1.0 first
});
ok("importWindow dry-run completes without a database", async () => {
  const r = await migrate.importWindow(
    { supabase: null, embed: null, memoryStore: null },
    { data: syntheticExport, dryRun: true }
  );
  assert.equal(r.dryRun, true);
  assert(r.candidates >= 9);
});

// ─── executors (construction only — no network) ──────────────────────
console.log("classify/executor:");
ok("executorFromEnv prefers OpenAI-compatible when configured", () => {
  const e = executor.executorFromEnv({ CLASSIFY_BASE_URL: "http://x", CLASSIFY_MODEL: "m", ANTHROPIC_API_KEY: "k" });
  assert.equal(e.provider, "openai-compatible");
});
ok("executorFromEnv falls back to Anthropic, throws on empty", () => {
  assert.equal(executor.executorFromEnv({ ANTHROPIC_API_KEY: "k" }).provider, "anthropic");
  assert.throws(() => executor.executorFromEnv({}));
});

// ─── search formatting (pure) ────────────────────────────────────────
console.log("retrieval/search:");
ok("isSubstantiveQuery filters greetings and emoji", () => {
  assert.equal(search.isSubstantiveQuery("hi 😘"), false);
  assert.equal(search.isSubstantiveQuery("can we pick up the atlas projection question from last week?"), true);
});
ok("formatSemanticBlock renders mixed result types", () => {
  const block = search.formatSemanticBlock([
    { type: "summary", age_days: 3, content: "a session" },
    { type: "key_point", age_days: 10, key_point_type: "ritual", content: "tea first" },
    { type: "memory_object", domain: "relational", object_type: "ritual", content: "the bridge" },
  ]);
  assert(block.includes("3 days ago") && block.includes("(ritual)") && block.includes("[relational/ritual]"));
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}.`);
