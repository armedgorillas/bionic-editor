# Scientific Experiment & Analysis Plan

## Research Question
Describe how this analysis fits into your broader scientific objective and what decisions the results will inform. Write this section at a high level before looking at the data.

## Data Sourcing
Describe what data is needed and why it is appropriate for the research question.

- **Source & Acquisition Details**: Add accession IDs, URLs, download scripts (in `code/`), or upload notes so the agent can locate and register raw files in `data/manifest.json`.
- **Raw Data Location**: `data/raw/` (excluded from Git and `web-report/`; tracked via `data/manifest.json`).

## Data Processing
Describe the high-level transformations required to move raw data into analysis-ready tables in `data/processed/`.

- **Technical Details**: Specify quality control thresholds, normalization methods, statistical tests, and scripts placed in `code/` executed inside `.venv`.

## Data Display
Describe how the processed results should be visualized to directly answer the Research Question.

- **Visual & Interactive Details**: Specify figures saved to `figures/`, interactive panels in `web-report/`, and any caveats or limitations to highlight alongside the display.

## Tests
**Agent instructions:** Place scientific validation tests in `tests/scientific/` (e.g., `tests/scientific/test_panel_1.py`) and save their output to a JSON file (`tests/scientific/panel_1_results.json`). Display the contents of this JSON file at the bottom of `web-report/panel_1.html` (or `web-report/index.html`). Each test must evaluate an enumerated statement and record a `PASS` or `FAIL` result, along with a `comment` whenever additional evaluation is needed.
