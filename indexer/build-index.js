#!/usr/bin/env node

// Uses Node.js built-in sqlite (requires Node >= 22.5.0)
// No npm install needed — zero external dependencies

const { DatabaseSync } = require('node:sqlite');
const fs   = require('fs');
const path = require('path');

// ── CONFIG ───────────────────────────────────────────────────────────────────
const vaultRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : process.cwd();

const pluginId  = 'vault-rag-explorer';
const dbDir     = path.join(vaultRoot, '.obsidian', 'plugins', pluginId, 'data');
const dbPath    = path.join(dbDir, 'smart_index.db');

// Try multi/ first, fall back to root .smart-env
let smartFolder = path.join(vaultRoot, '.smart-env', 'multi');
if (!fs.existsSync(smartFolder)) {
  smartFolder = path.join(vaultRoot, '.smart-env');
  console.log('[indexer] WARNING: multi/ not found, using .smart-env root');
}

console.log('[indexer] vault root   :', vaultRoot);
console.log('[indexer] smart folder :', smartFolder);
console.log('[indexer] db path      :', dbPath);

// ── PREFLIGHT ─────────────────────────────────────────────────────────────────
if (!fs.existsSync(vaultRoot)) {
  console.error('[indexer] FATAL: vault root does not exist:', vaultRoot);
  process.exit(1);
}
if (!fs.existsSync(smartFolder)) {
  console.error('[indexer] FATAL: no .smart-env folder found — has SC finished embedding?');
  process.exit(1);
}

const ajsonFiles = fs.readdirSync(smartFolder)
  .filter(f => f.endsWith('.ajson'))
  .map(f => path.join(smartFolder, f));

console.log(`[indexer] found ${ajsonFiles.length} .ajson files`);

if (ajsonFiles.length === 0) {
  console.error('[indexer] FATAL: no .ajson files found');
  process.exit(1);
}

// ── CREATE DB ────────────────────────────────────────────────────────────────
fs.mkdirSync(dbDir, { recursive: true });

if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
  console.log('[indexer] deleted existing DB for clean rebuild');
}

const db = new DatabaseSync(dbPath);
console.log('[indexer] DB created');

// ── SCHEMA ───────────────────────────────────────────────────────────────────
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous  = NORMAL;

  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    title TEXT,
    metadata_json TEXT,
    raw_json TEXT,
    mtime INTEGER,
    hash TEXT
  );

  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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

  CREATE TABLE IF NOT EXISTS index_file_meta (
    filepath TEXT PRIMARY KEY,
    mtime    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sources_path ON sources(path);
  CREATE INDEX IF NOT EXISTS idx_blocks_source_id ON blocks(source_id);
  CREATE INDEX IF NOT EXISTS idx_embeddings_owner ON embeddings(owner_type, model_name, owner_id);
  CREATE INDEX IF NOT EXISTS idx_wikilinks_src ON wikilinks(src_source_id);
  CREATE INDEX IF NOT EXISTS idx_wikilinks_dst ON wikilinks(dst_source_id);
`);

console.log('[indexer] schema created (6 tables)');

// ── PREPARED STATEMENTS ──────────────────────────────────────────────────────
const insertSource = db.prepare(
  `INSERT INTO sources (path, title, metadata_json, raw_json, mtime, hash)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(path) DO UPDATE SET
     title=excluded.title,
     metadata_json=excluded.metadata_json,
     raw_json=excluded.raw_json,
     mtime=excluded.mtime,
     hash=excluded.hash
   RETURNING id`
);
const insertBlock = db.prepare(
  `INSERT INTO blocks (source_id, block_key, block_path, block_label, line_start, line_end, text, text_length, metadata_json, raw_json)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(block_key) DO UPDATE SET
     source_id=excluded.source_id,
     block_path=excluded.block_path,
     block_label=excluded.block_label,
     line_start=excluded.line_start,
     line_end=excluded.line_end,
     text=excluded.text,
     text_length=excluded.text_length,
     metadata_json=excluded.metadata_json,
     raw_json=excluded.raw_json
   RETURNING id`
);
const insertEmbedding = db.prepare(
  `INSERT INTO embeddings (owner_type, owner_id, model_name, dim, dtype, norm, is_normalized, embedding)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(owner_type, owner_id, model_name) DO UPDATE SET
     dim=excluded.dim,
     dtype=excluded.dtype,
     norm=excluded.norm,
     is_normalized=excluded.is_normalized,
     embedding=excluded.embedding`
);
const setIndexedFileMtime = db.prepare(
  `INSERT OR REPLACE INTO index_file_meta (filepath, mtime) VALUES (?, ?)`
);
const getIndexedFileMtime = db.prepare(
  `SELECT mtime FROM index_file_meta WHERE filepath = ?`
);

const getSourceId = db.prepare(`SELECT id FROM sources WHERE path = ?`);
const getBlockId = db.prepare(`SELECT id FROM blocks WHERE block_key = ?`);

// ── PARSE AND INSERT ─────────────────────────────────────────────────────────
let totalSources    = 0;
let totalBlocks     = 0;
let totalEmbeddings = 0;
let totalErrors     = 0;

// Single transaction wraps everything — ~50x faster than per-row commits
db.exec('BEGIN');

try {
  let i = 0;
  for (const filePath of ajsonFiles) {
    console.log(`[indexer] progress file ${i + 1}/${ajsonFiles.length}: ${filePath}`);
    i++;

    const fileStat = fs.statSync(filePath);
    const fileMtime = fileStat.mtimeMs;

    let storedMtime = null;
    try {
      const row = getIndexedFileMtime.get(filePath);
      if (row) storedMtime = row.mtime;
    } catch(e) {}

    if (storedMtime !== null && storedMtime === fileMtime) {
      console.log(`[indexer] file unchanged (mtime match), skipping: ${filePath}`);
      continue;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);

    for (const line of lines) {
      // SC .ajson format: "key": {json object}
      // Leading " is always present; find the ": separator
      const sepIdx = line.indexOf('": ');
      if (sepIdx === -1) {
        console.warn('[indexer]   skipping malformed line (no key separator):', line.slice(0, 80));
        continue;
      }

      const key      = line.slice(1, sepIdx);   // strip leading "
      const jsonPart = line.slice(sepIdx + 3);  // everything after ": "

      let record;
      try {
        record = JSON.parse(jsonPart);
      } catch (e) {
        console.warn(`[indexer]   JSON parse error on key "${key}":`, e.message);
        totalErrors++;
        continue;
      }

      // ── Source record (no '#' in key = file-level)
      let ownerId = null;
      let ownerType = key.includes('#') ? 'block' : 'source';

      if (ownerType === 'source') {
        const res = insertSource.get(
          key, // path
          record.title || record.name || null, // title
          JSON.stringify(record.metadata || {}), // metadata_json
          jsonPart, // raw_json
          record.mtime ?? null, // mtime
          record.hash || null // hash
        );
        if (res) ownerId = res.id;
        totalSources++;
      } else {
        // ── Block record (has '#' separator)
        const sourcePath = key.split('#')[0];

        // Find source_id
        let sourceId = null;
        try {
           const row = getSourceId.get(sourcePath);
           if (row) sourceId = row.id;
        } catch(e){}

        if (!sourceId) {
          console.warn(`[indexer]   skipping block ${key} - source not found`);
          continue;
        }

        const content = record.content ?? record.text ?? "";

        const res = insertBlock.get(
          sourceId, // source_id
          key, // block_key
          sourcePath, // block_path
          record.label || null, // block_label
          record.line_start || null, // line_start
          record.line_end || null, // line_end
          content, // text
          content.length, // text_length
          JSON.stringify(record.metadata || {}), // metadata_json
          jsonPart // raw_json
        );
        if (res) ownerId = res.id;
        totalBlocks++;
      }

      // ── Embeddings — iterate over model keys inside record.embeddings
      if (record.embeddings && typeof record.embeddings === 'object') {
        for (const [modelName, modelData] of Object.entries(record.embeddings)) {
          const vec = modelData?.vec ?? modelData?.vector ?? null;

          if (!Array.isArray(vec) || vec.length === 0) {
            console.warn(`[indexer]   WARNING: no vec array under model "${modelName}" for key "${key}"`);
            continue;
          }

          if (!ownerId) {
             console.warn(`[indexer]   WARNING: owner not found for embedding key "${key}"`);
             continue;
          }

          // pack embedding to blob
          const arr = new Float32Array(vec);
          let sumSq = 0;
          for (let k = 0; k < arr.length; k++) sumSq += (arr[k] || 0) * (arr[k] || 0);
          const norm = Math.sqrt(sumSq);
          const isNormalized = Math.abs(norm - 1.0) < 1e-4;
          const blob = Buffer.from(arr.buffer);

          insertEmbedding.run(
            ownerType,
            ownerId,
            modelName,
            vec.length, // dim
            "float32", // dtype
            norm, // norm
            isNormalized ? 1 : 0, // is_normalized
            blob // embedding
          );
          totalEmbeddings++;
        }
      }
    }

    setIndexedFileMtime.run(filePath, fileMtime);
  }

  db.exec('COMMIT');
  console.log('[indexer] transaction committed');

} catch (err) {
  db.exec('ROLLBACK');
  console.error('[indexer] FATAL: transaction rolled back due to error:', err.message);
  process.exit(1);
}

// ── SUMMARY ──────────────────────────────────────────────────────────────────
const dbSize = fs.statSync(dbPath).size;

console.log('\n[indexer] ── BUILD COMPLETE ───────────────────────────────────');
console.log('[indexer] sources    :', totalSources);
console.log('[indexer] blocks     :', totalBlocks);
console.log('[indexer] embeddings :', totalEmbeddings);
console.log('[indexer] errors     :', totalErrors);
console.log('[indexer] db size    :', dbSize, 'bytes');
console.log('[indexer] db path    :', dbPath);

db.close();
