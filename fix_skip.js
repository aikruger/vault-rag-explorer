import fs from 'fs';
let content = fs.readFileSync('indexer/build-index.js', 'utf8');

const search = `    if (storedMtime !== null && storedMtime === fileMtime) {
      console.log(\`[indexer] file unchanged (mtime match), skipping: \${filePath}\`);
      // We don't need to emit progress for every skipped file, but let's do it periodically or just rely on the batch commit
      // to avoid spamming the UI. We'll emit progress if it's the last file.
      if (i === ajsonFiles.length) {
        emitProgress({
          phase: 'file',`;

const replace = `    if (storedMtime !== null && storedMtime === fileMtime) {
      console.log(\`[indexer] file unchanged (mtime match), skipping: \${filePath}\`);
      if (i % COMMIT_EVERY === 0 || i === ajsonFiles.length) {
        emitProgress({
          phase: 'file',`;

content = content.replace(search, replace);

const sessionStartSearch = `  console.log('[indexer] BEGIN batch transaction', { batchStart: 0 });`;
const sessionStartReplace = `  console.log('[indexer] session start');
  console.log('[indexer] batch begin');
  console.log('[indexer] BEGIN batch transaction', { batchStart: 0 });`;

content = content.replace(sessionStartSearch, sessionStartReplace);

fs.writeFileSync('indexer/build-index.js', content);
