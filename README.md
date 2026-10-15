# 🔬 Bionic Editor

**A Scientific Document & Analysis IDE for Analytical Scientists**

Bionic Editor is an IDE designed for biologists, researchers, and analytical thinkers who need the power of an AI coding agent harness without the clutter of traditional software development tools. It bridges the gap between natural scientific note-taking and reproducible computational pipelines.

---

## 🌟 Key Features

- ** WYSIWYG Markdown Editor**:
  - Clean, distraction-free document editing with proportional typography.
  - Headings, lists, bold/italics, quotes, code snippets, and links.
  - Native inline rendering for local experiment figures (e.g. `figures/volcano_plot.png` or `data/` assets).
  - Lossless bidirectional synchronization with raw Markdown so AI agents and git diffs remain pristine.

- **AI Scientific Agent Harness**:
  - Operates as a collaborative coding harness confined safely to your project workspace.
  - Supports **Google Gemini** (Gemini 2.5 Flash / Pro), **OpenAI** (GPT-4o), **Anthropic** (Claude 3.5 Sonnet), **Local Ollama**, or an **Offline Scientific Demo Assistant**.
  - **Unconstrained Turns**: No arbitrary turn limits (the previous 25-turn cap has been removed), allowing long-running, iterative scientific exploration.
  - Non-terminal conversational UI: displays natural step cards (*"Reading expression data"*, *"Executing analysis script"*, *"Updated SPEC.md"*) rather than raw CLI terminal dumps.
  - Live token tracker and running cost estimator (opencode-style).

- **Arbitrary Workspace Serving & Linux Systemd Deployment**:
  - Run from any location on a Linux server and serve any arbitrary workspace directory.
  - Can be started via CLI (`bioniceditor /path/to/workspace`) or run as a production systemd service (`systemctl start bionic-editor`).
  - Automated installer script: `./scripts/install-systemd.sh`.

- **Default Scientific Workspace Structure**:
  - Automatically initializes a Cookiecutter Data Science layout:
    ```text
    workspace/
    ├── SPEC.md               # Core scientific plan and agent instructions
    ├── data/
    │   ├── raw/              # Raw data (CSV, TSV, FASTQ, etc.)
    │   └── processed/        # Cleaned datasets and DEG tables
    ├── src/
    │   └── analyze.py        # Reproducible Python scripts
    ├── figures/              # Plots and visual figures
    ├── web-report/
    │   └── index.html        # Interactive HTML reports & visualizations
    ├── requirements.txt      # Declarative package dependencies
    └── .venv/                # Isolated workspace virtual environment
    ```

- **Live Web-Report Server**:
  - Built-in preview tab that renders interactive HTML dashboards (`web-report/index.html`) in real time.
  - Live reload when the agent or user updates report files.

- **Declarative Python Virtual Environment (`.venv`)**:
  - One-click `.venv` initialization and `requirements.txt` installation directly from the UI.
  - All agent executions and Python scripts run inside the project's isolated environment.

- **"Coding Mode" Toggle**:
  - By default, advanced developer interfaces are hidden so non-coders are not overwhelmed.
  - Toggling **Coding Mode** unhides an interactive `.venv` terminal session, raw Monaco code editor views, and technical consoles.

- **Single-Port Architecture**:
  - Multiplexes the frontend UI (`/`), WebSocket streams (`/ws`), REST API (`/api/*`), and live web reports (`/report/`) through a **single exposed port**, making it seamless to host behind any reverse proxy.

---

## 🚀 Quick Start & Installation

### Prerequisites
- **Node.js**: v18+ (tested on Node v20, v22, v24)
- **Python**: 3.10+ (for data analysis and `.venv`)

### Option A: Install Globally via NPM (Easiest)

Download the latest `.tgz` release package from GitHub Releases and install globally:

```bash
# Install globally from a GitHub Release tarball
npm install -g https://github.com/armedgorillas/bionic-editor/releases/latest/download/bioniceditor-latest.tgz

# Or install from local tarball
npm install -g ./bioniceditor-0.1.0-beta.1.tgz

# Run anywhere!
bioniceditor /path/to/my-workspace --port 3000
```

### Option B: Standalone Release Bundle (For Linux Servers & Systemd)

Download the standalone archive from GitHub Releases. Pre-built frontend and backend distributions are included:

```bash
# Download and extract standalone bundle
tar -xzf bioniceditor-0.1.0-beta.1-standalone.tar.gz
cd bioniceditor-0.1.0-beta.1

# Install production dependencies only (no dev/build tooling required)
npm install --omit=dev

# Install and start as a Linux systemd background service
sudo ./scripts/install-systemd.sh --workspace /srv/bio/experiment_01 --port 3000

# Or start directly
npm start
```

### Option C: Build from Source (Developers)

1. Clone repository:
   ```bash
   git clone https://github.com/armedgorillas/bionic-editor.git
   cd bionic-editor
   ```

2. Install dependencies:
   ```bash
   npm install
   npm --prefix client install
   ```

3. Build the frontend and backend:
   ```bash
   npm run build
   ```

4. Run tests:
   ```bash
   npm test
   ```

5. Start the application:
   ```bash
   npm start
   ```

6. Open your browser at **`http://localhost:3000`**.

---

## ⚙️ Configuration & API Keys

You can configure your LLM providers either through environment variables or directly inside the app:

### 1. In-App Settings Modal (Easiest)
Click the **⚙ (Gear)** icon in the AI Agent panel on the right:
- Paste your **Google Gemini API Key** (`AIzaSy...`)
- Paste your **OpenAI** or **Anthropic** key
- Or enter your local **Ollama** endpoint (`http://localhost:11434/v1`)
- Keys are saved locally in your browser session.

### 2. Environment Variables (`.env` or `/etc/bionic-editor.env`)
Create a `.env` file in the root directory (or `/etc/bionic-editor.env` for systemd):
```env
PORT=3000
HOST=0.0.0.0
# Point to any arbitrary workspace folder on the server
WORKSPACE_DIR=/path/to/any/workspace

# AI Providers
GEMINI_API_KEY=your_gemini_api_key
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
OLLAMA_BASE_URL=http://localhost:11434/v1
```

---

## 🐧 Linux Server & Systemd Service Deployment

To install Bionic Editor as a systemd service running in an arbitrary directory on a Linux server and serving an arbitrary workspace:

```bash
# Automated installer (builds assets, sets up systemd service, and starts it)
sudo ./scripts/install-systemd.sh --workspace /srv/bio/experiment_01 --port 3000

# Manage with systemctl
sudo systemctl status bionic-editor
sudo systemctl restart bionic-editor
sudo systemctl stop bionic-editor
sudo journalctl -u bionic-editor -f
```

See [docs/SYSTEMD_SETUP.md](docs/SYSTEMD_SETUP.md) for full instructions, multi-instance setups (`bionic-editor@.service`), and custom configurations.

---

## 🧪 Development & Testing

### Run Development Servers
- Backend: `npm run dev`
- Frontend: `npm run dev:client` (proxies to backend port 3000)

### Run Automated Tests
Run the comprehensive end-to-end integration test suite:
```bash
npm test
```

The test suite validates:
- Single-port server startup and client asset delivery
- Live `web-report` static serving
- Workspace template scaffolding and file explorer tree operations
- Raw file streaming for inline WYSIWYG images
- AI agent chat streaming and tool execution
- Google Gemini and multi-provider availability

---

## 📄 License
MIT License.
