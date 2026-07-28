import type { App, Plugin } from "obsidian";
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js";
import * as path from "path";
import * as fs from "fs";
import { DB_SCHEMA_V1 } from "./schema";

const LOG = "[Database]";
export class Database {
    private db: SqlJsDatabase | null = null;
    private SQL: SqlJsStatic | null = null;
    private dbPath: string;
    private pluginDir: string;

    private lastPersistAt = 0;
    private persistPending = false;
    private readonly PERSIST_MIN_INTERVAL_MS = 10_000; // don't do a full export/write more than once per 10s

    constructor(app: App, dbRelPath: string, plugin: Plugin) {
        const basePath = (app.vault.adapter as import("obsidian").FileSystemAdapter).getBasePath();
        this.dbPath = path.join(basePath, dbRelPath);

        // Derive the absolute path to the plugin folder using manifest.dir
        // manifest.dir is e.g. ".obsidian/plugins/vault-rag-explorer"
        // This is always set by Obsidian and does not rely on __dirname
        this.pluginDir = path.join(basePath, plugin.manifest.dir ?? "");

        console.log(`${LOG} dbPath resolved to`, this.dbPath);
        console.log(`${LOG} pluginDir resolved to`, this.pluginDir);
    }

    public async init(): Promise<void> {
        try {
            console.log(`${LOG} Loading sql.js WASM from pluginDir`, this.pluginDir);

            const wasmPath = path.join(this.pluginDir, 'sql-wasm.wasm');
            console.log(`${LOG} Reading WASM binary from`, wasmPath);

            if (!fs.existsSync(wasmPath)) {
                console.error(`${LOG} WASM file not found at`, wasmPath, '— was it copied during build?');
                throw new Error(`sql-wasm.wasm not found at ${wasmPath}`);
            }

            const wasmBinary = fs.readFileSync(wasmPath);
            console.log(`${LOG} WASM binary read, size=${wasmBinary.byteLength} bytes`);

            // wasmBinary.buffer extracts the underlying ArrayBuffer
            this.SQL = await initSqlJs({ wasmBinary: wasmBinary.buffer });
            console.log(`${LOG} sql.js initialized successfully via wasmBinary`);

            const dbDir = path.dirname(this.dbPath);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
                console.log(`${LOG} Created DB directory`, dbDir);
            }

            if (fs.existsSync(this.dbPath)) {
                console.log(`${LOG} Loading existing DB file from`, this.dbPath);
                const fileBuffer = fs.readFileSync(this.dbPath);
                console.log(`${LOG} existing DB file size on disk`, { bytes: fileBuffer.length });
                if (fileBuffer.length === 0) {
                  console.error(`${LOG} existing DB file is 0 bytes — refusing to silently treat as fresh DB`, { dbPath: this.dbPath });
                  throw new Error(`smart_index.db at ${this.dbPath} is 0 bytes — likely an interrupted write. Not auto-recreating to avoid silent data loss; please restore from a backup or rename the file to force a rebuild.`);
                }
                try {
                  this.db = new this.SQL.Database(fileBuffer);
                  console.log(`${LOG} Existing DB loaded`);
                } catch (loadErr) {
                  console.error(`${LOG} existing DB file failed to parse — likely corrupt, refusing to silently discard`, loadErr);
                  throw loadErr;
                }
            } else {
                console.log(`${LOG} No existing DB found, creating new DB`);
                this.db = new this.SQL.Database();
            }

            console.log(`${LOG} Running schema migrations`);
            this.db.run(DB_SCHEMA_V1);
            console.log(`${LOG} Schema applied successfully`);


            // Migration v2: add hash column to blocks if missing
            try {
              this.db.exec("ALTER TABLE blocks ADD COLUMN hash TEXT NOT NULL DEFAULT '';");
              console.log('[Database] Migration v2 applied: added hash column to blocks table');
            } catch (e) {
              console.log('[Database] Migration v2 skipped: hash column already exists in blocks');
            }



            // Migration v3: soft-delete columns on sources and index_file_meta
            try {
              console.log('[schema] ensureColumn start', { tableName: 'sources', columnName: 'is_deleted' });
              this.db.exec("ALTER TABLE sources ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;");
              console.log('[schema] added column', { tableName: 'sources', columnName: 'is_deleted' });

              console.log('[schema] ensureColumn start', { tableName: 'sources', columnName: 'deleted_at' });
              this.db.exec("ALTER TABLE sources ADD COLUMN deleted_at INTEGER;");
              console.log('[schema] added column', { tableName: 'sources', columnName: 'deleted_at' });

              console.log('[schema] ensureColumn start', { tableName: 'sources', columnName: 'delete_reason' });
              this.db.exec("ALTER TABLE sources ADD COLUMN delete_reason TEXT;");
              console.log('[schema] added column', { tableName: 'sources', columnName: 'delete_reason' });
            } catch (e) {
              console.log('[schema] soft-delete schema skipped or already exists (sources)', e);
            }

            try {
              console.log('[schema] ensureColumn start', { tableName: 'index_file_meta', columnName: 'is_missing' });
              this.db.exec("ALTER TABLE index_file_meta ADD COLUMN is_missing INTEGER NOT NULL DEFAULT 0;");
              console.log('[schema] added column', { tableName: 'index_file_meta', columnName: 'is_missing' });

              console.log('[schema] ensureColumn start', { tableName: 'index_file_meta', columnName: 'missing_since' });
              this.db.exec("ALTER TABLE index_file_meta ADD COLUMN missing_since INTEGER;");
              console.log('[schema] added column', { tableName: 'index_file_meta', columnName: 'missing_since' });

              console.log('[schema] ensureColumn start', { tableName: 'index_file_meta', columnName: 'missing_reason' });
              this.db.exec("ALTER TABLE index_file_meta ADD COLUMN missing_reason TEXT;");
              console.log('[schema] added column', { tableName: 'index_file_meta', columnName: 'missing_reason' });
              console.log('[schema] soft-delete schema ready');
            } catch (e) {
              console.log('[schema] soft-delete schema skipped or already exists (index_file_meta)', e);
            }

            this.persist();
            console.log(`${LOG} DB initialized successfully at`, this.dbPath);
        } catch (error) {
            console.error(`${LOG} Failed to initialize DB:`, error);
            throw error;
        }
    }

    public getDb(): SqlJsDatabase {
        if (!this.db) {
            throw new Error("Database not initialized. Call init() first.");
        }
        return this.db;
    }

    /**
     * Throttled entry point for watcher-driven persists. Guarantees at most one
     * real disk write per PERSIST_MIN_INTERVAL_MS, while still flushing any
     * pending write shortly after the window closes so nothing is lost.
     */
    public requestPersist(): void {
        const now = Date.now();
        const elapsed = now - this.lastPersistAt;

        if (elapsed >= this.PERSIST_MIN_INTERVAL_MS) {
            console.log(`${LOG} requestPersist — throttle window elapsed, persisting immediately`, { elapsed });
            this.lastPersistAt = now;
            this.persist();
            return;
        }

        if (this.persistPending) {
            console.log(`${LOG} requestPersist — persist already scheduled, skipping duplicate schedule`);
            return;
        }

        const waitMs = this.PERSIST_MIN_INTERVAL_MS - elapsed;
        console.log(`${LOG} requestPersist — throttled, scheduling deferred persist`, { waitMs });
        this.persistPending = true;
        window.setTimeout(() => {
            this.persistPending = false;
            this.lastPersistAt = Date.now();
            console.log(`${LOG} requestPersist — deferred persist firing now`);
            this.persist();
        }, waitMs);
    }

    public persist(): void {
        if (!this.db || !this.SQL) {
            console.warn(`${LOG} persist() called but DB or SQL is null — skipping`);
            return;
        }
        try {
            const data = this.db.export();
            const buffer = Buffer.from(data);

            console.log('[IndexBuilder] persisting DB to disk', {
              dbPath: this.dbPath,
              byteLength: buffer.length,
            });

            // Write to a temp file in the SAME directory (so renameSync stays atomic
            // on the same volume), then atomically swap it into place. This
            // guarantees that a crash/kill mid-write can never leave a truncated
            // or zero-byte smart_index.db — the old file stays valid until the
            // instant the new one is fully ready.
            const tmpPath = `${this.dbPath}.tmp-${process.pid}-${Date.now()}`;
            console.log(`${LOG} writing to temp file before atomic rename`, { tmpPath });

            fs.writeFileSync(tmpPath, buffer);

            const tmpStat = fs.statSync(tmpPath);
            if (tmpStat.size !== buffer.length) {
              console.error(`${LOG} temp file size mismatch after write — aborting persist to protect existing DB`, {
                expected: buffer.length,
                actual: tmpStat.size,
              });
              try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort cleanup */ }
              return;
            }

            fs.renameSync(tmpPath, this.dbPath);
            console.log(`${LOG} atomic rename complete — smart_index.db updated safely`, { dbPath: this.dbPath });

            const stat = fs.statSync(this.dbPath);
            console.log('[IndexBuilder] persisted file stat', {
              dbPath: this.dbPath,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            });

            console.log('[IndexBuilder] readback verification start', { dbPath: this.dbPath });

            const fileBuffer = fs.readFileSync(this.dbPath);
            const verifyDb = new this.SQL.Database(fileBuffer);

            const getScalar = (db: SqlJsDatabase, sql: string): number | string | null => {
                const res = db.exec(sql);
                return res?.[0]?.values?.[0]?.[0] as number | string ?? null;
            };

            const getRows = (db: SqlJsDatabase, sql: string): unknown[] => {
                const res = db.exec(sql);
                if (!res?.[0]) return [];
                const cols = res[0].columns;
                return res[0].values.map((row: unknown[]) =>
                    Object.fromEntries(cols.map((c: string, i: number) => [c, row[i]]))
                );
            };

            console.log('[IndexBuilder] readback verification counts', {
                sources: getScalar(verifyDb, 'SELECT COUNT(*) FROM sources'),
                blocks: getScalar(verifyDb, 'SELECT COUNT(*) FROM blocks'),
                embeddings: getScalar(verifyDb, 'SELECT COUNT(*) FROM embeddings'),
                embeddingsByModel: getRows(verifyDb, `
                    SELECT model_name as modelname, COUNT(*) AS count
                    FROM embeddings
                    GROUP BY model_name
                    ORDER BY count DESC
                `),
            });

            verifyDb.close();

            console.log(`${LOG} DB persisted to disk at`, this.dbPath);
        } catch (error) {
            console.error(`${LOG} Failed to persist DB — existing smart_index.db on disk is untouched:`, error);
            // Note: because we write to a temp file first, an error here (e.g. disk
            // full, OneDrive lock on the temp file) never corrupts the live DB —
            // worst case we just fail to save this round's changes and retry next
            // persist cycle.
        }
    }

    public close(): void {
        if (this.db) {
            this.persist();
            this.db.close();
            this.db = null;
            console.log(`${LOG} DB closed`);
        }
    }
}
