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
 * ── Two transports ──────────────────────────────────────────────────
 *
 * STDIO (default) — a local process for Claude Desktop / Code. Private by
 * construction: only your machine can spawn it. This is what runs when no
 * PORT is set.
 *
 *   claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "sostenuto": {
 *         "command": "npx",
 *         "args": ["-y", "-p", "sostenuto", "sostenuto-mcp"],
 *         "env": { "SUPABASE_URL": "...", "SUPABASE_SERVICE_ROLE_KEY": "...", "VOYAGE_API_KEY": "..." }
 *       }
 *     }
 *   }
 *
 * HTTP (remote / mobile) — activates when PORT (or SOSTENUTO_HTTP_PORT) is
 * set, as deploy platforms do. Lets you add Sostenuto as a custom remote
 * connector so the tools reach the Claude mobile/web apps, not just
 * Desktop. Stateless (each request independent — scales and survives
 * restarts) and FAIL-CLOSED: it refuses to start without
 * SOSTENUTO_AUTH_TOKEN, because a remote endpoint exposes your entire
 * memory (and a service-role key path) to the internet.
 *
 *   Endpoint:  POST /mcp        — the MCP transport
 *   Auth:      Authorization: Bearer <SOSTENUTO_AUTH_TOKEN>
 *              ...or  /mcp?token=<SOSTENUTO_AUTH_TOKEN>  (for URL-only clients)
 *   Health:    GET  /health
 *
 * Capture honesty: tool-based memory depends on the model choosing to call
 * `remember`. The descriptions nudge it; for guaranteed capture pair this
 * with closeSession() on a surface that exposes an end-of-session hook.
 */

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

import { createEmbedder } from "../src/retrieval/embeddings.js";
import { searchMemories, formatSemanticBlock } from "../src/retrieval/search.js";
import { createMemoryStore } from "../src/memory/store.js";
import { getProactiveMemories, getBehaviorGuidance } from "../src/memory/query.js";

const VERSION = "0.2.0";

// ─── Server factory (shared by both transports) ─────────────────────
// Returns a fresh McpServer with the three tools wired to `deps`. A new
// instance is built per HTTP request (stateless) and once for stdio.

export function buildServer({ supabase, embedder, store }) {
  const server = new McpServer({ name: "sostenuto", version: VERSION });

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
      return { content: [{ type: "text", text: block || "No matching memories." }] };
    }
  );

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
        parts.push("ORIENTATION (carry silently; don't quote):\n" +
          proactive.map((m) => `- ${m.content}`).join("\n"));
      }
      if (behavior.length > 0) {
        parts.push("BEHAVIOR GUIDANCE (be this, don't say it):\n" +
          behavior.map((m) => `- ${m.should_do || m.content}`).join("\n"));
      }
      const sessions = sessionsRes.data || [];
      if (sessions.length > 0) {
        parts.push("RECENT SESSIONS:\n" +
          sessions.map((s) => `- ${(s.ended_at || "").slice(0, 10)}: ${s.headline || "(unclassified)"}`).join("\n"));
      }
      return {
        content: [{ type: "text", text: parts.join("\n\n") || "No memory yet — this relationship is just beginning." }],
      };
    }
  );

  return server;
}

// ─── Auth ────────────────────────────────────────────────────────────

function tokensMatch(a, b) {
  const ba = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (ba.length !== bb.length) return false; // length leak is acceptable here
  return timingSafeEqual(ba, bb);
}

// ─── HTTP transport (remote / mobile) ───────────────────────────────

export function runHttp({ port, authToken, deps }) {
  const httpServer = createServer(async (req, res) => {
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
      return json(400, { error: "bad request" });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json(200, { status: "ok", service: "sostenuto-mcp", version: VERSION });
    }
    if (url.pathname !== "/mcp") {
      return json(404, { error: "not found" });
    }

    // Auth gate — header preferred, query param as a fallback for URL-only clients.
    const header = req.headers.authorization || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
    const token = bearer || url.searchParams.get("token");
    if (!token || !tokensMatch(token, authToken)) {
      return json(401, { error: "unauthorized" });
    }

    if (req.method !== "POST") {
      return json(405, { error: "method not allowed" });
    }

    // Read + parse the JSON-RPC body, then hand to a stateless transport.
    let body;
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    } catch {
      return json(400, { error: "invalid JSON body" });
    }

    const server = buildServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  httpServer.listen(port, () => {
    console.error(`[sostenuto-mcp] ready (http :${port})`);
  });
  return httpServer;
}

// ─── Entry ───────────────────────────────────────────────────────────

// Skip auto-start when imported (e.g. by tests): only run when invoked
// directly as the process entry point.
const isEntry =
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1].endsWith("sostenuto-mcp") ||
    process.argv[1].endsWith("server.js"));

if (isEntry) {
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
  const deps = { supabase, embedder, store };

  const httpPort = process.env.PORT || process.env.SOSTENUTO_HTTP_PORT;
  if (httpPort) {
    const authToken = process.env.SOSTENUTO_AUTH_TOKEN;
    if (!authToken) {
      console.error(
        "[sostenuto-mcp] HTTP mode requires SOSTENUTO_AUTH_TOKEN — refusing to " +
        "expose memory to the network without auth. Set a long random token."
      );
      process.exit(1);
    }
    runHttp({ port: Number(httpPort), authToken, deps });
  } else {
    const server = buildServer(deps);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[sostenuto-mcp] ready (stdio)");
  }
}
