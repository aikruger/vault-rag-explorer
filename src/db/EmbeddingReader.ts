import type { Database } from "./Database";

const LOG_PREFIX = "[EmbeddingReader]";

export interface StoredEmbedding {
  ownerType: 'source' | 'block';
  ownerId: number;
  modelName: string;
  dim: number;
  norm: number;
  isNormalized: boolean;
  vec: Float32Array;
}

import type { Database as SqlJsDatabase } from "sql.js";
import { getScalar, getRows } from "./IndexBuilder";

export class EmbeddingReader {
  constructor(private db: Database) {}

  /**
   * Load all stored embeddings for a given modelName.
   * Returns an array of StoredEmbedding, one per row in the embeddings table.
   */
  loadAll(modelName: string): StoredEmbedding[] {
    if (modelName == null || modelName === "") {
      console.error(`${LOG_PREFIX} invalid modelName before bind`, { modelName });
      throw new Error("Invalid modelName before SQL bind");
    }

    const rawDb = this.db.getDb();
    console.log('[EmbeddingReader] loadEmbeddings start', { modelName });

    console.log('[EmbeddingReader] DB counts before model query', {
      totalEmbeddings: getScalar(rawDb, 'SELECT COUNT(*) FROM embeddings'),
      byModel: getRows(rawDb, `
        SELECT model_name as modelname, COUNT(*) AS count
        FROM embeddings
        GROUP BY model_name
        ORDER BY count DESC
      `),
    });

    console.log('[EmbeddingReader] querying embeddings', {
      requestedModel: modelName,
    });

    const stmt = rawDb.prepare(`
      SELECT owner_type, owner_id, model_name, dim, norm, is_normalized, embedding
      FROM embeddings
      WHERE model_name = ?
    `);

    const results: StoredEmbedding[] = [];

    try {
      console.log(`${LOG_PREFIX} statement prepared for loadAll`, { modelName });
      stmt.bind([modelName]);
      console.log(`${LOG_PREFIX} statement bound for loadAll`, { modelName });

      while (stmt.step()) {
        const row = stmt.getAsObject() as {
          owner_type: 'source' | 'block';
          owner_id: number;
          model_name: string;
          dim: number;
          norm: number;
          is_normalized: number;
          embedding: Uint8Array;
        };

        if (row.embedding == null) {
          console.error(`${LOG_PREFIX} missing embedding blob`, { ownerId: row.owner_id });
          continue;
        }

        const buf = Buffer.from(row.embedding as string | Uint8Array);
			// Removed per-row logging to reduce noise, only logging errors
        const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

        if (vec.length !== row.dim) {
          console.warn(`${LOG_PREFIX} Skipping embedding id=${row.owner_id} — dim mismatch stored=${row.dim} actual=${vec.length}`);
          continue;
        }

        results.push({
          ownerType: row.owner_type,
          ownerId: row.owner_id,
          modelName: row.model_name,
          dim: row.dim,
          norm: row.norm,
          isNormalized: Boolean(row.is_normalized),
          vec
        });
      }
      stmt.reset();
      console.log(`${LOG_PREFIX} statement reset for loadAll`);
    } catch (error) {
      console.error(`${LOG_PREFIX} statement failed in loadAll`, { modelName, error });
      throw error;
    } finally {
      stmt.free();
      console.log(`${LOG_PREFIX} statement freed for loadAll`);
    }

    console.log('[EmbeddingReader] query results', {
      requestedModel: modelName,
      rowCount: results.length,
      sample: results[0]
        ? {
            ownerType: results[0].ownerType,
            ownerId: results[0].ownerId,
            modelName: results[0].modelName,
            dim: results[0].dim,
          }
        : null,
    });

    return results;
  }

  /**
   * Load embeddings for a specific owner (source or block).
   */
  loadForOwner(ownerType: 'source' | 'block', ownerId: number, modelName: string): StoredEmbedding | null {
    if (modelName == null || modelName === "") {
      console.error(`${LOG_PREFIX} invalid modelName before bind`, { modelName });
      throw new Error("Invalid modelName before SQL bind");
    }
    if (!Number.isFinite(ownerId) || ownerId <= 0) {
      console.error(`${LOG_PREFIX} invalid ownerId before bind`, { ownerId });
      throw new Error("Invalid ownerId before SQL bind");
    }

    const rawDb = this.db.getDb();
    const stmt = rawDb.prepare(`
      SELECT owner_type, owner_id, model_name, dim, norm, is_normalized, embedding
      FROM embeddings
      WHERE owner_type = ? AND owner_id = ? AND model_name = ?
    `);

    let resultRow: StoredEmbedding | null = null;

    try {
      console.log(`${LOG_PREFIX} statement prepared for loadForOwner`, { ownerType, ownerId, modelName });
      stmt.bind([ownerType, ownerId, modelName]);
      console.log(`${LOG_PREFIX} statement bound for loadForOwner`, { ownerType, ownerId, modelName });

      if (stmt.step()) {
        const row = stmt.getAsObject() as {
          owner_type: 'source' | 'block';
          owner_id: number;
          model_name: string;
          dim: number;
          norm: number;
          is_normalized: number;
          embedding: Uint8Array;
        };

        if (row.embedding != null) {
          const buf = Buffer.from(row.embedding as string | Uint8Array);
          const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

          if (vec.length === row.dim) {
            resultRow = {
              ownerType: row.owner_type,
              ownerId: row.owner_id,
              modelName: row.model_name,
              dim: row.dim,
              norm: row.norm,
              isNormalized: Boolean(row.is_normalized),
              vec
            };
          } else {
            console.warn(`${LOG_PREFIX} Skipping embedding id=${row.owner_id} — dim mismatch stored=${row.dim} actual=${vec.length}`);
          }
        }
      }
      stmt.reset();
      console.log(`${LOG_PREFIX} statement reset for loadForOwner`);
    } catch (error) {
      console.error(`${LOG_PREFIX} statement failed in loadForOwner`, { ownerType, ownerId, modelName, error });
      throw error;
    } finally {
      stmt.free();
      console.log(`${LOG_PREFIX} statement freed for loadForOwner`);
    }

    return resultRow;
  }

  loadAllByDim(dim: number): StoredEmbedding[] {
    if (!Number.isFinite(dim) || dim <= 0) {
      console.error(`${LOG_PREFIX} invalid dim before bind`, { dim });
      throw new Error("Invalid dim before SQL bind");
    }

    const rawDb = this.db.getDb();
    console.log('[EmbeddingReader] loadAllByDim', { dim });

    const stmt = rawDb.prepare(`
      SELECT owner_type, owner_id, model_name, dim, norm, is_normalized, embedding
      FROM embeddings
      WHERE dim = ?
    `);

    const results: StoredEmbedding[] = [];

    try {
      console.log(`${LOG_PREFIX} statement prepared for loadAllByDim`, { dim });
      stmt.bind([dim]);
      console.log(`${LOG_PREFIX} statement bound for loadAllByDim`, { dim });

      while (stmt.step()) {
        const row = stmt.getAsObject() as Record<string, unknown>;
        if (row.embedding == null) continue;
        const buf = Buffer.from(row.embedding as string | Uint8Array);
        const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        if (vec.length !== row.dim) continue;
        results.push({
          ownerType: row.owner_type as "block" | "source",
          ownerId: row.owner_id as number,
          modelName: row.model_name as string,
          dim: row.dim as number,
          norm: row.norm as number,
          isNormalized: Boolean(row.is_normalized),
          vec,
        });
      }
      stmt.reset();
      console.log(`${LOG_PREFIX} statement reset for loadAllByDim`);
    } catch (error) {
      console.error(`${LOG_PREFIX} statement failed in loadAllByDim`, { dim, error });
      throw error;
    } finally {
      stmt.free();
      console.log(`${LOG_PREFIX} statement freed for loadAllByDim`);
    }

    console.log('[EmbeddingReader] loadAllByDim results', { dim, count: results.length });
    return results;
  }
}
