/**
 * http.mjs — offline test for the remote HTTP transport + auth gate.
 *
 *   node test/http.mjs
 *
 * No database, no network, no API keys: boots the HTTP transport with stub
 * deps (tool handlers never fire in these checks) and verifies routing,
 * the fail-closed auth gate, and that a valid token reaches the MCP
 * transport. Full MCP protocol behavior is covered by the live MCP client
 * against a real deploy; this proves the gate around it.
 */

import assert from "node:assert/strict";
import { runHttp } from "../mcp/server.js";

const TOKEN = "test-token-do-not-use-in-prod";
const stubDeps = { supabase: {}, embedder: {}, store: {} };

// Boot on an ephemeral port.
const httpServer = runHttp({ port: 0, authToken: TOKEN, deps: stubDeps });
await new Promise((r) => httpServer.once("listening", r));
const { port } = httpServer.address();
const base = `http://127.0.0.1:${port}`;

let passed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); process.exitCode = 1; }
}

const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

console.log("http transport:");

await ok("GET /health → 200 ok", async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, "ok");
  assert.equal(j.service, "sostenuto-mcp");
});

await ok("unknown path → 404", async () => {
  const r = await fetch(`${base}/nope`);
  assert.equal(r.status, 404);
});

await ok("POST /mcp without auth → 401", async () => {
  const r = await fetch(`${base}/mcp`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(INIT),
  });
  assert.equal(r.status, 401);
});

await ok("POST /mcp wrong token → 401", async () => {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    body: JSON.stringify(INIT),
  });
  assert.equal(r.status, 401);
});

await ok("valid bearer token passes the gate (reaches MCP transport, not 401)", async () => {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(INIT),
  });
  // The transport handles it — could be 200 (initialized) or a JSON-RPC
  // error, but it must NOT be the auth 401.
  assert.notEqual(r.status, 401, `got ${r.status}`);
});

await ok("token via ?query param also passes the gate", async () => {
  const r = await fetch(`${base}/mcp?token=${encodeURIComponent(TOKEN)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(INIT),
  });
  assert.notEqual(r.status, 401, `got ${r.status}`);
});

await ok("GET /mcp with valid token but wrong method → 405", async () => {
  const r = await fetch(`${base}/mcp?token=${encodeURIComponent(TOKEN)}`);
  assert.equal(r.status, 405);
});

httpServer.close();
console.log(`\n${passed} http checks passed${process.exitCode ? " (with failures)" : ""}.`);
