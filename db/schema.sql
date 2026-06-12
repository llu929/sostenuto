-- ============================================================
-- Sostenuto — consolidated schema
-- Selective long-term memory for AI companions.
--
-- Run once in your Supabase SQL Editor (or any Postgres with
-- pgvector). Single-user by design — no user_id columns; isolate
-- tenants at the project level.
--
-- NOTE on vector dimensions: 1024 matches voyage-3-large at
-- output_dimension=1024. If you use a different embedding model,
-- change every `vector(1024)` below to its output dimension —
-- embedding spaces cannot be mixed within a column.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Sessions ────────────────────────────────────────────────
-- One row per conversation session, on any surface. Classification
-- enriches the row at session end (or incrementally during it).

CREATE TABLE IF NOT EXISTS sessions (
  id                  BIGSERIAL PRIMARY KEY,
  started_at          TIMESTAMPTZ DEFAULT NOW(),
  ended_at            TIMESTAMPTZ,
  end_type            TEXT,             -- free-form: natural | goodnight | abrupt | ...
  source              TEXT,             -- surface tag, e.g. 'web' | 'terminal' | 'import'
  external_session_id TEXT,             -- upsert key for surfaces with their own session ids
                                        -- (e.g. a Claude Code session UUID)
  headline            TEXT,             -- one sentence: what actually mattered
  detailed_summary    TEXT,             -- arc-shaped summary (early → middle → late)
  diary_entry         TEXT,             -- first-person reflection in the companion's voice
  thinking_highlights JSONB DEFAULT '[]'::jsonb,  -- [{moment, thought}] mined from model
                                        -- reasoning when the provider exposes it
  key_points          JSONB DEFAULT '[]'::jsonb,  -- [{type, content, valence, weight}]
  semantic_context    JSONB,            -- cached retrieval results for this session
  summary_embedding   vector(1024),
  last_classified_message_count INT,    -- incremental-classification watermark
  mood_delta          DOUBLE PRECISION,
  connection_delta    DOUBLE PRECISION,
  attunement_delta    DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_sessions_ended    ON sessions (ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_source   ON sessions (source);
CREATE INDEX IF NOT EXISTS idx_sessions_external ON sessions (external_session_id);

-- ─── Messages ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages (
  id         UUID PRIMARY KEY,
  session_id BIGINT REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  thinking   TEXT,                      -- model reasoning, when available; the classifier
                                        -- mines this for perception that didn't surface
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, created_at);

-- ─── Memory objects — the heart of Sostenuto ─────────────────
-- Durable knowledge units distilled from sessions. Each carries
-- emotional coordinates (valence/arousal), a salience score, and a
-- usage policy (proactive_use) controlling *initiative*, distinct
-- from retrievability. Like the sostenuto pedal: items you choose
-- to hold sustain; the rest is allowed to fade.

CREATE TABLE IF NOT EXISTS memory_objects (
  id                 BIGSERIAL PRIMARY KEY,
  source_session_id  BIGINT,            -- provenance (not FK: survives session cleanup)
  domain             TEXT NOT NULL CHECK (domain IN (
                       'user_self', 'agent_self', 'relational', 'evidence')),
  type               TEXT NOT NULL CHECK (type IN (
                       'fact', 'preference', 'trajectory', 'somatic_affective',
                       'interpretive_frame', 'project', 'boundary', 'commitment',
                       'ritual', 'shared_concept', 'recurring_subject',
                       'contradiction', 'style_adjustment', 'voice_note',
                       'constraint', 'context_note', 'brief', 'resume_guidance',
                       'continuation', 'other')),
  content            TEXT NOT NULL,
  evidence_refs      JSONB DEFAULT '[]'::jsonb,   -- provenance trail; grows on reinforce
  epistemic_status   TEXT NOT NULL DEFAULT 'inferred' CHECK (epistemic_status IN (
                       'explicit', 'inferred', 'co_created',
                       'assistant_reflection', 'system_generated')),
  time_scope         TEXT NOT NULL DEFAULT 'ongoing' CHECK (time_scope IN (
                       'momentary', 'session', 'active_project',
                       'ongoing', 'historical', 'deprecated')),
  sensitivity        TEXT NOT NULL DEFAULT 'low' CHECK (sensitivity IN (
                       'low', 'medium', 'high')),
  -- Tier 2 model-facing guidance. Most memories are content-only (Tier 1).
  -- A curated subset carries a short positive instruction; should_not_do is
  -- never auto-populated — manual entries only (lean-not-cautious).
  should_do          TEXT,
  should_not_do      TEXT,
  confidence         DOUBLE PRECISION DEFAULT 0.5
                       CHECK (confidence >= 0 AND confidence <= 1),
  status             TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN (
                       'candidate', 'confirmed', 'active', 'reinforced',
                       'revised', 'deprecated', 'forgotten')),
  source_surface     TEXT DEFAULT 'system',
  embedding          vector(1024),
  -- Structured usage policy (machine-read; never dumped into prompts):
  --   valence (-1..1), arousal (0..1), salience (0..1), stability,
  --   proactive_use: 'yes' | 'only_when_relevant' | 'no'
  --     (controls initiative, NOT access — 'no' items still retrieve on
  --      explicit anchor, i.e. high-similarity reference by the user),
  --   retrieval_conditions, do_not_use_when, future_response_guidance,
  --   retrieval_keywords[], source_memory_type, import_policy
  usage_guidance     JSONB DEFAULT '{}'::jsonb,
  -- Append-only log of content upgrades (preserves provenance on rewrite)
  version_history    JSONB DEFAULT '[]'::jsonb,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  last_reinforced_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mo_domain_status  ON memory_objects (domain, status);
CREATE INDEX IF NOT EXISTS idx_mo_type           ON memory_objects (type);
CREATE INDEX IF NOT EXISTS idx_mo_status         ON memory_objects (status);
CREATE INDEX IF NOT EXISTS idx_mo_sensitivity    ON memory_objects (sensitivity);
CREATE INDEX IF NOT EXISTS idx_mo_source_session ON memory_objects (source_session_id);
CREATE INDEX IF NOT EXISTS idx_mo_created        ON memory_objects (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mo_proactive_use  ON memory_objects ((usage_guidance->>'proactive_use'));

-- ─── Key point embeddings ────────────────────────────────────
-- Fine-grained retrieval over session key points.

CREATE TABLE IF NOT EXISTS key_point_embeddings (
  id         BIGSERIAL PRIMARY KEY,
  session_id BIGINT REFERENCES sessions(id) ON DELETE CASCADE,
  type       TEXT,
  content    TEXT NOT NULL,
  embedding  vector(1024),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kpe_session ON key_point_embeddings (session_id);

-- ─── Agent state (singleton) ─────────────────────────────────
-- Continuous emotional axes, updated by per-session deltas, clamped.
-- The four shipped axes are a default, not a doctrine — redefine them
-- for your companion. Visible state is part of the design: the user
-- can always read these values.

CREATE TABLE IF NOT EXISTS agent_state (
  id                BIGINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  connection        DOUBLE PRECISION DEFAULT 0.3,  -- 0..1 pull to reach out
  discretion        DOUBLE PRECISION DEFAULT 0.5,  -- 0..1 restraint
  mood              DOUBLE PRECISION DEFAULT 0.0,  -- -1..1
  attunement        DOUBLE PRECISION DEFAULT 0.3,  -- 0..1 sense of where the user is
  proactive_enabled BOOLEAN DEFAULT FALSE,         -- user-controlled off-switch
  last_updated      TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO agent_state (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ─── User profile (singleton) ────────────────────────────────
-- Stable identity-level facts about the user. Regenerated wholesale
-- every N sessions / T days — the only compaction step in the system.

CREATE TABLE IF NOT EXISTS user_profile (
  id                     BIGINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  content                TEXT DEFAULT '',
  last_refreshed         TIMESTAMPTZ DEFAULT NOW(),
  sessions_since_refresh INT DEFAULT 0
);

INSERT INTO user_profile (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ─── Relationship context brief (singleton) ──────────────────
-- Dense "what to know right now" orientation paragraph, distinct from
-- user_profile (identity facts) — this is current relational texture.

CREATE TABLE IF NOT EXISTS relationship_context_brief (
  id                BIGINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  content           TEXT NOT NULL DEFAULT '',
  source_session_id BIGINT,
  refreshed_at      TIMESTAMPTZ DEFAULT NOW(),
  version_history   JSONB DEFAULT '[]'::jsonb
);

INSERT INTO relationship_context_brief (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ============================================================
-- Search RPCs — time-decayed cosine similarity
-- score = similarity * exp(-decay_rate * age_days)
-- decay_rate 0.03 ≈ a month-old match keeps ~40% of its score.
-- ============================================================

CREATE OR REPLACE FUNCTION search_summaries(
  query_embedding vector(1024),
  match_threshold DOUBLE PRECISION DEFAULT 0.3,
  match_count     INT DEFAULT 10,
  decay_rate      DOUBLE PRECISION DEFAULT 0.03
)
RETURNS TABLE (
  session_id    BIGINT,
  content       TEXT,
  similarity    DOUBLE PRECISION,
  age_days      DOUBLE PRECISION,
  decayed_score DOUBLE PRECISION,
  created_at    TIMESTAMPTZ
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.detailed_summary,
    1 - (s.summary_embedding <=> query_embedding) AS similarity,
    (EXTRACT(EPOCH FROM (NOW() - COALESCE(s.ended_at, s.started_at))) / 86400.0)::DOUBLE PRECISION AS age_days,
    (1 - (s.summary_embedding <=> query_embedding)) *
      EXP(-decay_rate * EXTRACT(EPOCH FROM (NOW() - COALESCE(s.ended_at, s.started_at))) / 86400.0)
      AS decayed_score,
    s.started_at
  FROM sessions s
  WHERE s.summary_embedding IS NOT NULL
    AND 1 - (s.summary_embedding <=> query_embedding) > match_threshold
  ORDER BY decayed_score DESC
  LIMIT match_count;
END;
$$;

CREATE OR REPLACE FUNCTION search_key_points(
  query_embedding vector(1024),
  match_threshold DOUBLE PRECISION DEFAULT 0.3,
  match_count     INT DEFAULT 10,
  decay_rate      DOUBLE PRECISION DEFAULT 0.03
)
RETURNS TABLE (
  session_id     BIGINT,
  content        TEXT,
  key_point_type TEXT,
  similarity     DOUBLE PRECISION,
  age_days       DOUBLE PRECISION,
  decayed_score  DOUBLE PRECISION,
  created_at     TIMESTAMPTZ
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    k.session_id,
    k.content,
    k.type,
    1 - (k.embedding <=> query_embedding) AS similarity,
    (EXTRACT(EPOCH FROM (NOW() - k.created_at)) / 86400.0)::DOUBLE PRECISION AS age_days,
    (1 - (k.embedding <=> query_embedding)) *
      EXP(-decay_rate * EXTRACT(EPOCH FROM (NOW() - k.created_at)) / 86400.0)
      AS decayed_score,
    k.created_at
  FROM key_point_embeddings k
  WHERE k.embedding IS NOT NULL
    AND 1 - (k.embedding <=> query_embedding) > match_threshold
  ORDER BY decayed_score DESC
  LIMIT match_count;
END;
$$;

CREATE OR REPLACE FUNCTION search_memory_objects(
  query_embedding vector(1024),
  match_threshold DOUBLE PRECISION DEFAULT 0.3,
  match_count     INT DEFAULT 10,
  decay_rate      DOUBLE PRECISION DEFAULT 0.02,
  domain_filter   TEXT[] DEFAULT NULL,
  status_filter   TEXT[] DEFAULT ARRAY['active', 'confirmed', 'reinforced']
)
RETURNS TABLE (
  id                 BIGINT,
  domain             TEXT,
  type               TEXT,
  content            TEXT,
  epistemic_status   TEXT,
  sensitivity        TEXT,
  confidence         DOUBLE PRECISION,
  similarity         DOUBLE PRECISION,
  decayed_score      DOUBLE PRECISION,
  status             TEXT,
  source_session_id  BIGINT,
  last_reinforced_at TIMESTAMPTZ,
  usage_guidance     JSONB
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    mo.id, mo.domain, mo.type, mo.content,
    mo.epistemic_status, mo.sensitivity, mo.confidence,
    1 - (mo.embedding <=> query_embedding) AS similarity,
    (1 - (mo.embedding <=> query_embedding)) *
      EXP(-decay_rate * EXTRACT(EPOCH FROM (NOW() - mo.created_at)) / 86400.0)
      AS decayed_score,
    mo.status,
    mo.source_session_id,
    mo.last_reinforced_at,
    mo.usage_guidance
  FROM memory_objects mo
  WHERE mo.embedding IS NOT NULL
    AND mo.status = ANY(status_filter)
    AND (domain_filter IS NULL OR mo.domain = ANY(domain_filter))
    AND 1 - (mo.embedding <=> query_embedding) > match_threshold
  ORDER BY decayed_score DESC
  LIMIT match_count;
END;
$$;
