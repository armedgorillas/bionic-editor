# **SPEC_START: Initial Project Specification & Mock Data**

This document is a self-contained specification for recreating the skeleton of the heimberg2025 SCimilarity visualization project. Instead of processing raw biological data, this case study focuses on establishing the correct directory structure, Python environment, mock data generation, and the front-end web application skeleton.

*something here*

---

## **0. Group Registration**

Before you begin, your agent will ask for your group members' names and a group name. This information will be used to register your project and generate your unique deployment URL.

---

## **1. Background and Goal**

Recreate the web visualization for Figure 3 from:

> Heimberg et al. (2024). "A cell atlas foundation model for scalable search of similar human cells." *Nature* 638, 1085–1094.

**What Figure 3 shows (kidney dataset):**

\- **3b**: UMAP of cells, colored by the *author's* annotation.

\- **3c**: The same cells, colored by the model's *predicted* cell type.

\- **\*\*3d\*\***: A concordance heatmap. Rows = predicted types, columns = author-annotated types.

**\*\*Deliverables:\*\***

\- A. A Python script that generates **\*\*mock data\*\*** perfectly matching the JSON schemas expected by the web application.

\- B. A **\*\*strictly single-page\*\*** HTML/JS web application that displays the interactive visualization using an art-inspired color palette.

**---**

**## Implementation**

**### 2. Technology Stack**

Always create a virtual environment before proceeding.

**#### Python (Environment Setup & Data Generation)**

\- Python 3.9+

\- **\*\*Core dependencies to install now for later case studies:\*\***

\- `scimilarity==0.4.1` — SCimilarity model (PyPI; pulls PyTorch, PyTorch-Lightning, TileDB)

\- `scanpy==1.11.5` — Single-cell data analysis (UMAP, PCA, QC, normalization)

\- `anndata==0.12.10` — h5ad file format

\- `scipy==1.17.1` — Sparse matrix handling (MTX format)

\- `umap-learn==0.5.11`, `leidenalg==0.11.0`, `igraph==1.0.0`

\- `matplotlib`, `plotly`

\- **\*\*For this case study's mock data generation:\*\***

\- `numpy==1.26.4` — Array manipulation and statistical sampling (Gaussian distributions)

\- `pandas==2.3.3` — Easy cross-tabulation for the concordance matrix

\- Full pinned dependencies must be in `requirements.txt`

**#### JavaScript (Visualization)**

\- Plotly.js 2.27.0 (loaded from CDN)

\- Pure HTML/CSS/JS — no build step, no framework.

\- Three Plotly chart types: `scatter` or `scattergl` for UMAPs, `heatmap` for concordance.

**---**

**## Outputs**

**### 3. Project File Structure**

\`\`\`text

./

├── scripts/

│ ├── setup\_[env.sh](http://env.sh) # Creates the python venv and installs requirements

│ └── run\_[tests.py](http://tests.py) # Runs validation tests and outputs JSON for the web app

├── src/

│ └── generate_mock\_[data.py](http://data.py) # Python script to generate the JSON files

├── web-report/

│ ├── index.html # Main visualization page (STRICTLY single-page)

│ ├── visualization.js # All plot logic

│ └── data/ # Written by generate_mock\_[data.py](http://data.py)

│ ├── umap_data.json # Per-cell coordinates and labels

│ ├── concordance_matrix.json # Concordance heatmap data

│ ├── metadata.json # Cell type lists, colors, stats

│ └── test_results.json # Scientific validation test results

├── tests/

│ └── validation/ # Scientific validation tests (one file per test)

├── requirements.txt

├── .gitignore

├── [README.md](http://README.md)

└── \[SPECs\] # SPEC documents

\`\`\`

**---**

**### 4. Art-Inspired Color Schema**

Before writing the web application, user should choose a favorite work of art (e.g., "The Starry Night" by Van Gogh, "The Great Wave off Kanagawa" by Hokusai, or "Nighthawks" by Edward Hopper).

Ask your LLM to extract a cohesive 5-to-6 color hex palette from this artwork. You must incorporate these colors into your application:

1\. **\*\*In your CSS:\*\*** Use the palette for your application's background, text, borders, and UI elements (buttons/sliders).

2\. **\*\*In your Data/JS:\*\*** Use these specific hex codes in your `metadata.json` (or hardcoded in JS) as the `color_map` for rendering the different mock cell types.

**---**

**### 5. Mock Data Generation (**`src/generate_mock_data.py`**)**

Write a Python script to generate random data that mimics the biological output. Create \~1,000 to 5,000 "cells" distributed among 5 "cell types".

**\*\*Key Implementation Logic:\*\***

\- **\*\*Author Coordinates (**`x_author`**,** `y_author`**):\*\*** Generate 2D coordinates by sampling from a Gaussian cluster for each cell type (e.g., Type A centers at `[0,0]`, Type B at `[5,5]`, etc., with a small variance).

\- **\*\*Predicted Coordinates (**`x_scim`**,** `y_scim`**):\*\*** To mimic the model's slight variations, derive these coordinates from the author coordinates by applying a small rotation matrix (angle \~0.15 rad) plus extra random noise ($\\sigma \\approx 0.4$). This visually conveys that the model's embedding agrees with the base structure while differing in fine detail.

\- **\*\*Label Concordance:\*\*** For \~90% of cells, the `predicted_label` should match the `author_label`. For \~10% of cells, randomly assign a different predicted label to simulate model errors.

**\*\*Required Outputs (Saved directly to** `web-report/data/`**):\*\***

1\. `umap_data.json`: Columnar format `{ "x_author": [...], "y_author": [...], "x_scim": [...], "y_scim": [...], "cell_id": [...], "author_label_idx": [...], "pred_label_idx": [...] }`

2\. `metadata.json`: Contains global statistics, your art-inspired `color_map`, the string labels mapped to the integer indices used in the UMAP data, the `group_name`, and the `members` list.

3\. `concordance_matrix.json`: Contains the `values` (a 5x5 matrix of percentage overlaps), `author_labels`, and `pred_labels`.

**---**

**### 6.** `web-report/index.html`

A single-file static HTML page. **\*\*Multi-page routing or separate HTML files are strictly prohibited.\*\*** All UI must live in this file.

**### Page Layout**

\`\`\`text

\[Sidebar: Table of Contents (Auto-generated from Page Headers)\]

\[Main Content Area:\]

\[Header: title + paper citation\]

\[Controls bar: point size slider | opacity slider | highlight cell type dropdown | cell count stats\]

\[2-column grid:\]

```
\[Figure 3b: UMAP - Author Annotations\]  |  \[Figure 3c: UMAP - SCimilarity Predictions\]
```

\[Full-width: Figure 3d: Concordance Heatmap\]

\[Full-width: Scientific Validation Test Results Table\]

```
\[Columns: Test Name | Score | Comment\]
```

\[Full-width: Site Tree & Document Viewer\]

```
\[List of published Case Study documents | Download links\]
```

\[Full-width: Group Information\]

```
\[Group Name: displayed here\]

\[Members: list of names displayed here\]
```

\[Legend panel: colored boxes for each cell type\]

\[Footer\]

\`\`\`

**#### Key DOM Element IDs**

\- `sidebar-toc` — container for the application's table of contents

\- `umap-author` — container for Figure 3b scatter plot

\- `umap-predicted` — container for Figure 3c scatter plot

\- `concordance-heatmap` — container for Figure 3d heatmap

\- `test-results-table` — container for the validation test results table

\- `site-tree` — container for the list of published markdown documents

\- `doc-viewer` — container for displaying selected markdown content

\- `group-info` — container for displaying the group name and member list

\- `pointSize` — range input, min=1 max=10 default=3

\- `opacity` — range input, min=0.1 max=1 default=0.7

\- `highlightCellType` — select element, default option = "" (All cell types)

**---**

**### 7.** `web-report/visualization.js`

All visualization logic. No external dependencies beyond Plotly.js.

**#### Global State**

\`\`\`javascript

let umapData = null;

let concordanceData = null;

let metadata = null;

let testResults = null; // Scientific validation test results

let currentHighlight = ''; // Currently highlighted cell type ('' = all)

\`\`\`

**#### Required Functions**

\- **\*\***`loadData()`**\*\***: Fetches all four JSON files from `data/` in parallel (`Promise.all`). Sets global variables and triggers rendering.

\- **\*\***`createUMAPPlot(containerId, labelType)`**\*\***: Creates a Plotly scatter plot. Filters data by cell type, creating one trace per cell type so the legend can easily control visibility. Uses `marker.color` from your art-inspired `color_map` and modifies `marker.opacity` based on `currentHighlight`.

\- **\*\***`createConcordanceHeatmap(containerId)`**\*\***: Single Plotly `heatmap` trace. Adjust the `colorscale` to visually complement your art-inspired theme.

\- **\*\***`renderTestResultsTable(containerId)`**\*\***: Generates an HTML table from the `testResults` JSON data. Each row displays the test name, score, and comment.

\- **\*\***`renderSiteTree(containerId)`**\*\***: Lists all `.md` files found in `web-report/markdown/`. When a user clicks a file, it should be fetched and rendered in the `doc-viewer`.

\- **\*\***`renderGroupInfo(containerId)`**\*\***: Fetches `data/metadata.json` and displays the `group_name` and `members` list in the UI.

\- **\*\***`generateTOC(containerId)`**\*\***: Automatically scans the page for headers and populates the `sidebar-toc` with clickable links to each section.

\- **\*\***`init()`**\*\***: Called on `DOMContentLoaded`. Loads data, populates dropdowns, attaches slider event listeners, and draws the initial plots, table, site tree, and TOC. Attach a window resize handler calling `Plotly.Plots.resize`.

**##### renderSiteTree**

The renderSiteTree function should

\* read dynamically from all the files in web-report/markdown/

\* render the contents not as raw markdown but has html using javascript and css

**---**

**### 8. Scientific Validation (**`tests/validation/label_count_check.py`**)**

Write a Python script to perform a basic scientific sanity check on your mock data.

**\*\*Validation Logic:\*\***

\- Load `web-report/data/umap_data.json`.

\- Count the number of unique cell types present in the `author_label_idx` set.

\- Count the number of unique cell types present in the `pred_label_idx` set.

\- Compare the two counts.

**\*\*Expected Output:\*\***

The script must print a single JSON object to stdout:

\- `test_name`: "Label Count Consistency"

\- `score`: `1` if the number of unique labels is identical between both sets, `0` otherwise.

\- `comment`: A string describing the result (e.g., "Found 5 author types and 5 predicted types.").

**### 9. Footer**

At the bottom of the page, include the following content, rendered from markdown to HTML:

\`\`\`

This application was created during a Bio-IT 2026 workshop on AI Upskilling for Computational Biologists.

To see other finished products or find more information about how you can run your own workshop,

visit the homepage: <https://bioit26-compbio-ai-workshop.rightbionic.com/>

\`\`\`

copyright: © 2026 Sonia Timberlake & Ryan Bellmore

license: Proprietary - Authorized Workshop Participants Only

distribution_allowed: false

**---**

**## PROJECT SUMMARY LOG**

- **Base Platform Established**: Single-page interactive SCimilarity benchmark report recreating Figure 3 (3b, 3c, 3d) using Plotly and Van Gogh "The Starry Night" art-inspired palette.
- **Scientific Validation Automated**: Validation test harness `label_count_check.py` integrated via `scripts/run_tests.py` and reflected in web report.
- **Interactive Cat Science Fact Feature Added**: Integrated an interactive "Feline Science Fact" card in `web-report/index.html` and `web-report/visualization.js` highlighting comparative genomics (90.2% genomic synteny with human genomes, cellular mechanics, and sensory biology), featuring a rotating fact button and sidebar navigation link.