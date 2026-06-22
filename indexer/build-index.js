#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ── CONFIG ───────────────────────────────────────────────────────────────────
// Resolve vault root: pass as first argument, or default to cwd
const vaultRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : process.cwd();

const smartFolder   = path.join(vaultRoot, '.smart-env', 'multi');
const pluginId      = 'vault-rag-explorer';
const dbDir         = path.join(vaultRoot, '.obsidian', 'plugins', pluginId, 'data');
const dbPath        = path.join(dbDir, 'smart_index.db');

console.log('[indexer] vault root   :', vaultRoot);
console.log('[indexer] smart folder :', smartFolder);
console.log('[indexer] db path      :', dbPath);

// ── PREFLIGHT CHECKS ─────────────────────────────────────────────────────────
if (!fs.existsSync(vaultRoot)) {
  console.error('[indexer] FATAL: vault root does not exist');
  process.exit(1);
}

if (!fs.existsSync(smartFolder)) {
  // Try root .smart-env as fallback (older SC versions)
  const alt = path.join(vaultRoot, '.smart-env');
  console.warn('[indexer] WARNING: .smart-env/multi not found, trying .smart-env root');
  if (!fs.existsSync(alt)) {
    console.error('[indexer] FATAL: no .smart-env folder found at all');
    process.exit(1);
  }
}

// ── DISCOVER .AJSON FILES ────────────────────────────────────────────────────
const ajsonFiles = fs.readdirSync(smartFolder)
  .filter(f => f.endsWith('.ajson'))
  .map(f => path.join(smartFolder, f));

console.log(`[indexer] found ${ajsonFiles.length} .ajson files`);

if (ajsonFiles.length === 0) {
  console.error('[indexer] FATAL: no .ajson files found — has Smart Connections finished embedding?');
  process.exit(1);
}

// ── CREATE DB ────────────────────────────────────────────────────────────────
fs.mkdirSync(dbDir, { recursive: true });

// Delete existing DB so we always do a clean rebuild
if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
  console.log('[indexer] deleted existing DB for clean rebuild');
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

console.log('[indexer] DB created at', dbPath);

// ── SCHEMA ───────────────────────────────────────────────────────────────────
db.exec(`
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
`);

console.log('[indexer] schema created');

// ── PREPARED STATEMENTS ──────────────────────────────────────────────────────
const insertSource = db.prepare(`
  INSERT OR REPLACE INTO sources (id, filepath, mtime, size)
  VALUES (@id, @filepath, @mtime, @size)
`);

const insertBlock = db.prepare(`
  INSERT OR REPLACE INTO blocks (id, sourceid, blockkey, content)
  VALUES (@id, @sourceid, @blockkey, @content)
`);

const insertEmbedding = db.prepare(`
  INSERT INTO embeddings (ownertype, ownerid, modelname, dim, vector)
  VALUES (@ownertype, @ownerid, @modelname, @dim, @vector)
`);

// ── PARSE AND INSERT ─────────────────────────────────────────────────────────
let totalSources    = 0;
let totalBlocks     = 0;
let totalEmbeddings = 0;
let totalErrors     = 0;

// Wrap all inserts in a single transaction for ~50x speed improvement
const runAll = db.transaction(() => {
  for (const filePath of ajsonFiles) {
    console.log(`[indexer] parsing: ${path.basename(filePath)}`);

    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);

    console.log(`[indexer]   lines: ${lines.length}`);

    for (const line of lines) {
      // Each line format: "key": {json}
      const firstColon = line.indexOf('": ');
      if (firstColon === -1) {
        console.warn('[indexer]   skipping malformed line (no key separator):', line.slice(0, 80));
        continue;
      }

      const key      = line.slice(1, firstColon); // strip leading "
      const jsonPart = line.slice(firstColon + 3);

      let record;
      try {
        record = JSON.parse(jsonPart);
      } catch (e) {
        console.warn('[indexer]   JSON parse error on key:', key, '—', e.message);
        totalErrors++;
        continue;
      }

      console.log(`[indexer]   record key=${key}, top-level keys=${Object.keys(record).join(',')}`);

      // ── Source record (no '#' in key = file-level)
      if (!key.includes('#')) {
        insertSource.run({
          id:       key,
          filepath: key,
          mtime:    record.mtime ?? null,
          size:     record.size  ?? null,
        });
        totalSources++;
      } else {
        // ── Block record (has '#' separator)
        const sourceId = key.split('#')[0];
        insertBlock.run({
          id:       key,
          sourceid: sourceId,
          blockkey: key,
          content:  record.content ?? record.text ?? null,
        });
        totalBlocks++;
      }

      // ── Embeddings — iterate over model keys inside record.embeddings
      if (record.embeddings && typeof record.embeddings === 'object') {
        console.log(`[indexer]   embedding model keys: ${Object.keys(record.embeddings).join(',')}`);

        for (const [modelName, modelData] of Object.entries(record.embeddings)) {
          const vec = modelData?.vec ?? modelData?.vector ?? null;

          if (!vec || !Array.isArray(vec)) {
            console.warn(`[indexer]   WARNING: no vec array for model ${modelName} on key ${key}`);
            continue;
          }

          insertEmbedding.run({
            ownertype: key.includes('#') ? 'block' : 'source',
            ownerid:   key,
            modelname: modelName,
            dim:       vec.length,
            vector:    JSON.stringify(vec),
          });
          totalEmbeddings++;
        }
      } else {
        console.log(`[indexer]   no embeddings field on this record`);
      }
    }
  }
});

runAll();

// ── SUMMARY ──────────────────────────────────────────────────────────────────
console.log('\n[indexer] ── BUILD COMPLETE ──────────────────────────────────');
console.log('[indexer] sources    :', totalSources);
console.log('[indexer] blocks     :', totalBlocks);
console.log('[indexer] embeddings :', totalEmbeddings);
console.log('[indexer] errors     :', totalErrors);
console.log('[indexer] db written :', dbPath);
console.log('[indexer] db size    :', fs.statSync(dbPath).size, 'bytes');

db.close();
