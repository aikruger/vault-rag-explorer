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
}

// ── PREFLIGHT ─────────────────────────────────────────────────────────────────
if (!fs.existsSync(vaultRoot)) {
  process.exit(1);
}
if (!fs.existsSync(smartFolder)) {
  process.exit(1);
}

const ajsonFiles = fs.readdirSync(smartFolder)
  .filter(f => f.endsWith('.ajson'))
  .map(f => path.join(smartFolder, f));

if (ajsonFiles.length === 0) {
  process.exit(1);
}

// ── CREATE DB ────────────────────────────────────────────────────────────────
fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(dbPath);

// ── SCHEMA ───────────────────────────────────────────────────────────────────
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous  = NORMAL;
  PRAGMA busy_timeout = 10000;

  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    title TEXT,
    metadata_json TEXT,
    raw_json TEXT,
    mtime INTEGER,
    hash TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    delete_reason TEXT
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

  CREATE TABLE IF NOT EXISTS index_file_meta (
    filepath TEXT PRIMARY KEY,
    mtime INTEGER,
    is_missing INTEGER NOT NULL DEFAULT 0,
    missing_since INTEGER,
    missing_reason TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sources_path ON sources(path);
  CREATE INDEX IF NOT EXISTS idx_blocks_source_id ON blocks(source_id);
  CREATE INDEX IF NOT EXISTS idx_embeddings_owner ON embeddings(owner_type, model_name, owner_id);
  CREATE INDEX IF NOT EXISTS idx_wikilinks_src ON wikilinks(src_source_id);
  CREATE INDEX IF NOT EXISTS idx_wikilinks_dst ON wikilinks(dst_source_id);
`);

// ── PREPARED STATEMENTS ──────────────────────────────────────────────────────
const insertSource = db.prepare(`
  INSERT INTO sources (path, title, metadata_json, raw_json, mtime, hash, is_deleted, deleted_at, delete_reason)
  VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL)
  ON CONFLICT(path) DO UPDATE SET
    title = excluded.title,
    metadata_json = excluded.metadata_json,
    raw_json = excluded.raw_json,
    mtime = excluded.mtime,
    hash = excluded.hash,
    is_deleted = 0,
    deleted_at = NULL,
    delete_reason = NULL
  RETURNING id
`);

const insertBlock = db.prepare(`
  INSERT INTO blocks (source_id, block_key, block_path, block_label, line_start, line_end, text, text_length, hash, metadata_json, raw_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(block_key) DO UPDATE SET
    source_id = excluded.source_id,
    block_path = excluded.block_path,
    block_label = excluded.block_label,
    line_start = excluded.line_start,
    line_end = excluded.line_end,
    text = excluded.text,
    text_length = excluded.text_length,
    hash = excluded.hash,
    metadata_json = excluded.metadata_json,
    raw_json = excluded.raw_json
  RETURNING id
`);

const insertEmbedding = db.prepare(`
  INSERT INTO embeddings (owner_type, owner_id, model_name, dim, dtype, norm, is_normalized, embedding)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(owner_type, owner_id, model_name) DO UPDATE SET
    dim = excluded.dim,
    dtype = excluded.dtype,
    norm = excluded.norm,
    is_normalized = excluded.is_normalized,
    embedding = excluded.embedding
`);

const getFileMeta = db.prepare(`SELECT mtime FROM index_file_meta WHERE filepath = ?`);
const updateFileMeta = db.prepare(`
  INSERT INTO index_file_meta (filepath, mtime, is_missing, missing_since, missing_reason)
  VALUES (?, ?, 0, NULL, NULL)
  ON CONFLICT(filepath) DO UPDATE SET
    mtime = excluded.mtime,
    is_missing = 0,
    missing_since = NULL,
    missing_reason = NULL
`);
const softDeleteSource = db.prepare(`
  UPDATE sources
  SET is_deleted = 1, deleted_at = ?, delete_reason = ?
  WHERE path = ?
`);
const softDeleteMeta = db.prepare(`
  UPDATE index_file_meta
  SET is_missing = 1, missing_since = ?, missing_reason = ?
  WHERE filepath = ?
`);

const allFileMeta = db.prepare(`SELECT filepath FROM index_file_meta WHERE is_missing = 0`);

function packEmbedding(vec) {
  const arr = new Float32Array(vec);
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) sumSq += (arr[i] || 0) * (arr[i] || 0);
  const norm = Math.sqrt(sumSq);
  const isNormalized = Math.abs(norm - 1.0) < 1e-4;
  const blob = Buffer.from(arr.buffer);
  return { blob, norm, isNormalized };
}

function deriveLogicalSourcePath(ajsonPath) {
    const filename = path.basename(ajsonPath, ".ajson");
    const logical = filename.replace(/#/g, "/") + ".md";
    // For unit testing path identity logging requirement
    console.log('[indexer] deriveLogicalSourcePath', { ajsonPath, logicalSourcePath: logical });
    return logical;
}

let totalSources    = 0;
let totalBlocks     = 0;
let totalEmbeddings = 0;
let totalErrors     = 0;
let processedFiles  = 0;
let skippedFiles = 0;
let sourcesSoftDeleted = 0;

const startTime = Date.now();

function emitProgress(lastFile) {
  const payload = {
    status: "running",
    phase: "file",
    startedAt: startTime,
    heartbeatAt: Date.now(),
    progressUpdatedAt: Date.now(),
    processedFiles,
    totalFiles: ajsonFiles.length,
    lastFile: lastFile || "",
    sourcesInserted: totalSources, // simplification
    sourcesUpdated: 0,
    sourcesSoftDeleted: sourcesSoftDeleted,
    blocksUpserted: totalBlocks,
    embeddingsUpserted: totalEmbeddings,
    errors: totalErrors,
    activeSources: totalSources,
    softDeletedSources: sourcesSoftDeleted,
    pid: process.pid
  };
  console.log("[indexer-progress] " + JSON.stringify(payload));
}

setInterval(() => {
  emitProgress("");
}, 2000);


// ── PARSE AND INSERT ─────────────────────────────────────────────────────────

db.exec('BEGIN');

try {
  const seenPaths = new Set();

  for (const filePath of ajsonFiles) {
    const fileName = path.basename(filePath);
    seenPaths.add(filePath);

    const fileStat = fs.statSync(filePath);
    const fileMtime = fileStat.mtimeMs;

    getFileMeta.bind(filePath);
    const metaRow = getFileMeta.get();

    if (metaRow && metaRow.mtime === fileMtime) {
       console.log(`[indexer] file unchanged, skipping`, { filePath, fileMtime });
       skippedFiles++;
       processedFiles++;
       emitProgress(filePath);
       continue;
    }

    console.log(`[indexer] file changed, reindexing`, { filePath, storedMtime: metaRow?.mtime, fileMtime });

    const raw = fs.readFileSync(filePath, 'utf8');

    // Proper JSON parsing
    // .ajson files are one JSON object per line.
    const lines = raw.split('\n').filter(l => l.trim().length > 0);

    for (const line of lines) {
      const sepIdx = line.indexOf('": ');
      if (sepIdx === -1) continue;

      const key      = line.slice(1, sepIdx);
      const jsonPart = line.slice(sepIdx + 3);

      let record;
      try {
        record = JSON.parse(jsonPart);
      } catch (e) {
        totalErrors++;
        continue;
      }

      if (!key.includes('#')) {
        const title = path.basename(key, '.md');
        const sourcePath = key; // usually the path is the key
        const sourceRes = insertSource.get(sourcePath, title, JSON.stringify(record.metadata || {}), jsonPart, record.mtime || null, record.hash || null);

        if (sourceRes) {
            totalSources++;
            const sourceId = sourceRes.id;
            if (record.embeddings && typeof record.embeddings === 'object') {
              for (const [modelName, modelData] of Object.entries(record.embeddings)) {
                const vec = modelData?.vec ?? modelData?.vector ?? null;
                if (!Array.isArray(vec) || vec.length === 0) continue;
                const { blob, norm, isNormalized } = packEmbedding(vec);
                insertEmbedding.run('source', sourceId, modelName, vec.length, 'float32', norm, isNormalized ? 1 : 0, blob);
                totalEmbeddings++;
              }
            }
        }
      } else {
        const sourcePath = key.split('#')[0];
        // Ensure source exists. We might not have metadata for it.
        const sourceRes = insertSource.get(sourcePath, path.basename(sourcePath, '.md'), "{}", "{}", null, null);
        const sourceId = sourceRes ? sourceRes.id : null;

        if (sourceId) {
            const blockRes = insertBlock.get(sourceId, key, sourcePath, key.split('#')[1] || '', record.line_start || 0, record.line_end || 0, record.content || record.text || '', (record.content || record.text || '').length, record.hash || '', JSON.stringify(record.metadata || {}), jsonPart);

            if (blockRes) {
                totalBlocks++;
                const blockId = blockRes.id;

                if (record.embeddings && typeof record.embeddings === 'object') {
                  for (const [modelName, modelData] of Object.entries(record.embeddings)) {
                    const vec = modelData?.vec ?? modelData?.vector ?? null;
                    if (!Array.isArray(vec) || vec.length === 0) continue;
                    const { blob, norm, isNormalized } = packEmbedding(vec);
                    insertEmbedding.run('block', blockId, modelName, vec.length, 'float32', norm, isNormalized ? 1 : 0, blob);
                    totalEmbeddings++;
                  }
                }
            }
        }
      }
    }

    updateFileMeta.run(filePath, fileMtime);
    console.log(`[indexer] setIndexedFileMtime`, { filePath, fileMtime });

    processedFiles++;
    emitProgress(filePath);
  }

  // Soft deletes
  const dbFiles = allFileMeta.all();
  for (const row of dbFiles) {
      const dbPath = row.filepath;
      if (!seenPaths.has(dbPath)) {
          const logicalSourcePath = deriveLogicalSourcePath(dbPath);
          console.log(`[indexer] soft-delete candidate detected`, { indexedPath: dbPath, logicalSourcePath, reason: 'missing from current scan' });
          const now = Date.now();
          softDeleteSource.run(now, 'missing from scan', logicalSourcePath);
          softDeleteMeta.run(now, 'missing from scan', dbPath);
          console.log(`[indexer] source soft-deleted`, { logicalSourcePath, deletedAt: now });
          console.log(`[indexer] index_file_meta marked missing`, { indexedPath: dbPath, reason: 'missing from scan' });
          sourcesSoftDeleted++;
      }
  }

  db.exec('COMMIT');

} catch (err) {
  db.exec('ROLLBACK');
  console.error('[indexer] FATAL: transaction rolled back due to error:', err.message);
  process.exit(1);
}

const payload = {
    status: "complete",
    phase: "done",
    startedAt: startTime,
    heartbeatAt: Date.now(),
    progressUpdatedAt: Date.now(),
    processedFiles,
    totalFiles: ajsonFiles.length,
    lastFile: "",
    sourcesInserted: totalSources,
    sourcesUpdated: 0,
    sourcesSoftDeleted: sourcesSoftDeleted,
    blocksUpserted: totalBlocks,
    embeddingsUpserted: totalEmbeddings,
    errors: totalErrors,
    activeSources: totalSources,
    softDeletedSources: sourcesSoftDeleted,
    pid: process.pid
};
console.log("[indexer-progress] " + JSON.stringify(payload));
process.exit(0);
