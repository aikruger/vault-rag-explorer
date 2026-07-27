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
  PRAGMA journal_mode = WAL;
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

function emitProgress(payload) {
  payload.heartbeatAt = Date.now();
  payload.sessionId = process.env.VRE_SESSION_ID || null;

  if (payload.phase === 'start') {
    payload.startedAt = Date.now();
    payload.status = 'running';
  } else if (payload.phase === 'complete') {
    payload.completedAt = Date.now();
    payload.status = payload.errors && payload.errors > 0 ? 'complete-with-errors' : 'complete';
  } else if (payload.phase === 'fatal') {
    payload.status = 'error';
  } else {
    payload.status = 'running';
  }

  process.stdout.write(`[indexer-progress] ${JSON.stringify(payload)}\n`);

  try {
    const progressPath = path.join(dbDir, '..', 'index-progress.json');
    fs.writeFileSync(progressPath, JSON.stringify(payload, null, 2));
    console.log('[indexer] progress write success');
  } catch(e) {
    console.error('[indexer] progress write skipped (error)', e);
  }
}

function getSourceState(logicalSourcePath) {
  try {
    const row = getSourceId.get(logicalSourcePath);
    return {
      hasSource: !!row,
      sourceId: row ? Number(row.id) : null,
    };
  } catch (error) {
    console.error('[indexer] getSourceState failed', { logicalSourcePath, error: String(error) });
    return {
      hasSource: false,
      sourceId: null,
      error: String(error),
    };
  }
}

function getIndexedFileState(filePath) {
  const logicalSourcePath = deriveLogicalSourcePathFromAjsonPath(filePath);
  const esc = logicalSourcePath.replace(/'/g, "''");

  const sourceRow = db.prepare(`SELECT id, path, hash, mtime FROM sources WHERE path = '${esc}' LIMIT 1`).get();
  const metaMtime = db.prepare(`SELECT mtime FROM index_file_meta WHERE filepath = '${filePath.replace(/'/g, "''")}' LIMIT 1`).get()?.mtime ?? null;

  if (!sourceRow) {
    return {
      hasMeta: metaMtime != null,
      hasSource: false,
      sourceId: null,
      blockCount: 0,
      sourceEmbeddingCount: 0,
      blockEmbeddingCount: 0,
      isComplete: false,
      reason: 'missing source row'
    };
  }

  const sourceId = sourceRow.id;

  const blockCount = db.prepare(`SELECT COUNT(*) as c FROM blocks WHERE source_id = ${Number(sourceId)}`).get()?.c ?? 0;
  const sourceEmbeddingCount = db.prepare(`SELECT COUNT(*) as c FROM embeddings WHERE owner_type = 'source' AND owner_id = ${Number(sourceId)}`).get()?.c ?? 0;
  const blockEmbeddingCount = db.prepare(`SELECT COUNT(*) as c FROM embeddings WHERE owner_type = 'block' AND owner_id IN (SELECT id FROM blocks WHERE source_id = ${Number(sourceId)})`).get()?.c ?? 0;

  const isComplete = blockCount > 0 && sourceEmbeddingCount > 0 && blockEmbeddingCount > 0;

  return {
    hasMeta: metaMtime != null,
    metaMtime,
    hasSource: true,
    sourceId,
    blockCount,
    sourceEmbeddingCount,
    blockEmbeddingCount,
    isComplete,
    reason: isComplete ? 'complete' : 'incomplete source/block/embedding rows'
  };
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
    console.log('[indexer] evaluating file', { filePath });

    const logicalSourcePath = deriveLogicalSourcePathFromAjsonPath(filePath);
    console.log('[indexer] derived logical source path', { filePath, logicalSourcePath });

    const fileStat = fs.statSync(filePath);
    const fileMtime = fileStat.mtimeMs;

    let storedMtime = null;
    try {
      const metaRow = getIndexedFileMtime.get(filePath);
      if (metaRow) storedMtime = metaRow.mtime;
    } catch (error) {
      console.warn('[indexer] failed reading index_file_meta row; treating as missing meta', {
        filePath,
        error: String(error),
      });
    }

    const sourceState = getSourceState(logicalSourcePath);
    console.log('[indexer] source state', {
      filePath,
      logicalSourcePath,
      hasSource: sourceState.hasSource,
      sourceId: sourceState.sourceId,
      storedMtime,
      fileMtime,
    });

    if (!sourceState.hasSource) {
      console.warn('[indexer] source row missing, forcing insert', {
        filePath,
        logicalSourcePath,
        storedMtime,
        fileMtime,
      });
    } else {
      console.log('[indexer] source row exists, checking completeness', {
        filePath,
        logicalSourcePath,
        sourceId: sourceState.sourceId,
      });
    }

    const indexedState = getIndexedFileState(filePath);
    if (indexedState) {
      console.log('[indexer] indexed file state', {
        filePath,
        logicalSourcePath,
        hasSource: indexedState.hasSource,
        hasMeta: indexedState.hasMeta,
        blockCount: indexedState.blockCount,
        sourceEmbeddingCount: indexedState.sourceEmbeddingCount,
        blockEmbeddingCount: indexedState.blockEmbeddingCount,
        isComplete: indexedState.isComplete,
        reason: indexedState.reason,
      });
    }

    if (sourceState.hasSource && indexedState && !indexedState.isComplete) {
      console.warn('[indexer] source row exists but DB rows are incomplete, forcing repair', {
        filePath,
        logicalSourcePath,
        reason: indexedState.reason,
        storedMtime,
        fileMtime,
      });
    }

    let shouldProcess = false;
    let processReason = 'unknown';

    if (!sourceState.hasSource) {
      shouldProcess = true;
      processReason = 'missing-source-row';
    } else if (indexedState && !indexedState.isComplete) {
      shouldProcess = true;
      processReason = 'incomplete-db-rows';
    } else if (storedMtime === null) {
      shouldProcess = true;
      processReason = 'missing-indexfilemeta';
    } else if (storedMtime !== fileMtime) {
      shouldProcess = true;
      processReason = 'mtime-changed';
    } else {
      shouldProcess = false;
      processReason = 'mtime-match-and-db-complete';
    }

    if (
      sourceState.hasSource &&
      indexedState &&
      indexedState.isComplete &&
      storedMtime === fileMtime
    ) {
      try {
        const rawForCheck = fs.readFileSync(filePath, 'utf8');
        const recordsForCheck = parseAjsonRecords(rawForCheck, filePath);

        const sourceRecordsForCheck = [];
        const blockRecordsForCheck = [];
        for (const item of recordsForCheck) {
          if (!item.key.includes('#')) sourceRecordsForCheck.push(item);
          else blockRecordsForCheck.push(item);
        }

        const expectedSources = sourceRecordsForCheck.length;
        const expectedBlocks = blockRecordsForCheck.length;

        if (
          indexedState.blockCount < expectedBlocks ||
          (expectedSources > 0 && !indexedState.hasSource)
        ) {
          shouldProcess = true;
          processReason = 'shape-mismatch-despite-mtime-match';
          console.warn('[indexer] reprocessing file because DB shape is incomplete despite mtime match', {
            filePath,
            logicalSourcePath,
            expectedSources,
            expectedBlocks,
            actualBlockCount: indexedState.blockCount,
          });
        }
      } catch (error) {
        shouldProcess = true;
        processReason = 'verification-parse-failed';
        console.warn('[indexer] verification parse failed; forcing repair', {
          filePath,
          logicalSourcePath,
          error: String(error),
        });
      }
    }

    console.log('[indexer] process decision', {
      filePath,
      logicalSourcePath,
      shouldProcess,
      processReason,
      storedMtime,
      fileMtime,
    });

    if (!shouldProcess) {
      console.log('[indexer] skipping complete indexed file', {
        filePath,
        logicalSourcePath,
        storedMtime,
        fileMtime,
      });

      if (i % COMMIT_EVERY === 0 || i === ajsonFiles.length) {
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
          errors: totalErrors,
          decision: 'skipped',
          reason: processReason,
          logicalSourcePath
        });
      }
      continue;
    }

    console.log('[indexer] beginning file rebuild', {
      filePath,
      logicalSourcePath,
      processReason,
    });

    let raw;
    let records = [];
    let readSuccess = false;
    for (let attempts = 0; attempts < 3; attempts++) {
      try {
        raw = fs.readFileSync(filePath, 'utf8');
        records = parseAjsonRecords(raw, filePath);
        readSuccess = true;
        break;
      } catch (err) {
        if (attempts === 2) {
          console.error(`[indexer] failed to read ${filePath} after 3 attempts`, err);
        } else {
          // Jittered backoff (e.g., 50ms to 150ms)
          const delay = 50 + Math.random() * 100;
          const startDelay = Date.now();
          while (Date.now() - startDelay < delay) {} // synchronous sleep
        }
      }
    }

    if (!readSuccess) {
      totalErrors++;
      if (i % COMMIT_EVERY === 0 || i === ajsonFiles.length) {
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
          errors: totalErrors,
          decision: 'failed-to-read',
          reason: processReason,
          logicalSourcePath
        });
      }
      continue;
    }

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

        console.log('[indexer] source upsert start', {
          filePath,
          logicalSourcePath: pathVal,
          existedBefore,
        });

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

          console.log('[indexer] source upsert success', {
            filePath,
            logicalSourcePath: pathVal,
            sourceId,
            existedBefore,
          });

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
          console.warn('[indexer] skipping block because parent source was not found', {
            filePath,
            blockKey,
            sourcePath,
          });
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
          errors: totalErrors,
          decision: 'processed',
          reason: processReason,
          logicalSourcePath
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

  console.log('[indexer] db commit success');
  db.exec('COMMIT TRANSACTION'); // final partial batch
  console.log('[indexer] final COMMIT', { processedFiles: ajsonFiles.length });

  if (sinceCommit > 0 && sinceCommit < COMMIT_EVERY) {
    emitProgress({
      phase: 'file',
      processedFiles: ajsonFiles.length,
      totalFiles: ajsonFiles.length,
      lastFile: '',
      sourcesInserted,
      sourcesUpdated,
      sourcesDeleted,
      blocksUpserted,
      embeddingsUpserted,
      errors: totalErrors,
      decision: 'processed',
      reason: 'final-batch'
    });
  }
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

try {
  const sourceCount = db.prepare('SELECT COUNT(*) AS c FROM sources').get()?.c ?? 0;
  const blockCount = db.prepare('SELECT COUNT(*) AS c FROM blocks').get()?.c ?? 0;
  const embeddingCount = db.prepare('SELECT COUNT(*) AS c FROM embeddings').get()?.c ?? 0;

  console.log('[indexer] post-run table counts', {
    sourceCount,
    blockCount,
    embeddingCount,
  });
} catch (error) {
  console.error('[indexer] failed to read post-run table counts', {
    error: String(error),
  });
}

const dbSize = fs.statSync(dbPath).size;

console.log('\n[indexer] ── BUILD COMPLETE ───────────────────────────────────');
console.log('[indexer] sources updated :', sourcesUpdated);
console.log('[indexer] blocks upserted :', blocksUpserted);
console.log('[indexer] embeddings      :', embeddingsUpserted);
console.log('[indexer] sources deleted :', sourcesDeleted);
console.log('[indexer] errors          :', totalErrors);
console.log('[indexer] db size         :', dbSize, 'bytes');

db.close();
