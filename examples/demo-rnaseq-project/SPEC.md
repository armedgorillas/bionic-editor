# Scientific Experiment & Analysis Plan

## Research Question
Evaluate differential gene expression in a kidney injury cohort (n = 12 samples: 6 treated vs. 6 vehicle control) to identify candidate early-response biomarkers with strong fold-change (|log2FC| >= 1.0) and consistent group separation for downstream target validation.

## Data Sourcing
- **Dataset**: `data/raw/kidney_cohort_counts.csv` (generated reproducibly via `code/generate_cohort_data.py` for this public demonstration module; tracked via `data/manifest.json` with SHA-256 fingerprint).
- Raw data is excluded from Git and excluded from `web-report/`; only summary tables and interactive visualizations are published.

## Data Processing
1. Load sample-level normalized expression matrix (`gene`, `pathway`, `ctrl_1..ctrl_6`, `treat_1..treat_6`).
2. Compute per-gene group means, log2 fold change (`log2((mean_treat + 1) / (mean_ctrl + 1))`), two-sample Welch t-statistic, and approximate p-value / Benjamini-Hochberg adjusted p-value.
3. Export processed summary table to `data/processed/deg_summary.json` and `web-report/data/deg_summary.json`.

## Data Display
Render an interactive HTML volcano plot and sortable top-biomarker table in `web-report/index.html`, accompanied by the scientific validation scorecard from `tests/scientific/panel_1_results.json`.

## Tests
Scientific validation tests live in `tests/scientific/test_panel_1.py` and write enumerated `PASS`/`FAIL` statements with comments to `tests/scientific/panel_1_results.json`, displayed at the bottom of `web-report/index.html`.
