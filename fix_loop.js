import fs from 'fs';
let content = fs.readFileSync('indexer/build-index.js', 'utf8');

const searchBefore = `      if (sinceCommit >= COMMIT_EVERY) {
        db.exec('COMMIT TRANSACTION');
        console.log('[indexer] COMMIT batch transaction', { processedFiles: i, sinceCommit });
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        console.log('[indexer] wal_checkpoint(TRUNCATE) after batch commit');
        db.exec('BEGIN TRANSACTION');
        sinceCommit = 0;
      }
    } catch (e) {
      db.exec('ROLLBACK TO file_txn');
      console.error(\`[indexer] error processing file \${filePath}:\`, e.message);
      totalErrors++;
    }

    emitProgress({
      phase: 'file',
      processedFiles: i,
      totalFiles: ajsonFiles.length,
      lastFile: filePath,
      sourcesInserted,
      sourcesUpdated,
      sourcesDeleted,
      blocksUpserted,
      embeddingsUpserted,
      errors: totalErrors
    });
  }
  db.exec('COMMIT TRANSACTION'); // final partial batch
  console.log('[indexer] final COMMIT', { processedFiles: i });`;

const replaceAfter = `      if (sinceCommit >= COMMIT_EVERY) {
        console.log('[indexer] db commit success');
        db.exec('COMMIT TRANSACTION');
        console.log('[indexer] COMMIT batch transaction', { processedFiles: i, sinceCommit });
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        console.log('[indexer] wal_checkpoint(TRUNCATE) after batch commit');

        emitProgress({
          phase: 'file',
          processedFiles: i,
          totalFiles: ajsonFiles.length,
          lastFile: filePath,
          sourcesInserted,
          sourcesUpdated,
          sourcesDeleted,
          blocksUpserted,
          embeddingsUpserted,
          errors: totalErrors
        });

        console.log('[indexer] batch begin');
        db.exec('BEGIN TRANSACTION');
        sinceCommit = 0;
      }
    } catch (e) {
      db.exec('ROLLBACK TO file_txn');
      console.error(\`[indexer] error processing file \${filePath}:\`, e.message);
      totalErrors++;
    }
  }
  db.exec('COMMIT TRANSACTION'); // final partial batch
  console.log('[indexer] final COMMIT', { processedFiles: i });
  console.log('[indexer] db commit success');`;

content = content.replace(searchBefore, replaceAfter);

const skipSearch = `    if (storedMtime !== null && storedMtime === fileMtime) {
      console.log(\`[indexer] file unchanged (mtime match), skipping: \${filePath}\`);
      emitProgress({`;
const skipReplace = `    if (storedMtime !== null && storedMtime === fileMtime) {
      console.log(\`[indexer] file unchanged (mtime match), skipping: \${filePath}\`);
      // We don't need to emit progress for every skipped file, but let's do it periodically or just rely on the batch commit
      // to avoid spamming the UI. We'll emit progress if it's the last file.
      if (i === ajsonFiles.length) {
        emitProgress({`;
content = content.replace(skipSearch, skipReplace);

fs.writeFileSync('indexer/build-index.js', content);
