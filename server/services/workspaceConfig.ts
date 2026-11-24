import fs from 'fs';
import path from 'path';
import { WORKSPACE_DIR, BASE_SPEC, normalizeBaseSpec } from '../config.js';
import { resolveSafePath, atomicWriteFileSync } from './fsSafe.js';

export interface WorkspaceConfigData {
  rootFile?: string;
}

export interface ResolvedWorkspaceConfig {
  rootFile: string;
  baseSpec: string;
  source: 'workspace' | 'env' | 'default';
}

const CONFIG_REL_PATH = '.bionic/config.json';

function getConfigFullPath(): string {
  return path.join(WORKSPACE_DIR, CONFIG_REL_PATH);
}

export function normalizeRootFilePath(raw?: string): string {
  if (!raw) return '';
  const cleaned = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
  return cleaned;
}

export function readWorkspaceConfigFile(): WorkspaceConfigData {
  const fullPath = getConfigFullPath();
  if (!fs.existsSync(fullPath)) return {};
  try {
    const raw = fs.readFileSync(fullPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as WorkspaceConfigData;
    }
  } catch {
    // ignore corrupted config
  }
  return {};
}

export function getResolvedWorkspaceConfig(): ResolvedWorkspaceConfig {
  const fileCfg = readWorkspaceConfigFile();
  const configuredRoot = normalizeRootFilePath(fileCfg.rootFile);
  if (configuredRoot) {
    try {
      resolveSafePath(configuredRoot);
      return {
        rootFile: configuredRoot,
        baseSpec: configuredRoot,
        source: 'workspace'
      };
    } catch {
      // fall through if config file has unsafe path
    }
  }

  const hasEnvOrCliSpec = Boolean(
    process.env.BASE_SPEC ||
    process.env.SPEC_FILE ||
    BASE_SPEC !== 'SPEC.md'
  );
  const envSpec = normalizeRootFilePath(BASE_SPEC) || 'SPEC.md';
  return {
    rootFile: envSpec,
    baseSpec: envSpec,
    source: hasEnvOrCliSpec ? 'env' : 'default'
  };
}

export function getProjectRootFile(): string {
  return getResolvedWorkspaceConfig().rootFile;
}

export function updateWorkspaceConfig(input: {
  rootFile?: string;
  createIfMissing?: boolean;
}): ResolvedWorkspaceConfig {
  const existing = readWorkspaceConfigFile();
  const next: WorkspaceConfigData = { ...existing };

  if (input.rootFile !== undefined) {
    const normalized = normalizeRootFilePath(input.rootFile);
    if (!normalized) {
      delete next.rootFile;
    } else {
      const fullTarget = resolveSafePath(normalized);
      if (fullTarget === path.resolve(WORKSPACE_DIR)) {
        throw new Error('Project root file cannot be the workspace directory itself');
      }
      if (fs.existsSync(fullTarget) && fs.statSync(fullTarget).isDirectory()) {
        throw new Error(`Project root file cannot be a directory: ${normalized}`);
      }
      const canonicalRel = path.relative(path.resolve(WORKSPACE_DIR), fullTarget).replace(/\\/g, '/');
      if (!fs.existsSync(fullTarget) && input.createIfMissing) {
        const starterContent = buildStarterPlanTemplate(canonicalRel);
        atomicWriteFileSync(fullTarget, starterContent);
      }
      next.rootFile = normalizeBaseSpec(canonicalRel);
    }
  }

  atomicWriteFileSync(getConfigFullPath(), JSON.stringify(next, null, 2) + '\n');
  return getResolvedWorkspaceConfig();
}

export function buildStarterPlanTemplate(_filePath: string = 'SPEC.md'): string {
  return `# Scientific Experiment & Analysis Plan

## Research Question
Describe how this analysis fits into your broader scientific objective and what decisions the results will inform. Write this section at a high level before looking at the data.

## Data Sourcing
Describe what data is needed and why it is appropriate for the research question.

- **Source & Acquisition Details**: Add accession IDs, URLs, download scripts (in \`code/\`), or upload notes so the agent can locate and register raw files in \`data/manifest.json\`.
- **Raw Data Location**: \`data/raw/\` (excluded from Git and \`web-report/\`; tracked via \`data/manifest.json\`).

## Data Processing
Describe the high-level transformations required to move raw data into analysis-ready tables in \`data/processed/\`.

- **Technical Details**: Specify quality control thresholds, normalization methods, statistical tests, and scripts placed in \`code/\` executed inside \`.venv\`.

## Data Display
Describe how the processed results should be visualized to directly answer the Research Question.

- **Visual & Interactive Details**: Specify figures saved to \`figures/\`, interactive panels in \`web-report/\`, and any caveats or limitations to highlight alongside the display.

## Tests
**Agent instructions:** Place scientific validation tests in \`tests/scientific/\` (e.g., \`tests/scientific/test_panel_1.py\`) and save their output to a JSON file (\`tests/scientific/panel_1_results.json\`). Display the contents of this JSON file at the bottom of \`web-report/panel_1.html\` (or \`web-report/index.html\`). Each test must evaluate an enumerated statement and record a \`PASS\` or \`FAIL\` result, along with a \`comment\` whenever additional evaluation is needed.
`;
}
