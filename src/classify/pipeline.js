/**
 * pipeline.js — classification call + robust parsing + sanitization.
 *
 * The classifier returns JSON; models occasionally wrap it in fences,
 * preface it with prose, or truncate mid-stream at the token limit.
 * parseClassification() survives all three (fence-strip → outer-brace
 * match → truncation salvage that rebalances brackets).
 */

import { clamp, safeSlice } from "../memory/guidance.js";

export const VALID_KEY_POINT_TYPES = new Set([
  "decision", "open_question", "preference", "user_flagged",
  "continuation", "emotional_note", "ritual", "language_moment", "peak_moment",
]);

// ─── Parsing ─────────────────────────────────────────────────────────

/** Attempt to repair JSON truncated mid-stream at a token limit. */
function salvageTruncated(text) {
  const lastBrace = text.lastIndexOf("}");
  if (lastBrace === -1) return null;
  let candidate = text.slice(0, lastBrace + 1);
  // Balance any brackets/braces left open before the cut.
  let depthCurly = 0;
  let depthSquare = 0;
  let inString = false;
  let escape = false;
  for (const ch of candidate) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depthCurly++;
    else if (ch === "}") depthCurly--;
    else if (ch === "[") depthSquare++;
    else if (ch === "]") depthSquare--;
  }
  if (inString) candidate += '"';
  candidate += "]".repeat(Math.max(0, depthSquare));
  candidate += "}".repeat(Math.max(0, depthCurly));
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export function parseClassification(rawText) {
  let text = (rawText || "").trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "");
  const match = text.match(/\{[\s\S]*\}/);
  if (match) text = match[0];
  try {
    return JSON.parse(text);
  } catch {
    const salvaged = salvageTruncated(text);
    if (salvaged) return salvaged;
    throw new Error(
      `classification JSON unparseable (first 200 chars): ${text.slice(0, 200)}`
    );
  }
}

// ─── Sanitization ────────────────────────────────────────────────────

export function sanitizeKeyPoints(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (kp) =>
        kp && typeof kp === "object" &&
        typeof kp.content === "string" &&
        VALID_KEY_POINT_TYPES.has(kp.type)
    )
    .map((kp) => {
      const point = { type: kp.type, content: safeSlice(kp.content, 500) };
      if (typeof kp.valence === "number" && !isNaN(kp.valence)) {
        point.valence = clamp(kp.valence, -1, 1);
      }
      if (typeof kp.weight === "number" && !isNaN(kp.weight)) {
        point.weight = clamp(kp.weight, 0, 1);
      }
      return point;
    });
}

export function sanitizeThinkingHighlights(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (h) =>
        h && typeof h === "object" &&
        typeof h.moment === "string" &&
        typeof h.thought === "string"
    )
    .map((h) => ({
      moment: safeSlice(h.moment, 200),
      thought: safeSlice(h.thought, 600),
    }))
    .slice(0, 6);
}

/** Normalize a parsed classification into a stable result shape. */
export function sanitizeClassification(parsed, { hintEndType } = {}) {
  return {
    headline: parsed.headline || parsed.summary || "",
    detailed_summary: parsed.detailed_summary || "",
    diary_entry: parsed.diary_entry || "",
    thinking_highlights: sanitizeThinkingHighlights(parsed.thinking_highlights),
    key_points: sanitizeKeyPoints(parsed.key_points),
    end_type: parsed.end_type || hintEndType || "unknown",
    mood_delta: clamp(parsed.mood_delta ?? 0, -0.5, 0.5),
    connection_delta: clamp(parsed.connection_delta ?? 0, -0.5, 0.5),
    attunement_delta: clamp(parsed.attunement_delta ?? 0, 0, 1),
    candidate_memories: Array.isArray(parsed.candidate_memories)
      ? parsed.candidate_memories
      : [],
  };
}
