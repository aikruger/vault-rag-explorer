import type { Database as BetterSqlite3 } from "better-sqlite3";
import type { Database } from "./Database";
import type {
  ParsedSource,
  ParsedBlock,
  ParsedEmbedding,
  IndexBuildResult,
} from "../types";

const LOG_PREFIX = "[IndexBuilder]";

/** Number of records to write per SQLite transaction. */
const BATCH_SIZE = 500;

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
   * Write all parsed sources and blocks into the SQLite database.
   * Operates incrementally: records whose `hash` matches the stored value are
   * skipped (no re-write needed). Pass `forceRebuild=true` to bypass the hash
   * check and overwrite every record.
   */
  async buildIndex(
    sources: ParsedSource[],
    blocks: ParsedBlock[],
    forceRebuild = false
  ): Promise<IndexBuildResult> {
    const startTime = Date.now();
    console.log(`${LOG_PREFIX} buildIndex started`, {
      sourcesTotal: sources.length,
      blocksTotal: blocks.length,
      forceRebuild,
    });

    const result: IndexBuildResult = {
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

    const rawDb = this.db.getDb();
    if (!rawDb) {
      const msg = "Database is not open — cannot build index";
      console.error(`${LOG_PREFIX} ${msg}`);
      result.errors.push(msg);
      return result;
    }

    // Apply performance pragmas for the write session
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("synchronous = NORMAL");
    rawDb.pragma("temp_store = MEMORY");
    console.log(`${LOG_PREFIX} Applied WAL pragmas`);

    // --- Sources ---
    await this.upsertSources(rawDb, sources, forceRebuild, result);

    // --- Blocks ---
    await this.upsertBlocks(rawDb, blocks, forceRebuild, result);

    result.durationMs = Date.now() - startTime;

    console.log(`${LOG_PREFIX} buildIndex complete`, {
      sourcesInserted: result.sourcesInserted,
      sourcesUpdated: result.sourcesUpdated,
      sourcesSkipped: result.sourcesSkipped,
      blocksInserted: result.blocksInserted,
      blocksUpdated: result.blocksUpdated,
      blocksSkipped: result.blocksSkipped,
      embeddingsWritten: result.embeddingsWritten,
      wikilinksWritten: result.wikilinksWritten,
      durationMs: result.durationMs,
      errors: result.errors.length,
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private: upsert sources
  // ---------------------------------------------------------------------------

  private upsertSources(
    rawDb: BetterSqlite3,
    sources: ParsedSource[],
    forceRebuild: boolean,
    result: IndexBuildResult
  ): void {
    console.log(`${LOG_PREFIX} Upserting ${sources.length} sources in batches of ${BATCH_SIZE}`);

    const selectHash = rawDb.prepare<[string], { hash: string | null }>(
      "SELECT hash FROM sources WHERE path = ?"
    );

    const insertSource = rawDb.prepare(`
      INSERT INTO sources (path, title, metadata_json, raw_json, mtime, hash)
      VALUES (@path, @title, @metadata_json, @raw_json, @mtime, @hash)
    `);

    const updateSource = rawDb.prepare(`
      UPDATE sources
      SET title = @title, metadata_json = @metadata_json, raw_json = @raw_json,
          mtime = @mtime, hash = @hash
      WHERE path = @path
    `);

    const selectSourceId = rawDb.prepare<[string], { id: number }>(
      "SELECT id FROM sources WHERE path = ?"
    );

    for (let batchStart = 0; batchStart < sources.length; batchStart += BATCH_SIZE) {
      const batch = sources.slice(batchStart, batchStart + BATCH_SIZE);
      console.log(
        `${LOG_PREFIX} Sources batch ${batchStart + 1}-${batchStart + batch.length} of ${sources.length}`
      );

      const writeBatch = rawDb.transaction(() => {
        for (const source of batch) {
          try {
            const existing = selectHash.get(source.path);

            if (!forceRebuild && existing && existing.hash === source.hash && source.hash !== "") {
              result.sourcesSkipped++;
              if (this.enableDebugLogging) {
                console.log(`${LOG_PREFIX} Source unchanged, skipping: ${source.path}`);
              }
              continue;
            }

            const row = {
              path: source.path,
              title: source.title,
              metadata_json: JSON.stringify(source.metadata),
              raw_json: source.rawJson,
              mtime: source.mtime,
              hash: source.hash,
            };

            if (!existing) {
              insertSource.run(row);
              result.sourcesInserted++;
              console.log(`${LOG_PREFIX} Inserted source: ${source.path}`);
            } else {
              updateSource.run(row);
              result.sourcesUpdated++;
              console.log(`${LOG_PREFIX} Updated source: ${source.path}`);
            }

            // Write embeddings
            const idRow = selectSourceId.get(source.path);
            if (idRow) {
              const embCount = this.upsertEmbeddings(rawDb, "source", idRow.id, source.embeddings);
              result.embeddingsWritten += embCount;
            }

            // Write wikilinks
            const srcIdRow = selectSourceId.get(source.path);
            if (srcIdRow) {
              const wlCount = this.upsertWikilinks(rawDb, srcIdRow.id, source.outlinks);
              result.wikilinksWritten += wlCount;
            }
          } catch (e) {
            const msg = `Error upserting source ${source.path}: ${String(e)}`;
            console.error(`${LOG_PREFIX} ${msg}`);
            result.errors.push(msg);
          }
        }
      });

      writeBatch();
    }
  }

  // ---------------------------------------------------------------------------
  // Private: upsert blocks
  // ---------------------------------------------------------------------------

  private upsertBlocks(
    rawDb: BetterSqlite3,
    blocks: ParsedBlock[],
    forceRebuild: boolean,
    result: IndexBuildResult
  ): void {
    console.log(`${LOG_PREFIX} Upserting ${blocks.length} blocks in batches of ${BATCH_SIZE}`);

    const selectBlockHash = rawDb.prepare<[string], { id: number; hash: string | null }>(
      "SELECT id, hash FROM blocks WHERE block_key = ?"
    );

    const selectSourceId = rawDb.prepare<[string], { id: number }>(
      "SELECT id FROM sources WHERE path = ?"
    );

    const insertBlock = rawDb.prepare(`
      INSERT INTO blocks
        (source_id, block_key, block_path, block_label, line_start, line_end,
         text, text_length, metadata_json, raw_json)
      VALUES
        (@source_id, @block_key, @block_path, @block_label, @line_start, @line_end,
         @text, @text_length, @metadata_json, @raw_json)
    `);

    const updateBlock = rawDb.prepare(`
      UPDATE blocks
      SET source_id = @source_id, block_path = @block_path, block_label = @block_label,
          line_start = @line_start, line_end = @line_end, text = @text,
          text_length = @text_length, metadata_json = @metadata_json, raw_json = @raw_json
      WHERE block_key = @block_key
    `);

    const selectBlockId = rawDb.prepare<[string], { id: number }>(
      "SELECT id FROM blocks WHERE block_key = ?"
    );

    for (let batchStart = 0; batchStart < blocks.length; batchStart += BATCH_SIZE) {
      const batch = blocks.slice(batchStart, batchStart + BATCH_SIZE);
      console.log(
        `${LOG_PREFIX} Blocks batch ${batchStart + 1}-${batchStart + batch.length} of ${blocks.length}`
      );

      const writeBatch = rawDb.transaction(() => {
        for (const block of batch) {
          try {
            // Resolve parent source_id — required FK
            const srcRow = selectSourceId.get(block.blockPath);
            if (!srcRow) {
              const msg = `Block ${block.blockKey}: parent source not found for path=${block.blockPath} — skipping`;
              console.warn(`${LOG_PREFIX} ${msg}`);
              result.blocksSkipped++;
              result.errors.push(msg);
              continue;
            }

            const existing = selectBlockHash.get(block.blockKey);

            if (!forceRebuild && existing && existing.hash !== undefined) {
              // hash is stored inside raw_json / metadata, re-check using embedHash as proxy
              // For simplicity, skip if block_key already exists and forceRebuild is false
              // and the embed hash matches. In Milestone 6 this can be refined.
              result.blocksSkipped++;
              if (this.enableDebugLogging) {
                console.log(`${LOG_PREFIX} Block exists, skipping (incremental): ${block.blockKey}`);
              }
              continue;
            }

            const row = {
              source_id: srcRow.id,
              block_key: block.blockKey,
              block_path: block.blockPath,
              block_label: block.blockLabel,
              line_start: block.lineStart,
              line_end: block.lineEnd,
              text: block.text,
              text_length: block.textLength,
              metadata_json: JSON.stringify(block.metadata),
              raw_json: block.rawJson,
            };

            if (!existing) {
              insertBlock.run(row);
              result.blocksInserted++;
              if (this.enableDebugLogging) {
                console.log(`${LOG_PREFIX} Inserted block: ${block.blockKey}`);
              }
            } else {
              updateBlock.run(row);
              result.blocksUpdated++;
              if (this.enableDebugLogging) {
                console.log(`${LOG_PREFIX} Updated block: ${block.blockKey}`);
              }
            }

            // Write embeddings
            const blockIdRow = selectBlockId.get(block.blockKey);
            if (blockIdRow) {
              const embCount = this.upsertEmbeddings(rawDb, "block", blockIdRow.id, block.embeddings);
              result.embeddingsWritten += embCount;
            }
          } catch (e) {
            const msg = `Error upserting block ${block.blockKey}: ${String(e)}`;
            console.error(`${LOG_PREFIX} ${msg}`);
            result.errors.push(msg);
          }
        }
      });

      writeBatch();
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
    rawDb: BetterSqlite3,
    ownerType: "source" | "block",
    ownerId: number,
    embeddings: ParsedEmbedding[]
  ): number {
    if (embeddings.length === 0) return 0;

    const upsertEmb = rawDb.prepare(`
      INSERT INTO embeddings
        (owner_type, owner_id, model_name, dim, dtype, norm, is_normalized, embedding)
      VALUES
        (@owner_type, @owner_id, @model_name, @dim, @dtype, @norm, @is_normalized, @embedding)
      ON CONFLICT(owner_type, owner_id, model_name) DO UPDATE SET
        dim          = excluded.dim,
        dtype        = excluded.dtype,
        norm         = excluded.norm,
        is_normalized = excluded.is_normalized,
        embedding    = excluded.embedding
    `);

    let written = 0;
    for (const emb of embeddings) {
      try {
        const { blob, norm, isNormalized } = this.packEmbedding(emb.vec);

        upsertEmb.run({
          owner_type: ownerType,
          owner_id: ownerId,
          model_name: emb.modelName,
          dim: emb.dim,
          dtype: "float32",
          norm,
          is_normalized: isNormalized ? 1 : 0,
          embedding: blob,
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

    return written;
  }

  // ---------------------------------------------------------------------------
  // Private: upsert wikilinks
  // ---------------------------------------------------------------------------

  private upsertWikilinks(
    rawDb: BetterSqlite3,
    srcSourceId: number,
    outlinks: string[]
  ): number {
    if (outlinks.length === 0) return 0;

    // Delete existing wikilinks for this source to replace with fresh set
    rawDb.prepare("DELETE FROM wikilinks WHERE src_source_id = ?").run(srcSourceId);

    const insertWikilink = rawDb.prepare(`
      INSERT INTO wikilinks (src_source_id, dst_path, dst_source_id, anchor_text, line_no, edge_type)
      VALUES (@src_source_id, @dst_path, @dst_source_id, @anchor_text, @line_no, @edge_type)
    `);

    const lookupDst = rawDb.prepare<[string], { id: number }>(
      "SELECT id FROM sources WHERE path = ?"
    );

    let written = 0;
    for (const dstPath of outlinks) {
      try {
        const dstRow = lookupDst.get(dstPath);
        insertWikilink.run({
          src_source_id: srcSourceId,
          dst_path: dstPath,
          dst_source_id: dstRow ? dstRow.id : null,
          anchor_text: null,
          line_no: null,
          edge_type: "wikilink",
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
