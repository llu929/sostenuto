/**
 * api/mcp.js — Vercel serverless function: Sostenuto MCP over HTTP.
 *
 * The serverless counterpart to the persistent HTTP server in
 * mcp/server.js. Same three tools, same stateless transport, same
 * fail-closed auth — adapted to Vercel's handler model (a function that
 * spins up per request) instead of a long-lived listener.
 *
 * Why this works on serverless: Sostenuto's transport is stateless —
 * every recall/remember/context call is an independent request/response,
 * no streaming, no session to keep warm between invocations. That's the
 * shape serverless wants.
 *
 * Deploy: `vercel deploy` from the repo root. Set four env vars in the
 * Vercel dashboard:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY,
 *   SOSTENUTO_AUTH_TOKEN   (a long random string you generate)
 *
 * Connector URL: https://your-app.vercel.app/mcp   (rewritten here)
 * Auth: Authorization: Bearer <token>   or   /mcp?token=<token>
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { buildServer, tokensMatch } from "../mcp/server.js";
import { createEmbedder } from "../src/retrieval/embeddings.js";
import { createMemoryStore } from "../src/memory/store.js";

// Lazy singleton — constructed on first request, reused across warm
// invocations. Lazy so importing the module never requires env to be set.
let _deps = null;
function getDeps() {
  if (_deps) return _deps;
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY } = process.env;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const embedder = createEmbedder({ apiKey: VOYAGE_API_KEY });
  const store = createMemoryStore({ supabase, embed: embedder.embed });
  _deps = { supabase, embedder, store };
  return _deps;
}

export default async function handler(req, res) {
  const json = (code, obj) => {
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(obj));
  };

  const authToken = process.env.SOSTENUTO_AUTH_TOKEN;
  if (!authToken) {
    // Fail closed: never serve memory without an auth token configured.
    return json(500, { error: "server misconfigured: SOSTENUTO_AUTH_TOKEN unset" });
  }

  // Auth gate — header preferred, ?token= fallback for URL-only clients.
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  let token = bearer;
  if (!token) {
    try {
      token = new URL(req.url, `http://${req.headers.host || "localhost"}`).searchParams.get("token");
    } catch {
      token = null;
    }
  }
  if (!token || !tokensMatch(token, authToken)) {
    return json(401, { error: "unauthorized" });
  }

  if (req.method !== "POST") {
    return json(405, { error: "method not allowed" });
  }

  // Body: Vercel usually pre-parses JSON; fall back to reading the stream.
  let body = req.body;
  try {
    if (body === undefined) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    } else if (typeof body === "string") {
      body = body ? JSON.parse(body) : undefined;
    }
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  const server = buildServer(getDeps());
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
