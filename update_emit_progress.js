import fs from 'fs';
let content = fs.readFileSync('indexer/build-index.js', 'utf8');

const search = `function emitProgress(payload) {
  process.stdout.write(\`[indexer-progress] \${JSON.stringify(payload)}\\n\`);
  try {
    const sz = fs.statSync(dbPath).size;
    console.log('[indexer] main db file size check', { dbPath, bytes: sz });
  } catch (e) {
    console.log('[indexer] could not stat db file', e);
  }
}`;

const replace = `
const sessionId = 'session-' + Date.now();
const progressPath = path.join(dbDir, '..', 'index-progress.json');

function emitProgress(payload) {
  payload.heartbeatAt = Date.now();
  payload.sessionId = sessionId;

  if (payload.phase === 'start') {
    payload.startedAt = Date.now();
    payload.status = 'running';
  } else if (payload.phase === 'complete') {
    payload.completedAt = Date.now();
    payload.status = 'complete';
  } else if (payload.phase === 'fatal') {
    payload.status = 'error';
  } else {
    payload.status = 'running';
  }

  process.stdout.write(\`[indexer-progress] \${JSON.stringify(payload)}\\n\`);

  try {
    fs.writeFileSync(progressPath, JSON.stringify(payload, null, 2));
    console.log('[indexer] progress write success');
  } catch(e) {
    console.error('[indexer] progress write skipped (error)', e);
  }

  try {
    const sz = fs.statSync(dbPath).size;
    console.log('[indexer] main db file size check', { dbPath, bytes: sz });
  } catch (e) {
    console.log('[indexer] could not stat db file', e);
  }
}`;

content = content.replace(search, replace);
fs.writeFileSync('indexer/build-index.js', content);
