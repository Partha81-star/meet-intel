-- ============================================================
--  MeetIntel — Supabase Database Schema
--  Run this once in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- 0. Enable pgvector extension (one-time per project)
CREATE EXTENSION IF NOT EXISTS vector;


-- ============================================================
-- 1. MEETINGS table
-- ============================================================
CREATE TABLE IF NOT EXISTS meetings (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT        NOT NULL DEFAULT 'Untitled Meeting',
  participants TEXT[]      DEFAULT '{}',
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,
  status       TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','paused')),
  summary      TEXT,
  -- pgvector column: 1536 dims = text-embedding-3-small
  embedding    vector(1536),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meetings_status_idx     ON meetings (status);
CREATE INDEX IF NOT EXISTS meetings_started_at_idx ON meetings (started_at DESC);
-- HNSW vector index for fast ANN cosine search
CREATE INDEX IF NOT EXISTS meetings_embedding_idx
  ON meetings USING hnsw (embedding vector_cosine_ops);


-- ============================================================
-- 2. ACTION ITEMS table
-- ============================================================
CREATE TABLE IF NOT EXISTS action_items (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id   UUID        REFERENCES meetings(id) ON DELETE CASCADE,
  title        TEXT        NOT NULL,
  assignee     TEXT,
  due          TEXT,                        -- free-form: "EOD Friday", "next Tuesday"
  priority     TEXT        NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  status       TEXT        NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved','resolved','partial')),
  context      TEXT,                        -- verbatim quote from transcript
  embedding    vector(1536),               -- for cross-meeting debt similarity search
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS action_items_meeting_idx   ON action_items (meeting_id);
CREATE INDEX IF NOT EXISTS action_items_status_idx    ON action_items (status);
-- HNSW index for debt queries
CREATE INDEX IF NOT EXISTS action_items_embedding_idx
  ON action_items USING hnsw (embedding vector_cosine_ops);


-- ============================================================
-- 3. TRANSCRIPT SEGMENTS table (optional — for full-text search)
-- ============================================================
CREATE TABLE IF NOT EXISTS transcript_segments (
  id         BIGSERIAL   PRIMARY KEY,
  meeting_id UUID        REFERENCES meetings(id) ON DELETE CASCADE,
  speaker    TEXT,
  text       TEXT        NOT NULL,
  is_final   BOOLEAN     NOT NULL DEFAULT false,
  confidence REAL,
  ts         REAL,        -- Deepgram timestamp in seconds
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS segments_meeting_idx ON transcript_segments (meeting_id);


-- ============================================================
-- 4. SLIDE CONTEXTS table
-- ============================================================
CREATE TABLE IF NOT EXISTS slide_contexts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  UUID        REFERENCES meetings(id) ON DELETE CASCADE,
  description TEXT,
  key_points  TEXT[],
  slide_type  TEXT        DEFAULT 'other',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  frame_b64   TEXT        -- JPEG base64 thumbnail (or store in Supabase Storage)
);

CREATE INDEX IF NOT EXISTS slides_meeting_idx ON slide_contexts (meeting_id);


-- ============================================================
-- 5. RPC: match_action_items — vector similarity for Debt Engine
-- ============================================================
--  Called by DebtEngine.query() in engine.py:
--    db.rpc("match_action_items", {
--      query_embedding, meeting_ids, match_status, match_threshold, match_count
--    })
-- ============================================================
CREATE OR REPLACE FUNCTION match_action_items(
  query_embedding  vector(1536),
  meeting_ids      UUID[],
  match_status     TEXT    DEFAULT 'unresolved',
  match_threshold  FLOAT   DEFAULT 0.78,
  match_count      INT     DEFAULT 5
)
RETURNS TABLE (
  id          UUID,
  meeting_id  UUID,
  title       TEXT,
  assignee    TEXT,
  due         TEXT,
  priority    TEXT,
  status      TEXT,
  context     TEXT,
  similarity  FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.id,
    a.meeting_id,
    a.title,
    a.assignee,
    a.due,
    a.priority,
    a.status,
    a.context,
    1 - (a.embedding <=> query_embedding) AS similarity
  FROM action_items a
  WHERE
    a.meeting_id   = ANY(meeting_ids)
    AND a.status   = match_status
    AND a.embedding IS NOT NULL
    AND 1 - (a.embedding <=> query_embedding) >= match_threshold
  ORDER BY a.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


-- ============================================================
-- 6. RPC: match_meetings — find similar past meetings (bonus)
-- ============================================================
CREATE OR REPLACE FUNCTION match_meetings(
  query_embedding vector(1536),
  match_threshold FLOAT   DEFAULT 0.75,
  match_count     INT     DEFAULT 5
)
RETURNS TABLE (
  id          UUID,
  title       TEXT,
  started_at  TIMESTAMPTZ,
  summary     TEXT,
  similarity  FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.title,
    m.started_at,
    m.summary,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM meetings m
  WHERE
    m.status    = 'ended'
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) >= match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


-- ============================================================
-- 7. Row-Level Security
-- ============================================================
ALTER TABLE meetings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE slide_contexts      ENABLE ROW LEVEL SECURITY;

-- service_role key (used by backend) bypasses RLS automatically.
-- These open policies are for local demo — tighten before production.
CREATE POLICY "allow_all_demo" ON meetings            FOR ALL USING (TRUE);
CREATE POLICY "allow_all_demo" ON action_items        FOR ALL USING (TRUE);
CREATE POLICY "allow_all_demo" ON transcript_segments FOR ALL USING (TRUE);
CREATE POLICY "allow_all_demo" ON slide_contexts      FOR ALL USING (TRUE);
