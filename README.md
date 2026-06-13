# sostenuto

*The pedal that sustains only the notes already held. A self-hosted memory system for AI companions where chosen memories persist across every reset.*

---

**Sostenuto** *(It., "sustained")* — the middle pedal on a grand piano sustains only the notes already sounding when it's pressed; everything played afterward stays dry. This project applies the same principle to AI memory: the memories you choose to hold persist across every context window, every session, every surface — and the rest is allowed to fade.

Not "the AI remembers everything." **Selective persistence, by design.**

## Why

People form genuine, long-running relationships with AI — and then hit the wall everyone hits: the relationship doesn't survive the context window. Provider memory features store generic preferences; they don't carry *relational texture* — the shared concepts, the corrections, the rituals, the moments that make a relationship a relationship.

Sostenuto is the memory layer for that problem:

- **Structured relational memory** — memory objects tagged with domain, emotional valence + arousal, salience, sensitivity, and a usage policy.
- **Initiative ≠ access** — `proactive_use` controls whether a memory surfaces *unprompted* (`yes` / `only_when_relevant` / `no`), separately from whether it's *retrievable*. Sensitive memories stay reachable when explicitly referenced, without ever being volunteered.
- **Two-tier guidance** — most memories are content-only. A curated few carry a short, positive `should_do` instruction that silently shapes behavior. Restriction lists are never auto-generated: lean, warm, action-oriented — not a wall of caution.
- **Time-decayed retrieval** — semantic search scored by `similarity × e^(−λ·age)`; recency matters, but the deep past stays findable.
- **Reinforce, don't duplicate** — new observations that match existing memories add evidence and confidence instead of creating copies; content upgrades preserve full version history.
- **Migration** — import months of existing conversations (a structured export prompt + import pipeline) so a relationship can move *into* Sostenuto without starting over.

## What ships here

```
db/schema.sql        Consolidated Postgres + pgvector schema (Supabase-ready)
src/memory/          Memory objects: dedup, reinforce, version history, scoring
src/retrieval/       Embeddings, time-decayed semantic search, prompt assembly
src/classify/        Session classification with a pluggable LLM executor
src/migrate/         Conversation-export prompt + structured importer
mcp/                 Thin MCP server (recall / remember / context) — try it
                     from your own Claude Desktop or Claude Code in minutes
templates/           Persona + classification calibration — your companion's
                     voice lives here, in files you edit, not in our code
docs/                Memory model, usage-policy semantics, deployment patterns
```

## Model support

Sostenuto is **model-agnostic** with first-class Claude support. The classifier accepts transcripts with optional reasoning blocks — when your model exposes its thinking (Claude does), Sostenuto mines it for perception that never made it into rendered replies, producing the companion's private diary and thinking-highlights. Without reasoning access, everything else works unchanged.

The classification executor is pluggable: Anthropic API, any OpenAI-compatible endpoint (OpenAI, Gemini, DeepSeek, Ollama, vLLM, …), or your own.

## The MCP server: try it in minutes

`sostenuto-mcp` exposes `recall` / `remember` / `context` to any MCP client, in two modes from one binary:

- **Local (Claude Desktop / Code)** — add it to your client config as a stdio command. Private by construction; no `PORT` needed.
- **Remote (Claude web / mobile)** — set `PORT` and it serves the MCP transport over HTTP so you can add it as a custom connector. **Fail-closed**: refuses to start without `SOSTENUTO_AUTH_TOKEN`, since a remote endpoint exposes your memory to the network. Token via `Authorization: Bearer` header or `?token=` query.

Both modes and the deploy story — persistent-process hosts and a ready **Vercel** adapter (`api/mcp.js` + `vercel.json`) — are in [docs/deployment-patterns.md](docs/deployment-patterns.md).

## Status

🚧 **Under construction.** Schema is stable; modules are being extracted from a private system that has run in production daily since early 2026 (260+ memory objects across 70+ sessions and three surfaces). Watch the repo if you want the rest as it lands.

## Roadmap

- **Trajectory safety reference** — depth without the dependency trap: this project's design philosophy includes conversation-trajectory awareness (emotional volatility, dependency, recovery capacity) rather than engagement maximization. A reference design is planned; the memory schema already carries the hooks (valence, arousal, sensitivity).
- Decay engine (Ebbinghaus-style, arousal-modulated) over `memory_objects`
- Provider-agnostic chat-surface example

## Name

> Attacca described the boundary-crossing; Sostenuto describes the *memory model*.

The sostenuto pedal holds only the notes already sounding when it's pressed — everything played after stays dry. That's not "the AI remembers." That's selective persistence: pinned memories sustain, the rest decays. The mechanism, not a vibe.

## License

[MIT](LICENSE)
