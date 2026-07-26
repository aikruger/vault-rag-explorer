import type { IndexBuilder } from "../db/IndexBuilder";
import type { Database } from "../db/Database";

const LOG = "[AjsonWatcherService]";
const DEBOUNCE_MS = 2000; // wait 2s after last event before re-indexing

import type { FSWatcher } from "fs";
import type VaultRagExplorerPlugin from "../plugin";

export class AjsonWatcherService {
  private watcher: FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private indexBuilder: IndexBuilder;
  private db: Database;
  private plugin: VaultRagExplorerPlugin;
  private watchPath: string = "";
  private isRunning: boolean = false;

  constructor(
    plugin: VaultRagExplorerPlugin,
    indexBuilder: IndexBuilder,
    db: Database
  ) {
    this.plugin = plugin;
    this.indexBuilder = indexBuilder;
    this.db = db;
    console.log("[AjsonWatcherService] constructor received plugin", {
      pluginConstructor: this.plugin?.constructor?.name,
      hasBeginIndexing: typeof (this.plugin as { beginIndexing?: unknown })?.beginIndexing,
    });
  }

  /**
   * Start watching the given directory for .ajson file changes.
   * Safe to call multiple times — stops the previous watcher first.
   */
  public start(ajsonFolderPath: string): void {
    this.stop(); // tear down any existing watcher

    const fs = require("fs");
    const path = require("path");

    if (!fs.existsSync(ajsonFolderPath)) {
      console.warn(`${LOG} start() — folder does not exist, watcher not started:`, ajsonFolderPath);
      return;
    }

    this.watchPath = ajsonFolderPath;
    this.isRunning = true;

    console.log(`${LOG} starting fs.watch on`, ajsonFolderPath);

    try {
      this.watcher = fs.watch(
        ajsonFolderPath,
        { persistent: false },
        (eventType: string, filename: string | null) => {
          if (!filename || !filename.endsWith(".ajson")) return;
          console.log(`${LOG} .ajson change detected: ${filename}`);

          const fullPath = path.join(ajsonFolderPath, filename);
          this.scheduleReindex(fullPath);
        }
      );

      this.watcher?.on("error", (err: Error) => {
        console.error(`${LOG} fs.watch error:`, err);
        // Attempt to restart after a short delay
        setTimeout(() => {
          console.log(`${LOG} attempting watcher restart after error`);
          this.start(this.watchPath);
        }, 5000);
      });

      console.log(`${LOG} watcher active on`, ajsonFolderPath);
    } catch (err) {
      console.error(`${LOG} failed to start fs.watch:`, err);
      this.isRunning = false;
    }
  }

  /**
   * Stop the watcher and cancel all pending debounce timers.
   */
  public stop(): void {
    if (this.watcher) {
      console.log(`${LOG} stopping watcher on`, this.watchPath);
      try {
        this.watcher.close();
      } catch (e) {
        console.warn(`${LOG} error closing watcher:`, e);
      }
      this.watcher = null;
    }

    // Cancel all debounce timers
    for (const [filePath, timer] of this.debounceTimers.entries()) {
      clearTimeout(timer);
      console.log(`${LOG} cancelled pending debounce for`, filePath);
    }
    this.debounceTimers.clear();
    this.isRunning = false;
    console.log(`${LOG} stopped`);
  }

  public get running(): boolean {
    return this.isRunning;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private scheduleDrain(): void {
    if (this.plugin.reindexDrainScheduled) {
      return;
    }

    this.plugin.reindexDrainScheduled = true;
    console.log(`${LOG} scheduleDrain set`, {
      pendingCount: this.plugin.pendingAjsonReindex.size,
    });

    window.setTimeout(() => {
      this.plugin.reindexDrainScheduled = false;
      void this.drainQueue();
    }, 1500);
  }

  private async drainQueue(): Promise<void> {
    console.log(`${LOG} drainQueue start`, {
      pendingCount: this.plugin.pendingAjsonReindex.size,
      activeQueryCount: this.plugin.activeQueryCount,
      isIndexing: this.plugin.isIndexing,
    });

    if (!this.plugin.beginIndexing()) {
      console.log(`${LOG} drainQueue deferred`, {
        pendingCount: this.plugin.pendingAjsonReindex.size,
        activeQueryCount: this.plugin.activeQueryCount,
        isIndexing: this.plugin.isIndexing,
      });
      this.scheduleDrain();
      return;
    }

    try {
      const pending = Array.from(this.plugin.pendingAjsonReindex);
      this.plugin.pendingAjsonReindex.clear();

      for (const filePath of pending) {
        console.log(`${LOG} drainQueue processing file`, { filePath });
        await this.reindexFile(filePath);
      }
    } finally {
      this.plugin.endIndexing();

      if (this.plugin.pendingAjsonReindex.size > 0) {
        console.log(`${LOG} drainQueue rescheduling — more files arrived`, {
          pendingCount: this.plugin.pendingAjsonReindex.size,
        });
        this.scheduleDrain();
      }
    }
  }

  /**
   * Debounce re-index calls per file. Each new event for the same file
   * resets the timer, so we only fire after DEBOUNCE_MS of silence.
   */
  private scheduleReindex(fullFilePath: string): void {
    const existing = this.debounceTimers.get(fullFilePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(fullFilePath);
      this.plugin.pendingAjsonReindex.add(fullFilePath);
      console.log(`${LOG} debounced file enqueued`, {
        fullFilePath,
        pendingCount: this.plugin.pendingAjsonReindex.size,
      });
      this.scheduleDrain();
    }, DEBOUNCE_MS);

    this.debounceTimers.set(fullFilePath, timer);
  }

  /**
   * Re-parse a single .ajson file and upsert its contents into the DB.
   * Handles the case where the file has been deleted (remove orphan records).
   */
  private async reindexFile(fullFilePath: string): Promise<void> {
    const fs = require("fs");
    console.log(`${LOG} reindexFile start:`, fullFilePath);

    // If the file was deleted, remove orphan records from the DB
    if (!fs.existsSync(fullFilePath)) {
      console.log(`${LOG} file deleted — orphan cleanup:`, fullFilePath);
      await this.removeOrphansForFile(fullFilePath);
      return;
    }

    // Lightweight mtime guard — skip if file hasn't changed since last index
    try {
      const stat = fs.statSync(fullFilePath);
      const rawDb = this.db.getDb();
      if (rawDb) {
        const res = rawDb.exec(
          `SELECT mtime FROM index_file_meta WHERE filepath = '${fullFilePath.replace(/'/g, "''")}'`
        );
        const storedMtime = res?.[0]?.values?.[0]?.[0] as number | undefined;
        if (storedMtime !== undefined && storedMtime === stat.mtimeMs) {
          console.log(`${LOG} reindexFile skipped — mtime unchanged:`, fullFilePath);
          return;
        }
        console.log(`${LOG} reindexFile proceeding — mtime changed from ${storedMtime} to ${stat.mtimeMs}`);
      }
    } catch (e) {
      console.warn(`${LOG} mtime check failed, proceeding anyway:`, e);
    }

    try {
      const result = await this.indexBuilder.buildFromSingleFile(
        this.watchPath,
        fullFilePath
      );
      console.log(`${LOG} reindexFile complete:`, fullFilePath, result);
    } catch (err) {
      console.error(`${LOG} reindexFile error for`, fullFilePath, err);
    }
  }

  /**
   * Remove sources, blocks, embeddings, and wikilinks for a deleted .ajson file.
   * The .ajson filename maps to one or more source paths stored in the DB.
   */
  private async removeOrphansForFile(fullFilePath: string): Promise<void> {
    console.log(`${LOG} removeOrphansForFile:`, fullFilePath);
    try {
      const rawDb = this.db.getDb();

      // Derive the source path pattern from the .ajson filename
      // Smart Connections names files like "path#to#note.ajson"
      // Reconstruct as "path/to/note.md" for the DB lookup
      const path = require("path");
      const filename = path.basename(fullFilePath, ".ajson");
      const sourcePath = filename.replace(/#/g, "/") + ".md";

      console.log(`${LOG} looking up source path for deletion:`, sourcePath);

      // Find the source id
      const res = rawDb.exec(
        `SELECT id FROM sources WHERE path = '${sourcePath.replace(/'/g, "''")}'`
      );
      if (!res[0] || !res[0].values[0]) {
        console.log(`${LOG} no DB record found for deleted file, nothing to remove`);
        return;
      }

      const sourceId = res[0].values[0][0] as number;
      console.log(`${LOG} removing records for source id:`, sourceId, "path:", sourcePath);

      rawDb.exec("BEGIN TRANSACTION;");
      rawDb.exec(`DELETE FROM embeddings WHERE owner_type = 'source' AND owner_id = ${sourceId}`);
      rawDb.exec(`DELETE FROM wikilinks WHERE src_source_id = ${sourceId}`);

      // Remove block embeddings first, then blocks
      rawDb.exec(`
        DELETE FROM embeddings
        WHERE owner_type = 'block'
          AND owner_id IN (SELECT id FROM blocks WHERE source_id = ${sourceId})
      `);
      rawDb.exec(`DELETE FROM blocks WHERE source_id = ${sourceId}`);
      rawDb.exec(`DELETE FROM sources WHERE id = ${sourceId}`);
      rawDb.exec("COMMIT;");

      if ((this.plugin as any).isExternalIndexerRunning && (this.plugin as any).isExternalIndexerRunning()) {
        console.warn('[AjsonWatcherService] aborting persist — external indexer became active mid-drain, in-memory snapshot is now stale');
      } else {
        console.log('[checker] before persist');
        this.db.persist();
      }
      console.log(`${LOG} orphan cleanup complete for source id:`, sourceId);
    } catch (err) {
      console.error(`${LOG} removeOrphansForFile error:`, err);
      try { this.db.getDb().exec("ROLLBACK;"); } catch (_) { /* ignore */ }
    }
  }
}
