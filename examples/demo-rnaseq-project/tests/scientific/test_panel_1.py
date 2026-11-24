#!/usr/bin/env python3
"""Scientific validation suite for Panel 1 (writes PASS/FAIL JSON results)."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SUMMARY_PATH = ROOT / "data" / "processed" / "deg_summary.json"
OUT_JSON = Path(__file__).resolve().parent / "panel_1_results.json"

summary = json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))
by_gene = {g["gene"]: g for g in summary["genes"]}

checks = []
def record(idx: int, statement: str, passed: bool, comment: str):
    checks.append({
        "id": idx,
        "statement": statement,
        "status": "PASS" if passed else "FAIL",
        "comment": comment
    })

# 1. Known injury markers upregulated
havcr1 = by_gene["HAVCR1"]
lcn2 = by_gene["LCN2"]
record(
    1,
    "Canonical tubular injury biomarkers (HAVCR1, LCN2) are significantly upregulated (log2FC >= 2.0, padj <= 0.05).",
    havcr1["log2fc"] >= 2.0 and lcn2["log2fc"] >= 2.0 and havcr1["significant"] and lcn2["significant"],
    f"HAVCR1 log2FC={havcr1['log2fc']}, LCN2 log2FC={lcn2['log2fc']}"
)

# 2. Housekeeping genes remain stable
hk = [by_gene[g] for g in ("GAPDH", "ACTB", "RPLP0", "B2M")]
hk_stable = all(abs(g["log2fc"]) < 0.25 for g in hk)
record(
    2,
    "Housekeeping control genes (GAPDH, ACTB, RPLP0, B2M) exhibit |log2FC| < 0.25.",
    hk_stable,
    "Max housekeeping |log2FC|=" + str(round(max(abs(g["log2fc"]) for g in hk), 3))
)

# 3. Tubular function markers downregulated
umod = by_gene["UMOD"]
record(
    3,
    "Tubular function marker UMOD is significantly downregulated (log2FC <= -1.0).",
    umod["log2fc"] <= -1.0 and umod["significant"],
    f"UMOD log2FC={umod['log2fc']}"
)

OUT_JSON.write_text(json.dumps(checks, indent=2) + "\n", encoding="utf-8")
failed = [c for c in checks if c["status"] != "PASS"]
if failed:
    raise SystemExit(f"Scientific validation failed: {failed}")
print(f"OK: All {len(checks)} scientific validation tests PASSED.")
