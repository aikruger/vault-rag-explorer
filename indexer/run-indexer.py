import subprocess, sys, json, os, time, pathlib, shutil

vault_root = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
plugin_dir = pathlib.Path(vault_root) / '.obsidian' / 'plugins' / 'vault-rag-explorer'
progress_file = plugin_dir / 'index-progress.json'

plugin_dir.mkdir(parents=True, exist_ok=True)

node_script = pathlib.Path(__file__).parent / 'build-index.js'

# Write initial status
progress_file.write_text(json.dumps({
    "status": "running",
    "startedAt": int(time.time() * 1000),
    "filesProcessed": 0,
    "totalFiles": 0,
    "lastFile": "",
    "completedAt": None,
    "error": None
}))
print(f'[run-indexer] Progress file: {progress_file}')

# Count total files upfront
smart_env = pathlib.Path(vault_root) / '.smart-env' / 'multi'
if not smart_env.exists():
    smart_env = pathlib.Path(vault_root) / '.smart-env'
total_files = len(list(smart_env.glob('*.ajson')))

proc = subprocess.Popen(
    ['node', str(node_script), vault_root],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1
)

files_done = 0
for line in proc.stdout:
    line = line.rstrip()
    print(line)  # pass through to terminal
    if '[indexer] parsing file' in line or '[indexer] progress' in line:
        files_done += 1
        progress_file.write_text(json.dumps({
            "status": "running",
            "startedAt": int(time.time() * 1000),
            "filesProcessed": files_done,
            "totalFiles": total_files,
            "lastFile": line,
            "completedAt": None,
            "error": None
        }))

proc.wait()
status = "complete" if proc.returncode == 0 else "error"
progress_file.write_text(json.dumps({
    "status": status,
    "startedAt": int(time.time() * 1000),
    "filesProcessed": files_done,
    "totalFiles": total_files,
    "lastFile": "",
    "completedAt": int(time.time() * 1000),
    "error": None if status == "complete" else f"Exit code {proc.returncode}"
}))
print(f'[run-indexer] Done — status: {status}')
