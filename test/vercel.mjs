/**
 * vercel.mjs — offline test for the Vercel serverless handler's gate.
 *
 *   node test/vercel.mjs
 *
 * Verifies the adapter's own logic: fail-closed misconfig, the auth gate
 * (header and ?token paths), and method gating. The MCP transport itself
 * is identical to the stdio/http path and is proven by test/http.mjs and
 * the live deploy, so this focuses on what's Vercel-specific.
 */

import assert from "node:assert/strict";
import handler from "../api/mcp.js";

function mockReq({ method = "POST", url = "/api/mcp", headers = {}, body } = {}) {
  return { method, url, headers: { host: "localhost", ...headers }, body };
}
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: "", ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); },
    end(b) { this.body = b || ""; this.ended = true; },
    on() {},
  };
}

let passed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); process.exitCode = 1; }
}

console.log("vercel handler:");

await ok("fail-closed: no SOSTENUTO_AUTH_TOKEN → 500", async () => {
  delete process.env.SOSTENUTO_AUTH_TOKEN;
  const res = mockRes();
  await handler(mockReq({ headers: { authorization: "Bearer anything" } }), res);
  assert.equal(res.statusCode, 500);
});

process.env.SOSTENUTO_AUTH_TOKEN = "vtok-test";

await ok("no auth → 401", async () => {
  const res = mockRes();
  await handler(mockReq(), res);
  assert.equal(res.statusCode, 401);
});

await ok("wrong token → 401", async () => {
  const res = mockRes();
  await handler(mockReq({ headers: { authorization: "Bearer nope" } }), res);
  assert.equal(res.statusCode, 401);
});

await ok("valid bearer + GET → 405 (passed auth, failed method)", async () => {
  const res = mockRes();
  await handler(mockReq({ method: "GET", headers: { authorization: "Bearer vtok-test" } }), res);
  assert.equal(res.statusCode, 405);
});

await ok("valid ?token query + GET → 405 (query auth path works)", async () => {
  const res = mockRes();
  await handler(mockReq({ method: "GET", url: "/api/mcp?token=vtok-test" }), res);
  assert.equal(res.statusCode, 405);
});

await ok("valid token + POST malformed body → 400, not 401 (gate passed)", async () => {
  const res = mockRes();
  await handler(mockReq({ headers: { authorization: "Bearer vtok-test" }, body: "{not json" }), res);
  assert.equal(res.statusCode, 400);
});

console.log(`\n${passed} vercel checks passed${process.exitCode ? " (with failures)" : ""}.`);
