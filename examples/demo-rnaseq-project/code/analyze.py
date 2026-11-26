#!/usr/bin/env python3
"""Self-contained differential expression analysis and interactive HTML report builder."""
import csv
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_CSV = ROOT / "data" / "raw" / "kidney_cohort_counts.csv"
PROC_DIR = ROOT / "data" / "processed"
REPORT_DIR = ROOT / "web-report"
REPORT_DATA_DIR = REPORT_DIR / "data"
RESULTS_JSON = ROOT / "tests" / "scientific" / "panel_1_results.json"

PROC_DIR.mkdir(parents=True, exist_ok=True)
REPORT_DATA_DIR.mkdir(parents=True, exist_ok=True)

def mean(xs):
    return sum(xs) / len(xs)

def var(xs):
    m = mean(xs)
    return sum((x - m) ** 2 for x in xs) / max(1, len(xs) - 1)

def approx_p_from_t(t_abs):
    # Complementary error function normal tail approximation (strictly deterministic stdlib)
    return max(1e-12, math.erfc(t_abs / math.sqrt(2.0)))

rows = []
with RAW_CSV.open("r", encoding="utf-8") as f:
    for rec in csv.DictReader(f):
        ctrl = [float(rec[f"ctrl_{i}"]) for i in range(1, 7)]
        treat = [float(rec[f"treat_{i}"]) for i in range(1, 7)]
        mc, mt = mean(ctrl), mean(treat)
        log2fc = math.log2((mt + 1.0) / (mc + 1.0))
        se = math.sqrt(var(ctrl) / len(ctrl) + var(treat) / len(treat) + 1e-9)
        t_stat = (mt - mc) / se
        pval = approx_p_from_t(abs(t_stat))
        rows.append({
            "gene": rec["gene"],
            "pathway": rec["pathway"],
            "mean_ctrl": round(mc, 2),
            "mean_treat": round(mt, 2),
            "log2fc": round(log2fc, 3),
            "t_stat": round(t_stat, 2),
            "pvalue": pval
        })

# Benjamini-Hochberg adjustment
rows.sort(key=lambda r: r["pvalue"])
n = len(rows)
for rank, r in enumerate(rows, start=1):
    r["padj"] = min(1.0, round(r["pvalue"] * n / rank, 8))
    r["neg_log10_padj"] = round(-math.log10(max(1e-12, r["padj"])), 2)
    r["significant"] = abs(r["log2fc"]) >= 1.0 and r["padj"] <= 0.05

summary = {
    "cohort": "Kidney Injury Demo Cohort (n=12)",
    "total_genes": len(rows),
    "significant_genes": sum(1 for r in rows if r["significant"]),
    "genes": rows
}

(PROC_DIR / "deg_summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
(REPORT_DATA_DIR / "deg_summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

# Render clean interactive standalone HTML report
test_results = json.loads(RESULTS_JSON.read_text(encoding="utf-8")) if RESULTS_JSON.exists() else []
html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Kidney Cohort DEG Analysis — Bionic Report</title>
  <style>
    body {{ font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 2rem; }}
    .wrap {{ max-width: 960px; margin: 0 auto; }}
    .card {{ background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }}
    h1 {{ margin: 0 0 0.25rem; font-size: 1.5rem; }}
    .meta {{ color: #64748b; font-size: 0.875rem; margin-bottom: 1rem; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 0.875rem; }}
    th, td {{ text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e2e8f0; }}
    .badge {{ display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }}
    .sig {{ background: #dcfce7; color: #166534; }}
    .ns {{ background: #f1f5f9; color: #475569; }}
    .pass {{ background: #dcfce7; color: #166534; }}
    .fail {{ background: #fee2e2; color: #991b1b; }}
    svg {{ width: 100%; height: 280px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Kidney Cohort Differential Gene Expression</h1>
      <div class="meta">Self-contained reproducible Bionic module · {summary['total_genes']} genes analyzed · {summary['significant_genes']} significant biomarkers (|log2FC| &ge; 1.0, padj &le; 0.05)</div>
      <svg id="volcano" viewBox="0 0 600 260" aria-label="Volcano Plot"></svg>
    </div>
    <div class="card">
      <h2>Biomarker Summary Table</h2>
      <table>
        <thead><tr><th>Gene</th><th>Pathway</th><th>Ctrl Mean</th><th>Treat Mean</th><th>log2FC</th><th>padj</th><th>Status</th></tr></thead>
        <tbody id="deg-rows"></tbody>
      </table>
    </div>
    <div class="card">
      <h2>Scientific Validation Tests (tests/scientific/panel_1_results.json)</h2>
      <div id="test-panel"></div>
    </div>
  </div>
  <script>
    const DATA = {json.dumps(summary)};
    const TESTS = {json.dumps(test_results)};
    const svg = document.getElementById('volcano');
    const padX = 45, padY = 25, W = 600 - padX * 2, H = 260 - padY * 2;
    const xScale = v => padX + ((v + 4) / 8) * W;
    const yScale = v => padY + H - (Math.min(12, v) / 12) * H;
    let markup = '<line x1="' + xScale(0) + '" y1="20" x2="' + xScale(0) + '" y2="235" stroke="#cbd5e1" stroke-dasharray="4"/>';
    for (const g of DATA.genes) {{
      const cx = xScale(g.log2fc), cy = yScale(g.neg_log10_padj);
      const fill = g.significant ? (g.log2fc > 0 ? '#2563eb' : '#ea580c') : '#94a3b8';
      markup += '<circle cx="' + cx + '" cy="' + cy + '" r="5" fill="' + fill + '"><title>' + g.gene + ' (log2FC=' + g.log2fc + ')</title></circle>';
      if (g.significant) markup += '<text x="' + (cx + 7) + '" y="' + (cy + 3) + '" font-size="10" fill="#1e293b">' + g.gene + '</text>';
    }}
    svg.innerHTML = markup;
    document.getElementById('deg-rows').innerHTML = DATA.genes.map(g =>
      '<tr><td><strong>' + g.gene + '</strong></td><td>' + g.pathway + '</td><td>' + g.mean_ctrl + '</td><td>' + g.mean_treat + '</td><td>' + g.log2fc + '</td><td>' + g.padj + '</td><td><span class="badge ' + (g.significant ? 'sig">Significant' : 'ns">NS') + '</span></td></tr>'
    ).join('');
    document.getElementById('test-panel').innerHTML = TESTS.length
      ? TESTS.map(t => '<p><span class="badge ' + (t.status === 'PASS' ? 'pass' : 'fail') + '">' + t.status + '</span> <strong>' + t.statement + '</strong> — ' + t.comment + '</p>').join('')
      : '<p class="meta">Run <code>./scripts/run.sh</code> to populate scientific test validation results.</p>';
  </script>
</body>
</html>
"""
(REPORT_DIR / "index.html").write_text(html, encoding="utf-8")
print(f"Built {REPORT_DIR / 'index.html'} ({summary['significant_genes']}/{summary['total_genes']} significant)")
