# 📘 Bionic Editor - User Guide & Scientific Documentation

Bionic Editor is an IDE for analytical biologists and non-coder scientists. It provides an intuitive Bear-style document editor alongside an AI coding harness confined to an isolated Python virtual environment.

---

## 1. Core Architecture

### File Explorer & Cookiecutter Data Science Layout
Every analysis project in Bionic Editor is structured around reproducible data science standards:

- **`SPEC.md`**: The central living document where you define scientific hypotheses, variables, controls, and pipeline steps.
- **`data/raw/`**: Where original, read-only datasets live (CSV, TSV, FASTQ, etc.).
- **`data/processed/`**: Cleaned, standardized results produced by computational scripts.
- **`src/`**: Python analysis scripts that execute inside the workspace's `.venv`.
- **`figures/`**: Generated volcano plots, heatmaps, PCA projections, and charts.
- **`web-report/`**: Live interactive HTML dashboard viewable directly inside the editor.
- **`requirements.txt`**: Declarative dependency specification.
- **`.venv/`**: Isolated Python virtual environment automatically managed by the IDE.

---

## 2. Document Editing (Bear-Style WYSIWYG)

- **Proportional Typography**: Clean, uncluttered reading canvas with proportional fonts, natural headings, and lists.
- **Inline Local Figures**: Reference any image locally (e.g. `![DEG Volcano Plot](figures/volcano_plot.png)`). The editor automatically resolves and renders the image inline.
- **Lossless Markdown Sync**: All edits are bidirectionally synced with pure Markdown on disk, so AI agents and git diffs remain pristine.

---

## 3. Working with the AI Scientific Agent

The AI Agent acts as your computational research assistant. It has access to:
- `read_file`: Inspecting datasets and scripts.
- `write_file`: Writing Python scripts and updating `SPEC.md`.
- `run_command` & `run_python`: Executing scripts inside the project `.venv`.
- `list_files`: Scanning workspace contents.

### Transparent Coding Harness:
1. **Agent Plan & Logic**: Explains the rationale before executing tools.
2. **Action Cards**: Displays real command traces (`$ python src/analyze.py`, `read data/raw/sample.csv`).
3. **Unabridged Tracebacks**: When an error occurs, full Python stack traces are displayed with an embedded copy button.
4. **Stopping Work**: Click the red **Stop (■)** button in the chat box to immediately halt execution and terminate active processes.
5. **Session History**: Click the **History** icon in the agent header to save, switch between, and export analysis sessions to `REPORT.md`.

---

## 4. Coding Mode

By default, complex developer tools are hidden to avoid confusing non-coders.

When you need terminal access or advanced inspections, toggle **Coding Mode: ON** in the top right header:
- Unhides the interactive shell connected to your project's `.venv`.
- Provides quick execution shortcuts (`python src/analyze.py`, `pip list`).
- Unhides raw code views in Monaco Editor.

---

## 5. Live Web Report

The **Web Report** tab renders `web-report/index.html` live inside the application. When the AI agent writes interactive charts (using Plotly, Chart.js, or HTML tables), the preview updates seamlessly.
