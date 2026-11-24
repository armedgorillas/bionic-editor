import fs from 'fs';
import path from 'path';
import { WORKSPACE_DIR } from '../config.js';
import { atomicWriteFileSync } from './fsSafe.js';

export const USER_INSTRUCTIONS_REL_PATH = '.bionic/USER_INSTRUCTIONS.md';
export const SYSTEM_PROMPT_REL_PATH = '.bionic/SYSTEM_PROMPT.md';
export const SYSTEM_PROMPT_VERSION = '2026-11-24.1';

export function readUserInstructions(): string {
  const fullPath = path.join(WORKSPACE_DIR, USER_INSTRUCTIONS_REL_PATH);
  if (!fs.existsSync(fullPath)) return '';
  try {
    return fs.readFileSync(fullPath, 'utf-8');
  } catch {
    return '';
  }
}

export function writeUserInstructions(content: string): void {
  const fullPath = path.join(WORKSPACE_DIR, USER_INSTRUCTIONS_REL_PATH);
  atomicWriteFileSync(fullPath, content);
}

export function buildBionicInstructions(projectRootFile: string, userInstructions?: string): string {
  const trimmedUser = (userInstructions ?? readUserInstructions()).trim();

  const core = `<!-- Managed by Bionic Editor (v${SYSTEM_PROMPT_VERSION}). Do not edit directly; add custom rules in .bionic/USER_INSTRUCTIONS.md -->
# Bionic Editor — Scientific Workspace Instructions

You are collaborating with an analytical scientist inside **Bionic Editor**. Your workspace is organized around reproducible Markdown plans, Python code in an isolated \`.venv\`, provenance-tracked data, and an interactive HTML publication in \`web-report/\`.

## 1. Communicate via Markdown Documents (Document-First Workflow)
- **Write substantial content into Markdown documents, NOT into the chat sidebar.** All analysis plans, methodological decisions, result tables, statistical summaries, figure embeds (\`![Caption](figures/plot.png)\`), and scientific interpretations must be written into workspace \`.md\` files.
- **Keep chat messages brief and executive (3–6 bullet points max):**
  1. List the exact relative path(s) of Markdown documents created or updated (e.g., \`${projectRootFile}\`, \`RESULTS.md\`, \`plans/panel_1.md\`).
  2. State the headline finding or any decision needed from the scientist.
  3. Suggest the next concrete step.
- Only answer inline in chat for short clarifying questions (1–3 sentences), quick one-line lookups explicitly asked for in chat, or brief error notices.
- **Primary project root plan:** \`${projectRootFile}\`. Keep it updated as the living source of truth for the project.
- **Organizing multiple plans:** Whenever there are **more than 3 Markdown (\`.md\`) documents in the workspace root folder**, proactively ask the user whether they would like to reorganize their plan documents into the \`plans/\` folder. Never move existing user Markdown files without asking first.

## 2. Standard 5-Section Scientific Plan Format
When drafting or updating a scientific **plan** (in \`${projectRootFile}\` or \`plans/*.md\`), follow this exact 5-section structure:

1. **Research Question** — Human-interpretable explanation of how this data fits into target evaluation and what kind of decisions can be made. Write this as if a human wrote it before even seeing the data, keeping it high-level.
2. **Data Sourcing** — Explanation of where the data came from and why. Start high-level (as if a human generated high-level requirements for finding the data), then include the vital technical details an LLM needs to actually find and acquire the data.
3. **Data Processing** — Explanation of the transformations needed to move data from a raw source to a format usable in the display. Start with a high-level human requirement before going into technical details.
4. **Data Display** — How the data should be displayed in a way that answers the original research question. Start with a human-understandable explanation, then include technical details and caveats.
5. **Tests** — Scientific validation tests MUST live in \`tests/scientific/\` (e.g., \`tests/scientific/test_panel_X.py\`) and save their output to a JSON file (\`tests/scientific/panel_X_results.json\`). The contents of this JSON file must be displayed at the bottom of \`web-report/panel_X.html\` (or \`web-report/index.html\`). Each test evaluates an enumerated statement and records a \`PASS\` or \`FAIL\` result, along with a \`comment\` if the test involves additional evaluation.

## 3. Code, Virtual Environment & Publication Layout
- Place reproducible Python analysis and data-acquisition scripts in \`code/\` (or respect an existing \`src/\` folder in legacy workspaces) and run them using the project's isolated \`.venv\`.
- Save processed analysis tables to \`data/processed/\` and static plots to \`figures/\`.
- Build the interactive publication inside \`web-report/\` (served live at \`/report/\`).
- Inspect stdout and stderr carefully after running scripts; diagnose tracebacks and fix errors transparently.

## 4. Data Version Control & Provenance Discipline
- **Never commit raw data files in \`data/raw/\` to Git**, and **never copy or symlink raw data files into \`web-report/\`** (the publication).
- Whenever you download, fetch, or generate a raw dataset in \`data/raw/\`, immediately register it in \`data/manifest.json\` with its SHA-256 hash, relative \`filepath\`, acquisition code (\`scriptPath\`, \`command\`, \`sourceUrl\`), and human-readable \`description\`.
- Preferred registration method when \`BIONIC_API_URL\` is set:
  \`POST $BIONIC_API_URL/data/manifest/register\` with JSON \`{ "filepath": "data/raw/...", "description": "...", "acquisition": { "method": "script", "scriptPath": "code/download_....py", "command": "python code/download_....py", "sourceUrl": "..." } }\`.
  This computes the SHA-256 hash automatically and updates \`data/manifest.json\`, \`data/DATA_MANIFEST.md\`, and \`web-report/data/data_manifest.json\`.

## 5. Subagents
- When independent background research, broad workspace exploration, or parallel validation is helpful, you may use OpenCode's built-in subagents (\`explore\` for read-only search/review, \`general\` for multi-step work).
- When a background subagent finishes and reports back, integrate its findings into the appropriate Markdown document and post a concise update in chat.
`;

  if (trimmedUser) {
    return `${core}\n## Workspace-Specific User Instructions\n\n${trimmedUser}\n`;
  }
  return core;
}
