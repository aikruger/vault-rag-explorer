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
    console.log("[AjsonWatcherService] constructor received plugin");
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
          if (!filename) return;
          if (!filename.endsWith(".ajson")) return;
          console.log(`${LOG} [AjsonWatcher] .ajson change detected`, { filename });

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

  private isExternalIndexerRunning(): boolean {
    const fs = require('fs');
    const path = require('path');
    const vaultAdapter = this.plugin.app.vault.adapter as any;
    const basePath = vaultAdapter.getBasePath();
    const pluginDir = path.join(basePath, '.obsidian', 'plugins', this.plugin.manifest.id);
    const progressFile = path.join(pluginDir, 'data', 'index-progress.json');

    if (!fs.existsSync(progressFile)) return false;

    try {
        const content = fs.readFileSync(progressFile, 'utf8');
        const progress = JSON.parse(content);
        const staleThreshold = 15000;
        const heartbeatStale = (Date.now() - (progress.heartbeatAt || 0)) > staleThreshold;

        return progress.status === 'running' && !heartbeatStale;
    } catch (e) {
        return false;
    }
  }

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

    if (this.isExternalIndexerRunning()) {
        console.log(`${LOG} [plugin] bulk index denied - external indexer active`);
        console.log('[indexer] lock acquired', { pid: process.pid });
        console.log(`${LOG} [AjsonWatcher] full build already running, incremental request queued`, { count: this.plugin.pendingAjsonReindex.size });
        this.scheduleDrain();
        return;
    }

    if (!this.plugin.beginIndexing()) {
      this.scheduleDrain();
      return;
    }

    try {
      console.log('[checker] indexing started');
      const pending = Array.from(this.plugin.pendingAjsonReindex);
      this.plugin.pendingAjsonReindex.clear();

      for (const filePath of pending) {
        console.log(`${LOG} drainQueue processing file`, { filePath });
        await this.reindexFile(filePath);
      }

      console.log('[checker] persist start');
      console.log('[checker] before persist');
      this.db.persist();
      console.log('[checker] after persist');
      console.log('[checker] persist complete');

      const rawDb = this.db.getDb();
      if (rawDb) {
        try {
          const res = rawDb.exec('SELECT COUNT(*) FROM sources');
          const count = res?.[0]?.values?.[0]?.[0];
          console.log('[checker] post-persist readback verification counts', { sources: count });
        } catch (e) {
          console.error('[checker] readback verification failed', e);
        }
      }

    } finally {
      this.plugin.endIndexing();
      console.log('[checker] indexing lock cleared');

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
    const existing = this.debounceTimers.get(fullFilePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(fullFilePath);
      this.plugin.pendingAjsonReindex.add(fullFilePath);
      console.log(`${LOG} [AjsonWatcher] debounced file enqueued`, {
        fullFilePath,
        pendingCount: this.plugin.pendingAjsonReindex.size,
      });
      this.scheduleDrain();
    }, DEBOUNCE_MS);

    this.debounceTimers.set(fullFilePath, timer);
  }

  private async reindexFile(fullFilePath: string): Promise<void> {
    const fs = require("fs");
    console.log(`${LOG} reindexFile start:`, fullFilePath);

    // If the file was deleted, remove orphan records from the DB
    if (!fs.existsSync(fullFilePath)) {
      console.log(`${LOG} file no longer exists — running orphan cleanup for:`, fullFilePath);
      await this.removeOrphansForFile(fullFilePath);
      return;
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
                console.log(`${LOG} [AjsonWatcher] reindex skipped - unchanged mtime`, { fullFilePath });
                return;
            }
        }
    } catch (e) {
        console.log(`${LOG} error checking mtime`, e);
    }

    try {
      const result = await this.indexBuilder.buildFromSingleFile(
        this.watchPath,
        fullFilePath
      );

      // Update mtime
      try {
          const stat = fs.statSync(fullFilePath);
          const mtime = stat.mtimeMs;
          const rawDb = this.db.getDb();
          rawDb.exec(`
              INSERT INTO index_file_meta (filepath, mtime, is_missing)
              VALUES ('${fullFilePath.replace(/'/g, "''")}', ${mtime}, 0)
              ON CONFLICT(filepath) DO UPDATE SET mtime = ${mtime}, is_missing = 0
          `);
          // Debounced persist to the end of drainQueue
      } catch (e) {
          console.error("Failed to update mtime", e);
      }

      console.log(`${LOG} reindexFile complete:`, fullFilePath, result);
    } catch (err) {
      console.error(`${LOG} reindexFile error for`, fullFilePath, err);
    }
  }

  private async removeOrphansForFile(fullFilePath: string): Promise<void> {
    console.log(`${LOG} removeOrphansForFile:`, fullFilePath);
    try {
      const rawDb = this.db.getDb();
      const path = require("path");
      const filename = path.basename(fullFilePath, ".ajson");
      const sourcePath = filename.replace(/#/g, "/") + ".md";

      console.log(`${LOG} looking up source path for deletion:`, sourcePath);

      // Mark as deleted instead of hard delete
      rawDb.exec("BEGIN TRANSACTION;");
      rawDb.exec(`UPDATE sources SET is_deleted = 1, deleted_at = ${Date.now()}, delete_reason = 'watcher delete' WHERE path = '${sourcePath.replace(/'/g, "''")}'`);
      rawDb.exec(`UPDATE index_file_meta SET is_missing = 1, missing_since = ${Date.now()}, missing_reason = 'watcher delete' WHERE filepath = '${fullFilePath.replace(/'/g, "''")}'`);
      rawDb.exec("COMMIT;");
      console.log(`${LOG} orphan cleanup (soft delete) complete for source:`, sourcePath);
      // Debounced persist to the end of drainQueue
    } catch (err) {
      console.error(`${LOG} removeOrphansForFile error:`, err);
      try { this.db.getDb().exec("ROLLBACK;"); } catch (_) { /* ignore */ }
    }
  }
}
