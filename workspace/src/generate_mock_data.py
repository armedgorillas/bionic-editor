"""
Mock Data Generator for Heimberg et al. (2024) SCimilarity Visualization
Generates:
1. web-report/data/umap_data.json
2. web-report/data/concordance_matrix.json
3. web-report/data/metadata.json
"""
import os
import json
import numpy as np
import pandas as pd

def generate_mock_data():
    np.random.seed(42)

    # 5 kidney cell types as in Heimberg et al. Figure 3 kidney dataset
    cell_types = [
        "Podocyte",
        "Proximal Tubule",
        "Loop of Henle",
        "Distal Convoluted Tubule",
        "Collecting Duct"
    ]
    num_types = len(cell_types)
    num_cells = 3000

    # Cluster centers for author coordinates
    centers = [
        (-4.5, 3.5),   # Podocyte
        (-1.5, -3.0),  # Proximal Tubule
        (3.5, -2.5),   # Loop of Henle
        (4.0, 3.0),    # Distal Convoluted Tubule
        (0.0, 1.0)     # Collecting Duct
    ]

    # Assign cells to cell types
    # Slightly non-uniform biological distribution
    proportions = [0.12, 0.35, 0.20, 0.18, 0.15]
    cell_type_indices = np.random.choice(num_types, size=num_cells, p=proportions)

    x_author = []
    y_author = []

    for idx in cell_type_indices:
        cx, cy = centers[idx]
        # Gaussian distribution with std ~ 0.8
        x = np.random.normal(cx, 0.85)
        y = np.random.normal(cy, 0.85)
        x_author.append(round(float(x), 4))
        y_author.append(round(float(y), 4))

    x_author = np.array(x_author)
    y_author = np.array(y_author)

    # Predicted coordinates: apply slight rotation (~0.15 rad) and noise (sigma ~ 0.4)
    theta = 0.15
    cos_t, sin_t = np.cos(theta), np.sin(theta)
    rot_matrix = np.array([[cos_t, -sin_t], [sin_t, cos_t]])
    coords = np.vstack([x_author, y_author])
    rotated = rot_matrix @ coords
    noise = np.random.normal(0, 0.40, size=rotated.shape)
    scim_coords = rotated + noise

    x_scim = [round(float(val), 4) for val in scim_coords[0]]
    y_scim = [round(float(val), 4) for val in scim_coords[1]]

    # Concordance: ~90% concordance, ~10% randomly assigned another label
    pred_indices = []
    for true_idx in cell_type_indices:
        if np.random.rand() < 0.90:
            pred_indices.append(int(true_idx))
        else:
            other_indices = [i for i in range(num_types) if i != true_idx]
            pred_indices.append(int(np.random.choice(other_indices)))

    cell_ids = [f"cell_{i+1:05d}" for i in range(num_cells)]

    # Van Gogh "The Starry Night" inspired palette
    color_map = {
        "Podocyte": "#1e40af",                 # Deep Cobalt
        "Proximal Tubule": "#0284c7",          # Celestial Sky
        "Loop of Henle": "#eab308",            # Crescent Gold
        "Distal Convoluted Tubule": "#f97316", # Starlight Amber
        "Collecting Duct": "#10b981"           # Cypress Jade
    }

    # Ensure output directory exists
    out_dir = os.path.join("web-report", "data")
    os.makedirs(out_dir, exist_ok=True)

    # 1. umap_data.json
    umap_data = {
        "x_author": list(x_author),
        "y_author": list(y_author),
        "x_scim": x_scim,
        "y_scim": y_scim,
        "cell_id": cell_ids,
        "author_label_idx": [int(x) for x in cell_type_indices],
        "pred_label_idx": pred_indices
    }
    with open(os.path.join(out_dir, "umap_data.json"), "w") as f:
        json.dump(umap_data, f)

    # 2. concordance_matrix.json
    # Rows = predicted types, Columns = author-annotated types
    df = pd.DataFrame({
        "author": [cell_types[i] for i in cell_type_indices],
        "pred": [cell_types[i] for i in pred_indices]
    })
    crosstab = pd.crosstab(df["pred"], df["author"]).reindex(
        index=cell_types, columns=cell_types, fill_value=0
    )
    # Calculate column percentages (fraction of author cells assigned to each pred label)
    crosstab_pct = (crosstab / crosstab.sum(axis=0) * 100).round(2)
    matrix_values = crosstab_pct.values.tolist()

    concordance_data = {
        "values": matrix_values,
        "author_labels": cell_types,
        "pred_labels": cell_types
    }
    with open(os.path.join(out_dir, "concordance_matrix.json"), "w") as f:
        json.dump(concordance_data, f, indent=2)

    # 3. metadata.json
    concordance_rate = float(np.mean(cell_type_indices == np.array(pred_indices)))
    metadata = {
        "group_name": "SCimilarity Nephron Atlas Research Team",
        "members": ["Sonia Timberlake", "Ryan Bellmore", "Bionic AI Collaborator"],
        "dataset_name": "Human Kidney Atlas (Heimberg et al. 2024)",
        "artwork_theme": "The Starry Night (Vincent van Gogh, 1889)",
        "cell_types": cell_types,
        "label_to_idx": {name: i for i, name in enumerate(cell_types)},
        "idx_to_label": {str(i): name for i, name in enumerate(cell_types)},
        "color_map": color_map,
        "global_stats": {
            "total_cells": num_cells,
            "num_cell_types": num_types,
            "concordance_rate": round(concordance_rate * 100, 2),
            "rotation_noise_applied": "angle=0.15rad, sigma=0.4"
        }
    }
    with open(os.path.join(out_dir, "metadata.json"), "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"Mock data successfully generated in {out_dir}:")
    print(f" - umap_data.json ({num_cells} cells)")
    print(f" - concordance_matrix.json ({num_types}x{num_types})")
    print(f" - metadata.json")

if __name__ == "__main__":
    generate_mock_data()
