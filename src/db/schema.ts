export const DB_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT,
  metadata_json TEXT,
  raw_json TEXT,
  mtime INTEGER,
  hash TEXT
);

CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL,
  block_key TEXT NOT NULL UNIQUE,
  block_path TEXT,
  block_label TEXT,
  line_start INTEGER,
  line_end INTEGER,
  text TEXT,
  text_length INTEGER,
  hash TEXT NOT NULL DEFAULT '',
  metadata_json TEXT,
  raw_json TEXT,
  FOREIGN KEY(source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS embeddings (
  id INTEGER PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  model_name TEXT NOT NULL,
  dim INTEGER NOT NULL,
  dtype TEXT NOT NULL,
  norm REAL NOT NULL,
  is_normalized INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  UNIQUE(owner_type, owner_id, model_name)
);

CREATE TABLE IF NOT EXISTS wikilinks (
  id INTEGER PRIMARY KEY,
  src_source_id INTEGER NOT NULL,
  dst_path TEXT NOT NULL,
  dst_source_id INTEGER,
  anchor_text TEXT,
  line_no INTEGER,
  edge_type TEXT NOT NULL,
  FOREIGN KEY(src_source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS rag_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query_text TEXT NOT NULL,
  query_embedding_model TEXT NOT NULL,
  options_json TEXT NOT NULL,
  workspace_json TEXT NOT NULL,
  explanations_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sources_path ON sources(path);
CREATE INDEX IF NOT EXISTS idx_blocks_source_id ON blocks(source_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_owner ON embeddings(owner_type, model_name, owner_id);
CREATE INDEX IF NOT EXISTS idx_wikilinks_src ON wikilinks(src_source_id);
CREATE INDEX IF NOT EXISTS idx_wikilinks_dst ON wikilinks(dst_source_id);
`;
