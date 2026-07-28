import type { Database as SqlJsDatabase } from "sql.js";
import type { Database } from "./Database";
import type {
  ParsedSource,
  ParsedBlock,
  ParsedEmbedding,
  IndexBuildResult,
} from "../types";

const LOG_PREFIX = "[IndexBuilder]";

/** Number of records to write per SQLite transaction. */
const BATCH_SIZE = 50;

export function getScalar(db: SqlJsDatabase, sql: string): number | string | null {
  try {
    const res = db.exec(sql);
    return res?.[0]?.values?.[0]?.[0] as number | string ?? null;
  } catch (e) {
    console.log('[IndexBuilder] SQL debug query failed (getScalar)', { sql, error: e });
    return null;
  }
}

export function getRows(db: SqlJsDatabase, sql: string): unknown[] {
  try {
    const res = db.exec(sql);
    if (!res?.[0]) return [];
    const cols = res[0].columns;
    return res[0].values.map((row: unknown[]) =>
      Object.fromEntries(cols.map((c: string, i: number) => [c, row[i]]))
    );
  } catch (e) {
    console.log('[IndexBuilder] SQL debug query failed (getRows)', { sql, error: e });
    return [];
  }
}

export class IndexBuilder {
  private db: Database;
  private enableDebugLogging: boolean;

  constructor(db: Database, enableDebugLogging = true) {
    this.db = db;
    this.enableDebugLogging = enableDebugLogging;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Convenience wrapper for re-indexing a single .ajson file.
   * Called by AjsonWatcherService on each debounced file change event.
   */
  async buildFromSingleFile(
    watchFolder: string,
    filePath: string
  ): Promise<{ sources: number; blocks: number; embeddings: number }> {
    console.log(`[IndexBuilder] buildFromSingleFile start`, {
      filePath,
      watchFolder,
      timestamp: Date.now(),
    });
    return this.buildFromPath(watchFolder, [filePath]);
  }

  /**
   * Write all parsed sources and blocks into the SQLite database.
   * Operates incrementally: records whose `hash` matches the stored value are
   * skipped (no re-write needed). Pass `forceRebuild=true` to bypass the hash
   * check and overwrite every record.
   */
  async buildFromPath(
    smartEnvPath: string,
    ajsonFiles: string[]
  ): Promise<{ sources: number; blocks: number; embeddings: number }> {
    console.log('[IndexBuilder] buildFromPath ENTER — files:', ajsonFiles.length);
    const startTime = Date.now();

    const rawDb = this.db.getDb();
    if (!rawDb) {
      throw new Error("Database is not open — cannot build index");
    }

    // Apply performance pragmas for the write session
    rawDb.exec("PRAGMA journal_mode = WAL;");
    rawDb.exec("PRAGMA synchronous = NORMAL;");
    rawDb.exec("PRAGMA temp_store = MEMORY;");

    let totalSources = 0;
    let totalBlocks = 0;
    let totalEmbeddings = 0;
    let parseErrors = 0;
    const CHUNK_SIZE = 20; // files per chunk before yielding

    // Dynamic import to avoid top-level require errors if AjsonParser is isolated
    const { AjsonParser } = await import("../parsers/AjsonParser");
    const parser = new AjsonParser(this.enableDebugLogging);
    const fs = require('fs');

    const resultDummy: IndexBuildResult = {
      sourcesInserted: 0,
      sourcesUpdated: 0,
      sourcesSkipped: 0,
      blocksInserted: 0,
      blocksUpdated: 0,
      blocksSkipped: 0,
      embeddingsWritten: 0,
      wikilinksWritten: 0,
      durationMs: 0,
      errors: [],
    };

    for (let i = 0; i < ajsonFiles.length; i++) {
      if (i > 0 && i % CHUNK_SIZE === 0) {
        await new Promise(resolve => window.setTimeout(resolve, 0));
        console.log(`[IndexBuilder] yielded at file ${i}/${ajsonFiles.length}`);
      }

      const filePath = ajsonFiles[i];
      if (!filePath) continue;
      console.log(`[IndexBuilder] parsing file ${i + 1}/${ajsonFiles.length}: ${filePath}`);

      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = parser.parseContent(raw, filePath);

        const sourcesCount = parsed.sources.length;
        const blocksCount = parsed.blocks.length;
        const embeddingsCount = parsed.sources.reduce((a, s) => a + s.embeddings.length, 0) + parsed.blocks.reduce((a, b) => a + b.embeddings.length, 0);

        console.log(`[IndexBuilder] parsed — sources:${sourcesCount} blocks:${blocksCount} embeddings:${embeddingsCount}`);

        if (sourcesCount > 0) {
          this.upsertSources(rawDb, parsed.sources, false, resultDummy);
          totalSources += sourcesCount;
        }
        if (blocksCount > 0) {
          this.upsertBlocks(rawDb, parsed.blocks, false, resultDummy);
          totalBlocks += blocksCount;
        }
        totalEmbeddings += resultDummy.embeddingsWritten; // using upsert return logic implicitly via result dummy
        // Note: totalEmbeddings tracks *written* embeddings based on actual upsert

      } catch (err) {
        parseErrors++;
        console.error('[IndexBuilder] error processing file:', filePath, err);
      }
    }

    console.log('[IndexBuilder] parse complete', {
      totalSources,
      totalBlocks,
      totalEmbeddings,
      parseErrors,
    });

    if (totalEmbeddings === 0 && resultDummy.embeddingsWritten === 0 && parseErrors === 0) {
      console.log('[IndexBuilder] WARNING — zero embeddings parsed. Checking first file manually...');
      if (ajsonFiles.length > 0) {
        const raw = fs.readFileSync(ajsonFiles[0], 'utf8');
        console.log('[IndexBuilder] first file length', raw.length);
        console.log('[IndexBuilder] first file preview', raw.slice(0, 500).replace(/\n/g, '\\n'));
      }
    }

    await new Promise(resolve => window.setTimeout(resolve, 0));
    console.log('[IndexBuilder] yielding before db.persist() / export()');
    // We defer persistence to the caller (e.g. AjsonWatcherService or external indexer) to debounce writes.
    console.log('[IndexBuilder] buildFromPath EXIT — embeddings:', resultDummy.embeddingsWritten);

    return { sources: totalSources, blocks: totalBlocks, embeddings: resultDummy.embeddingsWritten };
  }

  // ---------------------------------------------------------------------------
  // Private: upsert sources
  // ---------------------------------------------------------------------------

  private upsertSources(
    rawDb: SqlJsDatabase,
    sources: ParsedSource[],
    forceRebuild: boolean,
    result: IndexBuildResult
  ): void {
    console.log(`${LOG_PREFIX} Upserting ${sources.length} sources in batches of ${BATCH_SIZE}`);

    const selectHash = rawDb.prepare(
      "SELECT hash FROM sources WHERE path = $path"
    );

    const insertSource = rawDb.prepare(`
      INSERT INTO sources (path, title, metadata_json, raw_json, mtime, hash)
      VALUES ($path, $title, $metadata_json, $raw_json, $mtime, $hash)
    `);

    const updateSource = rawDb.prepare(`
      UPDATE sources
      SET title = $title, metadata_json = $metadata_json, raw_json = $raw_json,
          mtime = $mtime, hash = $hash
      WHERE path = $path
    `);

    // NEW: find any row — deleted or not — with the same hash under a DIFFERENT path.
    // This is how we detect "this is the same file, just moved/renamed".
    const selectByHashDifferentPath = rawDb.prepare(
      "SELECT id, path FROM sources WHERE hash = $hash AND hash != '' AND path != $path"
    );

    // NEW: rename update — reassigns the path on the EXISTING row/id, un-deletes it,
    // and does NOT touch blocks/embeddings since source_id never changes.
    const renameSource = rawDb.prepare(`
      UPDATE sources
      SET path = $newPath, title = $title, metadata_json = $metadata_json,
          raw_json = $raw_json, mtime = $mtime, hash = $hash,
          is_deleted = 0, deleted_at = NULL, delete_reason = NULL
      WHERE id = $id
    `);

    const selectSourceId = rawDb.prepare(
      "SELECT id FROM sources WHERE path = $path"
    );
    try {

    for (let batchStart = 0; batchStart < sources.length; batchStart += BATCH_SIZE) {
      const batch = sources.slice(batchStart, batchStart + BATCH_SIZE);
      console.log(`${LOG_PREFIX} BEGIN source batch transaction`, {
        batchStart,
        batchSize: batch.length
      });

      rawDb.exec("BEGIN TRANSACTION;");
      for (const source of batch) {
        try {
          console.log(`[IndexBuilder] Upserting source`, source.path);
          selectHash.bind({ $path: source.path });
          let existing: { hash: string | null } | undefined;
          if (selectHash.step()) {
             existing = selectHash.getAsObject() as { hash: string | null };
          }
          selectHash.reset();

          if (!forceRebuild && existing && existing.hash === source.hash && source.hash !== "") {
            result.sourcesSkipped++;
            if (this.enableDebugLogging) {
              console.log(`${LOG_PREFIX} Source unchanged, skipping: ${source.path}`);
            }
            continue;
          }

          const rowParams = {
            $path: source.path,
            $title: source.title,
            $metadata_json: JSON.stringify(source.metadata),
            $raw_json: source.rawJson,
            $mtime: source.mtime,
            $hash: source.hash,
          };

          if (existing) {
            updateSource.run(rowParams);
            result.sourcesUpdated++;
            console.log(`${LOG_PREFIX} Updated existing source: ${source.path}`);
          } else {
            // No row at this path — before inserting fresh, check if this content
            // (by hash) already exists somewhere else under a different path.
            // If so, this is a RENAME, not a new file.
          if (source.hash) {
            selectByHashDifferentPath.bind({ $hash: source.hash, $path: source.path });
            let renameMatch: { id: number; path: string } | undefined;
            if (selectByHashDifferentPath.step()) {
              renameMatch = selectByHashDifferentPath.getAsObject() as { id: number; path: string };
            }
            selectByHashDifferentPath.reset();

            if (renameMatch) {
              console.log(`[IndexBuilder] rename detected via hash match`, {
                sourceId: renameMatch.id,
                oldPath: renameMatch.path,
                newPath: source.path,
                hash: source.hash,
              });
              renameSource.run({ $id: renameMatch.id, $newPath: source.path, ...rowParams });
              result.sourcesInserted++; // counted as a change, not a true fresh insert
              console.log(`[IndexBuilder] rename reconciled — source_id preserved`, {
                sourceId: renameMatch.id,
                newPath: source.path,
              });

              // We must still write embeddings and blocks for this path in case any inner
              // content changed (or if blocks were not previously persisted correctly).
              // Proceed down to embeddings loop.
            } else {
              insertSource.run(rowParams);
              result.sourcesInserted++;
              console.log(`${LOG_PREFIX} Inserted source: ${source.path}`);
            }
          } else {
            insertSource.run(rowParams);
            result.sourcesInserted++;
            console.log(`${LOG_PREFIX} Inserted source: ${source.path}`);
          }
          }

          // Write embeddings
          selectSourceId.bind({ $path: source.path });
          if (selectSourceId.step()) {
            const idRow = selectSourceId.getAsObject() as { id: number };
            const embCount = this.upsertEmbeddings(rawDb, "source", idRow.id, source.embeddings);
            result.embeddingsWritten += embCount;
          }
          selectSourceId.reset();

          // Write wikilinks
          selectSourceId.bind({ $path: source.path });
          if (selectSourceId.step()) {
             const srcIdRow = selectSourceId.getAsObject() as { id: number };
             const wlCount = this.upsertWikilinks(rawDb, srcIdRow.id, source.outlinks);
             result.wikilinksWritten += wlCount;
          }
          selectSourceId.reset();
        } catch (e) {
          const msg = `Error upserting source ${source.path}: ${String(e)}`;
          console.error(`${LOG_PREFIX} ${msg}`);
          result.errors.push(msg);
        }
      }
      rawDb.exec("COMMIT;");
      console.log(`${LOG_PREFIX} COMMIT source batch transaction`, {
        batchStart,
        batchSize: batch.length
      });
    }

    } finally {
      selectByHashDifferentPath.free();
      renameSource.free();
      selectHash.free();
      console.log('[MemoryCheck] stmt freed', { name: 'selectHash' });
      insertSource.free();
      console.log('[MemoryCheck] stmt freed', { name: 'insertSource' });
      updateSource.free();
      console.log('[MemoryCheck] stmt freed', { name: 'updateSource' });
      selectSourceId.free();
      console.log('[MemoryCheck] stmt freed', { name: 'selectSourceId' });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: upsert blocks
  // ---------------------------------------------------------------------------

  private upsertBlocks(
    rawDb: SqlJsDatabase,
    blocks: ParsedBlock[],
    forceRebuild: boolean,
    result: IndexBuildResult
  ): void {
    console.log(`${LOG_PREFIX} Upserting ${blocks.length} blocks in batches of ${BATCH_SIZE}`);

    const selectBlockHash = rawDb.prepare(
      "SELECT id, hash FROM blocks WHERE block_key = $block_key"
    );

    const selectSourceId = rawDb.prepare(
      "SELECT id FROM sources WHERE path = $path"
    );

    const selectStoredHashRow = rawDb.prepare(
      "SELECT raw_json FROM blocks WHERE block_key = $block_key"
    );

    const insertBlock = rawDb.prepare(`
      INSERT INTO blocks
        (source_id, block_key, block_path, block_label, line_start, line_end,
         text, text_length, metadata_json, raw_json)
      VALUES
        ($source_id, $block_key, $block_path, $block_label, $line_start, $line_end,
         $text, $text_length, $metadata_json, $raw_json)
    `);

    const updateBlock = rawDb.prepare(`
      UPDATE blocks
      SET source_id = $source_id, block_path = $block_path, block_label = $block_label,
          line_start = $line_start, line_end = $line_end, text = $text,
          text_length = $text_length, metadata_json = $metadata_json, raw_json = $raw_json
      WHERE block_key = $block_key
    `);

    const selectBlockId = rawDb.prepare(
      "SELECT id FROM blocks WHERE block_key = $block_key"
    );
    try {

    for (let batchStart = 0; batchStart < blocks.length; batchStart += BATCH_SIZE) {
      const batch = blocks.slice(batchStart, batchStart + BATCH_SIZE);
      console.log(`${LOG_PREFIX} BEGIN block batch transaction`, {
        batchStart,
        batchSize: batch.length
      });

      rawDb.exec("BEGIN TRANSACTION;");
      for (const block of batch) {
        try {
          // Resolve parent source_id — required FK
          let srcRow: { id: number } | undefined;
          try {
            selectSourceId.bind({ $path: block.blockPath });
            if (selectSourceId.step()) {
              srcRow = selectSourceId.getAsObject() as { id: number };
            }
          } finally {
            selectSourceId.reset();
            console.log('[MemoryCheck] stmt reset in finally', { name: 'selectSourceId', key: block.blockKey });
          }

          if (!srcRow) {
            const msg = `Block ${block.blockKey}: parent source not found for path=${block.blockPath} — skipping`;
            console.warn(`${LOG_PREFIX} ${msg}`);
            result.blocksSkipped++;
            result.errors.push(msg);
            continue;
          }

          let existing: { id: number; hash: string | null } | undefined;
          try {
            selectBlockHash.bind({ $block_key: block.blockKey });
            if (selectBlockHash.step()) {
              existing = selectBlockHash.getAsObject() as { id: number; hash: string | null };
            }
          } finally {
            selectBlockHash.reset();
          }

          let storedHashRow: { raw_json: string } | undefined;
          try {
            selectStoredHashRow.bind({ $block_key: block.blockKey });
            if (selectStoredHashRow.step()) {
              storedHashRow = selectStoredHashRow.getAsObject() as { raw_json: string };
            }
          } finally {
            selectStoredHashRow.reset();
          }

          if (!forceRebuild && storedHashRow) {
            try {
              const storedRaw = JSON.parse(storedHashRow.raw_json);
              const storedEmbedHash = storedRaw?.last_embed?.hash ?? '';
              if (storedEmbedHash === block.embedHash && block.embedHash !== '') {
                result.blocksSkipped++;
                if (this.enableDebugLogging) {
                  console.log(`${LOG_PREFIX} Block embed hash unchanged, skipping: ${block.blockKey}`);
                }
                continue;
              }
            } catch (e) {
              console.warn(`${LOG_PREFIX} Could not parse raw_json for hash check: ${block.blockKey}`, e);
            }
          }

          const rowParams = {
            $source_id: srcRow.id,
            $block_key: block.blockKey,
            $block_path: block.blockPath,
            $block_label: block.blockLabel,
            $line_start: block.lineStart,
            $line_end: block.lineEnd,
            $text: block.text,
            $text_length: block.textLength,
            $metadata_json: JSON.stringify(block.metadata),
            $raw_json: block.rawJson,
          };

          if (!existing) {
            insertBlock.run(rowParams);
            result.blocksInserted++;
            if (this.enableDebugLogging) {
              console.log(`${LOG_PREFIX} Inserted block: ${block.blockKey}`);
            }
          } else {
            updateBlock.run(rowParams);
            result.blocksUpdated++;
            if (this.enableDebugLogging) {
              console.log(`${LOG_PREFIX} Updated block: ${block.blockKey}`);
            }
          }

          // Write embeddings
          try {
            selectBlockId.bind({ $block_key: block.blockKey });
            if (selectBlockId.step()) {
              const blockIdRow = selectBlockId.getAsObject() as { id: number };
              const embCount = this.upsertEmbeddings(rawDb, "block", blockIdRow.id, block.embeddings);
              result.embeddingsWritten += embCount;
            }
          } finally {
            selectBlockId.reset();
          }
        } catch (e) {
          const msg = `Error upserting block ${block.blockKey}: ${String(e)}`;
          console.error(`${LOG_PREFIX} ${msg}`);
          result.errors.push(msg);
        }
      }
      rawDb.exec("COMMIT;");
      console.log(`${LOG_PREFIX} COMMIT block batch transaction`, {
        batchStart,
        batchSize: batch.length
      });
    }

    } finally {
      selectBlockHash.free();
      console.log('[MemoryCheck] stmt freed', { name: 'selectBlockHash' });
      selectSourceId.free();
      console.log('[MemoryCheck] stmt freed', { name: 'selectSourceId' });
      selectStoredHashRow.free();
      console.log('[MemoryCheck] stmt freed', { name: 'selectStoredHashRow' });
      insertBlock.free();
      console.log('[MemoryCheck] stmt freed', { name: 'insertBlock' });
      updateBlock.free();
      console.log('[MemoryCheck] stmt freed', { name: 'updateBlock' });
      selectBlockId.free();
      console.log('[MemoryCheck] stmt freed', { name: 'selectBlockId' });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: upsert embeddings
  // ---------------------------------------------------------------------------

  /**
   * Convert each ParsedEmbedding to a float32 BLOB and upsert it.
   * Returns the number of embedding rows written.
   */
  private upsertEmbeddings(
    rawDb: SqlJsDatabase,
    ownerType: "source" | "block",
    ownerId: number,
    embeddings: ParsedEmbedding[]
  ): number {
    if (embeddings.length === 0) return 0;

    const upsertEmb = rawDb.prepare(`
      INSERT INTO embeddings
        (owner_type, owner_id, model_name, dim, dtype, norm, is_normalized, embedding)
      VALUES
        ($owner_type, $owner_id, $model_name, $dim, $dtype, $norm, $is_normalized, $embedding)
      ON CONFLICT(owner_type, owner_id, model_name) DO UPDATE SET
        dim          = excluded.dim,
        dtype        = excluded.dtype,
        norm         = excluded.norm,
        is_normalized = excluded.is_normalized,
        embedding    = excluded.embedding
    `);
    let written = 0;
    try {
    for (const emb of embeddings) {
      console.log(`[IndexBuilder] inserting embeddings batch`, { batchSize: embeddings.length, modelName: emb.modelName });
      try {
        const { blob, norm, isNormalized } = this.packEmbedding(emb.vec);

        upsertEmb.run({
          $owner_type: ownerType,
          $owner_id: ownerId,
          $model_name: emb.modelName,
          $dim: emb.dim,
          $dtype: "float32",
          $norm: norm,
          $is_normalized: isNormalized ? 1 : 0,
          $embedding: blob,
        });

        written++;

        if (this.enableDebugLogging) {
          console.log(
            `${LOG_PREFIX} Upserted embedding owner_type=${ownerType} owner_id=${ownerId} model=${emb.modelName} dim=${emb.dim} norm=${norm.toFixed(6)} is_normalized=${isNormalized}`
          );
        }
      } catch (e) {
        console.error(
          `${LOG_PREFIX} Failed to upsert embedding owner_type=${ownerType} owner_id=${ownerId} model=${emb.modelName}: ${String(e)}`
        );
      }
    }

    } finally {
      upsertEmb.free();
      console.log('[MemoryCheck] stmt freed', { name: 'upsertEmb' });
    }

    return written;
  }

  // ---------------------------------------------------------------------------
  // Private: upsert wikilinks
  // ---------------------------------------------------------------------------

  private upsertWikilinks(
    rawDb: SqlJsDatabase,
    srcSourceId: number,
    outlinks: string[]
  ): number {
    if (outlinks.length === 0) return 0;

    // Delete existing wikilinks for this source to replace with fresh set
    rawDb.exec(`DELETE FROM wikilinks WHERE src_source_id = ${srcSourceId}`);

    const insertWikilink = rawDb.prepare(`
      INSERT INTO wikilinks (src_source_id, dst_path, dst_source_id, anchor_text, line_no, edge_type)
      VALUES ($src_source_id, $dst_path, $dst_source_id, $anchor_text, $line_no, $edge_type)
    `);

    const lookupDst = rawDb.prepare(
      "SELECT id FROM sources WHERE path = $path"
    );
    let written = 0;
    try {
    for (const dstPath of outlinks) {
      try {
        let dstRow: { id: number } | undefined;
        try {
          lookupDst.bind({ $path: dstPath });
          if (lookupDst.step()) {
             dstRow = lookupDst.getAsObject() as { id: number };
          }
        } finally {
          lookupDst.reset();
        }

        insertWikilink.run({
          $src_source_id: srcSourceId,
          $dst_path: dstPath,
          $dst_source_id: dstRow ? dstRow.id : null,
          $anchor_text: null,
          $line_no: null,
          $edge_type: "wikilink",
        });
        written++;

        if (this.enableDebugLogging) {
          console.log(
            `${LOG_PREFIX} Wikilink: src_id=${srcSourceId} → dst=${dstPath} resolved=${!!dstRow}`
          );
        }
      } catch (e) {
        console.error(
          `${LOG_PREFIX} Failed to insert wikilink src_id=${srcSourceId} dst=${dstPath}: ${String(e)}`
        );
      }
    }

    } finally {
      insertWikilink.free();
      console.log('[MemoryCheck] stmt freed', { name: 'insertWikilink' });
      lookupDst.free();
      console.log('[MemoryCheck] stmt freed', { name: 'lookupDst' });
    }

    return written;
  }

  // ---------------------------------------------------------------------------
  // Private: embedding BLOB codec
  // ---------------------------------------------------------------------------

  /**
   * Convert a raw float[] into a float32 BLOB ready for SQLite storage.
   * Also computes the L2 norm and determines whether the vector is already
   * unit-normalized (norm ≈ 1.0 within 1e-4 tolerance).
   */
  private packEmbedding(vec: number[]): {
    blob: Buffer;
    norm: number;
    isNormalized: boolean;
  } {
    const arr = new Float32Array(vec);
    let sumSq = 0;
    for (let i = 0; i < arr.length; i++) sumSq += (arr[i] || 0) * (arr[i] || 0);
    const norm = Math.sqrt(sumSq);
    const isNormalized = Math.abs(norm - 1.0) < 1e-4;
    const blob = Buffer.from(arr.buffer);
    return { blob, norm, isNormalized };
  }
}
