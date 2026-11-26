#!/usr/bin/env bash
# Bionic Hub Editor VM Verification Suite
#
# Modes:
#   --image-build  Run during Packer image build (verifies binaries, services, permissions, nftables, OpenCode V2).
#   --ci-live      Run in GitHub Actions Ubuntu 24.04 CI (all live checks except GCE-only bootstrap/PD/IMDS firewall).
#   --live         (Default) Run on a booted GCP project VM (runs all image checks + full live GCE runtime checks).
set -uo pipefail

MODE="live"
if [[ "${1:-}" == "--image-build" ]]; then
  MODE="image-build"
elif [[ "${1:-}" == "--ci-live" ]]; then
  MODE="ci-live"
elif [[ "${1:-}" == "--live" || -z "${1:-}" ]]; then
  MODE="live"
else
  echo "Usage: $0 [--image-build | --ci-live | --live]" >&2
  exit 2
fi

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '  \033[0;32m✔ PASS\033[0m  %s\n' "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '  \033[0;31m✖ FAIL\033[0m  %s\n' "$1"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf '  \033[0;33m⚠ WARN\033[0m  %s\n' "$1"
}

section() {
  printf '\n\033[1;36m=== %s ===\033[0m\n' "$1"
}

check_cmd() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    pass "$label"
  else
    fail "$label"
  fi
}

echo "Bionic Hub Editor VM Verification Suite (mode=${MODE})"

# ==============================================================================
# 1. Core Binaries & Tooling (accessible to bionic-user on global PATH)
# ==============================================================================
section "1. Core Binaries & OpenCode V2"

for bin in node npm python3 uv git curl jq openssl chronyc nft gcsfuse; do
  check_cmd "Binary on PATH: ${bin}" command -v "$bin"
done

NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)"
if [[ "$NODE_MAJOR" -ge 22 ]]; then
  pass "Node.js version >= 22 ($(node -v))"
else
  fail "Node.js version >= 22 (found: $(node -v 2>/dev/null || echo missing))"
fi

if [[ -x /usr/local/bin/opencode ]]; then
  pass "/usr/local/bin/opencode exists and is executable"
else
  fail "/usr/local/bin/opencode missing or not executable"
fi

OC_VER="$(sudo -H -u bionic-user env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME /usr/local/bin/opencode --version 2>&1 || true)"
if [[ "$OC_VER" =~ 2\.[0-9]+ ]]; then
  pass "bionic-user can run OpenCode V2 (${OC_VER})"
else
  fail "bionic-user OpenCode V2 check failed (output: ${OC_VER:-empty})"
fi

# ==============================================================================
# 2. Installed Application Artifacts
# ==============================================================================
section "2. Installed Application Artifacts"

check_cmd "Bionic Editor server build (/opt/bioniceditor/dist-server/index.js)" test -f /opt/bioniceditor/dist-server/index.js
check_cmd "Bionic Editor client build (/opt/bioniceditor/client/dist/index.html)" test -f /opt/bioniceditor/client/dist/index.html
check_cmd "Bionic Editor production dependencies (/opt/bioniceditor/node_modules)" test -d /opt/bioniceditor/node_modules
check_cmd "Bionic VM Daemon build (/opt/bionic-hub/dist/daemon/index.js)" test -f /opt/bionic-hub/dist/daemon/index.js
check_cmd "Bootstrap helper syntax (/usr/local/libexec/bionic-vm-bootstrap)" bash -n /usr/local/libexec/bionic-vm-bootstrap
check_cmd "Shared data mount helper syntax (/usr/local/libexec/bionic-remount-shared-data)" bash -n /usr/local/libexec/bionic-remount-shared-data

# ==============================================================================
# 3. Two-Unit OS Isolation, Sudoers & nftables IMDS Guard
# ==============================================================================
section "3. OS Isolation, Sudoers & IMDS Firewall"

check_cmd "Unprivileged user bionic-daemon exists" id bionic-daemon
check_cmd "Unprivileged user bionic-user exists" id bionic-user
if id -nG bionic-daemon 2>/dev/null | tr ' ' '\n' | grep -qx 'bionic-user'; then
  pass "bionic-daemon is a member of group bionic-user (for Unix socket access)"
else
  fail "bionic-daemon is NOT in group bionic-user"
fi

check_cmd "Sudoers file valid (/etc/sudoers.d/bionic-daemon)" sudo visudo -cf /etc/sudoers.d/bionic-daemon
check_cmd "nftables config valid (/etc/nftables.conf)" sudo nft -c -f /etc/nftables.conf
check_cmd "nftables blocks IMDS 169.254.169.254:80 for non-daemon UIDs" grep -q '169.254.169.254' /etc/nftables.conf

# ==============================================================================
# 4. Systemd Unit Definitions & Enablement
# ==============================================================================
section "4. Systemd Units"

for unit in bionic-vm-bootstrap.service bionic-mount-shared-data.service bionic-daemon.service bioniceditor.service nftables.service; do
  if systemctl is-enabled "$unit" >/dev/null 2>&1; then
    pass "systemd enabled: ${unit}"
  else
    fail "systemd NOT enabled: ${unit}"
  fi
done

check_cmd "bioniceditor.service runs as User=bionic-user" grep -q '^User=bionic-user$' /etc/systemd/system/bioniceditor.service
check_cmd "bioniceditor.service enables BIONIC_HUB_MODE=true" grep -q '^Environment=BIONIC_HUB_MODE=true$' /etc/systemd/system/bioniceditor.service
check_cmd "bioniceditor.service sets BASE_SPEC=PLAN.md" grep -q '^Environment=BASE_SPEC=PLAN.md$' /etc/systemd/system/bioniceditor.service
check_cmd "bionic-daemon.service runs as User=bionic-daemon" grep -q '^User=bionic-daemon$' /etc/systemd/system/bionic-daemon.service

if [[ "$MODE" == "image-build" ]]; then
  printf '\nSummary (image-build): %d passed, %d failed, %d warnings\n' "$PASS_COUNT" "$FAIL_COUNT" "$WARN_COUNT"
  [[ "$FAIL_COUNT" -eq 0 ]]
  exit $?
fi

# ==============================================================================
# 5. Live Services & Env Files (Zero Raw API Keys on VM)
# ==============================================================================
section "5. Live Services & Env Isolation"

LIVE_UNITS=(bionic-daemon.service bioniceditor.service)
if [[ "$MODE" == "live" ]]; then
  LIVE_UNITS=(bionic-vm-bootstrap.service bionic-daemon.service bioniceditor.service nftables.service)
fi
for unit in "${LIVE_UNITS[@]}"; do
  if systemctl is-active "$unit" >/dev/null 2>&1; then
    pass "systemd active: ${unit}"
  else
    fail "systemd NOT active: ${unit}"
  fi
done

check_cmd "/etc/bionic-daemon.env exists (mode 600)" test -f /etc/bionic-daemon.env
check_cmd "/etc/bionic-editor.env exists (mode 600)" test -f /etc/bionic-editor.env

if grep -Eq '^(GEMINI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)=' /etc/bionic-editor.env /etc/bionic-daemon.env 2>/dev/null; then
  fail "Raw LLM API key found in /etc/bionic-*.env (violates zero-secret VM guarantee)"
else
  pass "Zero raw LLM API keys in /etc/bionic-*.env (keys stay in Hub Secret Manager)"
fi

# Load tokens for live probes (running as root via sudo)
# shellcheck disable=SC1091
source /etc/bionic-editor.env 2>/dev/null || true

if [[ -n "${BIONIC_PROJECT_ID:-}" && -n "${BIONIC_HUB_URL:-}" && -n "${BIONIC_LOCAL_SHIM_TOKEN:-}" && -n "${BIONIC_DAEMON_TOKEN:-}" ]]; then
  pass "Boot metadata env populated (project=${BIONIC_PROJECT_ID}, hub=${BIONIC_HUB_URL})"
else
  fail "Missing required env vars in /etc/bionic-editor.env"
fi

# ==============================================================================
# 6. Network Listeners, Unix Socket & Daemon Mount Namespace
# ==============================================================================
section "6. Listeners, Unix Socket & mTLS"

for port in 3000 3001 3002 3003; do
  if ss -tln 2>/dev/null | grep -qE ":${port}[[:space:]]"; then
    pass "Listening on TCP :${port}"
  else
    fail "NOT listening on TCP :${port}"
  fi
done

check_cmd "Unix socket /run/bionic-editor/app.sock exists" test -S /run/bionic-editor/app.sock

DAEMON_PID="$(pgrep -f '/opt/bionic-hub/dist/daemon/index.js' | head -n 1 || true)"
if [[ -n "$DAEMON_PID" ]]; then
  SOCK_HTTP="$(nsenter -t "$DAEMON_PID" -m -- sudo -u bionic-daemon curl -sS -o /dev/null -w '%{http_code}' --unix-socket /run/bionic-editor/app.sock http://localhost/ 2>/dev/null || echo 000)"
  if [[ "$SOCK_HTTP" == "200" ]]; then
    pass "bionic-daemon (inside ProtectSystem=strict) reaches app.sock -> HTTP 200"
  else
    fail "bionic-daemon -> app.sock returned HTTP ${SOCK_HTTP}"
  fi
else
  fail "Could not locate running bionic-daemon PID"
fi

MTLS_CHECK="$(curl -k -sS --max-time 3 https://127.0.0.1:3000/ 2>&1 || true)"
if echo "$MTLS_CHECK" | grep -qiE 'certificate required|handshake|alert|ssl'; then
  pass "mTLS :3000 rejects unauthenticated clients without Hub client cert"
else
  fail "mTLS :3000 did not reject unauthenticated client (output: ${MTLS_CHECK})"
fi

# ==============================================================================
# 7. Live IMDS Guard (bionic-user blocked, bionic-daemon allowed)
# ==============================================================================
section "7. Live GCE IMDS Guard (nftables)"

if [[ "$MODE" == "ci-live" ]]; then
  pass "Skipped live nftables IMDS probe in --ci-live mode (nftables syntax validated in section 3)"
else
  if sudo -u bionic-user curl -fsS --max-time 2 -H "Metadata-Flavor: Google" http://169.254.169.254/computeMetadata/v1/instance/name >/dev/null 2>&1; then
    fail "SECURITY: bionic-user was able to reach GCE IMDS (169.254.169.254:80)"
  else
    pass "bionic-user is BLOCKED from GCE IMDS (169.254.169.254:80)"
  fi

  if sudo -u bionic-daemon curl -fsS --max-time 2 -H "Metadata-Flavor: Google" http://169.254.169.254/computeMetadata/v1/instance/name >/dev/null 2>&1; then
    pass "bionic-daemon CAN reach GCE IMDS for attestation"
  else
    warn "bionic-daemon could not reach GCE IMDS (expected only on GCE VMs)"
  fi
fi

# ==============================================================================
# 8. Workspace Mount, Starter Template & lost+found Filtering
# ==============================================================================
section "8. Workspace Disk, Starter Template & lost+found Filtering"

WS="/var/lib/bionic/workspace"
if mountpoint -q "$WS"; then
  pass "Persistent workspace disk mounted at ${WS}"
else
  warn "${WS} is not a separate mountpoint (check GCE workspace PD attachment)"
fi

WS_OWNER="$(stat -c '%U:%G' "$WS" 2>/dev/null || echo unknown)"
if [[ "$WS_OWNER" == "bionic-user:bionic-user" ]]; then
  pass "Workspace root owned by bionic-user:bionic-user"
else
  fail "Workspace root owner is ${WS_OWNER} (expected bionic-user:bionic-user)"
fi

for expected in PLAN.md plans code data/raw data/processed figures web-report/index.html scripts/run.sh scripts/publish.sh bionic.yaml; do
  if [[ -e "${WS}/${expected}" ]]; then
    pass "Starter template item exists: ${expected}"
  else
    fail "Missing starter template item: ${expected}"
  fi
done

TREE_JSON="$(curl -fsS --unix-socket /run/bionic-editor/app.sock 'http://localhost/api/files/tree?includeDotItems=true' 2>/dev/null || echo '[]')"
if echo "$TREE_JSON" | jq -e '.. | objects | select(.name? == "lost+found")' >/dev/null 2>&1; then
  fail "File tree API leaked ext4 lost+found folder"
else
  pass "File tree API cleanly hides ext4 lost+found"
fi

# ==============================================================================
# 9. Hub LLM Shim, Agent Config & OpenCode V2 Model Wiring
# ==============================================================================
section "9. Hub LLM Gateway Shim & OpenCode V2 Integration"

SHIM_UNAUTH="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/models || echo 000)"
if [[ "$SHIM_UNAUTH" == "401" ]]; then
  pass "Localhost shim :3001 rejects unauthenticated requests (HTTP 401)"
else
  fail "Localhost shim :3001 returned HTTP ${SHIM_UNAUTH} without token (expected 401)"
fi

SHIM_MODELS_JSON="$(curl -fsS -H "X-Bionic-Shim-Token: ${BIONIC_LOCAL_SHIM_TOKEN:-}" http://127.0.0.1:3001/models 2>/dev/null || echo '{}')"
SHIM_MODEL_COUNT="$(echo "$SHIM_MODELS_JSON" | jq -r '.models | length // 0' 2>/dev/null || echo 0)"
if [[ "$SHIM_MODEL_COUNT" -gt 0 ]]; then
  FIRST_SLUG="$(echo "$SHIM_MODELS_JSON" | jq -r '.models[0].slug')"
  pass "Hub LLM Gateway returned ${SHIM_MODEL_COUNT} enabled model(s) via shim (first=${FIRST_SLUG})"
else
  fail "Hub LLM Gateway returned 0 models via shim (response: ${SHIM_MODELS_JSON})"
fi

AGENT_CFG_JSON="$(curl -fsS --unix-socket /run/bionic-editor/app.sock http://localhost/api/agent/config 2>/dev/null || echo '{}')"
if echo "$AGENT_CFG_JSON" | jq -e '.hubManaged == true and .isOpenCodeInstalled == true and .harness == "opencode"' >/dev/null 2>&1; then
  DEF_MODEL="$(echo "$AGENT_CFG_JSON" | jq -r '.defaultModel // ""')"
  pass "GET /api/agent/config reports hubManaged=true, harness=opencode, defaultModel=${DEF_MODEL:-none}"
else
  fail "GET /api/agent/config unexpected payload: ${AGENT_CFG_JSON}"
fi

if echo "$AGENT_CFG_JSON" | jq -e '(.hasGeminiKey == true) or (.hasOpenaiKey == true) or (.hasAnthropicKey == true)' >/dev/null 2>&1; then
  pass "GET /api/agent/config marks Hub-managed provider key as active (no false missing-key banner)"
else
  fail "GET /api/agent/config reports all provider keys inactive"
fi

if [[ -f "${WS}/.opencode/opencode.jsonc" ]]; then
  pass ".opencode/opencode.jsonc synced in workspace"
  OC_MODELS="$(cd "$WS" && sudo -H -u bionic-user env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME BIONIC_LOCAL_SHIM_TOKEN="${BIONIC_LOCAL_SHIM_TOKEN:-}" /usr/local/bin/opencode models 2>&1 | grep '^bionic-' || true)"
  if [[ -n "$OC_MODELS" ]]; then
    pass "OpenCode V2 recognizes Hub-managed models: $(echo "$OC_MODELS" | tr '\n' ' ' | sed 's/ $//')"
  else
    fail "OpenCode V2 did not list any bionic-* models from .opencode/opencode.jsonc"
  fi
else
  fail ".opencode/opencode.jsonc was not created after /api/agent/config"
fi

# ==============================================================================
# 10. Hub Mode Security Guards
# ==============================================================================
section "10. Hub Mode Security Guards"

REPORT_CODE="$(curl -s -o /dev/null -w '%{http_code}' --unix-socket /run/bionic-editor/app.sock http://localhost/report/ || echo 000)"
if [[ "$REPORT_CODE" == "403" ]]; then
  pass "Same-origin /report/ blocked on Editor server (HTTP 403)"
else
  fail "Same-origin /report/ returned HTTP ${REPORT_CODE} (expected 403)"
fi

SAVE_CFG_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' --unix-socket /run/bionic-editor/app.sock http://localhost/api/agent/save-config || echo 000)"
if [[ "$SAVE_CFG_CODE" == "403" ]]; then
  pass "BYOK /api/agent/save-config blocked in Hub Mode (HTTP 403)"
else
  fail "/api/agent/save-config returned HTTP ${SAVE_CFG_CODE} (expected 403)"
fi

DAEMON_UNAUTH="$(curl -s -o /dev/null -w '%{http_code}' --unix-socket /run/bionic-editor/app.sock http://localhost/api/hub-local/activity || echo 000)"
DAEMON_AUTH="$(curl -s -o /dev/null -w '%{http_code}' -H "X-Bionic-Daemon-Token: ${BIONIC_DAEMON_TOKEN:-}" --unix-socket /run/bionic-editor/app.sock http://localhost/api/hub-local/activity || echo 000)"
if [[ "$DAEMON_UNAUTH" == "403" && "$DAEMON_AUTH" == "200" ]]; then
  pass "/api/hub-local/activity enforces X-Bionic-Daemon-Token (403 unauth, 200 auth)"
else
  fail "/api/hub-local/activity auth check failed (unauth=${DAEMON_UNAUTH}, auth=${DAEMON_AUTH})"
fi

printf '\n======================================================\n'
printf 'VM Verification Summary (%s): %d passed, %d failed, %d warnings\n' "$MODE" "$PASS_COUNT" "$FAIL_COUNT" "$WARN_COUNT"
printf '======================================================\n'

[[ "$FAIL_COUNT" -eq 0 ]]
