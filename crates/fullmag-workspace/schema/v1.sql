CREATE TABLE items (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('project','script')),
  path            TEXT NOT NULL,
  path_key        TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  project_id      TEXT,
  first_seen_at   TEXT NOT NULL,
  last_used_at    TEXT NOT NULL,
  use_count       INTEGER NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0,
  forgotten       INTEGER NOT NULL DEFAULT 0,
  size_bytes      INTEGER,
  modified_at     TEXT,
  status          TEXT NOT NULL DEFAULT 'ready'
                  CHECK (status IN ('ready','missing','failed','migrate','readonly')),
  meta            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta))
);
CREATE INDEX items_recent ON items (forgotten, kind, last_used_at DESC);
CREATE INDEX items_project_id ON items (project_id) WHERE project_id IS NOT NULL;

CREATE TABLE events (
  id        INTEGER PRIMARY KEY,
  item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  at        TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN
            ('open','save','run','create','import','pin','unpin','forget')),
  actor     TEXT NOT NULL CHECK (actor IN ('desktop','cli','python','web')),
  detail    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail))
);
CREATE INDEX events_item ON events (item_id, at DESC);

CREATE TABLE kv (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL CHECK (json_valid(value))
);
