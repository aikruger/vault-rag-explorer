import subprocess, sys, json, os, time, pathlib, shutil, sqlite3

vault_root = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
plugin_dir = pathlib.Path(vault_root) / '.obsidian' / 'plugins' / 'vault-rag-explorer'
progress_file = plugin_dir / 'index-progress.json'
db_path = plugin_dir / 'data' / 'smart_index.db'
node_script = plugin_dir / 'indexer' / 'build-index.js'

plugin_dir.mkdir(parents=True, exist_ok=True)

existing_sources = 0
if db_path.exists():
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM sources")
        existing_sources = cursor.fetchone()[0]
        conn.close()
    except Exception as e:
        print(f"[run-indexer] error reading existing sources: {e}")

print(f"[run-indexer] vault_root={vault_root}")
print(f"[run-indexer] plugin_dir={plugin_dir}")
print(f"[run-indexer] db_path={db_path}")
print(f"[run-indexer] node_script={node_script}")
print(f"[run-indexer] existingSources={existing_sources}")

# Write initial status
progress_file.write_text(json.dumps({
    "status": "running",
    "startedAt": int(time.time() * 1000),
    "existingSources": existing_sources,
    "totalFiles": 0,
    "processedFiles": 0,
    "sourcesInserted": 0,
    "sourcesUpdated": 0,
    "sourcesDeleted": 0,
    "blocksUpserted": 0,
    "embeddingsUpserted": 0,
    "errors": 0,
    "lastFile": "",
    "completedAt": None,
    "error": None
}))
print(f'[run-indexer] Progress file: {progress_file}')

proc = subprocess.Popen(
    ['node', str(node_script), vault_root],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1
)

for line in proc.stdout:
    line = line.rstrip()
    if line.startswith('[indexer-progress] '):
        try:
            payload = json.loads(line[len('[indexer-progress] '):])

            # Default to 0 for missing fields
            sources_inserted = payload.get('sourcesInserted', 0)
            sources_updated = payload.get('sourcesUpdated', 0)
            sources_deleted = payload.get('sourcesDeleted', 0)
            blocks_upserted = payload.get('blocksUpserted', 0)
            embeddings_upserted = payload.get('embeddingsUpserted', 0)
            errors = payload.get('errors', 0)

            # Keep existing logic for backwards compatibility if needed
            if payload.get('phase') == 'start':
               progress_file.write_text(json.dumps({
                    "status": "running",
                    "startedAt": int(time.time() * 1000),
                    "existingSources": payload.get('existingSources', existing_sources),
                    "totalFiles": payload.get('totalFiles', 0),
                    "processedFiles": 0,
                    "sourcesInserted": 0,
                    "sourcesUpdated": 0,
                    "sourcesDeleted": 0,
                    "blocksUpserted": 0,
                    "embeddingsUpserted": 0,
                    "errors": 0,
                    "lastFile": "",
                    "completedAt": None,
                    "error": None
                }))
            else:
               progress_file.write_text(json.dumps({
                    "status": "running" if payload.get('phase') != 'complete' else 'complete',
                    "startedAt": int(time.time() * 1000),
                    "existingSources": existing_sources, # Keeps initial count
                    "totalFiles": payload.get('totalFiles', 0),
                    "processedFiles": payload.get('processedFiles', 0),
                    "sourcesInserted": sources_inserted,
                    "sourcesUpdated": sources_updated,
                    "sourcesDeleted": sources_deleted,
                    "blocksUpserted": blocks_upserted,
                    "embeddingsUpserted": embeddings_upserted,
                    "errors": errors,
                    "lastFile": payload.get('lastFile', ''),
                    "completedAt": int(time.time() * 1000) if payload.get('phase') == 'complete' else None,
                    "error": None
                }))
        except Exception as e:
            print(f"[run-indexer] error parsing progress JSON: {e}")
            print(line)
    else:
        print(line)  # pass through to terminal

proc.wait()
status = "complete" if proc.returncode == 0 else "error"

# Only write error state if it didn't complete cleanly
if status == 'error':
    try:
        current = json.loads(progress_file.read_text())
        current['status'] = status
        current['error'] = f"Exit code {proc.returncode}"
        current['completedAt'] = int(time.time() * 1000)
        progress_file.write_text(json.dumps(current))
    except Exception:
        progress_file.write_text(json.dumps({
            "status": status,
            "startedAt": int(time.time() * 1000),
            "existingSources": existing_sources,
            "totalFiles": 0,
            "processedFiles": 0,
            "sourcesInserted": 0,
            "sourcesUpdated": 0,
            "sourcesDeleted": 0,
            "blocksUpserted": 0,
            "embeddingsUpserted": 0,
            "errors": 0,
            "lastFile": "",
            "completedAt": int(time.time() * 1000),
            "error": f"Exit code {proc.returncode}"
        }))
print(f'[run-indexer] Done — status: {status}')
