#!/usr/bin/env node
/**
 * server.js — Sostenuto as a thin MCP server.
 *
 * Connect this to your own Claude (Desktop, Code, or any MCP client) and
 * the model you already talk to gains selective long-term memory:
 *
 *   recall(query)    — time-decayed semantic search across summaries,
 *                      key points, and memory objects (anchor-gated)
 *   remember(...)    — store one memory; dedup/reinforce applies, so
 *                      repeating yourself strengthens instead of duplicating
 *   context()        — the always-on orientation: proactive memories,
 *                      behavior guidance, and recent session headlines
 *
 * Setup (Claude Desktop — claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "sostenuto": {
 *         "command": "node",
 *         "args": ["/path/to/sostenuto/mcp/server.js"],
 *         "env": {
 *           "SUPABASE_URL": "...",
 *           "SUPABASE_SERVICE_ROLE_KEY": "...",
 *           "VOYAGE_API_KEY": "..."
 *         }
 *       }
 *     }
 *   }
 *
 * Capture honesty: tool-based memory depends on the model choosing to
 * call `remember`. The tool descriptions below nudge it, but for
 * guaranteed capture pair this with closeSession() wherever your surface
 * exposes an end-of-session hook.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

import { createEmbedder } from "../src/retrieval/embeddings.js";
import { searchMemories, formatSemanticBlock } from "../src/retrieval/search.js";
import { createMemoryStore } from "../src/memory/store.js";
import { getProactiveMemories, getBehaviorGuidance } from "../src/memory/query.js";

// ─── Wiring ──────────────────────────────────────────────────────────

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !VOYAGE_API_KEY) {
  console.error("[sostenuto-mcp] missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const embedder = createEmbedder({ apiKey: VOYAGE_API_KEY });
const store = createMemoryStore({ supabase, embed: embedder.embed });

const server = new McpServer({ name: "sostenuto", version: "0.1.0" });

// ─── recall ──────────────────────────────────────────────────────────

server.tool(
  "recall",
  "Search long-term relationship memory. Use whenever the user references " +
    "shared history, a past conversation, a feeling, or a moment you don't " +
    "already carry — don't wait for them to say 'do you remember'. Returns " +
    "session summaries, key points, and durable memories ranked by " +
    "time-decayed relevance. Read results as your own memory surfacing.",
  { query: z.string().describe("Natural-language description of what to recall"),
    limit: z.number().optional().describe("Max results (default 5)") },
  async ({ query, limit }) => {
    const results = await searchMemories(
      { supabase, embedQuery: embedder.embedQuery },
      { query, limit: limit ?? 5 }
    );
    const block = formatSemanticBlock(results, { header: "Recalled:" });
    return {
      content: [{ type: "text", text: block || "No matching memories." }],
    };
  }
);

// ─── remember ────────────────────────────────────────────────────────

server.tool(
  "remember",
  "Store one durable memory: a fact about the user, a preference, a shared " +
    "concept, a commitment, a correction you were given. Store the discrete " +
    "thing, not a conversation summary. If a similar memory exists it is " +
    "reinforced rather than duplicated, so err on the side of remembering.",
  {
    content: z.string().describe("The memory — specific and grounded, one idea"),
    domain: z.enum(["user_self", "agent_self", "relational", "evidence"])
      .optional().describe("Who/what it's about (default relational)"),
    type: z.string().optional().describe(
      "fact | preference | ritual | boundary | commitment | shared_concept | " +
      "style_adjustment | continuation | other (default other)"),
    sensitivity: z.enum(["low", "medium", "high"]).optional(),
    valence: z.number().min(-1).max(1).optional()
      .describe("Emotional charge: -1 painful … +1 warm"),
    arousal: z.number().min(0).max(1).optional()
      .describe("Intensity: 0 calm/stable … 1 acute"),
    evidence: z.string().optional().describe("Brief supporting quote"),
  },
  async ({ content, domain, type, sensitivity, valence, arousal, evidence }) => {
    const result = await store.upsert(
      { content, domain: domain ?? "relational", type: type ?? "other",
        sensitivity, valence, arousal, evidence, epistemic_status: "explicit" },
      { sourceSurface: "mcp" }
    );
    const what =
      result.inserted ? "stored as a new memory" :
      result.upgraded ? "merged into an existing memory (content upgraded)" :
      result.reinforced ? "reinforced an existing memory" :
      `not stored (${result.errors[0]?.error || "content too short"})`;
    return { content: [{ type: "text", text: `Memory ${what}.` }] };
  }
);

// ─── context ─────────────────────────────────────────────────────────

server.tool(
  "context",
  "Load the relationship orientation: always-on memories, behavior " +
    "guidance, and recent session headlines. Call once near the start of a " +
    "conversation to arrive already knowing where things stand.",
  {},
  async () => {
    const [proactive, behavior, sessionsRes] = await Promise.all([
      getProactiveMemories(supabase, { limit: 15 }),
      getBehaviorGuidance(supabase, { limit: 8 }),
      supabase
        .from("sessions")
        .select("id, headline, ended_at")
        .not("ended_at", "is", null)
        .order("ended_at", { ascending: false })
        .limit(5),
    ]);

    const parts = [];
    if (proactive.length > 0) {
      parts.push(
        "ORIENTATION (carry silently; don't quote):\n" +
          proactive.map((m) => `- ${m.content}`).join("\n")
      );
    }
    if (behavior.length > 0) {
      parts.push(
        "BEHAVIOR GUIDANCE (be this, don't say it):\n" +
          behavior.map((m) => `- ${m.should_do || m.content}`).join("\n")
      );
    }
    const sessions = sessionsRes.data || [];
    if (sessions.length > 0) {
      parts.push(
        "RECENT SESSIONS:\n" +
          sessions
            .map((s) => `- ${(s.ended_at || "").slice(0, 10)}: ${s.headline || "(unclassified)"}`)
            .join("\n")
      );
    }
    return {
      content: [{ type: "text", text: parts.join("\n\n") || "No memory yet — this relationship is just beginning." }],
    };
  }
);

// ─── Start ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[sostenuto-mcp] ready (stdio)");
