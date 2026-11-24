#!/usr/bin/env bash
# Portable report publishing script — zero hidden magic!
# Inside Bionic Hub: commits snapshot & streams web-report/ to $BIONIC_HUB_PUBLISH_URL
#   (where Hub independently re-verifies grants, leaks, and private/public bucket isolation).
# Standalone / Exported: deploys web-report/ directly to $PUBLISH_TARGET
#   (gs://bucket/prefix, s3://bucket/prefix, rsync://host/path, or a local directory).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VISIBILITY="${PUBLISH_VISIBILITY:-private}"
TITLE="${PUBLISH_TITLE:-Published Report}"
SUMMARY="${PUBLISH_SUMMARY:-}"
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

# 3. Capture Git commit snapshot (when in a git repo)
GIT_SHA="uncommitted"
if [[ "$NO_GIT" -eq 0 ]] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [[ "$DRY_RUN" -eq 0 ]]; then
    git add -A
    if ! git diff --cached --quiet; then
      git commit -m "publish: $TITLE"
    fi
    if git remote get-url origin >/dev/null 2>&1; then
      git push origin HEAD
    fi
  fi
  GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo uncommitted)"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN OK: verified web-report/ (commit $GIT_SHA, visibility=$VISIBILITY)."
  exit 0
fi

# 4a. Inside Bionic Hub -> stream archive (+ _bionic_meta/ manifest, bionic.yaml, test results) to Hub intake
if [[ -n "${BIONIC_HUB_PUBLISH_URL:-}" ]]; then
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
  SAFE_TITLE="$(printf '%s' "$TITLE" | tr -d '
')"
  SAFE_SUMMARY="$(printf '%s' "$SUMMARY" | tr -d '
')"
  curl -fsSL -X POST "$BIONIC_HUB_PUBLISH_URL" \
    -H "X-Bionic-Shim-Token: ${BIONIC_LOCAL_SHIM_TOKEN:-}" \
    -H "X-Bionic-Git-Commit: $GIT_SHA" \
    -H "X-Bionic-Visibility: $VISIBILITY" \
    -H "X-Bionic-Title: $SAFE_TITLE" \
    -H "X-Bionic-Summary: $SAFE_SUMMARY" \
    -H "Content-Type: application/gzip" \
    --data-binary "@$TMP_TAR"
  echo ""
  exit 0
fi

# 4b. Standalone / Exported -> push web-report/ directly to PUBLISH_TARGET
TARGET="${PUBLISH_TARGET:-}"
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
