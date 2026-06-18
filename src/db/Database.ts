import type { App } from "obsidian";
import DatabaseImpl, { type Database as BetterSqlite3Database } from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { DB_SCHEMA_V1 } from "./schema";

export class Database {
	private db: BetterSqlite3Database | null = null;
	private dbPath: string;

	constructor(app: App, dbRelPath: string) {
		// obsidian vault base path
		// note: on mobile, better-sqlite3 or fs access might not work directly this way.
		// For desktop MVP as per brief:
		const basePath = (app.vault.adapter as import("obsidian").FileSystemAdapter).getBasePath();
		this.dbPath = path.join(basePath, dbRelPath);
	}

	public async init(): Promise<void> {
		try {
			console.log(`[Database] Initializing DB at ${this.dbPath}`);

			// Ensure directory exists
			const dbDir = path.dirname(this.dbPath);
			if (!fs.existsSync(dbDir)) {
				fs.mkdirSync(dbDir, { recursive: true });
			}

			this.db = new DatabaseImpl(this.dbPath);

			console.log(`[Database] Running schema migrations`);
			this.db.exec(DB_SCHEMA_V1);
			console.log(`[Database] DB initialized successfully`);
		} catch (error) {
			console.error(`[Database] Failed to initialize DB:`, error);
			throw error;
		}
	}

	public getDb(): BetterSqlite3Database {
		if (!this.db) {
			throw new Error("Database not initialized");
		}
		return this.db;
	}

	public close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
			console.log(`[Database] Connection closed`);
		}
	}
}
