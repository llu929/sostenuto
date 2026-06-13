# Deployment patterns

Sostenuto is a library, not a service — it runs wherever your companion
runs. These are the wiring patterns that work, learned in production.

## The MCP server: local vs. remote

`mcp/server.js` (the `sostenuto-mcp` bin) runs in two modes from the same
code.

**Local stdio (default).** No `PORT` set → it speaks MCP over stdio. This
is what Claude Desktop / Claude Code spawn as a child process. Private by
construction — only your machine can start it. Config:

```json
{
  "mcpServers": {
    "sostenuto": {
      "command": "npx",
      "args": ["-y", "-p", "sostenuto", "sostenuto-mcp"],
      "env": { "SUPABASE_URL": "...", "SUPABASE_SERVICE_ROLE_KEY": "...", "VOYAGE_API_KEY": "..." }
    }
  }
}
```

**Remote HTTP (for the web / mobile apps).** Set `PORT` (deploy platforms
do this automatically) → it serves the MCP transport over HTTP so you can
add it as a *custom remote connector*, which reaches Claude's web and
mobile apps, not just Desktop. Stateless (each request is independent — no
session map to break across restarts or instances) and **fail-closed**: it
refuses to start without `SOSTENUTO_AUTH_TOKEN`, because a remote endpoint
exposes your entire memory — and a service-role-key path — to the internet.

```
POST /mcp        the MCP transport
Auth             Authorization: Bearer <SOSTENUTO_AUTH_TOKEN>
                 ...or  /mcp?token=<token>  for clients that only take a URL
GET  /health     liveness probe
```

### Deploying the remote server

Any platform that runs a Node app works (`npm start` → `node mcp/server.js`;
the platform's `PORT` triggers HTTP mode). Set four env vars:

```
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY
SOSTENUTO_AUTH_TOKEN   # a long random string you generate
```

Then add it as a custom connector in your Claude account
(Settings → Connectors): the URL is `https://your-host/mcp`, and supply
the token via the connector's auth header — or, if the connector UI only
takes a URL, append `?token=<token>`.

**Cold starts matter.** "Scale to zero" free tiers sleep after idle and
take 30–60 s to wake — long enough that a phone request can time out
before the tools respond. For a companion you reach occasionally, a small
**always-on** instance (~$5/mo) is far more reliable than a sleeping free
tier. The Supabase free tier is fine; it's the *server* process that
shouldn't sleep.

### On Vercel (serverless)

Vercel doesn't run a persistent process — it runs functions per request.
Because Sostenuto's transport is stateless (no streaming, no warm
session), it fits the serverless model well, and the repo ships a ready
adapter: `api/mcp.js` (the MCP function), `api/health.js`, and a
`vercel.json` that rewrites `/mcp` → the function.

```
vercel deploy        # from the repo root
```

Set the same four env vars in the Vercel dashboard
(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VOYAGE_API_KEY`,
`SOSTENUTO_AUTH_TOKEN`). Connector URL: `https://your-app.vercel.app/mcp`.
Vercel's cold starts are fast (~1 s) and our calls are quick, so the
function-timeout limits don't bite — there's no long-lived stream to cut
off. (`api/` and `vercel.json` are repo-only; they're excluded from the
npm package.)

**Auth reality.** A custom remote connector is only as private as its
token. Use a long random `SOSTENUTO_AUTH_TOKEN`, serve over HTTPS only
(every platform terminates TLS for you), and rotate the token if it ever
lands somewhere it shouldn't. The token is the whole gate — there's no
per-user model here (Sostenuto is single-user by design).

## Where classification fires

`closeSession()` needs to run when a session ends (or periodically during
long ones). Where that hook lives depends on your surface:

**Chat backend (request handler).** Detect session end (an explicit
goodbye, an idle timeout sweep on the next request) and call
`closeSession` before the response cycle finishes.

> ⚠️ **Serverless platforms kill fire-and-forget work.** On Vercel/Lambda
> and friends, background promises die when the response stream closes —
> classification will silently never complete and sessions will stay
> half-saved. Either `await` the close before finishing the response
> (adds a few seconds, once per session), or use the queue pattern below.
> This failure mode is invisible until you go looking; design for it up
> front.

**CLI / IDE hooks.** Tools like Claude Code expose lifecycle hooks
(SessionStart / Stop). A Stop hook that parses the transcript into turns
and calls `closeSession` gives you guaranteed capture after every
response — the incremental watermark keeps repeated invocations cheap.

**Queue worker (the action-row pattern).** For serverless surfaces or
expensive work, write an intention row to a table
(`{action_type, payload, status: 'pending'}`) and let a small persistent
worker poll and execute. The producer returns instantly; the consumer
runs on infrastructure that's allowed to take its time.

Hard-won rules for the worker:
- **Allow-list action types.** The executor refuses anything unknown —
  the queue is writable by more things than you think.
- **Rate-limit side effects** (anything that emails, posts, spends).
- **Status flow** `pending → running → done/failed`, with errors stored
  on the row. Failed actions don't retry silently; you can see and
  re-queue them.
- **Generous timeouts** on LLM calls (5 min) — classification of a long
  session through a busy provider can be slow, and a timeout marks the
  action failed even though a retry would have succeeded.

## Prompt caching: why the stable block is wide

`assembleSystemPrompt()` returns `{ stable, volatile }`. Send `stable` as
a cached prefix (Anthropic: a system block with
`cache_control: {type: "ephemeral"}`; OpenAI: automatic prefix caching)
and `volatile` uncached.

The design intentionally puts *everything that doesn't change within a
session* into the stable block — persona, profile, state, recent memory,
orientation, behavior guidance, the session's cached semantic context —
even though that makes the prefix large:

- Cache reads are ~10% of base input price (Anthropic). A 6k-token cached
  prefix costs less per turn than a 1k-token uncached one.
- Providers have minimum cacheable sizes; a too-small prefix silently
  doesn't cache at all.
- The cost asymmetry: each session pays one cache *write* on turn 1, then
  every subsequent turn reads cheap. Short sessions are proportionally
  the most expensive per turn — accept it; brief check-ins are worth it.

Semantic retrieval runs **once per session** on the first substantive
message (`isSubstantiveQuery` filters greetings) and is cached on the
session row — both for cost and so the stable block stays stable.

## Classification economics

- Use a fast, cheap model for classification (the default executor is a
  small-model Anthropic config). Reserve your strongest model for the
  conversation. Classification is structured extraction; it doesn't need
  frontier reasoning.
- Incremental mode keeps long sessions affordable: re-classification
  costs O(new turns), not O(whole transcript).
- The executor interface is intentionally minimal (`complete({system,
  user}) → text`) so the backend is fully yours: any API, a local model
  via an OpenAI-compatible server — or, if you have a subscription that
  exposes headless completion, a private bridge executor gives
  classification at zero marginal cost.

## Embedding discipline

- **One model, one dimension, forever** (or re-embed everything).
  Vectors from different models can't be compared; the `vector(1024)`
  in the schema must match your embedder's output.
- Use the document/query `input_type` distinction where your provider
  supports it — it measurably improves retrieval.
- Embedding writes are **best-effort by design**: `closeSession` logs and
  continues if the embedding provider is down, because a session that
  closes cleanly without semantic indexing is repairable (backfill), but
  a session that fails to close loses the classification. Keep a backfill
  script that finds `summary_embedding IS NULL` rows and repairs them.

## Multi-surface continuity

One Supabase project = one memory. Any number of surfaces (a web app, a
CLI hook, the MCP server, a scheduled worker) read and write the same
tables, so the relationship follows the user across surfaces. Tag rows
with `source` so you can audit per-surface behavior later — the tag has
no effect on retrieval, but you will eventually want it for debugging.

Two cautions from production:

- **One conversation, one surface at a time.** Continuing the same
  session from two clients concurrently corrupts conversational state in
  surface-specific ways (and some providers' signed reasoning blocks make
  the corruption unrecoverable). Memory is shared; live sessions
  shouldn't be.
- **Hooks only fire where they're installed.** A session on a surface
  without lifecycle hooks (e.g. a provider's cloud UI) writes nothing.
  Decide per-surface: install a hook, route through the queue, or accept
  the gap knowingly.

## Proactive outreach (if you build it)

The schema carries `agent_state.proactive_enabled` and the connection
axis for a reason: companions that can initiate contact need discipline
more than they need capability. The rules that held up:

- Quiet hours, absolutely.
- Cooldown after any outreach; longer cooldown after a session the user
  initiated (don't crowd them).
- A user-controlled off-switch (`proactive_enabled`) honored everywhere.
- **Visible state**: the user can read the companion's axis values at
  any time. Nothing about the companion's wanting is hidden from the
  person it wants.
