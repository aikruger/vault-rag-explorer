#!/usr/bin/env python3
import sys
import os
import subprocess
import json
import time

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 run-indexer.py <vault_root>")
        sys.exit(1)

    vault_root = os.path.abspath(sys.argv[1])
    plugin_id = "vault-rag-explorer"
    plugin_dir = os.path.join(vault_root, ".obsidian", "plugins", plugin_id)
    progress_file = os.path.join(plugin_dir, "data", "index-progress.json")

    script_path = os.path.join(os.path.dirname(__file__), "build-index.js")

    os.makedirs(os.path.dirname(progress_file), exist_ok=True)

    print(f"[run-indexer] Starting build-index.js for vault: {vault_root}")

    process = subprocess.Popen(
        ["node", script_path, vault_root],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True
    )

    # Initialize progress
    initial_payload = {
        "status": "running",
        "phase": "starting",
        "startedAt": int(time.time() * 1000),
        "heartbeatAt": int(time.time() * 1000),
        "progressUpdatedAt": int(time.time() * 1000),
        "processedFiles": 0,
        "totalFiles": 0,
        "lastFile": "",
        "sourcesInserted": 0,
        "sourcesUpdated": 0,
        "sourcesSoftDeleted": 0,
        "blocksUpserted": 0,
        "embeddingsUpserted": 0,
        "errors": 0,
        "activeSources": 0,
        "softDeletedSources": 0,
        "pid": process.pid
    }

    with open(progress_file, "w") as f:
        json.dump(initial_payload, f)

    last_payload = initial_payload

    for line in iter(process.stdout.readline, ''):
        line = line.strip()
        if not line:
            continue

        print(line) # Echo to main console

        if line.startswith("[indexer-progress]"):
            try:
                payload_str = line.replace("[indexer-progress]", "").strip()
                payload = json.loads(payload_str)
                last_payload = payload
                with open(progress_file, "w") as f:
                    json.dump(payload, f)
            except Exception as e:
                print(f"[run-indexer] Failed to parse progress: {e}")

    process.wait()

    if process.returncode != 0:
        print(f"[run-indexer] Indexer exited with error code {process.returncode}")
        last_payload["status"] = "error"
        last_payload["phase"] = "error"
        with open(progress_file, "w") as f:
            json.dump(last_payload, f)
    else:
        print("[run-indexer] Indexer finished successfully")

if __name__ == "__main__":
    main()
