#!/usr/bin/env bash
set -e

# Bionic Editor Systemd Installer for Linux
# Installs Bionic Editor as a systemd service serving an arbitrary workspace

print_help() {
  cat << 'EOF'
Usage: sudo ./scripts/install-systemd.sh [OPTIONS]

Options:
  -w, --workspace DIR     Arbitrary workspace path to serve (default: /var/lib/bionic-editor/workspace)
  -p, --port PORT         HTTP port to bind (default: 3000)
  -h, --host HOST         Host IP to bind (default: 0.0.0.0)
  -u, --user USERNAME     System user to run the service as (default: current user / root)
  -e, --env-file PATH     Path to save environment configuration (default: /etc/bionic-editor.env)
  --service-name NAME     Systemd service name (default: bionic-editor)
  --no-start              Install and enable service without immediately starting it
  --help                  Show this help message

Examples:
  sudo ./scripts/install-systemd.sh --workspace /srv/bio/experiment_01 --port 8080
  sudo ./scripts/install-systemd.sh -w /data/analysis -u scientist
EOF
}

# Resolve directory of this repo
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Detect user
SERVICE_USER="${SUDO_USER:-$USER}"
[ -z "$SERVICE_USER" ] && SERVICE_USER="root"

# Defaults
WORKSPACE_PATH="/var/lib/bionic-editor/workspace"
SERVICE_PORT="3000"
SERVICE_HOST="0.0.0.0"
ENV_FILE="/etc/bionic-editor.env"
SERVICE_NAME="bionic-editor"
START_SERVICE=true

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    -w|--workspace)
      WORKSPACE_PATH="$2"
      shift 2
      ;;
    -p|--port)
      SERVICE_PORT="$2"
      shift 2
      ;;
    -h|--host)
      SERVICE_HOST="$2"
      shift 2
      ;;
    -u|--user)
      SERVICE_USER="$2"
      shift 2
      ;;
    -e|--env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="$2"
      shift 2
      ;;
    --no-start)
      START_SERVICE=false
      shift
      ;;
    --help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      print_help
      exit 1
      ;;
  esac
done

echo "=========================================================="
echo "🔬 Installing Bionic Editor systemd service"
echo "=========================================================="
echo " Application Directory : ${APP_DIR}"
echo " Workspace Directory   : ${WORKSPACE_PATH}"
echo " Service User          : ${SERVICE_USER}"
echo " Port / Host           : ${SERVICE_PORT} (${SERVICE_HOST})"
echo " Environment File      : ${ENV_FILE}"
echo " Service Name          : ${SERVICE_NAME}.service"
echo "=========================================================="

# Check for root/sudo
if [ "$EUID" -ne 0 ]; then
  echo "⚠️ Please run this script with sudo or as root to configure systemd."
  exit 1
fi

# Detect node executable
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "❌ Node.js executable not found in PATH. Please install Node.js (v18+) first."
  exit 1
fi
echo "✓ Found Node.js at: ${NODE_BIN}"

# Build application assets if needed
echo "🔨 Building frontend and backend assets..."
(
  cd "${APP_DIR}"
  if [ -n "$SUDO_USER" ]; then
    sudo -u "$SUDO_USER" npm run build
  else
    npm run build
  fi
)

# Ensure workspace directory exists
echo "📁 Ensuring arbitrary workspace directory exists: ${WORKSPACE_PATH}"
mkdir -p "${WORKSPACE_PATH}"
if id "${SERVICE_USER}" &>/dev/null; then
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${WORKSPACE_PATH}" 2>/dev/null || true
fi

# Create /etc environment configuration file if not already present
if [ ! -f "${ENV_FILE}" ]; then
  echo "📝 Creating environment configuration file: ${ENV_FILE}"
  mkdir -p "$(dirname "${ENV_FILE}")"
  cat > "${ENV_FILE}" << EOF
# Bionic Editor Environment Configuration
NODE_ENV=production
WORKSPACE_DIR=${WORKSPACE_PATH}
PORT=${SERVICE_PORT}
HOST=${SERVICE_HOST}

# AI Provider API Keys (Fill in as needed)
GEMINI_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434/v1
EOF
  chmod 600 "${ENV_FILE}"
  if id "${SERVICE_USER}" &>/dev/null; then
    chown "${SERVICE_USER}:${SERVICE_USER}" "${ENV_FILE}" 2>/dev/null || true
  fi
else
  echo "ℹ️ Existing environment file found at ${ENV_FILE}, updating WORKSPACE_DIR, PORT, HOST..."
  grep -q "^WORKSPACE_DIR=" "${ENV_FILE}" && sed -i "s|^WORKSPACE_DIR=.*|WORKSPACE_DIR=${WORKSPACE_PATH}|" "${ENV_FILE}" || echo "WORKSPACE_DIR=${WORKSPACE_PATH}" >> "${ENV_FILE}"
  grep -q "^PORT=" "${ENV_FILE}" && sed -i "s|^PORT=.*|PORT=${SERVICE_PORT}|" "${ENV_FILE}" || echo "PORT=${SERVICE_PORT}" >> "${ENV_FILE}"
  grep -q "^HOST=" "${ENV_FILE}" && sed -i "s|^HOST=.*|HOST=${SERVICE_HOST}|" "${ENV_FILE}" || echo "HOST=${SERVICE_HOST}" >> "${ENV_FILE}"
fi

# Install systemd service unit
SYSTEMD_UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
echo "⚙️ Creating systemd service unit at: ${SYSTEMD_UNIT_PATH}"

cat > "${SYSTEMD_UNIT_PATH}" << EOF
[Unit]
Description=Bionic Editor Server
Documentation=https://github.com/your-username/bioniceditor
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${WORKSPACE_PATH}
EnvironmentFile=-${ENV_FILE}
Environment=NODE_ENV=production
Environment=WORKSPACE_DIR=${WORKSPACE_PATH}
Environment=PORT=${SERVICE_PORT}
Environment=HOST=${SERVICE_HOST}
ExecStart=${NODE_BIN} ${APP_DIR}/dist-server/index.js --workspace ${WORKSPACE_PATH} --port ${SERVICE_PORT} --host ${SERVICE_HOST}
Restart=always
RestartSec=5s
LimitNOFILE=65536
KillMode=mixed
TimeoutStopSec=15s

[Install]
WantedBy=multi-user.target
EOF

# Symlink global CLI executable if /usr/local/bin exists
if [ -d "/usr/local/bin" ] && [ -f "${APP_DIR}/bin/bioniceditor.js" ]; then
  ln -sf "${APP_DIR}/bin/bioniceditor.js" "/usr/local/bin/bioniceditor"
  ln -sf "${APP_DIR}/bin/bioniceditor.js" "/usr/local/bin/bionic-editor"
  echo "✓ Created CLI symlinks in /usr/local/bin/bioniceditor and /usr/local/bin/bionic-editor"
fi

# Reload systemd
echo "🔄 Reloading systemd daemon..."
systemctl daemon-reload

# Enable service
echo "🚀 Enabling ${SERVICE_NAME}.service on boot..."
systemctl enable "${SERVICE_NAME}.service"

if [ "$START_SERVICE" = true ]; then
  echo "▶️ Starting ${SERVICE_NAME}.service..."
  systemctl restart "${SERVICE_NAME}.service"
  sleep 1
  systemctl is-active --quiet "${SERVICE_NAME}.service" && echo "✅ Service is active and running!" || echo "⚠️ Service failed to start. Run 'journalctl -u ${SERVICE_NAME} -e' to view logs."
fi

echo ""
echo "=========================================================="
echo "🎉 Installation complete!"
echo " Service Name   : ${SERVICE_NAME}"
echo " Workspace URL  : http://${SERVICE_HOST}:${SERVICE_PORT}"
echo " Web Report     : http://${SERVICE_HOST}:${SERVICE_PORT}/report/"
echo " Config File    : ${ENV_FILE}"
echo ""
echo "Useful Commands:"
echo "  sudo systemctl status ${SERVICE_NAME}     # View service status"
echo "  sudo systemctl restart ${SERVICE_NAME}    # Restart service"
echo "  sudo systemctl stop ${SERVICE_NAME}       # Stop service"
echo "  sudo journalctl -u ${SERVICE_NAME} -f     # Live log output"
echo "=========================================================="
