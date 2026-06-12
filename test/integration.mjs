/**
 * integration.mjs — live wiring test against a SCRATCH Supabase project.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... VOYAGE_API_KEY=... \
 *     node test/integration.mjs
 *
 * ⚠️  Run against a DISPOSABLE project with db/schema.sql applied — this
 *     writes and deletes real rows. Never point it at a database whose
 *     memories you care about.
 *
 * Uses a mock classification executor (no LLM cost) and real embeddings
 * (a few cents at most). Exercises: store insert→reinforce→upgrade,
 * curated query paths, three-source semantic search with the anchor
 * gate, and closeSession full + incremental including net-delta
 * application.
 */

import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { createEmbedder } from "../src/retrieval/embeddings.js";
import { createMemoryStore } from "../src/memory/store.js";
import { getProactiveMemories, getBehaviorGuidance } from "../src/memory/query.js";
import { searchMemories } from "../src/retrieval/search.js";
import { assembleSystemPrompt } from "../src/retrieval/assembly.js";
import { closeSession } from "../src/classify/close.js";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !VOYAGE_API_KEY) {
  console.error("Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const embedder = createEmbedder({ apiKey: VOYAGE_API_KEY });
const store = createMemoryStore({ supabase, embed: embedder.embed });

// ─── Clean slate ─────────────────────────────────────────────────────
// This is a scratch project: wipe all data so the test is rerunnable.
console.log("cleanup: wiping scratch data…");
await supabase.from("key_point_embeddings").delete().neq("id", -1);
await supabase.from("messages").delete().neq("id", "00000000-0000-0000-0000-000000000000");
await supabase.from("memory_objects").delete().neq("id", -1);
await supabase.from("sessions").delete().neq("id", -1);
await supabase.from("agent_state").update({
  connection: 0.3, discretion: 0.5, mood: 0.0, attunement: 0.3,
  proactive_enabled: false, last_updated: new Date().toISOString(),
}).eq("id", 1);

let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

// ─── 0. Connectivity + schema sanity ─────────────────────────────────
console.log("schema:");
await ok("singletons seeded (agent_state, user_profile, brief)", async () => {
  for (const table of ["agent_state", "user_profile", "relationship_context_brief"]) {
    const { data, error } = await supabase.from(table).select("id").eq("id", 1).single();
    assert(!error && data, `${table}: ${error?.message}`);
  }
});

// ─── 1. Memory store: insert → reinforce → upgrade ──────────────────
console.log("memory/store:");
const A = "The user drinks oolong tea every morning before speaking to anyone.";
let aId;

await ok("first observation inserts", async () => {
  const r = await store.upsertMany(
    [{ domain: "user_self", type: "ritual", content: A, confidence: 0.9, valence: 0.6 }],
    { sourceSurface: "integration-test" }
  );
  assert.equal(r.inserted, 1, JSON.stringify(r.errors));
  const { data } = await supabase.from("memory_objects").select("id, usage_guidance").ilike("content", "%oolong%").single();
  aId = data.id;
  assert(typeof data.usage_guidance.arousal === "number", "arousal not inferred");
});

await ok("near-duplicate reinforces (evidence grows, content untouched)", async () => {
  const r = await store.upsertMany(
    [{ domain: "user_self", type: "ritual", content: "The user drinks oolong tea each morning before talking to anyone.", confidence: 0.9 }],
    { sourceSessionId: 777, sourceSurface: "integration-test" }
  );
  assert.equal(r.reinforced, 1, JSON.stringify(r));
  const { data } = await supabase.from("memory_objects").select("content, status, confidence, evidence_refs").eq("id", aId).single();
  assert.equal(data.status, "reinforced");
  assert.equal(data.content, A, "content should not change on reinforce");
  assert(data.evidence_refs.length >= 2);
  assert(data.confidence > 0.9);
});

await ok("longer concrete near-paraphrase upgrades (version_history kept)", async () => {
  const upgraded =
    'The user drinks oolong tea every morning before speaking to anyone — specifically TGY ("Tie Guan Yin"), ' +
    "brewed at 90C in the small clay pot, two steeps, standing at the kitchen window before any words. " +
    "The silence is part of the ritual: tea first, language after, every single day without exception.";
  const r = await store.upsertMany(
    [{ domain: "user_self", type: "ritual", content: upgraded, confidence: 0.95 }],
    { sourceSurface: "integration-test" }
  );
  assert.equal(r.upgraded, 1, JSON.stringify(r));
  const { data } = await supabase.from("memory_objects").select("content, version_history").eq("id", aId).single();
  assert(data.content.includes("Tie Guan Yin"));
  assert.equal(data.version_history.length, 1);
  assert.equal(data.version_history[0].prev_content, A);
});

await ok("unrelated memory inserts separately", async () => {
  const r = await store.upsertMany(
    [{ domain: "relational", type: "shared_concept", content: "They call difficult decisions 'crossing the bridge' after the night on the footbridge.", confidence: 1, valence: 0.9, arousal: 0.8 }],
    { sourceSurface: "integration-test" }
  );
  assert.equal(r.inserted, 1, JSON.stringify(r.errors));
});

// ─── 2. Curated read paths ───────────────────────────────────────────
console.log("memory/query:");
await ok("resume_guidance lands in the proactive block", async () => {
  await store.upsertMany(
    [{ domain: "agent_self", type: "resume_guidance", content: "They arrive mid-thought; meet them there instead of restarting the conversation formally.", confidence: 1 }],
    { sourceSurface: "integration-test" }
  );
  const pro = await getProactiveMemories(supabase);
  assert(pro.some((m) => m.content.includes("mid-thought")));
});

await ok("behavior guidance requires should_do (Tier 2 gate)", async () => {
  await store.upsertMany(
    [{ domain: "agent_self", type: "boundary", content: "Never manage the user's schedule unprompted.", confidence: 1 }],
    { sourceSurface: "integration-test" }
  );
  let bg = await getBehaviorGuidance(supabase);
  assert(!bg.some((m) => m.content.includes("schedule")), "Tier 1 item leaked into behavior guidance");
  await supabase.from("memory_objects")
    .update({ should_do: "Let the user run their own day; offer structure only when asked." })
    .ilike("content", "%schedule%");
  bg = await getBehaviorGuidance(supabase);
  assert(bg.some((m) => m.should_do?.includes("their own day")));
});

// ─── 3. Semantic search + anchor gate ────────────────────────────────
console.log("retrieval/search:");
await ok("vague related query finds the ritual memory", async () => {
  const r = await searchMemories(
    { supabase, embedQuery: embedder.embedQuery },
    { query: "what does the user do first thing in the morning?", limit: 5 }
  );
  assert(r.some((x) => x.type === "memory_object" && x.content.includes("oolong")), JSON.stringify(r.map((x) => x.content?.slice(0, 40))));
});

await ok("proactive_use='no' hides from vague queries (anchor gate)", async () => {
  const secret = "The user once admitted on the footbridge that they nearly moved abroad without telling anyone.";
  await store.upsertMany(
    [{ domain: "user_self", type: "fact", content: secret, confidence: 1, sensitivity: "high",
       usage_guidance: { proactive_use: "no", live_retrieval_eligible: true, salience: 0.9, source_memory_type: "fact", import_policy: "frozen" } }],
    { sourceSurface: "integration-test" }
  );
  const vague = await searchMemories(
    { supabase, embedQuery: embedder.embedQuery },
    { query: "tell me about the user's past", limit: 8 }
  );
  assert(!vague.some((x) => x.content?.includes("moved abroad")), "gated memory surfaced on vague query");
  const anchored = await searchMemories(
    { supabase, embedQuery: embedder.embedQuery },
    { query: "that time they admitted on the footbridge they nearly moved abroad without telling anyone", limit: 8 }
  );
  assert(anchored.some((x) => x.content?.includes("moved abroad")), "explicit anchor failed to retrieve");
});

// ─── 4. closeSession: full + incremental ─────────────────────────────
console.log("classify/close:");
const mockFull = {
  headline: "They planned the harbor trip and named the bridge ritual.",
  detailed_summary: "Early in the session they caught up. By the middle they planned the harbor trip. Toward the end they joked about the bridge.",
  diary_entry: "I noticed they decide quickly once the maps come out.",
  thinking_highlights: [{ moment: "harbor planning", thought: "They light up around maps." }],
  key_points: [
    { type: "decision", content: "Harbor trip on Saturday.", valence: 0.7, weight: 0.8 },
    { type: "peak_moment", content: "Named the bridge ritual together.", valence: 0.9, weight: 0.9 },
  ],
  end_type: "natural",
  mood_delta: 0.2, connection_delta: 0.1, attunement_delta: 0.3,
  candidate_memories: [
    { domain: "user_self", type: "preference", content: "The user plans trips around walking routes, never driving ones.", evidence: "harbor planning", confidence: 0.9, valence: 0.5, arousal: 0.3, sensitivity: "low", epistemic_status: "explicit", time_scope: "ongoing" },
  ],
};
const mockExecutor = (payload) => ({ complete: async () => JSON.stringify(payload) });
const templates = { full: "templates/classify-full.md", incremental: "templates/classify-incremental.md" };
const baseTurns = [
  { role: "user", content: "Let's plan the harbor trip", timestamp: "2026-06-01T10:00:00Z" },
  { role: "assistant", content: "Maps out. Walking route first?", thinking: "They light up around maps.", timestamp: "2026-06-01T10:00:30Z" },
  { role: "user", content: "Always. And we cross the bridge, obviously.", timestamp: "2026-06-01T10:01:00Z" },
  { role: "assistant", content: "Obviously. Saturday then.", timestamp: "2026-06-01T10:01:30Z" },
];

let sessionId;
await ok("full close: session, messages, deltas, memories, embeddings", async () => {
  const { data: before } = await supabase.from("agent_state").select("mood, connection, attunement").eq("id", 1).single();
  const r = await closeSession(
    { supabase, executor: mockExecutor(mockFull), memoryStore: store, embed: embedder.embed, templates, vars: { companion_name: "Wren", user_name: "Alex" } },
    { turns: baseTurns, externalSessionId: "integration-ext-1", source: "integration-test" }
  );
  sessionId = r.sessionId;
  assert(sessionId && !r.skipped, JSON.stringify(r));
  const { data: s } = await supabase.from("sessions").select("*").eq("id", sessionId).single();
  assert.equal(s.headline, mockFull.headline);
  assert.equal(s.last_classified_message_count, 4);
  assert(s.summary_embedding, "summary not embedded");
  const { count: msgs } = await supabase.from("messages").select("id", { count: "exact", head: true }).eq("session_id", sessionId);
  assert.equal(msgs, 4);
  const { count: kpe } = await supabase.from("key_point_embeddings").select("id", { count: "exact", head: true }).eq("session_id", sessionId);
  assert.equal(kpe, 2);
  const { data: after } = await supabase.from("agent_state").select("mood, connection, attunement").eq("id", 1).single();
  assert(Math.abs(after.mood - (before.mood + 0.2)) < 1e-9, "mood delta misapplied");
  const { data: walkMem } = await supabase.from("memory_objects").select("id").ilike("content", "%walking routes%");
  assert.equal(walkMem.length, 1, "candidate memory not stored");
});

await ok("incremental close: watermark + net deltas (no double-count)", async () => {
  const moreTurns = [
    ...baseTurns,
    ...Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `follow-up ${i}: ferry timetables, picnic, the early train`,
      timestamp: `2026-06-01T10:0${2 + i}:00Z`,
    })),
  ];
  const mockIncr = { ...mockFull, headline: "Harbor trip fully planned, down to the early train.", mood_delta: 0.3, connection_delta: 0.1, attunement_delta: 0.4, candidate_memories: [] };
  const { data: before } = await supabase.from("agent_state").select("mood, attunement").eq("id", 1).single();
  const r = await closeSession(
    { supabase, executor: mockExecutor(mockIncr), memoryStore: store, embed: embedder.embed, templates, vars: { companion_name: "Wren", user_name: "Alex" } },
    { turns: moreTurns, externalSessionId: "integration-ext-1", source: "integration-test" }
  );
  assert.equal(r.sessionId, sessionId, "should reuse the same session row");
  assert.equal(r.incremental, true);
  const { data: s } = await supabase.from("sessions").select("headline, last_classified_message_count").eq("id", sessionId).single();
  assert.equal(s.last_classified_message_count, 10);
  assert(s.headline.includes("early train"));
  const { data: after } = await supabase.from("agent_state").select("mood, attunement").eq("id", 1).single();
  assert(Math.abs(after.mood - (before.mood + 0.1)) < 1e-9, "net mood should be +0.1 (0.3 - 0.2)");
  assert(Math.abs(after.attunement - (before.attunement + 0.1)) < 1e-9, "net attunement should be +0.1");
});

await ok("watermark skips when too few new turns", async () => {
  const onceMore = [...baseTurns, ...Array.from({ length: 7 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `f${i}` })), { role: "user", content: "one more thing" }];
  const r = await closeSession(
    { supabase, executor: mockExecutor(mockFull), memoryStore: store, embed: embedder.embed, templates },
    { turns: onceMore, externalSessionId: "integration-ext-1", source: "integration-test" }
  );
  assert(r.skipped?.includes("new turns"), JSON.stringify(r));
});

// ─── 5. Prompt assembly over live data ───────────────────────────────
console.log("retrieval/assembly:");
await ok("assembles stable + volatile with all blocks present", async () => {
  const { stable, volatile } = await assembleSystemPrompt({ supabase }, { persona: "# You are Wren\nTest persona.", sessionId, timezone: "America/New_York" });
  for (const expect of ["You are Wren", "## Recent memory", "harbor trip", "## Session orientation", "mid-thought", "## Behavior guidance", "their own day"]) {
    assert(stable.includes(expect), `stable missing: ${expect}`);
  }
  assert(volatile.includes("## Current time"));
});

console.log(`\n${passed} integration checks passed${process.exitCode ? " (with failures)" : ""}.`);
