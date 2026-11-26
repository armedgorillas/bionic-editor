#!/usr/bin/env bash
# Portable raw data hydration script driven by data/manifest.json.
# Inside Bionic Hub: fetches short-lived V4 Signed Read URLs via $BIONIC_DATA_PROXY_URL.
# Standalone / Exported: uses gcloud storage cp / aws s3 cp / curl / acquisition.scriptPath.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MANIFEST="data/manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
  echo "No data/manifest.json found; nothing to pull."
  exit 0
fi

TARGET_ID="${1:-}"

python3 - "$MANIFEST" "$TARGET_ID" <<'PY'
import hashlib, json, os, subprocess, sys, urllib.request
from pathlib import Path

manifest_path = Path(sys.argv[1])
target_id = sys.argv[2]
doc = json.loads(manifest_path.read_text(encoding="utf-8"))
entries = doc.get("entries", [])
proxy_url = os.environ.get("BIONIC_DATA_PROXY_URL", "").rstrip("/")
shim_token = os.environ.get("BIONIC_LOCAL_SHIM_TOKEN", "")

def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

root = Path.cwd().resolve()
for entry in entries:
    eid = entry.get("id", "")
    if target_id and eid != target_id:
        continue
    fp = (root / entry["filepath"]).resolve()
    if not fp.is_relative_to(root):
        raise SystemExit(f"Security error: manifest filepath escapes workspace: {entry['filepath']}")
    expected = entry.get("sha256", "")
    if fp.exists() and expected and sha256_file(fp) == expected:
        print(f"[ok] {entry['filepath']} already verified ({expected[:12]})")
        continue

    fp.parent.mkdir(parents=True, exist_ok=True)
    storage = entry.get("storage") or {}
    uri = storage.get("uri", "")
    data_obj_id = storage.get("dataObjectId", "")
    acq = entry.get("acquisition") or {}

    if proxy_url and data_obj_id:
        req = urllib.request.Request(
            f"{proxy_url}/read-url",
            data=json.dumps({"dataObjectId": data_obj_id}).encode(),
            headers={"Content-Type": "application/json", "X-Bionic-Shim-Token": shim_token},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            signed_url = json.loads(resp.read().decode())["signedUrl"]
        subprocess.run(["curl", "-fsSL", "-o", str(fp), signed_url], check=True)
    elif uri.startswith("gs://"):
        subprocess.run(["gcloud", "storage", "cp", uri, str(fp)], check=True)
    elif uri.startswith("s3://"):
        subprocess.run(["aws", "s3", "cp", uri, str(fp)], check=True)
    elif acq.get("sourceUrl"):
        subprocess.run(["curl", "-fsSL", "-o", str(fp), acq["sourceUrl"]], check=True)
    elif acq.get("scriptPath"):
        script_abs = (root / acq["scriptPath"]).resolve()
        if not script_abs.is_relative_to(root) or not script_abs.is_file():
            raise SystemExit(f"Security error: acquisition scriptPath escapes workspace or missing: {acq['scriptPath']}")
        subprocess.run([sys.executable, str(script_abs)], check=True)
    else:
        print(f"[skip] No remote source recorded for {entry['filepath']}; place file manually.", file=sys.stderr)
        continue

    if expected:
        actual = sha256_file(fp)
        if actual != expected:
            raise SystemExit(f"SHA-256 verification failed for {entry['filepath']}: expected {expected}, got {actual}")
    print(f"[pulled] {entry['filepath']}")
PY
