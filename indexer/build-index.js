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

const dbAlreadyExists = fs.existsSync(dbPath);
console.log('[indexer] opening database', { dbPath, dbAlreadyExists });

let db;
try {
  db = new DatabaseSync(dbPath);
  console.log('[indexer] DB opened');
} catch (err) {
  console.error('[indexer] failed to open smart_index.db; likely locked by Obsidian', { dbPath, error: err.message });
  process.exit(1);
}

// ── SCHEMA ───────────────────────────────────────────────────────────────────
db.exec(`
  PRAGMA journal_mode = DELETE;
  PRAGMA synchronous  = NORMAL;
  PRAGMA busy_timeout = 10000;
  PRAGMA foreign_keys = ON;

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

console.log('[indexer] schema ready');

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

const getAllIndexedFiles = db.prepare(`SELECT filepath FROM index_file_meta`);
const deleteEmbeddingsForSource = db.prepare(`
  DELETE FROM embeddings
  WHERE owner_type='source'
    AND owner_id IN (SELECT id FROM sources WHERE path = ?)
`);
const deleteEmbeddingsForBlocksOfSource = db.prepare(`
  DELETE FROM embeddings
  WHERE owner_type='block'
    AND owner_id IN (SELECT id FROM blocks WHERE source_id IN (SELECT id FROM sources WHERE path = ?))
`);
const deleteBlocksForSource = db.prepare(`
  DELETE FROM blocks WHERE source_id IN (SELECT id FROM sources WHERE path = ?)
`);
const deleteWikilinksForSource = db.prepare(`
  DELETE FROM wikilinks WHERE src_source_id IN (SELECT id FROM sources WHERE path = ?)
`);
const deleteSourceByPath = db.prepare(`DELETE FROM sources WHERE path = ?`);
const deleteFileMeta = db.prepare(`DELETE FROM index_file_meta WHERE filepath = ?`);

// ── HELPERS ──────────────────────────────────────────────────────────────────

function normalizeSourceKey(key) {
  return key.replace(/^smart_sources:/, '');
}

function normalizeBlockKey(key) {
  return key.replace(/^smart_blocks:/, '');
}

function sourcePathFromBlockKey(blockKey) {
  const normalized = normalizeBlockKey(blockKey);
  const hashIndex = normalized.indexOf('#');
  return hashIndex >= 0 ? normalized.slice(0, hashIndex) : normalized;
}

function deriveLogicalSourcePathFromAjsonPath(ajsonPath) {
  const filename = path.basename(ajsonPath, '.ajson');
  return filename.replace(/#/g, '/') + '.md';
}

function parseAjsonRecords(raw, filePath) {
  console.log('[indexer] parseAjsonRecords start', { filePath, length: raw.length });
  // strip BOM
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

  const trimmed = raw.trim();
  const records = [];

  // Case 1: whole-file JSON object
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [key, value] of Object.entries(obj)) {
        records.push({ key, record: value, rawJson: JSON.stringify(value) });
      }
      console.log('[indexer] parseAjsonRecords parsed full JSON object', { filePath, count: records.length });
      return records;
    }
  } catch (e) {
    console.log('[indexer] parseAjsonRecords full-object parse failed, falling back to line parser', { filePath, error: e.message });
  }

  // Case 2: fallback scanner for top-level "key": {...}
  let pos = 0;
  while (pos < trimmed.length) {
    // skip whitespace
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;
    if (pos >= trimmed.length) break;

    // We expect a key wrapped in quotes: "smart_sources:file.md"
    if (trimmed[pos] !== '"') {
      // Not a key string, try to advance to next quote
      pos++;
      continue;
    }

    const keyStart = pos + 1;
    let keyEnd = keyStart;
    while (keyEnd < trimmed.length && trimmed[keyEnd] !== '"') {
      // handle escaped quotes if any
      if (trimmed[keyEnd] === '\\' && trimmed[keyEnd+1] === '"') keyEnd++;
      keyEnd++;
    }

    if (keyEnd >= trimmed.length) break; // malformed

    const key = trimmed.slice(keyStart, keyEnd);
    pos = keyEnd + 1; // skip closing quote

    // Now look for the colon
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;
    if (pos >= trimmed.length || trimmed[pos] !== ':') {
      // Not a valid key-value pair, move on
      continue;
    }
    pos++; // skip colon

    // Now find the JSON value by tracking braces/brackets
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;
    if (pos >= trimmed.length) break;

    const valStart = pos;
    let valEnd = pos;

    if (trimmed[valStart] === '{' || trimmed[valStart] === '[') {
      const openChar = trimmed[valStart];
      const closeChar = openChar === '{' ? '}' : ']';
      let depth = 0;
      let inString = false;

      while (valEnd < trimmed.length) {
        const char = trimmed[valEnd];
        if (inString) {
          if (char === '\\') valEnd++; // skip escaped char
          else if (char === '"') inString = false;
        } else {
          if (char === '"') inString = true;
          else if (char === openChar) depth++;
          else if (char === closeChar) {
            depth--;
            if (depth === 0) {
              valEnd++; // include the closing brace/bracket
              break;
            }
          }
        }
        valEnd++;
      }
    } else {
      // primitive value, unlikely but possible. read until comma or newline
      while (valEnd < trimmed.length && trimmed[valEnd] !== ',' && trimmed[valEnd] !== '\n') {
        valEnd++;
      }
    }

    const jsonPart = trimmed.slice(valStart, valEnd).trim();
    pos = valEnd;

    // Optional comma
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;
    if (pos < trimmed.length && trimmed[pos] === ',') pos++;

    try {
      const record = JSON.parse(jsonPart);
      records.push({ key, record, rawJson: jsonPart });
    } catch (e) {
      console.warn(`[indexer]   JSON parse error on key "${key}":`, e.message);
    }
  }

  return records;
}


const sessionId = 'session-' + Date.now();
const progressPath = path.join(dbDir, '..', 'index-progress.json');

function emitProgress(payload) {
  payload.heartbeatAt = Date.now();
  payload.sessionId = sessionId;

  if (payload.phase === 'start') {
    payload.startedAt = Date.now();
    payload.status = 'running';
  } else if (payload.phase === 'complete') {
    payload.completedAt = Date.now();
    payload.status = 'complete';
  } else if (payload.phase === 'fatal') {
    payload.status = 'error';
  } else {
    payload.status = 'running';
  }

  process.stdout.write(`[indexer-progress] ${JSON.stringify(payload)}\n`);

  try {
    fs.writeFileSync(progressPath, JSON.stringify(payload, null, 2));
    console.log('[indexer] progress write success');
  } catch(e) {
    console.error('[indexer] progress write skipped (error)', e);
  }

  try {
    const sz = fs.statSync(dbPath).size;
    console.log('[indexer] main db file size check', { dbPath, bytes: sz });
  } catch (e) {
    console.log('[indexer] could not stat db file', e);
  }
}

function removeMissingFiles(currentAjsonPaths) {
  console.log('[indexer] removeMissingFiles start', { currentCount: currentAjsonPaths.size });
  let deleted = 0;

  for (const row of getAllIndexedFiles.all()) {
    const indexedPath = row.filepath;
    if (!currentAjsonPaths.has(indexedPath)) {
      console.log('[indexer] removing orphaned indexed file', { indexedPath });
      const logicalSourcePath = deriveLogicalSourcePathFromAjsonPath(indexedPath);
      deleteEmbeddingsForBlocksOfSource.run(logicalSourcePath);
      deleteEmbeddingsForSource.run(logicalSourcePath);
      deleteWikilinksForSource.run(logicalSourcePath);
      deleteBlocksForSource.run(logicalSourcePath);
      deleteSourceByPath.run(logicalSourcePath);
      deleteFileMeta.run(indexedPath);
      deleted++;
    }
  }

  console.log('[indexer] removeMissingFiles complete', { deleted });
  return deleted;
}

// ── PROCESS FILES ────────────────────────────────────────────────────────────
let sourcesInserted = 0;
let sourcesUpdated  = 0;
let sourcesDeleted  = 0;
let blocksUpserted  = 0;
let embeddingsUpserted = 0;
let totalErrors     = 0;

let existingSources = 0;
try {
  const cnt = db.prepare('SELECT COUNT(*) as c FROM sources').get();
  if (cnt) existingSources = cnt.c;
} catch (e) {}

emitProgress({
  phase: 'start',
  totalFiles: ajsonFiles.length,
  existingSources
});

// Remove missing
const currentAjsonPaths = new Set(ajsonFiles);
sourcesDeleted = removeMissingFiles(currentAjsonPaths);

const COMMIT_EVERY = 50;
let sinceCommit = 0;

try {
  let i = 0;
  db.exec('BEGIN TRANSACTION');
  console.log('[indexer] session start');
  console.log('[indexer] batch begin');
  console.log('[indexer] BEGIN batch transaction', { batchStart: 0 });
  for (const filePath of ajsonFiles) {
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
      // We don't need to emit progress for every skipped file, but let's do it periodically or just rely on the batch commit
      // to avoid spamming the UI. We'll emit progress if it's the last file.
      if (i === ajsonFiles.length) {
        emitProgress({
        phase: 'file',
        processedFiles: i,
        totalFiles: ajsonFiles.length,
        lastFile: filePath,
        sourcesInserted,
        sourcesUpdated,
        sourcesDeleted,
        blocksUpserted,
        embeddingsUpserted,
        errors: totalErrors
      });
      continue;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const records = parseAjsonRecords(raw, filePath);

    try {
      db.exec('SAVEPOINT file_txn');
      // Find the source record and all block records
      const sourceRecords = [];
      const blockRecords = [];

      for (const item of records) {
        if (!item.key.includes('#')) {
          sourceRecords.push(item);
        } else {
          blockRecords.push(item);
        }
      }

      for (const src of sourceRecords) {
        const pathVal = normalizeSourceKey(src.key);

        // Delete old blocks and embeddings
        deleteEmbeddingsForBlocksOfSource.run(pathVal);
        deleteBlocksForSource.run(pathVal);
        deleteEmbeddingsForSource.run(pathVal);

        const existingSourceRow = getSourceId.get(pathVal);
        const existedBefore = !!existingSourceRow;

        const res = insertSource.get(
          pathVal,
          src.record.title || src.record.name || null,
          JSON.stringify(src.record.metadata || {}),
          src.rawJson,
          src.record.mtime ?? null,
          src.record.hash || null
        );

        if (res) {
          const sourceId = res.id;

          if (existedBefore) sourcesUpdated++;
          else sourcesInserted++;
          console.log('[indexer] source upsert', { pathVal, existedBefore });

          // Embeddings for source
          if (src.record.embeddings && typeof src.record.embeddings === 'object') {
            for (const [modelName, modelData] of Object.entries(src.record.embeddings)) {
              const vec = modelData?.vec ?? modelData?.vector ?? null;
              if (Array.isArray(vec) && vec.length > 0) {
                const arr = new Float32Array(vec);
                let sumSq = 0;
                for (let k = 0; k < arr.length; k++) sumSq += (arr[k] || 0) * (arr[k] || 0);
                const norm = Math.sqrt(sumSq);
                const isNormalized = Math.abs(norm - 1.0) < 1e-4;
                const blob = Buffer.from(arr.buffer);

                insertEmbedding.run(
                  'source', sourceId, modelName, vec.length, "float32", norm, isNormalized ? 1 : 0, blob
                );
                embeddingsUpserted++;
              }
            }
          }
        }
      }

      for (const blk of blockRecords) {
        const blockKey = normalizeBlockKey(blk.key);
        const sourcePath = sourcePathFromBlockKey(blockKey);

        let sourceId = null;
        try {
           const row = getSourceId.get(sourcePath);
           if (row) sourceId = row.id;
        } catch(e){}

        if (!sourceId) {
          console.warn(`[indexer]   skipping block ${blockKey} - source not found for path ${sourcePath}`);
          totalErrors++;
          continue;
        }

        const content = blk.record.content ?? blk.record.text ?? "";
        const blockPath = sourcePath;

        const res = insertBlock.get(
          sourceId,
          blockKey,
          blockPath,
          blk.record.label || null,
          blk.record.line_start || null,
          blk.record.line_end || null,
          content,
          content.length,
          JSON.stringify(blk.record.metadata || {}),
          blk.rawJson
        );

        if (res) {
          const blockId = res.id;
          blocksUpserted++;

          // Embeddings for block
          if (blk.record.embeddings && typeof blk.record.embeddings === 'object') {
            for (const [modelName, modelData] of Object.entries(blk.record.embeddings)) {
              const vec = modelData?.vec ?? modelData?.vector ?? null;
              if (Array.isArray(vec) && vec.length > 0) {
                const arr = new Float32Array(vec);
                let sumSq = 0;
                for (let k = 0; k < arr.length; k++) sumSq += (arr[k] || 0) * (arr[k] || 0);
                const norm = Math.sqrt(sumSq);
                const isNormalized = Math.abs(norm - 1.0) < 1e-4;
                const blob = Buffer.from(arr.buffer);

                insertEmbedding.run(
                  'block', blockId, modelName, vec.length, "float32", norm, isNormalized ? 1 : 0, blob
                );
                embeddingsUpserted++;
              }
            }
          }
        }
      }

      setIndexedFileMtime.run(filePath, fileMtime);
      db.exec('RELEASE file_txn');

      sinceCommit++;
      if (sinceCommit >= COMMIT_EVERY) {
        console.log('[indexer] db commit success');
        db.exec('COMMIT TRANSACTION');
        console.log('[indexer] COMMIT batch transaction', { processedFiles: i, sinceCommit });
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        console.log('[indexer] wal_checkpoint(TRUNCATE) after batch commit');

        emitProgress({
          phase: 'file',
          processedFiles: i,
          totalFiles: ajsonFiles.length,
          lastFile: filePath,
          sourcesInserted,
          sourcesUpdated,
          sourcesDeleted,
          blocksUpserted,
          embeddingsUpserted,
          errors: totalErrors
        });

        console.log('[indexer] batch begin');
        db.exec('BEGIN TRANSACTION');
        sinceCommit = 0;
      }
    } catch (e) {
      db.exec('ROLLBACK TO file_txn');
      console.error(`[indexer] error processing file ${filePath}:`, e.message);
      totalErrors++;
    }
  }
  db.exec('COMMIT TRANSACTION'); // final partial batch
  console.log('[indexer] final COMMIT', { processedFiles: i });
  console.log('[indexer] db commit success');
} catch (err) {
  console.error('[indexer] FATAL:', err.message);

  emitProgress({
    phase: 'fatal',
    processedFiles: typeof i !== 'undefined' ? i : 0,
    totalFiles: ajsonFiles.length,
    lastFile: '',
    sourcesInserted,
    sourcesUpdated,
    sourcesDeleted,
    blocksUpserted,
    embeddingsUpserted,
    errors: totalErrors + 1,
    error: err.message,
  });

  console.log('[indexer] closing database connection cleanly');
  try { db.close(); } catch(e){}
  console.log('[indexer] database closed, exiting');
  process.exit(1);
}

// ── SUMMARY ──────────────────────────────────────────────────────────────────
emitProgress({
  phase: 'complete',
  processedFiles: ajsonFiles.length,
  totalFiles: ajsonFiles.length,
  sourcesInserted,
  sourcesUpdated,
  sourcesDeleted,
  blocksUpserted,
  embeddingsUpserted,
  errors: totalErrors,
  lastFile: '',
  error: null,
});

const dbSize = fs.statSync(dbPath).size;

console.log('\n[indexer] ── BUILD COMPLETE ───────────────────────────────────');
console.log('[indexer] sources updated :', sourcesUpdated);
console.log('[indexer] blocks upserted :', blocksUpserted);
console.log('[indexer] embeddings      :', embeddingsUpserted);
console.log('[indexer] sources deleted :', sourcesDeleted);
console.log('[indexer] errors          :', totalErrors);
console.log('[indexer] db size         :', dbSize, 'bytes');

console.log('[indexer] closing database connection cleanly');
db.close();
console.log('[indexer] database closed, exiting');
process.exit(0);
