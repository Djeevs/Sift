-- D1 schema for the edge Worker. Only what the read path needs to append.
-- The pipeline's own database remains the source of truth; `npm run pull`
-- copies these rows into it so learning and diagnostics see them.

CREATE TABLE IF NOT EXISTS open_events (
  -- Deterministic: item + feed + day. Re-opening an article on the same day
  -- collapses into one event, matching the Node side.
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL,
  feed_id      TEXT,
  original_url TEXT NOT NULL,
  opened_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_open_events_time ON open_events(opened_at);
