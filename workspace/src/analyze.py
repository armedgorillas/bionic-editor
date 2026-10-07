"""
Scientific Analysis Pipeline
Automatically configured to run in isolated .venv
"""
import os
import pandas as pd
import numpy as np

def run_analysis():
    input_file = "data/raw/gene_expression_sample.csv"
    if not os.path.exists(input_file):
        print(f"Error: {input_file} not found.")
        return

    print("Loading raw expression data...")
    df = pd.read_csv(input_file)
    
    # Calculate group means
    df['ctrl_mean'] = (df['ctrl_rep1'] + df['ctrl_rep2']) / 2.0
    df['treat_mean'] = (df['treat_rep1'] + df['treat_rep2']) / 2.0
    
    # Compute Log2 Fold Change
    df['log2_fc'] = np.log2((df['treat_mean'] + 1e-5) / (df['ctrl_mean'] + 1e-5))
    
    output_dir = "data/processed"
    os.makedirs(output_dir, exist_ok=True)
    out_csv = os.path.join(output_dir, "deg_results.csv")
    df.to_csv(out_csv, index=False)
    print(f"Analysis complete. Results written to {out_csv}")

if __name__ == "__main__":
    run_analysis()
