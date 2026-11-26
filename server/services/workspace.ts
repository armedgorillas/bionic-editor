import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import {
  WORKSPACE_DIR,
  BIONIC_HUB_MODE,
  BIONIC_IS_FORK,
  BIONIC_SHIM_URL,
  BIONIC_PROJECT_ID,
  BIONIC_LOCAL_SHIM_TOKEN,
  getTargetSpawnOptions
} from '../config.js';
import {
  isPathSafe,
  resolveSafePath,
  applyTargetOwnership,
  ensureDirWithOwnership,
  atomicWriteFileSync
} from './fsSafe.js';
import { getProjectRootFile, buildStarterPlanTemplate } from './workspaceConfig.js';
import {
  ensureDataGitignore,
  createEmptyManifest,
  writeManifestSync,
  MANIFEST_REL_PATH
} from './dataManifest.js';
import { scaffoldPortableProjectScripts, upgradeManagedScriptsIfLegacy } from './portableScripts.js';

export { isPathSafe, resolveSafePath, applyTargetOwnership, ensureDirWithOwnership, atomicWriteFileSync };

export type FileCategory =
  | 'document'
  | 'plan'
  | 'data'
  | 'figure'
  | 'report'
  | 'code'
  | 'aux-code'
  | 'config'
  | 'other';

export interface FileItem {
  name: string;
  path: string; // relative to workspace
  isDirectory: boolean;
  size?: number;
  updatedAt?: string;
  children?: FileItem[];
  extension?: string;
  isDotItem?: boolean;
  category?: FileCategory;
}

export interface FileTreeOptions {
  includeDotItems?: boolean;
  maxDotEntries?: number;
}

const ALWAYS_EXCLUDED_DIRS = new Set([
  '.venv',
  '.git',
  'lost+found',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox'
]);

const AUX_CODE_DIRS = new Set(['scripts', 'tests']);
const CODE_EXTENSIONS = new Set([
  '.py', '.r', '.rmd', '.qmd', '.ipynb', '.nf', '.js', '.ts', '.tsx', '.jsx', '.sh', '.bash', '.zsh', '.sql'
]);
const CONFIG_EXTENSIONS = new Set(['.json', '.jsonc', '.yml', '.yaml', '.toml', '.cfg', '.ini', '.lock', '.env']);
const CONFIG_FILENAMES = new Set([
  'requirements.txt',
  'agents.md',
  'claude.md',
  'opencode.json',
  'opencode.jsonc',
  'dockerfile',
  'makefile',
  'snakefile',
  'pyproject.toml',
  'environment.yml',
  'package.json',
  'package-lock.json'
]);
const FIGURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf']);
const DATA_EXTENSIONS = new Set(['.csv', '.tsv', '.xlsx', '.xls', '.parquet', '.feather', '.h5ad', '.fastq', '.fq', '.bam', '.vcf']);

export function classifyFileItem(name: string, relPath: string, isDirectory: boolean): FileCategory {
  const lowerName = name.toLowerCase();
  const topDir = relPath.split('/')[0]?.toLowerCase() || '';

  if (isDirectory) {
    if (relPath === 'plans' || topDir === 'plans') return 'plan';
    if (relPath === 'code' || relPath === 'src' || topDir === 'code' || topDir === 'src') return 'code';
    if (relPath === 'data' || topDir === 'data') return 'data';
    if (relPath === 'figures' || topDir === 'figures') return 'figure';
    if (relPath === 'web-report' || topDir === 'web-report') return 'report';
    if (AUX_CODE_DIRS.has(topDir)) return 'aux-code';
    if (name.startsWith('.')) return 'config';
    return 'other';
  }

  const ext = path.extname(lowerName);
  if (lowerName === 'data_manifest.md') return 'document';
  if (relPath.toLowerCase() === 'data/manifest.json') return 'config';
  if (CONFIG_FILENAMES.has(lowerName)) return 'config';

  if (ext === '.md') {
    if (topDir === 'plans') return 'plan';
    return 'document';
  }

  if (topDir === 'code' || topDir === 'src') return 'code';
  if (AUX_CODE_DIRS.has(topDir)) return 'aux-code';
  if (topDir === 'figures' || FIGURE_EXTENSIONS.has(ext)) return 'figure';
  if (topDir === 'web-report') return 'report';
  if (topDir === 'data' || DATA_EXTENSIONS.has(ext)) return 'data';
  if (CODE_EXTENSIONS.has(ext)) return 'aux-code';
  if (CONFIG_EXTENSIONS.has(ext) || name.startsWith('.')) return 'config';

  return 'other';
}

export function hydrateWorkspaceFromHubGitIfAvailable(): boolean {
  if (!BIONIC_HUB_MODE || !BIONIC_SHIM_URL || !BIONIC_PROJECT_ID || !BIONIC_LOCAL_SHIM_TOKEN) {
    return false;
  }
  const gitUrl = `${BIONIC_SHIM_URL}/git/${BIONIC_PROJECT_ID}.git`;
  const authArg = `http.extraHeader=X-Bionic-Shim-Token: ${BIONIC_LOCAL_SHIM_TOKEN}`;
  const spawnOpts = getTargetSpawnOptions();
  try {
    // Check whether the Hub project repository already has commits (e.g. forked from a Completed Module).
    // Retry up to 45s on transient boot/attestation errors (connection refused, timeouts, 401, 5xx).
    let heads = '';
    const maxAttempts = BIONIC_IS_FORK ? 30 : 12;
    let lastErr: any = null;
    let reachedHub = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        heads = execFileSync('git', ['-c', authArg, 'ls-remote', '--heads', gitUrl], {
          cwd: WORKSPACE_DIR,
          encoding: 'utf-8',
          timeout: 15_000,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...spawnOpts
        }).trim();
        reachedHub = true;
        break;
      } catch (err: any) {
        lastErr = err;
        const msg = String(err?.stderr || err?.message || '');
        const isTransient =
          /Connection refused|Failed to connect|Could not connect|timed out|ETIMEDOUT|500|502|503|504|401|empty reply|reset by peer/i.test(
            msg
          );
        if (isTransient && attempt < maxAttempts - 1) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
          continue;
        }
        break;
      }
    }

    if (!reachedHub) {
      const errMsg = String(lastErr?.stderr || lastErr?.message || 'unknown error');
      if (BIONIC_IS_FORK) {
        // NEVER poison a forked VM disk with the generic starter template — exit non-zero so systemd retries!
        console.error(
          `[workspace] Forked project ${BIONIC_PROJECT_ID} could not reach Hub Git (${errMsg}); exiting so systemd retries hydration.`
        );
        process.exit(1);
      }
      console.warn(`[workspace] Could not reach Hub Git (${BIONIC_PROJECT_ID}): ${errMsg}`);
      return false;
    }

    if (!heads) {
      return false;
    }

    // Parse exact branch ref from ls-remote (`refs/heads/main` preferred, else first branch ref)
    const refLines = heads
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[1])
      .filter(Boolean);
    const targetRef = refLines.includes('refs/heads/main') ? 'refs/heads/main' : refLines[0];
    if (!targetRef) {
      return false;
    }

    if (!fs.existsSync(path.join(WORKSPACE_DIR, '.git'))) {
      execFileSync('git', ['init', '-b', 'main'], {
        cwd: WORKSPACE_DIR,
        timeout: 10_000,
        stdio: 'pipe',
        ...spawnOpts
      });
    }
    execFileSync('git', ['-c', authArg, 'fetch', gitUrl, targetRef], {
      cwd: WORKSPACE_DIR,
      timeout: 60_000,
      stdio: 'pipe',
      ...spawnOpts
    });
    execFileSync('git', ['reset', '--hard', 'FETCH_HEAD'], {
      cwd: WORKSPACE_DIR,
      timeout: 15_000,
      stdio: 'pipe',
      ...spawnOpts
    });

    // Post-hydration hygiene: ensure .gitignore, portable scripts, and executable permissions
    ensureDataGitignore();
    scaffoldPortableProjectScripts(WORKSPACE_DIR);
    upgradeManagedScriptsIfLegacy(WORKSPACE_DIR);

    const scriptsDir = path.join(WORKSPACE_DIR, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      for (const f of fs.readdirSync(scriptsDir)) {
        if (f.endsWith('.sh')) {
          try { fs.chmodSync(path.join(scriptsDir, f), 0o755); } catch {}
        }
      }
      const dataPull = path.join(scriptsDir, 'data-pull.sh');
      if (fs.existsSync(dataPull) && fs.existsSync(path.join(WORKSPACE_DIR, 'data', 'manifest.json'))) {
        try {
          const child = spawn('bash', [dataPull], {
            cwd: WORKSPACE_DIR,
            detached: true,
            stdio: 'ignore',
            ...spawnOpts
          });
          child.unref();
        } catch {}
      }
    }
    console.log(`📦 Hydrated forked workspace from Hub Git repository (${BIONIC_PROJECT_ID}, ref=${targetRef})`);
    return true;
  } catch (err: any) {
    if (BIONIC_IS_FORK) {
      console.error(
        `[workspace] Forked project ${BIONIC_PROJECT_ID} hydration failed (${err.message || err}); exiting so systemd retries.`
      );
      process.exit(1);
    }
    console.warn(`[workspace] Could not hydrate from Hub Git (${BIONIC_PROJECT_ID}): ${err.message || err}`);
    return false;
  }
}

export function ensureWorkspaceDir(): void {
  if (!fs.existsSync(WORKSPACE_DIR)) {
    ensureDirWithOwnership(WORKSPACE_DIR);
    if (!hydrateWorkspaceFromHubGitIfAvailable()) {
      initDefaultTemplate();
    }
  } else {
    // If workspace exists but contains only filesystem/git metadata (e.g. ext4 `lost+found`, `.git`),
    // first check Hub Git (for forked modules), otherwise scaffold default template.
    const entries = fs.readdirSync(WORKSPACE_DIR).filter((e) => e !== '.git' && e !== 'lost+found');
    if (entries.length === 0) {
      if (!hydrateWorkspaceFromHubGitIfAvailable()) {
        initDefaultTemplate();
      }
    } else if (BIONIC_HUB_MODE) {
      upgradeManagedScriptsIfLegacy(WORKSPACE_DIR);
    }
  }
}

export function initDefaultTemplate(): void {
  const dirs = [
    'plans',
    'code',
    'data/raw',
    'data/processed',
    'figures',
    'web-report',
    'web-report/data',
    'tests/scientific'
  ];

  for (const d of dirs) {
    ensureDirWithOwnership(path.join(WORKSPACE_DIR, d));
  }

  const rootFile = getProjectRootFile();
  const specPath = resolveSafePath(rootFile);
  if (!fs.existsSync(specPath)) {
    atomicWriteFileSync(specPath, buildStarterPlanTemplate(rootFile));
  }

  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeRootFileHtml = escapeHtml(rootFile);

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
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 2rem;
      line-height: 1.6;
    }
    .container { max-width: 860px; margin: 0 auto; }
    .card {
      background: var(--card-bg);
      padding: 1.75rem 2rem;
      border-radius: 10px;
      border: 1px solid var(--border);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    }
    h1 { margin: 0 0 0.5rem 0; font-size: 1.5rem; color: #0f172a; }
    p { color: var(--muted); margin: 0.5rem 0; }
    code {
      background: #f1f5f9;
      padding: 0.15rem 0.35rem;
      border-radius: 4px;
      font-size: 0.9em;
      color: #0f172a;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Scientific Web Report</h1>
      <p>Your live publication is ready at <code>web-report/index.html</code>.</p>
      <p>Draft your analysis plan in <code>${safeRootFileHtml}</code>, add datasets to <code>data/raw/</code> (registered in <code>data/manifest.json</code>), and ask the AI agent to build interactive charts and validation panels here.</p>
    </div>
  </div>
</body>
</html>
`;
  const reportPath = path.join(WORKSPACE_DIR, 'web-report', 'index.html');
  if (!fs.existsSync(reportPath)) {
    atomicWriteFileSync(reportPath, reportHtml);
  }

  const reqTxt = `pandas>=2.0.0
numpy>=1.24.0
matplotlib>=3.7.0
scipy>=1.10.0
`;
  const reqPath = path.join(WORKSPACE_DIR, 'requirements.txt');
  if (!fs.existsSync(reqPath)) {
    atomicWriteFileSync(reqPath, reqTxt);
  }

  // Ensure managed .gitignore block (excluding data/raw/*, .env, .bionic/sessions/) and data/raw/.gitkeep
  ensureDataGitignore();

  // Initialize empty Data Provenance Manifest + DATA_MANIFEST.md + web-report metadata mirror
  const manifestPath = path.join(WORKSPACE_DIR, MANIFEST_REL_PATH);
  if (!fs.existsSync(manifestPath)) {
    writeManifestSync(createEmptyManifest());
  }

  // Scaffold portable, zero-lock-in bash workflow scripts (scripts/*.sh + bionic.yaml)
  scaffoldPortableProjectScripts(WORKSPACE_DIR);
}

export function getFileTree(
  dirPath: string = WORKSPACE_DIR,
  relativeRoot: string = '',
  options: FileTreeOptions = {}
): FileItem[] {
  const includeDotItems = options.includeDotItems ?? false;
  const maxDotEntries = options.maxDotEntries ?? 200;

  return buildTreeRecursive(dirPath, relativeRoot, includeDotItems, maxDotEntries, false, { count: 0 });
}

function buildTreeRecursive(
  dirPath: string,
  relativeRoot: string,
  includeDotItems: boolean,
  maxDotEntries: number,
  insideDotTree: boolean,
  dotBudget: { count: number }
): FileItem[] {
  if (!fs.existsSync(dirPath)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const items: FileItem[] = [];

  for (const entry of entries) {
    if (ALWAYS_EXCLUDED_DIRS.has(entry.name)) {
      continue;
    }

    const isDotItem = entry.name.startsWith('.');
    if (isDotItem && !includeDotItems) {
      continue;
    }

    const inDot = insideDotTree || isDotItem;
    if (inDot) {
      if (dotBudget.count >= maxDotEntries) {
        continue;
      }
      dotBudget.count++;
    }

    const relPath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const fullPath = path.join(dirPath, entry.name);

    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(fullPath);
    } catch {
      // Skip broken or inaccessible entries without crashing tree loading
      continue;
    }

    let isDir = lst.isDirectory();
    let size = lst.size;
    let mtime = lst.mtime;

    if (lst.isSymbolicLink()) {
      // Safely inspect symlink targets only if they stay inside WORKSPACE_DIR
      try {
        resolveSafePath(relPath);
        const st = fs.statSync(fullPath);
        isDir = st.isDirectory();
        size = st.size;
        mtime = st.mtime;
      } catch {
        // Broken symlink or symlink escaping workspace: treat as non-traversable leaf
        isDir = false;
      }
    }

    const category = classifyFileItem(entry.name, relPath, isDir);

    if (isDir) {
      items.push({
        name: entry.name,
        path: relPath,
        isDirectory: true,
        isDotItem,
        category,
        children: buildTreeRecursive(fullPath, relPath, includeDotItems, maxDotEntries, inDot, dotBudget)
      });
    } else {
      items.push({
        name: entry.name,
        path: relPath,
        isDirectory: false,
        size,
        updatedAt: mtime.toISOString(),
        extension: path.extname(entry.name).toLowerCase(),
        isDotItem,
        category
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
  ensureDirWithOwnership(path.dirname(fullPath));
  fs.writeFileSync(fullPath, content, 'utf-8');
  applyTargetOwnership(fullPath);
}

function pathExistsIncludingSymlink(fullPath: string): boolean {
  try {
    fs.lstatSync(fullPath);
    return true;
  } catch {
    return false;
  }
}

export function createItem(relPath: string, isDirectory: boolean): void {
  const fullPath = resolveSafePath(relPath);
  if (pathExistsIncludingSymlink(fullPath)) {
    throw new Error(`Target already exists: ${relPath}`);
  }

  if (isDirectory) {
    ensureDirWithOwnership(fullPath);
  } else {
    ensureDirWithOwnership(path.dirname(fullPath));
    fs.writeFileSync(fullPath, '', 'utf-8');
    applyTargetOwnership(fullPath);
  }
}

export function renameItem(oldRelPath: string, newRelPath: string): void {
  const oldFull = resolveSafePath(oldRelPath);
  const newFull = resolveSafePath(newRelPath);

  if (oldFull === path.resolve(WORKSPACE_DIR) || newFull === path.resolve(WORKSPACE_DIR)) {
    throw new Error('Access denied: Cannot rename workspace root');
  }

  if (!pathExistsIncludingSymlink(oldFull)) {
    throw new Error(`Source not found: ${oldRelPath}`);
  }
  if (pathExistsIncludingSymlink(newFull)) {
    throw new Error(`Target already exists: ${newRelPath}`);
  }

  ensureDirWithOwnership(path.dirname(newFull));

  fs.renameSync(oldFull, newFull);
  applyTargetOwnership(newFull);
  try {
    const st = fs.lstatSync(newFull);
    if (!st.isSymbolicLink()) {
      if (st.isDirectory()) {
        fs.chmodSync(newFull, 0o775);
      } else {
        fs.chmodSync(newFull, 0o664);
      }
    }
  } catch {}
}

export function deleteItem(relPath: string): void {
  const fullPath = resolveSafePath(relPath);

  if (fullPath === path.resolve(WORKSPACE_DIR)) {
    throw new Error('Access denied: Cannot delete workspace root');
  }

  if (!pathExistsIncludingSymlink(fullPath)) {
    throw new Error(`Target not found: ${relPath}`);
  }

  fs.rmSync(fullPath, { recursive: true, force: true });
}
