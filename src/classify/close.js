/**
 * close.js — the session-close orchestrator.
 *
 * One call wires the whole memory lifecycle for a session:
 *
 *   turns → classify (full or incremental) → session row updated →
 *   emotion deltas applied (net) → candidate memories upserted
 *   (dedup/reinforce) → summary + key points embedded
 *
 * Surface-agnostic: callers parse their own transcripts into
 *   [{ role, content, thinking?, timestamp? }]
 * and call closeSession from wherever sessions end — a chat route, a
 * CLI hook, a queue worker, an importer.
 *
 * Incremental design: sessions carry a watermark
 * (last_classified_message_count). Re-classification only happens when
 * at least `minNewTurns` new turns have arrived, and the incremental
 * prompt receives the prior record + only the new turns — per-call cost
 * stays O(new) instead of O(total) as sessions grow.
 */

import { buildTranscript, buildNewTurnsTranscript } from "./transcript.js";
import { loadTemplate } from "./templates.js";
import { parseClassification, sanitizeClassification } from "./pipeline.js";
import { clamp } from "../memory/guidance.js";

/**
 * @param {object} deps
 * @param {object} deps.supabase
 * @param {object} deps.executor      from executor.js (or your own)
 * @param {object} deps.memoryStore   from src/memory/store.js
 * @param {function} deps.embed       async (texts) => vectors
 * @param {object} deps.templates     { full: path, incremental: path }
 * @param {object} [deps.vars]        template vars, e.g. { companion_name, user_name }
 *
 * @param {object} args
 * @param {Array}  args.turns               full turn list for the session
 * @param {number} [args.sessionId]         existing session row id
 * @param {string} [args.externalSessionId] upsert key for surface-managed ids
 * @param {string} [args.source]            surface tag for a newly created row
 * @param {string} [args.hintEndType]       e.g. 'goodbye' when the user signed off
 * @param {number} [args.minNewTurns=5]     incremental re-classify threshold
 * @param {boolean} [args.saveMessages=true] persist turns to the messages table
 */
export async function closeSession(deps, args) {
  const { supabase, executor, memoryStore, embed, templates, vars = {} } = deps;
  const {
    turns,
    sessionId: givenSessionId,
    externalSessionId,
    source = "system",
    hintEndType,
    minNewTurns = 5,
    saveMessages = true,
  } = args;

  if (!turns || turns.length === 0) {
    return { sessionId: givenSessionId ?? null, skipped: "no turns" };
  }

  const startedAt = turns[0]?.timestamp || new Date().toISOString();
  const endedAt = turns[turns.length - 1]?.timestamp || new Date().toISOString();

  // ── Resolve session row ────────────────────────────────────────────
  let sessionId = givenSessionId ?? null;
  let prior = null;

  if (!sessionId && externalSessionId) {
    const { data, error } = await supabase
      .from("sessions")
      .select("id, headline, detailed_summary, diary_entry, thinking_highlights, key_points, last_classified_message_count, mood_delta, connection_delta, attunement_delta")
      .eq("external_session_id", externalSessionId)
      .maybeSingle();
    if (error) throw new Error(`session lookup: ${error.message}`);
    if (data) {
      sessionId = data.id;
      prior = data;
    }
  } else if (sessionId) {
    const { data, error } = await supabase
      .from("sessions")
      .select("id, headline, detailed_summary, diary_entry, thinking_highlights, key_points, last_classified_message_count, mood_delta, connection_delta, attunement_delta")
      .eq("id", sessionId)
      .maybeSingle();
    if (error) throw new Error(`session lookup: ${error.message}`);
    prior = data;
  }

  if (!sessionId) {
    const { data, error } = await supabase
      .from("sessions")
      .insert({
        source,
        external_session_id: externalSessionId ?? null,
        started_at: startedAt,
        ended_at: endedAt,
      })
      .select("id")
      .single();
    if (error) throw new Error(`session insert: ${error.message}`);
    sessionId = data.id;
  } else {
    await supabase.from("sessions").update({ ended_at: endedAt }).eq("id", sessionId);
  }

  // ── Persist messages (replace-by-session keeps reruns idempotent) ──
  if (saveMessages) {
    await supabase.from("messages").delete().eq("session_id", sessionId);
    const rows = turns.map((t) => ({
      id: crypto.randomUUID(),
      session_id: sessionId,
      role: t.role,
      content: t.content,
      thinking: t.thinking || null,
      created_at: t.timestamp || startedAt,
    }));
    const { error } = await supabase.from("messages").insert(rows);
    if (error) throw new Error(`messages insert: ${error.message}`);
  }

  // ── Watermark: classify, incrementally, or not at all ──────────────
  const priorCount = prior?.last_classified_message_count ?? 0;
  if (priorCount >= turns.length) {
    return { sessionId, skipped: "no new turns" };
  }
  const newTurnsCount = turns.length - priorCount;
  if (priorCount > 0 && newTurnsCount < minNewTurns) {
    return { sessionId, skipped: `only ${newTurnsCount} new turns (< ${minNewTurns})` };
  }

  const incremental = priorCount > 0 && !!prior?.headline;

  let system, user;
  if (incremental) {
    system = loadTemplate(templates.incremental, vars);
    const priorRecord = {
      headline: prior.headline,
      detailed_summary: prior.detailed_summary,
      diary_entry: prior.diary_entry,
      thinking_highlights: prior.thinking_highlights || [],
      key_points: prior.key_points || [],
    };
    user = [
      `## Prior memory record (covers turns 1 to ${priorCount})`,
      "",
      "```json",
      JSON.stringify(priorRecord, null, 2),
      "```",
      "",
      `## New turns (${priorCount + 1} to ${turns.length})`,
      "",
      buildNewTurnsTranscript(turns, priorCount),
    ].join("\n");
  } else {
    system = loadTemplate(templates.full, vars);
    user = hintEndType
      ? `Hint: the ending likely matches "${hintEndType}".\n\n## Messages\n${buildTranscript(turns)}`
      : `## Messages\n${buildTranscript(turns)}`;
  }

  const rawText = await executor.complete({ system, user });
  const result = sanitizeClassification(parseClassification(rawText), { hintEndType });

  // ── Update session row ─────────────────────────────────────────────
  const { error: updErr } = await supabase
    .from("sessions")
    .update({
      headline: result.headline || null,
      detailed_summary: result.detailed_summary || null,
      diary_entry: result.diary_entry || null,
      thinking_highlights: result.thinking_highlights,
      key_points: result.key_points,
      end_type: result.end_type,
      mood_delta: result.mood_delta,
      connection_delta: result.connection_delta,
      attunement_delta: result.attunement_delta,
      last_classified_message_count: turns.length,
    })
    .eq("id", sessionId);
  if (updErr) throw new Error(`session update: ${updErr.message}`);

  // ── Apply emotion deltas (net of anything previously applied) ──────
  // Classification deltas are cumulative per session; on re-classification
  // we apply only the difference so state never double-counts.
  const net = {
    mood: result.mood_delta - (prior?.mood_delta ?? 0),
    connection: result.connection_delta - (prior?.connection_delta ?? 0),
    attunement: result.attunement_delta - (prior?.attunement_delta ?? 0),
  };
  if (net.mood !== 0 || net.connection !== 0 || net.attunement !== 0) {
    const { data: state } = await supabase
      .from("agent_state").select("*").eq("id", 1).maybeSingle();
    if (state) {
      await supabase
        .from("agent_state")
        .update({
          mood: clamp((state.mood ?? 0) + net.mood, -1, 1),
          connection: clamp((state.connection ?? 0) + net.connection, 0, 1),
          attunement: clamp((state.attunement ?? 0) + net.attunement, 0, 1),
          last_updated: new Date().toISOString(),
        })
        .eq("id", 1);
    }
  }

  // ── Candidate memories → dedup/reinforce/insert ────────────────────
  let memories = null;
  if (result.candidate_memories.length > 0) {
    memories = await memoryStore.upsertMany(result.candidate_memories, {
      sourceSessionId: sessionId,
      sourceSurface: source,
    });
  }

  // ── Embeddings: summary onto the session, key points into their table
  try {
    const texts = [];
    const kinds = [];
    if (result.detailed_summary) {
      texts.push(result.detailed_summary);
      kinds.push({ kind: "summary" });
    }
    for (const kp of result.key_points) {
      texts.push(kp.content);
      kinds.push({ kind: "key_point", kp });
    }
    if (texts.length > 0) {
      const vectors = await embed(texts);
      const writes = [];
      // Re-embedding key points on re-classification: replace, don't append.
      await supabase.from("key_point_embeddings").delete().eq("session_id", sessionId);
      for (let i = 0; i < kinds.length; i++) {
        if (!vectors[i]) continue;
        if (kinds[i].kind === "summary") {
          writes.push(
            supabase.from("sessions")
              .update({ summary_embedding: vectors[i] })
              .eq("id", sessionId)
          );
        } else {
          writes.push(
            supabase.from("key_point_embeddings").insert({
              session_id: sessionId,
              type: kinds[i].kp.type,
              content: kinds[i].kp.content,
              embedding: vectors[i],
            })
          );
        }
      }
      await Promise.all(writes);
    }
  } catch (err) {
    // Embeddings are best-effort: the session still closes cleanly without
    // semantic indexing; a backfill can repair it later.
    console.error("[sostenuto] embedding failed (non-fatal):", err.message);
  }

  return {
    sessionId,
    incremental,
    headline: result.headline,
    keyPoints: result.key_points.length,
    memories,
  };
}
