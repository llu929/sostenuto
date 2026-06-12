# The memory model

How Sostenuto decides what to keep, what to surface, and what to let fade.

## The unit: memory objects

A memory object is one durable piece of knowledge distilled from conversation — a fact, a preference, a shared concept, a correction, a commitment. Not a summary; a discrete thing with its own identity.

Each carries:

| Field | What it means |
|---|---|
| `domain` | Who it's about: `user_self`, `agent_self` (the companion in this relationship), `relational` (the relationship itself), `evidence` (verbatim quotes worth keeping) |
| `type` | What kind of thing it is — fact, preference, ritual, boundary, shared_concept, … (see `db/schema.sql` for the full vocabulary) |
| `content` | The memory, specific and grounded |
| `evidence_refs` | Provenance: which sessions support it. Grows over time — see *Reinforcement* below |
| `confidence` | 0–1; rises with reinforcement |
| `sensitivity` | `low` / `medium` / `high` — descriptive metadata. **Sensitivity never gates retrieval** (see below) |
| `status` | Lifecycle: `candidate → active → reinforced` (and `revised` / `deprecated` / `forgotten`) |
| `should_do` / `should_not_do` | Tier 2 guidance — see *Two tiers* |
| `usage_guidance` | The machine-read policy object (below) |
| `version_history` | Append-only log of every content rewrite — provenance is never lost |

## Emotional coordinates: valence and arousal

Two orthogonal dimensions (Russell's circumplex), supplied by the classifier or inferred by formula:

- **valence** (−1…1): emotional charge. Painful ↔ warm.
- **arousal** (0…1): intensity. A settled preference is low-arousal; a friction moment, a peak, a marked commitment is high-arousal. *A quiet warm memory can be high valence and low arousal* — they measure different things.

Arousal exists to modulate **decay** (planned: high-arousal memories fade slower — the Ebbenhaus-style decay engine is on the roadmap, and the data model already carries everything it needs) and to weight surfacing of unresolved, intense material.

**salience** (0…1) is a third, distinct number: importance-to-surface. A high-arousal moment can still be low-salience (too situational to bring forward), and vice versa.

## Initiative ≠ access: `proactive_use`

The single most important policy distinction in Sostenuto:

| Value | Meaning |
|---|---|
| `yes` | Always-on. Injected into every session's orientation block. Small, curated set — identity-level. |
| `only_when_relevant` | The default. Surfaces through semantic retrieval when the conversation matches it. |
| `no` | Never volunteered. **Still retrievable** — but only on *explicit anchor*: the user's message must match it at high similarity (default ≥ 0.65; calibrated for query-type embeddings, which score lower than document-pair similarity). |

`proactive_use` controls whether the companion *brings something up*. It does not control whether the companion *can remember it when asked*. The user clearly referencing a memory is consent to recall it; incidental similarity is not.

Corollary: **sensitivity does not gate retrieval.** High-sensitivity memories are part of the relationship and must stay findable when referenced. If something shouldn't auto-surface, that's a `proactive_use` decision — made by policy or curation, never by a blanket sensitivity rule. Blanket rules turn warmth into bureaucracy.

## Two tiers: content vs. instruction

Most memories (Tier 1) are **content-only** — they surface as themselves and the model responds to what they say. A small curated subset (Tier 2) carries `should_do`: a short, positive instruction distilling a rule the user taught — a boundary, a style correction, an operating principle. These render in the behavior-guidance block and silently shape the companion's conduct.

Two deliberate asymmetries:

1. **Only items that earned an instruction get one.** Auto-generating guidance for every memory produces generic noise; the cap (default 8 items) stays meaningful because most memories never enter the block at all.
2. **`should_not_do` is never auto-populated.** If present, it was set by hand and means it. The default posture is lean, warm, action-oriented — restrictions are added deliberately, not accumulated defensively. When multiple constraints could apply, the companion should default to warm and present, not cautious and short.

## The write path: reinforce, don't duplicate

Every candidate memory is embedded and searched against existing memories before insert (`src/memory/store.js`):

```
similarity ≥ 0.88  →  may UPGRADE content (near-paraphrase, substantially
                      more complete, concrete) — old content archived to
                      version_history
similarity ≥ 0.75  →  REINFORCE: evidence_refs grows, confidence rises,
                      status → 'reinforced'. Content untouched.
below 0.75         →  INSERT as new
```

The dual threshold matters: between 0.75 and 0.88, related-but-distinct memories *link* (shared evidence trail) without overwriting each other. A memory reinforced across many sessions accumulates a cross-session provenance trail — and ranks above one-off observations in the behavior-guidance block (evidence count is the tiebreaker after salience).

Batches process sequentially so that near-duplicates *within* one batch collapse correctly: the first occurrence inserts, the second reinforces it.

## The read paths

Four channels feed prompt assembly (`src/retrieval/assembly.js`):

1. **Proactive block** — `proactive_use='yes'`, ranked by status then confidence.
2. **Behavior guidance** — Tier 2, ranked salience → evidence count, capped small.
3. **Recent sessions** — recency window: top N in full (summary + diary + key points), next M as headlines.
4. **Semantic retrieval** — query-matched, time-decayed (`similarity × e^(−λ·age)`), fanned across session summaries, key points, and memory objects, anchor-gated for `proactive_use='no'`.

Channels 1–3 are stable within a session and live in the cacheable prefix; channel 4 is computed once per session on the first substantive message and cached on the session row.

## Sessions, classification, and the watermark

Sessions are classified by an LLM (`src/classify/`) into headline, arc-shaped summary, first-person diary, thinking-highlights, key points, emotion deltas, and candidate memories. Two prompt modes:

- **Full** — first classification of a session, phase-marked for long transcripts.
- **Incremental** — re-classification receives the prior record + only the new turns. Cost stays O(new). The watermark (`last_classified_message_count`) and a minimum-new-turns threshold prevent churn.

Emotion deltas are cumulative per session; on re-classification only the *net* difference is applied to agent state, so nothing double-counts.

## Forgetting

Sostenuto forgets in gradients, not deletions:

1. Recency windows (only the top sessions enter the prompt in full)
2. Time-decay scoring in retrieval (old needs higher similarity to compete)
3. Status lifecycle (`deprecated` / `forgotten` exclude from all reads, reversibly)
4. Caps with ranked eviction (behavior guidance, hot key points)
5. *(Roadmap)* the decay engine: confidence erosion over time since last reinforcement, modulated by arousal — with `proactive_use='yes'` items floored so curated memory never silently disappears

Hard deletion exists (it's your database), but the design treats forgetting as a ranking problem, not a destruction problem. The sostenuto pedal doesn't silence the other strings — it just doesn't sustain them.
