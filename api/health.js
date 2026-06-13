/**
 * api/health.js — Vercel liveness probe. GET /health → 200.
 */
export default function handler(req, res) {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ status: "ok", service: "sostenuto-mcp" }));
}
