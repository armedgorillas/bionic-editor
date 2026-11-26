import fs from 'fs';
import path from 'path';
import { WORKSPACE_DIR } from '../config.js';
import { ensureDirWithOwnership, atomicWriteFileSync, applyTargetOwnership } from './fsSafe.js';

export const BIONIC_YAML_TEMPLATE = `schemaVersion: 1
name: "bionic-analysis"
title: "Scientific Analysis Project"
summary: |
  Summarize the research question, data sources, analytical workflow, and key findings here.
  This summary is displayed on your project's landing page in Bionic Hub.
environment:
  pythonLockfile: "requirements.txt"
entrypoint:
  argv: ["bash", "scripts/run.sh"]
  workdir: "."
outputs:
  reportDir: "web-report"
  testResultsGlob: "tests/scientific/*_results.json"
`;

export const SCRIPT_VERIFY_DATA = `#!/usr/bin/env bash
# Portable pre-publish & CI data provenance + leak check.
# Works identically inside Bionic Hub or on any developer machine.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -s "web-report/index.html" ]]; then
  echo "ERROR: web-report/index.html is missing or empty." >&2
  exit 1
fi

# 1. Verify no raw data files are tracked in Git (when inside a git repo)
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  TRACKED_RAW="$(git ls-files -- 'data/raw/' | grep -v '^data/raw/\\.gitkeep$' || true)"
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
`;

export const SCRIPT_DATA_PULL = `#!/usr/bin/env bash
# Portable raw data hydration script driven by data/manifest.json.
# Inside Bionic Hub: fetches short-lived V4 Signed Read URLs via \$BIONIC_DATA_PROXY_URL.
# Standalone / Exported: uses gcloud storage cp / aws s3 cp / curl / acquisition.scriptPath.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MANIFEST="data/manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
  echo "No data/manifest.json found; nothing to pull."
  exit 0
fi

TARGET_ID="\${1:-}"

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
`;

export const SCRIPT_DATA_PUSH = `#!/usr/bin/env bash
# Portable raw data sync script for data/raw/* entries in data/manifest.json.
# Inside Bionic Hub: streams via \$BIONIC_DATA_PROXY_URL.
# Standalone / Exported: uploads via gcloud storage cp / aws s3 cp using \$BIONIC_DATA_BUCKET.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

EVICT_LOCAL=0
if [[ "\${1:-}" == "--evict-local" ]]; then
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
    manifest_path.write_text(json.dumps(doc, indent=2) + "\\n", encoding="utf-8")
PY
`;

export const SCRIPT_RUN = `#!/usr/bin/env bash
# Portable end-to-end reproducible analysis entrypoint.
# Executed both by Bionic Hub's reproducible module runner AND directly by coders locally.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# 1. Ensure isolated virtual environment exists
if [[ ! -x ".venv/bin/python" ]]; then
  if command -v uv >/dev/null 2>&1 && [[ -f "uv.lock" ]]; then
    uv sync --locked
  else
    python3 -m venv .venv
    if [[ -f "requirements.txt" ]]; then
      .venv/bin/pip install -q -r requirements.txt
    fi
  fi
fi

# 2. Ensure raw datasets listed in data/manifest.json are present & verified
if [[ -x "scripts/data-pull.sh" ]]; then
  ./scripts/data-pull.sh
fi

# 3. Run primary analysis pipeline if present
if [[ -f "code/run_pipeline.py" ]]; then
  .venv/bin/python code/run_pipeline.py
elif [[ -f "code/analyze.py" ]]; then
  .venv/bin/python code/analyze.py
else
  echo "No code/run_pipeline.py or code/analyze.py found yet."
fi

# 4. Run scientific validation tests if present, then refresh report if pipeline embeds results
if compgen -G "tests/scientific/test_*.py" >/dev/null 2>&1; then
  if .venv/bin/python -c "import pytest" >/dev/null 2>&1; then
    .venv/bin/python -m pytest -q tests/scientific
  else
    for t in tests/scientific/test_*.py; do
      .venv/bin/python "$t"
    done
  fi
  if [[ -f "code/analyze.py" ]]; then
    .venv/bin/python code/analyze.py
  fi
fi

echo "OK: Reproducible analysis run completed."
`;

export const SCRIPT_PUBLISH = `#!/usr/bin/env bash
# Portable report publishing script — zero hidden magic!
# Inside Bionic Hub: commits snapshot & streams web-report/ to \$BIONIC_HUB_PUBLISH_URL
#   (where Hub independently re-verifies grants, leaks, and private/public bucket isolation).
# Standalone / Exported: deploys web-report/ directly to \$PUBLISH_TARGET
#   (gs://bucket/prefix, s3://bucket/prefix, rsync://host/path, or a local directory).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VISIBILITY="\${PUBLISH_VISIBILITY:-private}"
TITLE="\${PUBLISH_TITLE:-Published Report}"
SUMMARY="\${PUBLISH_SUMMARY:-}"
NO_GIT=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --visibility) VISIBILITY="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --summary) SUMMARY="$2"; shift 2 ;;
    --no-git) NO_GIT=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

# 1. Hard pre-publish provenance & leak verification
./scripts/verify-data.sh

# 2. Push any un-synced raw datasets to object storage
if [[ -x "scripts/data-push.sh" ]]; then
  ./scripts/data-push.sh
fi

# 3. Capture & push Git commit snapshot (auto-initializes Git inside Bionic Hub so forks clone the full module)
GIT_SHA="uncommitted"
if [[ "$NO_GIT" -eq 0 ]]; then
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [[ -n "\${BIONIC_HUB_PUBLISH_URL:-}" ]]; then
    git init -b main >/dev/null 2>&1 || git init >/dev/null 2>&1
  fi
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [[ "$DRY_RUN" -eq 0 ]]; then
      git config user.name >/dev/null 2>&1 || git config user.name "Bionic Researcher"
      git config user.email >/dev/null 2>&1 || git config user.email "researcher@bionic.local"
      git add -A
      if ! git diff --cached --quiet; then
        git commit -m "publish: $TITLE" >/dev/null
      fi
      HUB_GIT_URL="\${BIONIC_GIT_PROXY_URL:-}"
      if [[ -z "$HUB_GIT_URL" && -n "\${BIONIC_SHIM_URL:-}" && -n "\${BIONIC_PROJECT_ID:-}" ]]; then
        HUB_GIT_URL="\${BIONIC_SHIM_URL}/git/\${BIONIC_PROJECT_ID}.git"
      fi
      if [[ -n "$HUB_GIT_URL" && -n "\${BIONIC_LOCAL_SHIM_TOKEN:-}" ]]; then
        git -c "http.extraHeader=X-Bionic-Shim-Token: \${BIONIC_LOCAL_SHIM_TOKEN}" push "$HUB_GIT_URL" HEAD:refs/heads/main --force
      elif git remote get-url origin >/dev/null 2>&1; then
        git push origin HEAD
      fi
    fi
    GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo uncommitted)"
  fi
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN OK: verified web-report/ (commit $GIT_SHA, visibility=$VISIBILITY)."
  exit 0
fi

# 4a. Inside Bionic Hub -> stream archive (+ _bionic_meta/ manifest, bionic.yaml, test results) to Hub intake
if [[ -n "\${BIONIC_HUB_PUBLISH_URL:-}" ]]; then
  TMP_STAGE="$(mktemp -d /tmp/bionic-pub-stage-XXXXXX)"
  TMP_TAR="$(mktemp /tmp/bionic-report-XXXXXX.tar.gz)"
  trap 'rm -rf "$TMP_STAGE" "$TMP_TAR"' EXIT
  cp -R web-report/. "$TMP_STAGE/"
  mkdir -p "$TMP_STAGE/_bionic_meta"
  [[ -f "data/manifest.json" ]] && cp "data/manifest.json" "$TMP_STAGE/_bionic_meta/manifest.json"
  [[ -f "bionic.yaml" ]] && cp "bionic.yaml" "$TMP_STAGE/_bionic_meta/bionic.yaml"
  if compgen -G "tests/scientific/*_results.json" >/dev/null 2>&1; then
    mkdir -p "$TMP_STAGE/_bionic_meta/test_results"
    cp tests/scientific/*_results.json "$TMP_STAGE/_bionic_meta/test_results/"
  fi
  tar -czf "$TMP_TAR" -C "$TMP_STAGE" .
  SAFE_TITLE="$(printf '%s' "$TITLE" | tr -d '\r\n')"
  SAFE_SUMMARY="$(printf '%s' "$SUMMARY" | tr -d '\r\n')"
  curl -fsSL -X POST "$BIONIC_HUB_PUBLISH_URL" \\
    -H "X-Bionic-Shim-Token: \${BIONIC_LOCAL_SHIM_TOKEN:-}" \\
    -H "X-Bionic-Git-Commit: $GIT_SHA" \\
    -H "X-Bionic-Visibility: $VISIBILITY" \\
    -H "X-Bionic-Title: $SAFE_TITLE" \\
    -H "X-Bionic-Summary: $SAFE_SUMMARY" \\
    -H "Content-Type: application/gzip" \\
    --data-binary "@$TMP_TAR"
  echo ""
  exit 0
fi

# 4b. Standalone / Exported -> push web-report/ directly to PUBLISH_TARGET
TARGET="\${PUBLISH_TARGET:-}"
if [[ -z "$TARGET" ]]; then
  echo "ERROR: Set PUBLISH_TARGET (e.g. gs://my-site/proj, s3://my-site/proj, or ./dist-report)." >&2
  exit 1
fi

case "$TARGET" in
  gs://*)
    gcloud storage rsync -r --delete-unmatched-destination-objects web-report/ "$TARGET/"
    ;;
  s3://*)
    aws s3 sync --delete web-report/ "$TARGET/"
    ;;
  rsync://*|*:*)
    rsync -avz --delete web-report/ "$TARGET/"
    ;;
  *)
    mkdir -p "$TARGET"
    cp -R web-report/. "$TARGET/"
    ;;
esac

echo "OK: Published web-report/ (commit $GIT_SHA) to $TARGET"
`;

export function scaffoldPortableProjectScripts(workspaceDir: string = WORKSPACE_DIR): void {
  const scriptsDir = path.join(workspaceDir, 'scripts');
  ensureDirWithOwnership(scriptsDir);

  const scripts: Array<[string, string]> = [
    ['verify-data.sh', SCRIPT_VERIFY_DATA],
    ['data-pull.sh', SCRIPT_DATA_PULL],
    ['data-push.sh', SCRIPT_DATA_PUSH],
    ['run.sh', SCRIPT_RUN],
    ['publish.sh', SCRIPT_PUBLISH]
  ];

  for (const [name, content] of scripts) {
    const targetPath = path.join(scriptsDir, name);
    if (!fs.existsSync(targetPath)) {
      atomicWriteFileSync(targetPath, content);
      try {
        fs.chmodSync(targetPath, 0o755);
      } catch {}
      applyTargetOwnership(targetPath);
    }
  }

  const bionicYamlPath = path.join(workspaceDir, 'bionic.yaml');
  if (!fs.existsSync(bionicYamlPath)) {
    atomicWriteFileSync(bionicYamlPath, BIONIC_YAML_TEMPLATE);
  }
}
