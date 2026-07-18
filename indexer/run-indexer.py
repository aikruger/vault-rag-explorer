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

started_at = int(time.time() * 1000)

progress = {
    "status": "running",
    "startedAt": started_at,
    "heartbeatAt": started_at,
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
    "error": None,
    "pid": None,
    "exitCode": None,
}
progress_file.write_text(json.dumps(progress))
print(f'[run-indexer] initial progress written: {progress}')

proc = subprocess.Popen(
    ['node', str(node_script), vault_root],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1
)

progress["pid"] = proc.pid
progress["heartbeatAt"] = int(time.time() * 1000)
progress_file.write_text(json.dumps(progress))
print(f'[run-indexer] subprocess started', {"pid": proc.pid})

for line in proc.stdout:
    line = line.rstrip()
    if line.startswith('[indexer-progress] '):
        try:
            payload = json.loads(line[len('[indexer-progress] '):])

            progress["heartbeatAt"] = int(time.time() * 1000)
            progress["existingSources"] = progress.get("existingSources", existing_sources)
            progress["totalFiles"] = payload.get("totalFiles", progress["totalFiles"])
            progress["processedFiles"] = payload.get("processedFiles", progress["processedFiles"])
            progress["sourcesInserted"] = payload.get("sourcesInserted", progress["sourcesInserted"])
            progress["sourcesUpdated"] = payload.get("sourcesUpdated", progress["sourcesUpdated"])
            progress["sourcesDeleted"] = payload.get("sourcesDeleted", progress["sourcesDeleted"])
            progress["blocksUpserted"] = payload.get("blocksUpserted", progress["blocksUpserted"])
            progress["embeddingsUpserted"] = payload.get("embeddingsUpserted", progress["embeddingsUpserted"])
            progress["errors"] = payload.get("errors", progress["errors"])
            progress["lastFile"] = payload.get("lastFile", progress["lastFile"])

            phase = payload.get("phase")
            if phase == "complete":
                progress["status"] = "complete"
                progress["completedAt"] = int(time.time() * 1000)
            else:
                progress["status"] = "running"

            progress_file.write_text(json.dumps(progress))
            print(f"[run-indexer] wrote progress update: phase={phase} processed={progress['processedFiles']}/{progress['totalFiles']}")
        except Exception as e:
            print(f"[run-indexer] error parsing progress JSON: {e}")
            print(line)
    else:
        print(line)  # pass through to terminal

proc.wait()
status = "complete" if proc.returncode == 0 else "error"

progress["heartbeatAt"] = int(time.time() * 1000)
progress["completedAt"] = int(time.time() * 1000)
progress["exitCode"] = proc.returncode
progress["status"] = status
if status == "error":
    progress["error"] = f"Exit code {proc.returncode}"

progress_file.write_text(json.dumps(progress))
print(f"[run-indexer] terminal progress written: {progress}")
print(f"[run-indexer] Done — status: {status}")
