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
    id       TEXT PRIMARY KEY,
    filepath TEXT NOT NULL,
    mtime    INTEGER,
    size     INTEGER
  );

  CREATE TABLE IF NOT EXISTS blocks (
    id       TEXT PRIMARY KEY,
    sourceid TEXT NOT NULL,
    blockkey TEXT,
    content  TEXT,
    FOREIGN KEY (sourceid) REFERENCES sources(id)
  );

  CREATE TABLE IF NOT EXISTS embeddings (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ownertype TEXT NOT NULL,
    ownerid   TEXT NOT NULL,
    modelname TEXT NOT NULL,
    dim       INTEGER NOT NULL,
    vector    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wikilinks (
    fromid TEXT,
    toid   TEXT
  );

  CREATE TABLE IF NOT EXISTS rag_sessions (
    id      TEXT PRIMARY KEY,
    data    TEXT,
    created INTEGER
  );
`);

console.log('[indexer] schema created (5 tables)');

// ── PREPARED STATEMENTS ──────────────────────────────────────────────────────
const insertSource = db.prepare(
  `INSERT OR REPLACE INTO sources (id, filepath, mtime, size)
   VALUES (?, ?, ?, ?)`
);
const insertBlock = db.prepare(
  `INSERT OR REPLACE INTO blocks (id, sourceid, blockkey, content)
   VALUES (?, ?, ?, ?)`
);
const insertEmbedding = db.prepare(
  `INSERT INTO embeddings (ownertype, ownerid, modelname, dim, vector)
   VALUES (?, ?, ?, ?, ?)`
);

// ── PARSE AND INSERT ─────────────────────────────────────────────────────────
let totalSources    = 0;
let totalBlocks     = 0;
let totalEmbeddings = 0;
let totalErrors     = 0;

// Single transaction wraps everything — ~50x faster than per-row commits
db.exec('BEGIN');

try {
  for (const filePath of ajsonFiles) {
    const fileName = path.basename(filePath);
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);

    console.log(`[indexer] ${fileName} — ${lines.length} lines`);

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

      console.log(`[indexer]   record key=${key}, top-level keys=${Object.keys(record).join(',')}`);

      // ── Source record (no '#' in key = file-level)
      if (!key.includes('#')) {
        insertSource.run(key, key, record.mtime ?? null, record.size ?? null);
        totalSources++;
      } else {
        // ── Block record (has '#' separator)
        const sourceId = key.split('#')[0];
        insertBlock.run(key, sourceId, key, record.content ?? record.text ?? null);
        totalBlocks++;
      }

      // ── Embeddings — iterate over model keys inside record.embeddings
      if (record.embeddings && typeof record.embeddings === 'object') {
        console.log(`[indexer]   embedding model keys: ${Object.keys(record.embeddings).join(',')}`);

        for (const [modelName, modelData] of Object.entries(record.embeddings)) {
          const vec = modelData?.vec ?? modelData?.vector ?? null;

          if (!Array.isArray(vec) || vec.length === 0) {
            console.warn(`[indexer]   WARNING: no vec array under model "${modelName}" for key "${key}"`);
            continue;
          }

          const ownerType = key.includes('#') ? 'block' : 'source';
          insertEmbedding.run(ownerType, key, modelName, vec.length, JSON.stringify(vec));
          totalEmbeddings++;
        }
      } else {
        console.log(`[indexer]   no embeddings field on this record`);
      }
    }
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
