import type { App, Plugin } from "obsidian";
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js";
import * as path from "path";
import * as fs from "fs";
import { DB_SCHEMA_V1 } from "./schema";
import type VaultRagExplorerPlugin from "../plugin";

const LOG = "[Database]";
export class Database {
    private db: SqlJsDatabase | null = null;
    private SQL: SqlJsStatic | null = null;
    private dbPath: string;
    private pluginDir: string;
    private plugin: VaultRagExplorerPlugin;
    public loadedAt = 0;

    private lastPersistAt = 0;
    private persistPending = false;
    private readonly PERSIST_MIN_INTERVAL_MS = 10_000; // don't do a full export/write more than once per 10s
    private persistPromise: Promise<void> | null = null;
    private writeQueue: Promise<void> = Promise.resolve();
    private readQueue: Promise<void> = Promise.resolve();

    constructor(app: App, dbRelPath: string, plugin: Plugin) {
        const basePath = (app.vault.adapter as import("obsidian").FileSystemAdapter).getBasePath();
        this.dbPath = path.join(basePath, dbRelPath);

        // Derive the absolute path to the plugin folder using manifest.dir
        // manifest.dir is e.g. ".obsidian/plugins/vault-rag-explorer"
        // This is always set by Obsidian and does not rely on __dirname
        this.pluginDir = path.join(basePath, plugin.manifest.dir ?? "");
        this.plugin = plugin as VaultRagExplorerPlugin;

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

            // Clean up orphaned temp files from earlier failed persists (e.g. before
            // this cleanup logic existed, or from a session that crashed mid-persist).
            try {
              const dbDir = path.dirname(this.dbPath);
              const dbBasename = path.basename(this.dbPath);
              const entries = fs.readdirSync(dbDir);
              const orphanedTmpFiles = entries.filter((f: string) => f.startsWith(`${dbBasename}.tmp-`));
              if (orphanedTmpFiles.length > 0) {
                console.warn(`${LOG} found orphaned temp files from previous failed persists — cleaning up`, {
                  count: orphanedTmpFiles.length,
                  files: orphanedTmpFiles,
                });
                for (const f of orphanedTmpFiles) {
                  const fullTmpPath = path.join(dbDir, f);
                  try {
                    const size = fs.statSync(fullTmpPath).size;
                    fs.unlinkSync(fullTmpPath);
                    console.log(`${LOG} removed orphaned temp file`, { fullTmpPath, sizeBytes: size });
                  } catch (e) {
                    console.error(`${LOG} failed to remove orphaned temp file`, { fullTmpPath, e });
                  }
                }
              } else {
                console.log(`${LOG} no orphaned temp files found on startup`);
              }
            } catch (e) {
              console.error(`${LOG} orphaned temp file sweep failed`, e);
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
                  this.loadedAt = Date.now();
                } catch (loadErr) {
                  console.error(`${LOG} existing DB file failed to parse — likely corrupt, refusing to silently discard`, loadErr);
                  throw loadErr;
                }
            } else {
                console.log(`${LOG} No existing DB found, creating new DB`);
                this.db = new this.SQL.Database();
                this.loadedAt = Date.now();
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
            console.log("[Database] open called");
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
    public requestPersist(): Promise<void> {
        const now = Date.now();
        const elapsed = now - this.lastPersistAt;

        if (elapsed >= this.PERSIST_MIN_INTERVAL_MS) {
            console.log(`${LOG} requestPersist — throttle window elapsed, persisting immediately`, { elapsed });
            this.lastPersistAt = now;
            return this.executePersistChain();
        }

        if (this.persistPending) {
            console.log(`${LOG} requestPersist — persist already scheduled, chaining to existing promise`);
            return this.persistPromise ?? Promise.resolve();
        }

        const waitMs = this.PERSIST_MIN_INTERVAL_MS - elapsed;
        console.log(`${LOG} requestPersist — throttled, scheduling deferred persist`, { waitMs });
        this.persistPending = true;

        this.persistPromise = (this.persistPromise ?? Promise.resolve()).then(() => {
            return new Promise<void>((resolve, reject) => {
                window.setTimeout(() => {
                    this.persistPending = false;
                    this.lastPersistAt = Date.now();
                    console.log(`${LOG} requestPersist — deferred persist firing now`);

                    this.enqueueWrite(() => {
                        this.persist();
                    }).then(resolve).catch(reject);
                }, waitMs);
            });
        }).catch((error) => {
            console.error(`${LOG} queued persistence failed`, { error });
            throw error;
        });

        return this.persistPromise;
    }

    public enqueueRead<T>(operation: () => Promise<T> | T): Promise<T> {
        const result = this.readQueue.then(async () => {
            console.log(`${LOG} read queued`, { operation: operation.name || "anonymous" });
            console.log(`${LOG} read started`, { operation: operation.name || "anonymous" });
            try {
                const res = await operation();
                console.log(`${LOG} read completed`, { operation: operation.name || "anonymous" });
                return res;
            } catch (error) {
                console.error(`${LOG} read failed`, { operation: operation.name || "anonymous", error });
                throw error;
            }
        });

        this.readQueue = result.then(
            () => undefined,
            () => undefined,
        );

        return result;
    }

    public enqueueWrite<T>(operation: () => Promise<T> | T): Promise<T> {
        const result = this.writeQueue.then(async () => {
            console.log(`${LOG} write queued`, { operation: operation.name || "anonymous" });
            console.log(`${LOG} write started`, { operation: operation.name || "anonymous" });
            try {
                const res = await operation();
                console.log(`${LOG} write completed`, { operation: operation.name || "anonymous" });
                return res;
            } catch (error) {
                console.error(`${LOG} write failed`, { operation: operation.name || "anonymous", error });
                throw error;
            }
        });

        this.writeQueue = result.then(
            () => undefined,
            () => undefined,
        );

        return result;
    }

    private executePersistChain(): Promise<void> {
        this.persistPromise = this.enqueueWrite(() => {
            this.persist();
        });
        return this.persistPromise;
    }

    public persist(): void {
        if (!this.db || !this.SQL) {
            console.warn(`${LOG} persist() called but DB or SQL is null — skipping`);
            return;
        }

        if (this.plugin?.isExternalIndexerRunning?.()) {
            console.log(`${LOG} persist() skipped — external indexer is running`);
            return;
        }

        const data = this.db.export();
        const buffer = Buffer.from(data);
        const tmpPath = `${this.dbPath}.tmp-${process.pid}-${Date.now()}`;

        console.log('[IndexBuilder] persisting DB to disk', {
          dbPath: this.dbPath,
          byteLength: buffer.length,
          tmpPath,
        });

        let renameSucceeded = false;

        try {
            fs.writeFileSync(tmpPath, buffer);

            const tmpStat = fs.statSync(tmpPath);
            if (tmpStat.size !== buffer.length) {
              console.error(`${LOG} temp file size mismatch after write — aborting persist`, {
                expected: buffer.length,
                actual: tmpStat.size,
              });
              return; // finally block below still cleans up tmpPath
            }

            // Retry the rename a few times — OneDrive frequently holds a transient
            // lock (EPERM/EBUSY) on the destination filename right after a large
            // write while it hashes/uploads the previous version. This is a race,
            // not a permanent failure, so back off and retry before giving up.
            const MAX_RENAME_ATTEMPTS = 5;
            const RETRY_DELAY_MS = 1500;

            for (let attempt = 1; attempt <= MAX_RENAME_ATTEMPTS; attempt++) {
              try {
                fs.renameSync(tmpPath, this.dbPath);
                renameSucceeded = true;
                console.log(`${LOG} atomic rename complete — smart_index.db updated safely`, {
                  dbPath: this.dbPath,
                  attempt,
                });
                break;
              } catch (renameErr) {
                const code = (renameErr as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
                console.warn(`${LOG} rename attempt ${attempt}/${MAX_RENAME_ATTEMPTS} failed`, {
                  code,
                  message: (renameErr as Error).message,
                  tmpPath,
                  dbPath: this.dbPath,
                });
                if (attempt === MAX_RENAME_ATTEMPTS) {
                  console.error(`${LOG} all rename attempts exhausted — persist failed, existing smart_index.db on disk is untouched`, { code });
                } else {
                  // Synchronous sleep via Atomics.wait is not available in all
                  // Electron renderer contexts — use a blocking busy-wait via
                  // Date.now() instead, since persist() is itself synchronous.
                  const deadline = Date.now() + RETRY_DELAY_MS;
                  while (Date.now() < deadline) { /* deliberate short synchronous wait */ }
                }
              }
            }

            if (!renameSucceeded) {
              return; // finally block still cleans up tmpPath
            }

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
        } finally {
            // Always attempt to remove the temp file if it's still sitting there —
            // covers the size-mismatch return, the exhausted-retries return, and
            // any unexpected exception path above. This is what was missing
            // before and is why tmp files were piling up.
            if (fs.existsSync(tmpPath)) {
              try {
                fs.unlinkSync(tmpPath);
                console.log(`${LOG} cleaned up leftover temp file`, { tmpPath });
              } catch (cleanupErr) {
                console.error(`${LOG} failed to clean up temp file — may require manual deletion`, { tmpPath, cleanupErr });
              }
            }
        }
    }

    public close(): void {
        console.log("[Database] close called");
        if (this.db) {
            this.persist();
            this.db.close();
            this.db = null;
            console.log(`${LOG} DB closed`);
        }
    }

    public reload(): void {
        if (!this.SQL) {
            throw new Error("SQL.js not initialized; call init() before reload().");
        }
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        if (!fs.existsSync(this.dbPath)) {
            this.db = new this.SQL.Database();
            this.loadedAt = Date.now();
            return;
        }
        const fileBuffer = fs.readFileSync(this.dbPath);
        this.db = new this.SQL.Database(fileBuffer);
        this.loadedAt = Date.now();
        console.log(`${LOG} reload complete`, { loadedAt: this.loadedAt });
    }
}
