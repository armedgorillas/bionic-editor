#!/usr/bin/env bash
# Packer Golden Image provisioner for Bionic Editor VMs (Two-Unit Unprivileged Systemd Split)
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq curl git python3 python3-venv python3-pip chrony nftables openssl jq ca-certificates gnupg

# Install Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y -qq nodejs

# Install uv (fast deterministic Python env builder)
curl -LsSf https://astral.sh/uv/install.sh | sudo env UV_INSTALL_DIR=/usr/local/bin sh

# Install pinned OpenCode V2 CLI
sudo npm install -g "opencode-ai@${OPENCODE_VERSION:-latest}" || curl -fsSL https://opencode.ai/install | sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash || true

# Install gcsfuse for read-only shared institutional datasets (/mnt/shared-data)
export GCSFUSE_REPO="gcsfuse-$(lsb_release -c -s)"
echo "deb [signed-by=/usr/share/keyrings/cloud.google.asc] https://packages.cloud.google.com/apt $GCSFUSE_REPO main" | sudo tee /etc/apt/sources.list.d/gcsfuse.list
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo tee /usr/share/keyrings/cloud.google.asc >/dev/null
sudo apt-get update -qq && sudo apt-get install -y -qq gcsfuse

# Install Bionic Editor & Bionic VM Control Daemon artifacts uploaded by Packer
sudo mkdir -p /opt/bioniceditor /opt/bionic-hub /usr/local/libexec
if [[ -f /tmp/bioniceditor.tgz ]]; then
  sudo tar -xzf /tmp/bioniceditor.tgz -C /opt/bioniceditor --strip-components=1
  (cd /opt/bioniceditor && sudo npm install --omit=dev)
  rm -f /tmp/bioniceditor.tgz
fi
if [[ -f /tmp/bionic-hub-daemon.tgz ]]; then
  # bionic-daemon uses Node.js built-ins only (zero external npm dependencies needed)
  sudo tar -xzf /tmp/bionic-hub-daemon.tgz -C /opt/bionic-hub
  rm -f /tmp/bionic-hub-daemon.tgz
fi

# Create two unprivileged OS accounts (Security C2: zero CAP_SETUID, zero chown!)
sudo useradd --system --home-dir /var/lib/bionic-daemon --shell /usr/sbin/nologin bionic-daemon || true
sudo useradd --create-home --shell /bin/bash bionic-user || true
sudo usermod -aG bionic-user bionic-daemon

sudo mkdir -p /var/lib/bionic/workspace /var/lib/bionic/managed-skills /run/bionic-daemon /run/bionic-editor /mnt/shared-data
sudo chown bionic-user:bionic-user /var/lib/bionic/workspace /run/bionic-editor
sudo chown bionic-daemon:bionic-daemon /run/bionic-daemon /var/lib/bionic/managed-skills
sudo chmod 0700 /run/bionic-daemon
sudo chmod 0750 /run/bionic-editor

# Security #6: nftables rule blocking GCE IMDS HTTP (169.254.169.254:80) for everyone except root & bionic-daemon!
DAEMON_UID="$(id -u bionic-daemon)"
cat <<EOF | sudo tee /etc/nftables.conf >/dev/null
#!/usr/sbin/nft -f
flush ruleset
table inet bionic_imds_guard {
  chain output {
    type filter hook output priority 0; policy accept;
    ip daddr 169.254.169.254 tcp dport 80 meta skuid != { 0, ${DAEMON_UID} } counter drop
  }
}
EOF
sudo systemctl enable nftables

# Boot-time root oneshot: mounts workspace PD, reads GCE metadata, mints shared shim & daemon tokens
cat <<'EOF' | sudo tee /usr/local/libexec/bionic-vm-bootstrap >/dev/null
#!/usr/bin/env bash
set -euo pipefail

# 1. Mount persistent workspace disk
WS_DEV="/dev/disk/by-id/google-bionic-workspace"
if [[ -b "$WS_DEV" ]]; then
  if ! blkid "$WS_DEV" >/dev/null 2>&1; then
    mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard "$WS_DEV"
  fi
  mountpoint -q /var/lib/bionic/workspace || mount -o discard,defaults "$WS_DEV" /var/lib/bionic/workspace
  chown bionic-user:bionic-user /var/lib/bionic/workspace
fi

meta() {
  curl -fsSL -H "Metadata-Flavor: Google" "http://169.254.169.254/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true
}

HUB_ORIGIN="$(meta bionic-hub-origin)"
PROJECT_ID="$(meta bionic-project-id)"
SHARED_BUCKET="$(meta bionic-shared-data-bucket)"
REPORTS_ORIGIN=""
if [[ -n "$HUB_ORIGIN" && -n "$PROJECT_ID" ]]; then
  DOMAIN="${HUB_ORIGIN#https://hub.}"
  REPORTS_ORIGIN="https://${PROJECT_ID}.reports.${DOMAIN}"
fi

SHIM_TOKEN="$(openssl rand -hex 32)"
DAEMON_TOKEN="$(openssl rand -hex 32)"

cat > /etc/bionic-daemon.env <<ENVEOF
BIONIC_HUB_ORIGIN=${HUB_ORIGIN}
BIONIC_PROJECT_ID=${PROJECT_ID}
BIONIC_LOCAL_SHIM_TOKEN=${SHIM_TOKEN}
BIONIC_DAEMON_TOKEN=${DAEMON_TOKEN}
WORKSPACE_DIR=/var/lib/bionic/workspace
ENVEOF
chown bionic-daemon:bionic-daemon /etc/bionic-daemon.env
chmod 0600 /etc/bionic-daemon.env

cat > /etc/bionic-editor.env <<ENVEOF
BIONIC_HUB_MODE=true
BIONIC_HUB_URL=${HUB_ORIGIN}
BIONIC_PROJECT_ID=${PROJECT_ID}
BIONIC_REPORTS_ORIGIN=${REPORTS_ORIGIN}
BIONIC_LOCAL_SHIM_TOKEN=${SHIM_TOKEN}
BIONIC_DAEMON_TOKEN=${DAEMON_TOKEN}
BIONIC_SHIM_URL=http://127.0.0.1:3001
ENVEOF
chown bionic-user:bionic-user /etc/bionic-editor.env
chmod 0600 /etc/bionic-editor.env

echo "BIONIC_SHARED_DATA_BUCKET=${SHARED_BUCKET}" > /etc/bionic-shared-data.conf
chmod 0644 /etc/bionic-shared-data.conf
EOF
sudo chmod 0755 /usr/local/libexec/bionic-vm-bootstrap

# Host-namespace gcsfuse mount helper (run via bionic-mount-shared-data.service, never inside ProtectSystem=strict!)
cat <<'EOF' | sudo tee /usr/local/libexec/bionic-remount-shared-data >/dev/null
#!/usr/bin/env bash
set -euo pipefail
source /etc/bionic-shared-data.conf 2>/dev/null || true
if mountpoint -q /mnt/shared-data; then
  ls /mnt/shared-data >/dev/null 2>&1 && exit 0
  fusermount -uz /mnt/shared-data || true
fi
if [[ -n "${BIONIC_SHARED_DATA_BUCKET:-}" ]]; then
  gcsfuse -o ro,allow_other --implicit-dirs "$BIONIC_SHARED_DATA_BUCKET" /mnt/shared-data
fi
EOF
sudo chmod 0755 /usr/local/libexec/bionic-remount-shared-data

# Locked-down fixed-command sudoers for bionic-daemon
cat <<'EOF' | sudo tee /etc/sudoers.d/bionic-daemon >/dev/null
bionic-daemon ALL=(root) NOPASSWD: /usr/bin/chronyc makestep
bionic-daemon ALL=(root) NOPASSWD: /usr/bin/systemctl restart bionic-mount-shared-data.service
EOF
sudo chmod 0440 /etc/sudoers.d/bionic-daemon

cat <<'EOF' | sudo tee /etc/systemd/system/bionic-vm-bootstrap.service >/dev/null
[Unit]
Description=Bionic VM Boot Metadata & Disk Bootstrap
After=network-online.target
Wants=network-online.target
Before=bionic-mount-shared-data.service bionic-daemon.service bioniceditor.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/libexec/bionic-vm-bootstrap

[Install]
WantedBy=multi-user.target
EOF

cat <<'EOF' | sudo tee /etc/systemd/system/bionic-mount-shared-data.service >/dev/null
[Unit]
Description=Mount Shared Institutional Datasets (gcsfuse RO, host mount namespace)
After=bionic-vm-bootstrap.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/libexec/bionic-remount-shared-data

[Install]
WantedBy=multi-user.target
EOF

# Unit 1: bionic-daemon.service (mTLS :3000/:3002 + localhost shim :3001)
cat <<'EOF' | sudo tee /etc/systemd/system/bionic-daemon.service >/dev/null
[Unit]
Description=Bionic VM Control Daemon (mTLS + Localhost Gateway Shim)
After=network-online.target chrony.service bionic-vm-bootstrap.service
Wants=network-online.target

[Service]
Type=simple
User=bionic-daemon
Group=bionic-daemon
RuntimeDirectory=bionic-daemon
RuntimeDirectoryMode=0700
EnvironmentFile=/etc/bionic-daemon.env
ExecStart=/usr/bin/node /opt/bionic-hub/dist/daemon/index.js
Restart=always
RestartSec=3s
NoNewPrivileges=no
ProtectSystem=strict
ReadWritePaths=/run/bionic-daemon /var/lib/bionic/managed-skills

[Install]
WantedBy=multi-user.target
EOF

# Unit 2: bioniceditor.service (unprivileged workspace IDE as bionic-user on Unix socket + 127.0.0.1:3003)
cat <<'EOF' | sudo tee /etc/systemd/system/bioniceditor.service >/dev/null
[Unit]
Description=Bionic Editor Workspace Server (Hub Mode)
After=network-online.target bionic-vm-bootstrap.service bionic-daemon.service

[Service]
Type=simple
User=bionic-user
Group=bionic-user
WorkingDirectory=/var/lib/bionic/workspace
RuntimeDirectory=bionic-editor
RuntimeDirectoryMode=0750
Environment=BIONIC_HUB_MODE=true
Environment=BASE_SPEC=PLAN.md
Environment=HOST=127.0.0.1
Environment=PORT=3003
Environment=BIONIC_UNIX_SOCKET=/run/bionic-editor/app.sock
Environment=WORKSPACE_DIR=/var/lib/bionic/workspace
EnvironmentFile=/etc/bionic-editor.env
ExecStart=/usr/bin/node /opt/bioniceditor/dist-server/index.js
Restart=always
RestartSec=3s
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable bionic-vm-bootstrap.service bionic-mount-shared-data.service bionic-daemon.service bioniceditor.service
echo "OK: Packer image provisioned."
