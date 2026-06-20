import type { App } from "obsidian";
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js";
import * as path from "path";
import * as fs from "fs";
import { DB_SCHEMA_V1 } from "./schema";

const LOG = "[Database]";

export class Database {
    private db: SqlJsDatabase | null = null;
    private SQL: SqlJsStatic | null = null;
    private dbPath: string;
    private dirty = false;

    constructor(app: App, dbRelPath: string) {
        const basePath = (app.vault.adapter as import("obsidian").FileSystemAdapter).getBasePath();
        this.dbPath = path.join(basePath, dbRelPath);
        console.log(`${LOG} dbPath resolved to`, this.dbPath);
    }

    public async init(): Promise<void> {
        try {
            console.log(`${LOG} Loading sql.js WASM`);
            // sql.js needs its WASM file — locate it relative to the plugin bundle
            this.SQL = await initSqlJs({
                // Obsidian plugins run from <vault>/.obsidian/plugins/<id>/
                // sql.js copies sql-wasm.wasm next to main.js after build
                locateFile: (file: string) => {
                    const globalAny = global as { __dirname?: string };
                    const dirname = globalAny.__dirname ?? __dirname;
                    const wasmPath = path.join(dirname, file);
                    console.log(`${LOG} locateFile resolved`, file, "→", wasmPath);
                    return wasmPath;
                },
            });

            console.log(`${LOG} sql.js loaded, opening DB at`, this.dbPath);

            const dbDir = path.dirname(this.dbPath);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
                console.log(`${LOG} Created DB directory`, dbDir);
            }

            if (fs.existsSync(this.dbPath)) {
                console.log(`${LOG} Loading existing DB file`);
                const fileBuffer = fs.readFileSync(this.dbPath);
                this.db = new this.SQL.Database(fileBuffer);
                console.log(`${LOG} Existing DB loaded`);
            } else {
                console.log(`${LOG} Creating new DB`);
                this.db = new this.SQL.Database();
            }

            console.log(`${LOG} Running schema migrations`);
            this.db.run(DB_SCHEMA_V1);
            console.log(`${LOG} Schema applied`);

            // Persist after schema run
            this.persist();
            console.log(`${LOG} DB initialized successfully`);
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

    // Call after any write operations to persist in-memory DB to disk
    public persist(): void {
        if (!this.db) {
            console.warn(`${LOG} persist() called but DB is null`);
            return;
        }
        const data = this.db.export();
        fs.writeFileSync(this.dbPath, Buffer.from(data));
        console.log(`${LOG} DB persisted to disk`, this.dbPath);
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