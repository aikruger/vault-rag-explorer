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
    public loadedAt: number = 0;
    private plugin: Plugin;

    constructor(app: App, dbRelPath: string, plugin: Plugin) {
        const basePath = (app.vault.adapter as import("obsidian").FileSystemAdapter).getBasePath();
        this.dbPath = path.join(basePath, dbRelPath);

        // Derive the absolute path to the plugin folder using manifest.dir
        // manifest.dir is e.g. ".obsidian/plugins/vault-rag-explorer"
        // This is always set by Obsidian and does not rely on __dirname
        this.pluginDir = path.join(basePath, ".obsidian", "plugins", plugin.manifest.id);
        this.plugin = plugin;

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
                this.db = new this.SQL.Database(fileBuffer);
                console.log(`${LOG} Existing DB loaded`);
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

            this.loadedAt = Date.now();
            this.persist();
            console.log(`${LOG} DB initialized successfully at`, this.dbPath);
        } catch (error) {
            console.error(`${LOG} Failed to initialize DB:`, error);
            throw error;
        }
    }

    public async reload(): Promise<void> {
        console.log('[Database] reload() — discarding in-memory snapshot and re-reading from disk', { dbPath: this.dbPath });
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        await this.init();
        console.log('[Database] reload() complete — in-memory snapshot now matches on-disk file');

        try {
            if (this.db) {
                const getScalar = (db: SqlJsDatabase, sql: string): number => {
                    const res = db.exec(sql);
                    return res?.[0]?.values?.[0]?.[0] as number ?? 0;
                };
                const sourceCount = getScalar(this.db, 'SELECT COUNT(*) FROM sources');
                const blockCount = getScalar(this.db, 'SELECT COUNT(*) FROM blocks');
                console.log('[Database] post-reload verification', {
                    sources: sourceCount,
                    blocks: blockCount,
                    timestamp: Date.now()
                });
            }
        } catch (e) {
            console.error('[Database] post-reload verification failed', e);
        }
    }

    public getDb(): SqlJsDatabase {
        if (!this.db) {
            throw new Error("Database not initialized. Call init() first.");
        }
        return this.db;
    }

    public persist(): void {
        if (!this.db || !this.SQL) {
            console.warn(`${LOG} persist() called but DB or SQL is null — skipping`);
            return;
        }

        const plugin = this.plugin as any;
        if (plugin.isExternalIndexerRunning && plugin.isExternalIndexerRunning()) {
            console.warn('[Database] persist() SKIPPED — external indexer is active');
            return;
        }

        // Try to read progress to check if we loaded before it completed
        try {
            const progressPath = path.join(this.pluginDir, 'index-progress.json');
            if (fs.existsSync(progressPath)) {
                const prog = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
                const extIndexerCompletedAt = prog.completedAt || fs.statSync(progressPath).mtimeMs;
                if (prog.status === 'complete' && extIndexerCompletedAt > this.loadedAt) {
                    console.warn('[Database] persist() SKIPPED — external indexer completed at', extIndexerCompletedAt, 'but plugin snapshot loaded at', this.loadedAt, '— would have clobbered fresh data');
                    return;
                }
            }
        } catch(e) {}

        try {
            const data = this.db.export();
            const buffer = Buffer.from(data);

            console.log('[IndexBuilder] persisting DB to disk', {
              dbPath: this.dbPath,
              byteLength: buffer.length,
            });

            fs.writeFileSync(this.dbPath, buffer);

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
            console.error(`${LOG} Failed to persist DB:`, error);
        }
    }

    public close(skipPersist: boolean = false): void {
        if (this.db) {
            console.log(`${LOG} close() called — checking for active external indexer before persisting`);
            if (!skipPersist) {
                this.persist();
            } else {
                console.log(`${LOG} skipping persist during close due to skipPersist flag`);
            }
            this.db.close();
            this.db = null;
            console.log(`${LOG} DB closed`);
        }
    }
}
