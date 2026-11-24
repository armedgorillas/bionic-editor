#!/usr/bin/env bash
# Portable raw data sync script for data/raw/* entries in data/manifest.json.
# Inside Bionic Hub: streams via $BIONIC_DATA_PROXY_URL.
# Standalone / Exported: uploads via gcloud storage cp / aws s3 cp using $BIONIC_DATA_BUCKET.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

EVICT_LOCAL=0
if [[ "${1:-}" == "--evict-local" ]]; then
  EVICT_LOCAL=1
fi

MANIFEST="data/manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
  echo "No data/manifest.json found; nothing to push."
  exit 0
fi

python3 - "$MANIFEST" "$EVICT_LOCAL" <<'PY'
import json, os, subprocess, sys, urllib.request
from pathlib import Path

manifest_path = Path(sys.argv[1])
evict = sys.argv[2] == "1"
doc = json.loads(manifest_path.read_text(encoding="utf-8"))
proxy_url = os.environ.get("BIONIC_DATA_PROXY_URL", "").rstrip("/")
shim_token = os.environ.get("BIONIC_LOCAL_SHIM_TOKEN", "")
bucket = os.environ.get("BIONIC_DATA_BUCKET", "").rstrip("/")
changed = False

for entry in doc.get("entries", []):
    fp = Path(entry["filepath"])
    storage = entry.get("storage") or {}
    if storage.get("syncStatus") in ("synced", "remote_only") and storage.get("uri"):
        if evict and fp.exists():
            fp.unlink()
            storage["syncStatus"] = "remote_only"
            entry["storage"] = storage
            changed = True
            print(f"[evicted] {fp}")
        continue
    if not fp.exists():
        continue

    if proxy_url:
        req = urllib.request.Request(
            f"{proxy_url}/upload-session",
            data=json.dumps({
                "filename": fp.name,
                "sizeBytes": fp.stat().st_size,
                "targetRelPath": entry["filepath"],
                "sha256": entry.get("sha256", "")
            }).encode(),
            headers={"Content-Type": "application/json", "X-Bionic-Shim-Token": shim_token},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            sess = json.loads(resp.read().decode())
        subprocess.run(["curl", "-fsSL", "-X", "PUT", "-T", str(fp), sess["resumableSessionUri"]], check=True)
        complete_req = urllib.request.Request(
            f"{proxy_url}/upload-complete",
            data=json.dumps({"dataObjectId": sess["dataObjectId"], "clientSha256": entry.get("sha256", "")}).encode(),
            headers={"Content-Type": "application/json", "X-Bionic-Shim-Token": shim_token},
            method="POST"
        )
        with urllib.request.urlopen(complete_req, timeout=30) as resp:
            meta = json.loads(resp.read().decode())
        entry["storage"] = {
            "provider": meta.get("provider", "gcs"),
            "dataObjectId": meta["dataObjectId"],
            "uri": meta["storageUri"],
            "generation": meta.get("generation"),
            "crc32c": meta.get("crc32c"),
            "syncStatus": "remote_only" if evict else "synced",
            "readOnly": False
        }
        if evict:
            fp.unlink()
        changed = True
        print(f"[pushed] {fp} -> {meta['storageUri']}")
    elif bucket:
        dest = f"{bucket}/{entry.get('sha256', 'raw')[:16]}/{fp.name}"
        if bucket.startswith("gs://"):
            subprocess.run(["gcloud", "storage", "cp", str(fp), dest], check=True)
            provider = "gcs"
        elif bucket.startswith("s3://"):
            subprocess.run(["aws", "s3", "cp", str(fp), dest], check=True)
            provider = "s3"
        else:
            raise SystemExit(f"Unsupported BIONIC_DATA_BUCKET scheme: {bucket}")
        entry["storage"] = {
            "provider": provider,
            "uri": dest,
            "syncStatus": "remote_only" if evict else "synced",
            "readOnly": False
        }
        if evict:
            fp.unlink()
        changed = True
        print(f"[pushed] {fp} -> {dest}")
    else:
        print(f"[skip] Set BIONIC_DATA_BUCKET (gs://... or s3://...) to push {fp} outside Bionic Hub.")

if changed:
    manifest_path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
PY
