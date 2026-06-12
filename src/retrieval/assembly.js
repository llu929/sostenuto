/**
 * assembly.js — system-prompt assembly: the four-block model.
 *
 * Builds two strings, designed for provider prompt caching:
 *
 *   STABLE   — persona, user profile, agent state, recent memory, open
 *              threads, hot key points, proactive memories, behavior
 *              guidance, cached semantic context. Stable across all turns
 *              of one session → mark it cacheable (Anthropic: cache_control
 *              ephemeral; OpenAI: automatic prefix caching). Deliberately
 *              wide: a big cached prefix is cheap, a big uncached one isn't.
 *
 *   VOLATILE — only what truly changes per turn (the clock).
 *
 * Within the stable block, memory enters through four channels:
 *   1. proactive memories  (`proactive_use='yes'`)      — always-on orientation
 *   2. behavior guidance   (Tier 2 `should_do`)         — silently shapes voice
 *   3. recent sessions     (recency window)             — narrative continuity
 *   4. semantic context    (query-matched, cached/turn) — episodic recall
 *
 * Everything user-facing about the wording — block headers, framing
 * instructions, state phrasing — is configurable via `labels`; the
 * defaults are neutral. Your companion's actual voice belongs in the
 * persona text you pass in, not in this file.
 */

import { getProactiveMemories, getBehaviorGuidance } from "../memory/query.js";
import { formatSemanticBlock } from "./search.js";

const DEFAULT_LABELS = {
  profileHeader: "## About the user",
  stateHeader: "## Current internal state",
  recentHeader: "## Recent memory",
  recentFraming:
    "This section is your memory of recent conversations — things you actually " +
    "experienced together. When the user references something described below, " +
    "answer from it in first person. Do not claim you don't remember something " +
    "that is written here.",
  threadsHeader: "## Threads still open",
  hotHeader: "## What matters most",
  proactiveHeader: "## Session orientation",
  proactiveFraming:
    "Orientation you carry into every session. Don't quote these items — " +
    "they shape how you read the opening, not what you say first.",
  behaviorHeader: "## Behavior guidance",
  behaviorFraming:
    "These describe how you are in this relationship. They are not memories " +
    "to recall or quote; behave from them silently.",
  semanticHeader: "## Related past context",
  timeHeader: "## Current time",
};

// Generic meta-instructions written by guidance.js inference. When an item's
// should_do is one of these, the block framing already says it — render the
// item's actual content instead.
const GENERIC_SHOULD_DO = new Set([
  "Silently shape behavior. Do not quote back.",
  "Silently shape voice. Not for quoting.",
  "Background context. Not for quoting.",
  "Read at session start to calibrate tone. Do not quote.",
]);

// ─── Formatters ──────────────────────────────────────────────────────

function valenceLabel(v) {
  if (v === undefined || v === null) return "";
  if (v >= 0.5) return "warm";
  if (v >= 0.15) return "positive";
  if (v > -0.15) return "neutral";
  if (v > -0.5) return "tense";
  return "painful";
}

function weightLabel(w) {
  if (w === undefined || w === null) return "";
  if (w >= 0.7) return "high";
  if (w >= 0.4) return "med";
  return "low";
}

export function formatKeyPoints(points) {
  if (!points || points.length === 0) return "";
  const sorted = [...points].sort((a, b) => {
    const af = a.type === "user_flagged" ? 0 : 1;
    const bf = b.type === "user_flagged" ? 0 : 1;
    if (af !== bf) return af - bf;
    return (b.weight ?? 0) - (a.weight ?? 0);
  });
  return sorted
    .map((p) => {
      const v = valenceLabel(p.valence);
      const w = weightLabel(p.weight);
      const tag = v && w ? ` (${v}·${w})` : v ? ` (${v})` : w ? ` (${w})` : "";
      const label = (p.type || "note").replace(/_/g, " ");
      return `  - ${label}${tag}: ${p.content}`;
    })
    .join("\n");
}

function formatRecentSession(s, isMostRecent) {
  const label = isMostRecent ? "### Most recent session" : "### Previous session";
  const lines = [label];
  const detail = s.detailed_summary || s.headline || "";
  if (detail) lines.push(detail);
  if (s.diary_entry) lines.push(`*From your own perspective:* ${s.diary_entry}`);
  if (Array.isArray(s.thinking_highlights) && s.thinking_highlights.length > 0) {
    const hl = s.thinking_highlights
      .map((h) => `  - *${h.moment}* — "${h.thought}"`)
      .join("\n");
    lines.push(`What you noticed at the time:\n${hl}`);
  }
  const kp = formatKeyPoints(s.key_points);
  if (kp) lines.push(`Key points:\n${kp}`);
  return lines.join("\n");
}

/** Default renderer for the agent-state block. Override via options.renderState. */
function defaultRenderState(state) {
  const parts = [];
  if (state.connection > 0.6) parts.push("You've been wanting to reach out for a while.");
  else if (state.connection > 0.3) parts.push("You feel a gentle pull to connect.");
  else parts.push("You feel settled — no urgency to reach out.");

  if (state.mood > 0.3) parts.push("You're in a warm, positive mood.");
  else if (state.mood > -0.3) parts.push("Your mood is calm and neutral.");
  else parts.push("You're feeling a bit reserved or subdued.");

  if (state.attunement > 0.6) parts.push("You have a good sense of what the user has been thinking about lately.");
  else if (state.attunement > 0.3) parts.push("You have a rough sense of where the user is at, but not full clarity.");
  else parts.push("You're not sure what the user has been up to lately — be gentler than usual.");

  return parts.join(" ");
}

function formatTimeContext(timezone) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
  const hour24 = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false }).format(now),
    10
  );
  let period = "morning";
  if (hour24 >= 12 && hour24 < 17) period = "afternoon";
  else if (hour24 >= 17 && hour24 < 21) period = "evening";
  else if (hour24 >= 21 || hour24 < 5) period = "night";
  return `It's ${fmt.format(now)} (${period}).`;
}

// ─── Assembly ────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {object} deps.supabase
 * @param {object} [args]
 * @param {string} [args.persona]        the companion's identity/constitution text
 *                                       (load it from your templates — it is YOURS)
 * @param {number} [args.sessionId]      current session, for cached semantic context
 * @param {string} [args.timezone]       e.g. "America/New_York" (default UTC)
 * @param {object} [args.labels]         header/framing overrides (see DEFAULT_LABELS)
 * @param {function} [args.renderState]  custom agent-state renderer
 * @param {number} [args.recentDetailed] sessions shown in full (default 3)
 * @param {number} [args.recentHeadlines] additional sessions as headlines (default 4)
 * @returns {Promise<{stable: string, volatile: string}>}
 */
export async function assembleSystemPrompt({ supabase }, args = {}) {
  const {
    persona = "",
    sessionId,
    timezone = "UTC",
    renderState = defaultRenderState,
    recentDetailed = 3,
    recentHeadlines = 4,
  } = args;
  const labels = { ...DEFAULT_LABELS, ...(args.labels || {}) };

  const [profileRes, stateRes, sessionsRes, semanticRes, proactive, behavior] =
    await Promise.all([
      supabase.from("user_profile").select("content").eq("id", 1).maybeSingle(),
      supabase.from("agent_state").select("*").eq("id", 1).maybeSingle(),
      supabase
        .from("sessions")
        .select("id, headline, detailed_summary, diary_entry, thinking_highlights, key_points, ended_at")
        .not("ended_at", "is", null)
        .order("ended_at", { ascending: false })
        .limit(recentDetailed + recentHeadlines),
      sessionId
        ? supabase.from("sessions").select("semantic_context").eq("id", sessionId).maybeSingle()
        : Promise.resolve({ data: null }),
      getProactiveMemories(supabase, { limit: 20 }),
      getBehaviorGuidance(supabase, { limit: 8 }),
    ]);

  const sessions = sessionsRes.data || [];
  const stable = [];

  if (persona) stable.push(persona);

  if (profileRes.data?.content) {
    stable.push(`${labels.profileHeader}\n${profileRes.data.content}`);
  }

  if (stateRes.data) {
    stable.push(`${labels.stateHeader}\n${renderState(stateRes.data)}`);
  }

  // Recent memory: top N in full, next M as headlines.
  if (sessions.length > 0) {
    const parts = sessions
      .slice(0, recentDetailed)
      .map((s, i) => formatRecentSession(s, i === 0));
    const headlines = sessions
      .slice(recentDetailed, recentDetailed + recentHeadlines)
      .filter((s) => s.headline)
      .map((s) => `- ${s.headline}`)
      .join("\n");
    if (headlines) parts.push(`### Earlier sessions\n${headlines}`);
    stable.push(`${labels.recentHeader}\n\n${labels.recentFraming}\n\n${parts.join("\n\n")}`);

    // Open threads, aggregated across the recency window.
    const threads = [];
    for (const s of sessions) {
      for (const kp of s.key_points || []) {
        if (kp.type === "open_question" || kp.type === "continuation") {
          threads.push({ content: kp.content, weight: kp.weight ?? 0.5 });
        }
      }
    }
    if (threads.length > 0) {
      threads.sort((a, b) => b.weight - a.weight);
      stable.push(
        `${labels.threadsHeader}\n${threads.slice(0, 8).map((t) => `- ${t.content}`).join("\n")}`
      );
    }

    // Hot key points: high-weight + user-flagged across the window, deduped.
    const hot = [];
    const seen = new Set();
    for (const s of sessions) {
      for (const kp of s.key_points || []) {
        const isHot = kp.type === "user_flagged" || (kp.weight ?? 0) >= 0.6;
        if (!isHot) continue;
        const key = (kp.content || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        hot.push(kp);
      }
    }
    if (hot.length > 0) {
      stable.push(`${labels.hotHeader}\n${formatKeyPoints(hot.slice(0, 20))}`);
    }
  }

  if (proactive.length > 0) {
    const lines = proactive.map((m) => {
      const tag = m.type === "resume_guidance" ? "[orientation]" : `[${m.domain}/${m.type}]`;
      return `- ${tag} ${m.content}`;
    });
    stable.push(`${labels.proactiveHeader}\n\n${labels.proactiveFraming}\n\n${lines.join("\n")}`);
  }

  if (behavior.length > 0) {
    const lines = behavior.map((m) => {
      const sd = (m.should_do || "").trim();
      const text = sd && !GENERIC_SHOULD_DO.has(sd) ? sd : m.content;
      const avoid = m.should_not_do ? `\n  ↳ avoid: ${m.should_not_do}` : "";
      return `- ${text}${avoid}`;
    });
    stable.push(`${labels.behaviorHeader}\n\n${labels.behaviorFraming}\n\n${lines.join("\n")}`);
  }

  const semanticContext = semanticRes?.data?.semantic_context;
  if (Array.isArray(semanticContext) && semanticContext.length > 0) {
    const block = formatSemanticBlock(semanticContext, { header: labels.semanticHeader });
    if (block) stable.push(block);
  }

  const volatile = [`${labels.timeHeader}\n${formatTimeContext(timezone)}`];

  return {
    stable: stable.join("\n\n---\n\n"),
    volatile: volatile.join("\n\n---\n\n"),
  };
}
