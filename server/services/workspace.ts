import fs from 'fs';
import path from 'path';
import { WORKSPACE_DIR } from '../config.js';

export interface FileItem {
  name: string;
  path: string; // relative to workspace
  isDirectory: boolean;
  size?: number;
  updatedAt?: string;
  children?: FileItem[];
  extension?: string;
}

export function ensureWorkspaceDir(): void {
  if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    initDefaultTemplate();
  } else {
    // If workspace exists but is empty, scaffold default template
    const entries = fs.readdirSync(WORKSPACE_DIR);
    if (entries.length === 0 || (entries.length === 1 && entries[0] === '.git')) {
      initDefaultTemplate();
    }
  }
}

export function isPathSafe(relativePath: string): boolean {
  const normalized = path.normalize(relativePath);
  const resolved = path.resolve(WORKSPACE_DIR, normalized);
  return resolved.startsWith(WORKSPACE_DIR);
}

export function resolveSafePath(relativePath: string): string {
  const normalized = path.normalize(relativePath);
  const resolved = path.resolve(WORKSPACE_DIR, normalized);
  if (!resolved.startsWith(WORKSPACE_DIR)) {
    throw new Error('Access denied: Path is outside workspace');
  }
  return resolved;
}

export function initDefaultTemplate(): void {
  const dirs = [
    'data/raw',
    'data/processed',
    'src',
    'web-report',
    'figures'
  ];

  dirs.forEach(d => {
    const full = path.join(WORKSPACE_DIR, d);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(full, { recursive: true });
    }
  });

  const specContent = `# Scientific Experiment & Analysis Plan

## 1. Scientific Objective
Investigate differential gene expression patterns between control and experimental drug-treated cell populations. The goal is to identify significantly up-regulated and down-regulated biomarker candidates.

## 2. Input Data
- **Location**: \`data/raw/gene_expression_sample.csv\`
- **Measurements**: High-throughput RNA-seq counts across 4 replicates (2 control, 2 treated).
- **Key Columns**:
  - \`gene_id\`: Ensembl gene identifier
  - \`gene_symbol\`: Common gene name (e.g. TP53, BRCA1, MYC)
  - \`ctrl_rep1\`, \`ctrl_rep2\`: Raw normalized counts for control group
  - \`treat_rep1\`, \`treat_rep2\`: Raw normalized counts for treated group

## 3. Analysis Pipeline
Instruct the AI assistant to perform the following steps:
1. **Quality Check**: Verify sample replicate correlation and normalize count distribution.
2. **Differential Expression**: Compute fold changes (log2FC) and Student's t-test p-values.
3. **Visualization**: Generate a Volcano plot and save the image to \`figures/volcano_plot.png\`.
4. **Interactive Report**: Output full interactive summary to \`web-report/index.html\`.

## 4. Deliverables
- Cleaned differential expression table in \`data/processed/deg_results.csv\`
- Python analysis script in \`src/analyze.py\`
- Visual summary in \`web-report/\`
`;

  const specPath = path.join(WORKSPACE_DIR, 'SPEC.md');
  if (!fs.existsSync(specPath)) {
    fs.writeFileSync(specPath, specContent, 'utf-8');
  }

  const sampleCsv = `gene_id,gene_symbol,ctrl_rep1,ctrl_rep2,treat_rep1,treat_rep2
ENSG00000141510,TP53,245.5,238.1,892.4,910.2
ENSG00000012048,BRCA1,512.0,498.4,142.3,139.8
ENSG00000136997,MYC,1280.2,1305.8,3210.4,3180.0
ENSG00000105329,TGFB1,310.4,295.1,120.5,124.2
ENSG00000171862,PTEN,640.8,632.0,628.4,635.1
ENSG00000148400,NOTCH1,180.2,192.4,750.3,732.0
ENSG00000139618,BRCA2,410.1,422.3,110.0,105.8
ENSG00000146648,EGFR,890.3,912.0,1850.5,1890.1
ENSG00000165731,RET,95.2,102.1,410.3,398.7
ENSG00000157764,BRAF,320.1,315.0,810.5,795.3
`;
  const csvPath = path.join(WORKSPACE_DIR, 'data/raw/gene_expression_sample.csv');
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, sampleCsv, 'utf-8');
  }

  const analyzePy = `"""
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
`;
  const pyPath = path.join(WORKSPACE_DIR, 'src/analyze.py');
  if (!fs.existsSync(pyPath)) {
    fs.writeFileSync(pyPath, analyzePy, 'utf-8');
  }

  const reportHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bionic Editor - Scientific Analysis Report</title>
  <style>
    :root {
      --primary: #2563eb;
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text: #1e293b;
      --muted: #64748b;
      --border: #e2e8f0;
      --success: #16a34a;
      --danger: #dc2626;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 2rem;
      line-height: 1.6;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
    }
    header {
      background: var(--card-bg);
      padding: 1.5rem 2rem;
      border-radius: 8px;
      border: 1px solid var(--border);
      margin-bottom: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    h1 { margin: 0 0 0.5rem 0; font-size: 1.6rem; color: #0f172a; }
    p.subtitle { margin: 0; color: var(--muted); font-size: 0.95rem; }
    .badge {
      display: inline-block;
      background: #dbeafe;
      color: #1e40af;
      padding: 0.2rem 0.6rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-top: 0.5rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .card {
      background: var(--card-bg);
      padding: 1.25rem;
      border-radius: 8px;
      border: 1px solid var(--border);
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .metric-title { font-size: 0.85rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .metric-value { font-size: 1.75rem; font-weight: 700; color: #0f172a; margin-top: 0.25rem; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 1rem;
      font-size: 0.9rem;
    }
    th, td {
      padding: 0.75rem 1rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th { background: #f1f5f9; font-weight: 600; }
    .up { color: var(--success); font-weight: 600; }
    .down { color: var(--danger); font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Differential Expression Analysis Report</h1>
      <p class="subtitle">Generated automatically by Bionic Editor AI Pipeline</p>
      <span class="badge">Live Web-Report Server Active</span>
    </header>

    <div class="grid">
      <div class="card">
        <div class="metric-title">Total Genes Tested</div>
        <div class="metric-value">10</div>
      </div>
      <div class="card">
        <div class="metric-title">Significantly Up-regulated</div>
        <div class="metric-value up">5</div>
      </div>
      <div class="card">
        <div class="metric-title">Significantly Down-regulated</div>
        <div class="metric-value down">3</div>
      </div>
      <div class="card">
        <div class="metric-title">Unchanged / Neutral</div>
        <div class="metric-value">2</div>
      </div>
    </div>

    <div class="card">
      <h2 style="font-size: 1.2rem; margin-top: 0;">Top Candidate Biomarkers</h2>
      <table>
        <thead>
          <tr>
            <th>Gene Symbol</th>
            <th>Control Mean</th>
            <th>Treated Mean</th>
            <th>Log2 Fold Change</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>TP53</strong></td>
            <td>241.8</td>
            <td>901.3</td>
            <td>+1.89</td>
            <td><span class="up">Up-regulated</span></td>
          </tr>
          <tr>
            <td><strong>MYC</strong></td>
            <td>1293.0</td>
            <td>3195.2</td>
            <td>+1.31</td>
            <td><span class="up">Up-regulated</span></td>
          </tr>
          <tr>
            <td><strong>BRCA1</strong></td>
            <td>505.2</td>
            <td>141.1</td>
            <td>-1.84</td>
            <td><span class="down">Down-regulated</span></td>
          </tr>
          <tr>
            <td><strong>BRCA2</strong></td>
            <td>416.2</td>
            <td>107.9</td>
            <td>-1.95</td>
            <td><span class="down">Down-regulated</span></td>
          </tr>
          <tr>
            <td><strong>PTEN</strong></td>
            <td>636.4</td>
            <td>631.8</td>
            <td>-0.01</td>
            <td>Neutral</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>
`;
  const reportPath = path.join(WORKSPACE_DIR, 'web-report/index.html');
  if (!fs.existsSync(reportPath)) {
    fs.writeFileSync(reportPath, reportHtml, 'utf-8');
  }

  const reqTxt = `pandas>=2.0.0
numpy>=1.24.0
matplotlib>=3.7.0
scipy>=1.10.0
`;
  const reqPath = path.join(WORKSPACE_DIR, 'requirements.txt');
  if (!fs.existsSync(reqPath)) {
    fs.writeFileSync(reqPath, reqTxt, 'utf-8');
  }

  const gitignore = `.venv/
__pycache__/
*.pyc
.ipynb_checkpoints/
.DS_Store
`;
  const gitignorePath = path.join(WORKSPACE_DIR, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, gitignore, 'utf-8');
  }
}

export function getFileTree(dirPath: string = WORKSPACE_DIR, relativeRoot: string = ''): FileItem[] {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  const items: FileItem[] = [];

  for (const entry of entries) {
    if (entry.name === '.venv' || entry.name === '.git' || entry.name === 'node_modules' || entry.name === '__pycache__') {
      continue;
    }

    const relPath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      items.push({
        name: entry.name,
        path: relPath,
        isDirectory: true,
        children: getFileTree(fullPath, relPath)
      });
    } else {
      const stats = fs.statSync(fullPath);
      items.push({
        name: entry.name,
        path: relPath,
        isDirectory: false,
        size: stats.size,
        updatedAt: stats.mtime.toISOString(),
        extension: path.extname(entry.name).toLowerCase()
      });
    }
  }

  // Sort directories first, then alphabetical
  items.sort((a, b) => {
    if (a.isDirectory === b.isDirectory) {
      return a.name.localeCompare(b.name);
    }
    return a.isDirectory ? -1 : 1;
  });

  return items;
}

export function readFileContent(relPath: string): { content: string; isBinary: boolean; size: number } {
  const fullPath = resolveSafePath(relPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${relPath}`);
  }

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory: ${relPath}`);
  }

  const ext = path.extname(relPath).toLowerCase();
  const binaryExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.zip', '.tar', '.gz', '.xlsx', '.xls'];

  if (binaryExtensions.includes(ext)) {
    const buffer = fs.readFileSync(fullPath);
    return {
      content: buffer.toString('base64'),
      isBinary: true,
      size: stat.size
    };
  }

  const text = fs.readFileSync(fullPath, 'utf-8');
  return {
    content: text,
    isBinary: false,
    size: stat.size
  };
}

export function writeFileContent(relPath: string, content: string): void {
  const fullPath = resolveSafePath(relPath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fullPath, content, 'utf-8');
}

export function createItem(relPath: string, isDirectory: boolean): void {
  const fullPath = resolveSafePath(relPath);
  if (fs.existsSync(fullPath)) {
    throw new Error(`Target already exists: ${relPath}`);
  }

  if (isDirectory) {
    fs.mkdirSync(fullPath, { recursive: true });
  } else {
    const parent = path.dirname(fullPath);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    fs.writeFileSync(fullPath, '', 'utf-8');
  }
}

export function renameItem(oldRelPath: string, newRelPath: string): void {
  const oldFull = resolveSafePath(oldRelPath);
  const newFull = resolveSafePath(newRelPath);

  if (!fs.existsSync(oldFull)) {
    throw new Error(`Source not found: ${oldRelPath}`);
  }
  if (fs.existsSync(newFull)) {
    throw new Error(`Target already exists: ${newRelPath}`);
  }

  const newParent = path.dirname(newFull);
  if (!fs.existsSync(newParent)) {
    fs.mkdirSync(newParent, { recursive: true });
  }

  fs.renameSync(oldFull, newFull);
}

export function deleteItem(relPath: string): void {
  const fullPath = resolveSafePath(relPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Target not found: ${relPath}`);
  }

  fs.rmSync(fullPath, { recursive: true, force: true });
}
