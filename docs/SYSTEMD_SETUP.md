# 🚀 Linux Server & Systemd Service Deployment Guide

This guide describes how to install and run **Bionic Editor** in an arbitrary directory on a Linux server and manage it as a systemd service (`systemctl`) serving any arbitrary workspace directory.

---

## 📋 Overview

- **Arbitrary Installation Location**: The application can reside anywhere on the server filesystem (e.g., `/opt/bioniceditor`, `/srv/bioniceditor`, `/usr/local/lib/bioniceditor`, or a user home directory).
- **Arbitrary Workspace Serving**: The server is not restricted to `workspace/`. You can serve any folder on disk via:
  - Command-line flag: `bioniceditor --workspace /path/to/any/project`
  - Positional argument: `bioniceditor /path/to/any/project`
  - Environment variable: `WORKSPACE_DIR=/path/to/any/project`
  - Systemd environment configuration: `/etc/bionic-editor.env`
- **Systemd Integration**: Full service unit definitions for single-workspace (`bionic-editor.service`) or multi-project template instances (`bionic-editor@<project>.service`).
- **No Turn Limits**: Chatbot turn restrictions have been lifted, enabling autonomous, multi-step analytical pipelines without arbitrary cutoff points.

---

## 🛠️ Prerequisites

- **Node.js**: v18+ (tested on Node v20/v24)
- **Python**: 3.10+ (for Python analyses and workspace `.venv`)
- **systemd**: Standard on modern Linux distributions (Ubuntu, Debian, RHEL, CentOS, Rocky Linux, Fedora, Arch)

---

## ⚡ Method 1: Automated Systemd Installation (Recommended)

1. Clone or copy the repository to your chosen server location (for example, `/opt/bioniceditor`):
   ```bash
   sudo git clone https://github.com/armedgorillas/bioniceditor.git /opt/bioniceditor
   cd /opt/bioniceditor
   sudo npm install
   sudo npm --prefix client install
   ```

2. Run the automated systemd installer script:
   ```bash
   sudo ./scripts/install-systemd.sh --workspace /srv/bio/experiment_01 --port 3000
   ```

   **Installer Options:**
   | Flag | Description | Default |
   |------|-------------|---------|
   | `-w, --workspace <dir>` | Arbitrary workspace path to serve | `/var/lib/bionic-editor/workspace` |
   | `-p, --port <number>` | Port number to bind | `3000` |
   | `-h, --host <ip>` | Host IP to bind | `0.0.0.0` |
   | `-u, --user <username>` | Service user | Current sudo user or `root` |
   | `-e, --env-file <path>` | Path to configuration file | `/etc/bionic-editor.env` |
   | `--service-name <name>`| Systemd service name | `bionic-editor` |
   | `--no-start` | Install & enable without starting | `false` |

3. The script will:
   - Build client and server bundles (`npm run build`)
   - Create the arbitrary workspace directory
   - Write `/etc/bionic-editor.env`
   - Install `/etc/systemd/system/bionic-editor.service`
   - Symlink `/usr/local/bin/bioniceditor` and `/usr/local/bin/bionic-editor`
   - Reload systemd and start the service

---

## 🔧 Method 2: Manual Systemd Installation

### 1. Build Production Assets
In your application directory:
```bash
npm run build
```

### 2. Configure Environment (`/etc/bionic-editor.env`)
Create `/etc/bionic-editor.env` with your desired workspace path and credentials:
```bash
sudo tee /etc/bionic-editor.env << 'EOF'
NODE_ENV=production
WORKSPACE_DIR=/data/experiments/study_alpha
PORT=3000
HOST=0.0.0.0

# LLM API Keys
GEMINI_API_KEY=your_gemini_key_here
OPENAI_API_KEY=your_openai_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
OLLAMA_BASE_URL=http://localhost:11434/v1
EOF

sudo chmod 600 /etc/bionic-editor.env
```

### 3. Create Systemd Service File
Copy `bionic-editor.service` to `/etc/systemd/system/bionic-editor.service` and adjust paths:
```ini
[Unit]
Description=Bionic Editor Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/data/experiments/study_alpha
EnvironmentFile=-/etc/bionic-editor.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/bioniceditor/dist-server/index.js --workspace /data/experiments/study_alpha --port 3000 --host 0.0.0.0
Restart=always
RestartSec=5s
LimitNOFILE=65536
KillMode=mixed
TimeoutStopSec=15s

[Install]
WantedBy=multi-user.target
```

### 4. Enable and Start
```bash
sudo systemctl daemon-reload
sudo systemctl enable bionic-editor
sudo systemctl start bionic-editor
```

---

## 🗂️ Running Multiple Workspaces (Instance Template)

If you need to serve multiple distinct research workspaces on the same server, use the systemd instance template `bionic-editor@.service`:

1. Copy the template:
   ```bash
   sudo cp bionic-editor@.service /etc/systemd/system/bionic-editor@.service
   sudo systemctl daemon-reload
   ```

2. Configure instances:
   - Create instance configuration e.g. `/etc/bionic-editor/exp1.env`:
     ```env
     PORT=3001
     WORKSPACE_DIR=/srv/workspaces/exp1
     ```
   - Create instance configuration e.g. `/etc/bionic-editor/exp2.env`:
     ```env
     PORT=3002
     WORKSPACE_DIR=/srv/workspaces/exp2
     ```

3. Manage each instance independently:
   ```bash
   sudo systemctl start bionic-editor@exp1
   sudo systemctl start bionic-editor@exp2
   ```

---

## 🖥️ Using the CLI Directly

You can also run Bionic Editor from the terminal in any arbitrary directory:

```bash
# Serve current working directory
bioniceditor

# Serve arbitrary directory by path
bioniceditor /home/researcher/my_analysis

# Serve arbitrary directory with flags
bioniceditor --workspace /data/experiment_42 --port 8080 --host 0.0.0.0
```

---

## 🔍 Service Management Commands

```bash
# Check service status
sudo systemctl status bionic-editor

# Restart service
sudo systemctl restart bionic-editor

# Stop service
sudo systemctl stop bionic-editor

# View live stream of server logs
sudo journalctl -u bionic-editor -f

# View last 100 log lines
sudo journalctl -u bionic-editor -n 100 --no-pager
```
