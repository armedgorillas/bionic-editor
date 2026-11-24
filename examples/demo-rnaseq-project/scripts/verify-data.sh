#!/usr/bin/env bash
# Portable pre-publish & CI data provenance + leak check.
# Works identically inside Bionic Hub or on any developer machine.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -s "web-report/index.html" ]]; then
  echo "ERROR: web-report/index.html is missing or empty." >&2
  exit 1
fi

# 1. Verify no raw data files are tracked in Git (when inside a git repo)
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  TRACKED_RAW="$(git ls-files -- 'data/raw/' | grep -v '^data/raw/\.gitkeep$' || true)"
  if [[ -n "$TRACKED_RAW" ]]; then
    echo "ERROR: Raw data files are tracked in Git (run 'git rm --cached'):" >&2
    echo "$TRACKED_RAW" >&2
    exit 1
  fi
fi

# 2. Verify manifest SHA-256 hashes and scan web-report/ for leaks
python3 - <<'PY'
import hashlib, json, os, sys
from pathlib import Path

root = Path.cwd().resolve()
manifest_path = root / "data" / "manifest.json"
report_dir = root / "web-report"

raw_ext = {".fastq", ".fq", ".bam", ".sam", ".cram", ".vcf", ".bcf", ".h5ad", ".loom", ".sra", ".bed", ".bigwig", ".bw"}
compound = (".fastq.gz", ".fq.gz", ".vcf.gz", ".bcf.gz", ".sam.gz", ".bed.gz", ".fastq.bz2", ".fq.bz2")
max_report_bytes = 25 * 1024 * 1024

def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

manifest_hashes = {}
errors = []

if manifest_path.exists():
    doc = json.loads(manifest_path.read_text(encoding="utf-8"))
    for entry in doc.get("entries", []):
        fp = entry.get("filepath", "")
        expected = entry.get("sha256", "")
        storage = entry.get("storage") or {}
        sync_status = storage.get("syncStatus")
        if expected:
            manifest_hashes[expected] = fp
        local = (root / fp)
        if local.exists() and local.is_file():
            actual = sha256_file(local)
            if expected and actual != expected:
                errors.append(f"SHA-256 mismatch for {fp}: expected {expected[:12]}, got {actual[:12]}")
        elif sync_status != "remote_only" and not fp.startswith("/mnt/shared-data/"):
            errors.append(f"Missing local raw dataset listed in manifest: {fp}")

for dirpath, dirnames, filenames in os.walk(report_dir):
    for name in list(dirnames) + list(filenames):
        p = Path(dirpath) / name
        rel = p.relative_to(root).as_posix()
        if p.is_symlink():
            target = p.resolve()
            if not target.is_relative_to(report_dir.resolve()):
                errors.append(f"Publication leak: symlink escapes web-report/: {rel}")
            continue
        if not p.is_file():
            continue
        lower = name.lower()
        if p.suffix.lower() in raw_ext or any(lower.endswith(s) for s in compound):
            errors.append(f"Publication leak: raw bioinformatics file in web-report/: {rel}")
        size = p.stat().st_size
        if size > max_report_bytes:
            errors.append(f"Publication leak: oversized file (>25 MB) in web-report/: {rel}")
        if size > 0 and manifest_hashes:
            digest = sha256_file(p)
            if digest in manifest_hashes:
                errors.append(f"Publication leak: {rel} matches raw data {manifest_hashes[digest]}")

if errors:
    for e in errors:
        print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)

print("OK: Data manifest and web-report publication safety check passed.")
PY
