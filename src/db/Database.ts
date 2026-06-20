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
                this.db = new this.SQL.Database(fileBuffer);
                console.log(`${LOG} Existing DB loaded`);
            } else {
                console.log(`${LOG} No existing DB found, creating new DB`);
                this.db = new this.SQL.Database();
            }

            console.log(`${LOG} Running schema migrations`);
            this.db.run(DB_SCHEMA_V1);
            console.log(`${LOG} Schema applied successfully`);

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

    public persist(): void {
        if (!this.db) {
            console.warn(`${LOG} persist() called but DB is null — skipping`);
            return;
        }
        try {
            const data = this.db.export();
            fs.writeFileSync(this.dbPath, Buffer.from(data));
            console.log(`${LOG} DB persisted to disk at`, this.dbPath);
        } catch (error) {
            console.error(`${LOG} Failed to persist DB:`, error);
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
