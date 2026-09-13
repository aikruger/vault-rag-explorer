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

    try {
      this.watcher = fs.watch(
        ajsonFolderPath,
        { persistent: false },
        (eventType: string, filename: string | null) => {
          if (!filename) return;

          const fullPath = path.join(ajsonFolderPath, filename);
          const isAjsonFile = fullPath.toLowerCase().endsWith(".ajson");

          if (isAjsonFile) {
            console.log(`${LOG} ignoring generated .ajson file`, {
              fullFilePath: fullPath,
              reason: "generated Smart Connections artefact",
            });
            return;
          }

          console.log(`${LOG} file change detected`, { eventType, filename });
          this.scheduleReindex(fullPath);
        }
      );

      this.watcher?.on("error", (err: Error) => {
        console.error(`${LOG} fs.watch error:`, err);
        // Attempt to restart after a short delay
        setTimeout(() => {
          this.start(this.watchPath);
        }, 5000);
      });
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
    }
    this.debounceTimers.clear();
    this.isRunning = false;
  }

  public get running(): boolean {
    return this.isRunning;
  }

  public triggerDrain(): void {
    this.scheduleDrain();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private scheduleDrain(): void {
    if (this.plugin.reindexDrainScheduled) {
      return;
    }

    this.plugin.reindexDrainScheduled = true;

    window.setTimeout(() => {
      this.plugin.reindexDrainScheduled = false;
      void this.drainQueue();
    }, 1500);
  }

  private async drainQueue(): Promise<void> {
    if (this.plugin.pendingAjsonReindex.size === 0) return;

    if (this.plugin.isExternalIndexerRunning()) {
        console.log(`${LOG} external indexer active — delaying incremental queue drain`, { count: this.plugin.pendingAjsonReindex.size });
        this.scheduleDrain();
        return;
    }

    if (!this.plugin.beginIndexing()) {
      this.scheduleDrain();
      return;
    }

    try {
      const pending = Array.from(this.plugin.pendingAjsonReindex);
      this.plugin.pendingAjsonReindex.clear();

      type ReindexSummary = {
        totalFiles: number;
        skippedCount: number;
        successCount: number;
        failedCount: number;
        failedFiles: Array<{
          path: string;
          error: string;
        }>;
        willPersist: boolean;
      };

      const summary: ReindexSummary = {
        totalFiles: pending.length,
        skippedCount: 0,
        successCount: 0,
        failedCount: 0,
        failedFiles: [],
        willPersist: false,
      };

      for (const filePath of pending) {
        try {
          const didWork = await this.reindexFile(filePath);
          if (didWork) {
            summary.successCount++;
          } else {
            summary.skippedCount++;
          }
        } catch (error) {
          summary.failedCount++;
          summary.failedFiles.push({
            path: filePath,
            error: error instanceof Error ? error.message : String(error),
          });

          console.error(`${LOG} file reindex failed`, {
            filePath,
            error,
          });
        }
      }

      summary.willPersist =
        summary.successCount > 0 &&
        summary.failedCount === 0;

      console.log(`${LOG} drainQueue summary`, summary);

      if (summary.willPersist) {
        if (!this.plugin.isExternalIndexerRunning()) {
          try {
            await this.db.requestPersist();
          } catch (error) {
            console.error(`${LOG} persistence failed`, {
              error,
            });
            if (this.plugin.view?.store) {
              this.plugin.view.store.setState({
                indexingError: error instanceof Error
                  ? error.message
                  : String(error),
              });
            }

            throw error;
          }
        } else {
          console.log(`${LOG} persist skipped — external indexer active`);
        }

        const rawDb = this.db.getDb();
        if (rawDb) {
          try {
            const res = rawDb.exec('SELECT COUNT(*) FROM sources');
            const count = res?.[0]?.values?.[0]?.[0];
            console.log(`${LOG} post-update source count`, { sources: count });
          } catch (e) {
            console.error(`${LOG} readback verification failed`, e);
          }
        }
      }

    } finally {
      this.plugin.endIndexing();

      if (this.plugin.pendingAjsonReindex.size > 0) {
        this.scheduleDrain();
      }
    }
  }

  /**
   * Debounce re-index calls per file. Each new event for the same file
   * resets the timer, so we only fire after DEBOUNCE_MS of silence.
   */
  private scheduleReindex(fullFilePath: string): void {
    if (this.plugin.activeQueryCount > 0) {
      console.log(`${LOG} deferring change — query active`, {
        fullFilePath,
      });
      this.plugin.pendingAjsonReindex.add(fullFilePath);
      return;
    }

    const existing = this.debounceTimers.get(fullFilePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(fullFilePath);
      this.plugin.pendingAjsonReindex.add(fullFilePath);
      this.scheduleDrain();
    }, DEBOUNCE_MS);

    this.debounceTimers.set(fullFilePath, timer);
  }

  private async reindexFile(fullFilePath: string): Promise<boolean> {
    const fs = require("fs");

    // If the file was deleted, remove orphan records from the DB
    if (!fs.existsSync(fullFilePath)) {
      const didDelete = await this.db.enqueueWrite(() => this.removeOrphansForFile(fullFilePath));
      return didDelete;
    }

    // Skip if mtime is unchanged
    try {
        const stat = fs.statSync(fullFilePath);
        const mtime = stat.mtimeMs;
        const rawDb = this.db.getDb();
        const res = rawDb.exec(`SELECT mtime FROM index_file_meta WHERE filepath = '${fullFilePath.replace(/'/g, "''")}'`);

        if (res[0] && res[0].values[0]) {
            const storedMtime = res[0].values[0][0] as number;
            if (storedMtime === mtime) {
                console.log(`${LOG} reindex skipped — unchanged mtime`, { fullFilePath });
                return false;
            }
        }
    } catch (e) {
        console.warn(`${LOG} mtime check failed — proceeding to reindex`, { fullFilePath, error: e });
    }

    const result = await this.db.enqueueWrite(() => this.indexBuilder.buildFromSingleFile(
      this.watchPath,
      fullFilePath
    ));

    // Update mtime
    try {
        const stat = fs.statSync(fullFilePath);
        const mtime = stat.mtimeMs;
        await this.db.enqueueWrite(() => {
          const rawDb = this.db.getDb();
          rawDb.exec(`
              INSERT INTO index_file_meta (filepath, mtime, is_missing)
              VALUES ('${fullFilePath.replace(/'/g, "''")}', ${mtime}, 0)
              ON CONFLICT(filepath) DO UPDATE SET mtime = ${mtime}, is_missing = 0
          `);
        });
        // Debounced persist to the end of drainQueue
    } catch (e) {
        console.error("Failed to update mtime", e);
    }

    console.log(`${LOG} reindex complete`, { fullFilePath, result });
    return true;
  }

  private async removeOrphansForFile(fullFilePath: string): Promise<boolean> {
    try {
      const rawDb = this.db.getDb();
      const path = require("path");
      const filename = path.basename(fullFilePath, ".ajson");
      const sourcePath = filename.replace(/#/g, "/") + ".md";

      rawDb.exec("BEGIN TRANSACTION;");
      rawDb.exec(`UPDATE sources SET is_deleted = 1, deleted_at = ${Date.now()}, delete_reason = 'watcher delete' WHERE path = '${sourcePath.replace(/'/g, "''")}'`);
      rawDb.exec(`UPDATE index_file_meta SET is_missing = 1, missing_since = ${Date.now()}, missing_reason = 'watcher delete' WHERE filepath = '${fullFilePath.replace(/'/g, "''")}'`);
      rawDb.exec("COMMIT;");
      console.log(`${LOG} orphan cleanup complete`, { sourcePath });
      return true;
    } catch (err) {
      console.error(`${LOG} removeOrphansForFile error:`, err);
      try { this.db.getDb().exec("ROLLBACK;"); } catch (_) { /* ignore */ }
      return false;
    }
  }
}
