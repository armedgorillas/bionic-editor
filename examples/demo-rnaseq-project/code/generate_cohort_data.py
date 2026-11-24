#!/usr/bin/env python3
"""Reproducible acquisition script generating the synthetic kidney cohort counts dataset."""
import csv
import math
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "raw" / "kidney_cohort_counts.csv"
OUT.parent.mkdir(parents=True, exist_ok=True)

GENES = [
    ("HAVCR1", "Tubular Injury", 12.0, 98.0),
    ("LCN2", "Tubular Injury", 18.0, 142.0),
    ("TIMP2", "Cell Cycle Arrest", 24.0, 86.0),
    ("IGFBP7", "Cell Cycle Arrest", 31.0, 105.0),
    ("CXCL10", "Inflammation", 15.0, 68.0),
    ("CCL2", "Inflammation", 22.0, 74.0),
    ("UMOD", "Tubular Function", 180.0, 62.0),
    ("EGF", "Tubular Function", 110.0, 38.0),
    ("AQP2", "Water Transport", 145.0, 54.0),
    ("SLC12A1", "Ion Transport", 130.0, 58.0),
    ("GAPDH", "Housekeeping", 410.0, 415.0),
    ("ACTB", "Housekeeping", 520.0, 512.0),
    ("RPLP0", "Housekeeping", 305.0, 309.0),
    ("B2M", "Housekeeping", 240.0, 248.0),
]

with OUT.open("w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["gene", "pathway", "ctrl_1", "ctrl_2", "ctrl_3", "ctrl_4", "ctrl_5", "ctrl_6",
                "treat_1", "treat_2", "treat_3", "treat_4", "treat_5", "treat_6"])
    for idx, (gene, pathway, c_base, t_base) in enumerate(GENES):
        ctrl = [round(c_base * (1.0 + 0.04 * math.sin(idx + i)), 2) for i in range(6)]
        treat = [round(t_base * (1.0 + 0.04 * math.cos(idx + i)), 2) for i in range(6)]
        w.writerow([gene, pathway, *ctrl, *treat])

print(f"Generated {OUT}")
