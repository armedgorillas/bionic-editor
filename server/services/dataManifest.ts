import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { WORKSPACE_DIR, getTargetSpawnOptions } from '../config.js';
import { resolveSafePath, atomicWriteFileSync, ensureDirWithOwnership } from './fsSafe.js';

const execFileAsync = promisify(execFile);

export const MANIFEST_REL_PATH = 'data/manifest.json';
export const MANIFEST_MD_REL_PATH = 'data/DATA_MANIFEST.md';
export const WEB_REPORT_MANIFEST_REL_PATH = 'web-report/data/data_manifest.json';

const RAW_BIO_EXTENSIONS = new Set([
  '.fastq', '.fq', '.bam', '.sam', '.cram', '.vcf', '.bcf', '.h5ad', '.loom', '.sra', '.bed', '.bigwig', '.bw'
]);
const RAW_BIO_COMPOUND_SUFFIXES = [
  '.fastq.gz', '.fq.gz', '.vcf.gz', '.bcf.gz', '.sam.gz', '.bed.gz', '.fastq.bz2', '.fq.bz2'
];
const WEB_REPORT_MAX_SAFE_BYTES = 25 * 1024 * 1024; // 25 MB warning threshold

function isRawBioFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (RAW_BIO_EXTENSIONS.has(path.extname(lower))) return true;
  return RAW_BIO_COMPOUND_SUFFIXES.some((s) => lower.endsWith(s));
}

export interface DataAcquisitionInfo {
  method: 'script' | 'upload' | 'url' | 'manual';
  scriptPath?: string;
  command?: string;
  codeSnippet?: string;
  scriptSha256?: string;
  sourceUrl?: string;
}

export interface DataStorageMetadata {
  provider: 'gcs' | 's3' | 'local';
  dataObjectId?: string;
  uri: string;
  generation?: string;
  crc32c?: string;
  syncStatus: 'synced' | 'pending' | 'remote_only';
  syncedAt?: string;
  readOnly?: boolean;
}

export interface DataManifestEntry {
  id: string;
  filepath: string;
  sha256: string;
  sizeBytes: number;
  mtimeMs?: number;
  acquiredAt: string;
  acquisition: DataAcquisitionInfo;
  description: string;
  excludeFromGit: boolean;
  excludeFromPublication: boolean;
  storage?: DataStorageMetadata;
}

export interface DataManifestDocument {
  schemaVersion: 1 | 2;
  updatedAt: string;
  entries: DataManifestEntry[];
}

export type PassiveEntryStatus = 'present' | 'remote_only' | 'size_changed' | 'missing';
export type VerifiedEntryStatus = 'verified' | 'remote_only' | 'modified' | 'missing';

export interface EntrySummary extends DataManifestEntry {
  status: PassiveEntryStatus | VerifiedEntryStatus;
  diskSizeBytes?: number;
  actualSha256?: string;
  scriptChanged?: boolean;
}

export interface PublicationLeak {
  path: string;
  reason: 'symlink_to_raw' | 'symlink_outside_workspace' | 'hash_match' | 'raw_extension' | 'oversized_file';
  matchedEntryId?: string;
  matchedFilepath?: string;
  sizeBytes?: number;
}

export interface LeakAuditResult {
  isGitRepo: boolean;
  gitTrackedRawFiles: string[];
  publicationLeaks: PublicationLeak[];
}

export interface ManifestSummaryResponse {
  manifest: DataManifestDocument;
  entries: EntrySummary[];
  untrackedRawFiles: Array<{ filepath: string; sizeBytes: number; mtimeMs: number }>;
  lastVerifiedAt: string | null;
  hasIssues: boolean;
}

export interface ManifestVerifyResponse extends ManifestSummaryResponse {
  leaks: LeakAuditResult;
}

// In-process write mutex to serialize manifest mutations
let writeChain: Promise<void> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  let result!: Promise<T>;
  writeChain = writeChain.then(
    () => {
      result = fn();
      return result.then(() => undefined, () => undefined);
    },
    () => {
      result = fn();
      return result.then(() => undefined, () => undefined);
    }
  );
  return writeChain.then(() => result);
}

// Single-flight lock for expensive full SHA-256 verification
let activeVerifyPromise: Promise<ManifestVerifyResponse> | null = null;
let lastVerifiedAt: string | null = null;
let lastInternalManifestWriteAt = 0;

export function wasManifestWrittenInternallyRecently(windowMs = 1200): boolean {
  return Date.now() - lastInternalManifestWriteAt < windowMs;
}

export function createEmptyManifest(): DataManifestDocument {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    entries: []
  };
}

export function computeFileSha256(fullPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(fullPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function makeEntryId(relPath: string): string {
  const base = path.basename(relPath, path.extname(relPath));
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (slug) return slug;
  return `dataset_${Date.now()}`;
}

function escapeMarkdownCell(val: string): string {
  return val.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function renderManifestMarkdown(manifest: DataManifestDocument): string {
  const lines: string[] = [
    '# Data Provenance Manifest',
    '',
    '> **Auto-generated from `data/manifest.json`** — Raw data files in `data/raw/` are excluded from Git and the `web-report/` publication. Edit entries via the **Data Provenance** panel in Bionic Editor.',
    '',
    `**Last Updated:** ${manifest.updatedAt}  `,
    `**Tracked Datasets:** ${manifest.entries.length}`,
    ''
  ];

  if (manifest.entries.length === 0) {
    lines.push('_No raw datasets registered yet. Upload a dataset into `data/raw/` or register a downloaded file via Data Provenance._', '');
    return lines.join('\n');
  }

  lines.push(
    '| Filepath | Description | Download / Acquisition Source | Size | Fingerprint (SHA-256) |',
    '| :--- | :--- | :--- | :--- | :--- |'
  );

  for (const e of manifest.entries) {
    const sourceParts: string[] = [];
    if (e.acquisition.scriptPath) sourceParts.push(`\`${e.acquisition.scriptPath}\``);
    if (e.acquisition.command) sourceParts.push(`\`${e.acquisition.command}\``);
    if (e.acquisition.sourceUrl) sourceParts.push(e.acquisition.sourceUrl);
    if (sourceParts.length === 0) sourceParts.push(e.acquisition.method || 'manual');

    lines.push(
      `| \`${escapeMarkdownCell(e.filepath)}\` | ${escapeMarkdownCell(e.description || '—')} | ${escapeMarkdownCell(sourceParts.join(' · '))} | ${formatBytes(e.sizeBytes)} | \`${e.sha256.slice(0, 12)}…\` |`
    );
  }

  lines.push('');
  return lines.join('\n');
}

export function readManifest(): DataManifestDocument {
  const fullPath = path.join(WORKSPACE_DIR, MANIFEST_REL_PATH);
  if (!fs.existsSync(fullPath)) {
    return createEmptyManifest();
  }
  try {
    const raw = fs.readFileSync(fullPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) {
      return {
        schemaVersion: parsed.schemaVersion === 2 || parsed.entries.some((e: any) => Boolean(e?.storage)) ? 2 : 1,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        entries: parsed.entries
      };
    }
  } catch {
    // fall back to empty manifest if unreadable
  }
  return createEmptyManifest();
}

/**
 * Syncs human-readable `data/DATA_MANIFEST.md` and metadata-only
 * `web-report/data/data_manifest.json` from `data/manifest.json`.
 */
export function syncManifestArtifacts(manifest: DataManifestDocument): void {
  const mdPath = path.join(WORKSPACE_DIR, MANIFEST_MD_REL_PATH);
  atomicWriteFileSync(mdPath, renderManifestMarkdown(manifest));

  const webReportDir = path.join(WORKSPACE_DIR, 'web-report');
  if (fs.existsSync(webReportDir)) {
    const webManifestPath = path.join(WORKSPACE_DIR, WEB_REPORT_MANIFEST_REL_PATH);
    atomicWriteFileSync(webManifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
}

export function writeManifestSync(manifest: DataManifestDocument): DataManifestDocument {
  const hasStorage = manifest.entries.some((e) => Boolean(e.storage));
  const updated: DataManifestDocument = {
    schemaVersion: manifest.schemaVersion === 2 || hasStorage ? 2 : 1,
    updatedAt: new Date().toISOString(),
    entries: manifest.entries
  };
  lastInternalManifestWriteAt = Date.now();
  const fullPath = path.join(WORKSPACE_DIR, MANIFEST_REL_PATH);
  atomicWriteFileSync(fullPath, JSON.stringify(updated, null, 2) + '\n');
  syncManifestArtifacts(updated);
  return updated;
}

export function ensureDataGitignore(): void {
  const gitignorePath = path.join(WORKSPACE_DIR, '.gitignore');
  const managedBlock = `# BEGIN BIONIC MANAGED
.venv/
__pycache__/
*.pyc
.ipynb_checkpoints/
.DS_Store
.env
.env.*
!.env.example
.bionic/sessions/
# Raw data files (tracked via data/manifest.json, not Git)
data/raw/*
!data/raw/.gitkeep
!data/manifest.json
!data/DATA_MANIFEST.md
# END BIONIC MANAGED`;

  let existing = '';
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, 'utf-8');
  }

  const blockRegex = /# BEGIN BIONIC MANAGED[\s\S]*?# END BIONIC MANAGED/;
  let nextContent: string;
  if (blockRegex.test(existing)) {
    nextContent = existing.replace(blockRegex, managedBlock);
  } else if (existing.trim().length > 0) {
    nextContent = `${existing.trimEnd()}\n\n${managedBlock}\n`;
  } else {
    nextContent = `${managedBlock}\n`;
  }

  if (nextContent !== existing) {
    atomicWriteFileSync(gitignorePath, nextContent);
  }

  // Ensure data/raw/.gitkeep exists so the empty directory stays in Git
  const rawDir = path.join(WORKSPACE_DIR, 'data', 'raw');
  ensureDirWithOwnership(rawDir);
  const gitkeepPath = path.join(rawDir, '.gitkeep');
  if (!fs.existsSync(gitkeepPath)) {
    atomicWriteFileSync(gitkeepPath, '');
  }
}

function normalizeWorkspaceRelPath(relPath: string): string {
  return relPath.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function walkRawFiles(dirPath: string, relPrefix: string, out: Array<{ filepath: string; sizeBytes: number; mtimeMs: number }>): void {
  if (!fs.existsSync(dirPath)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === '.gitkeep' || entry.name === '.DS_Store') continue;
    const rel = `${relPrefix}/${entry.name}`;
    const full = path.join(dirPath, entry.name);
    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) {
      // Do not follow symlinks blindly, still report as raw entry with size 0
      out.push({ filepath: rel, sizeBytes: lst.size, mtimeMs: lst.mtimeMs });
      continue;
    }
    if (lst.isDirectory()) {
      walkRawFiles(full, rel, out);
    } else if (lst.isFile()) {
      out.push({ filepath: rel, sizeBytes: lst.size, mtimeMs: lst.mtimeMs });
    }
  }
}

export function scanUntrackedRawFiles(manifest?: DataManifestDocument): Array<{ filepath: string; sizeBytes: number; mtimeMs: number }> {
  const m = manifest ?? readManifest();
  const tracked = new Set(m.entries.map((e) => normalizeWorkspaceRelPath(e.filepath)));
  const rawDir = path.join(WORKSPACE_DIR, 'data', 'raw');
  const allRaw: Array<{ filepath: string; sizeBytes: number; mtimeMs: number }> = [];
  walkRawFiles(rawDir, 'data/raw', allRaw);
  return allRaw.filter((f) => !tracked.has(f.filepath));
}

const SHARED_DATA_PREFIX = '/mnt/shared-data/';

function isSharedDataPath(fp: string): boolean {
  return fp.startsWith(SHARED_DATA_PREFIX) && !fp.includes('..');
}

function resolveEntryPath(fp: string): string {
  if (isSharedDataPath(fp)) {
    return path.resolve(fp);
  }
  return resolveSafePath(fp);
}

/**
 * Fast passive status check using lstatSync only (never hashes multi-GB files).
 */
export function getManifestSummary(): ManifestSummaryResponse {
  const manifest = readManifest();
  const entries: EntrySummary[] = manifest.entries.map((entry) => {
    try {
      const fullPath = resolveEntryPath(entry.filepath);
      if (!fs.existsSync(fullPath)) {
        if (entry.storage?.syncStatus === 'remote_only' && entry.storage.uri) {
          return { ...entry, status: 'remote_only' as const };
        }
        return { ...entry, status: 'missing' as const };
      }
      const st = fs.lstatSync(fullPath);
      if (!st.isFile()) {
        return { ...entry, status: 'missing' as const };
      }
      if (st.size !== entry.sizeBytes) {
        return { ...entry, status: 'size_changed' as const, diskSizeBytes: st.size };
      }
      return { ...entry, status: 'present' as const, diskSizeBytes: st.size };
    } catch {
      if (entry.storage?.syncStatus === 'remote_only' && entry.storage.uri) {
        return { ...entry, status: 'remote_only' as const };
      }
      return { ...entry, status: 'missing' as const };
    }
  });

  const untrackedRawFiles = scanUntrackedRawFiles(manifest);
  const hasIssues =
    untrackedRawFiles.length > 0 ||
    entries.some((e) => e.status === 'missing' || e.status === 'size_changed');

  return {
    manifest,
    entries,
    untrackedRawFiles,
    lastVerifiedAt,
    hasIssues
  };
}

/**
 * Registers a remote-only object-storage dataset (e.g. uploaded directly to GCS
 * via Hub resumable upload) without requiring the multi-GB file to be hydrated locally.
 */
export async function registerRemoteDataEntry(input: {
  filepath: string;
  sha256: string;
  sizeBytes: number;
  description?: string;
  id?: string;
  storage: DataStorageMetadata;
}): Promise<DataManifestEntry> {
  return withWriteLock(async () => {
    const normalizedPath = isSharedDataPath(input.filepath)
      ? input.filepath
      : normalizeWorkspaceRelPath(input.filepath);
    if (!normalizedPath) {
      throw new Error('filepath is required');
    }
    const manifest = readManifest();
    const id =
      input.id ||
      path
        .basename(normalizedPath, path.extname(normalizedPath))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') ||
      `dataset_${Date.now()}`;

    const entry: DataManifestEntry = {
      id,
      filepath: normalizedPath,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      acquiredAt: new Date().toISOString(),
      acquisition: {
        method: 'upload',
        sourceUrl: input.storage.uri
      },
      description: input.description || '',
      excludeFromGit: true,
      excludeFromPublication: true,
      storage: input.storage
    };

    const existingIdx = manifest.entries.findIndex((e) => e.filepath === normalizedPath || e.id === id);
    if (existingIdx >= 0) {
      manifest.entries[existingIdx] = entry;
    } else {
      manifest.entries.push(entry);
    }
    manifest.schemaVersion = 2;
    manifest.updatedAt = new Date().toISOString();
    ensureDataGitignore();
    writeManifestSync(manifest);
    return entry;
  });
}

export async function registerDataFile(input: {
  filepath: string;
  description?: string;
  acquisition?: Partial<DataAcquisitionInfo>;
  id?: string;
  excludeFromGit?: boolean;
  excludeFromPublication?: boolean;
}): Promise<DataManifestEntry> {
  return withWriteLock(async () => {
    const normalizedPath = normalizeWorkspaceRelPath(input.filepath);
    if (!normalizedPath) {
      throw new Error('filepath is required');
    }
    const fullPath = resolveSafePath(normalizedPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Data file not found: ${normalizedPath}`);
    }
    const st = fs.lstatSync(fullPath);
    if (!st.isFile()) {
      throw new Error(`Target is not a regular file: ${normalizedPath}`);
    }

    const sha256 = await computeFileSha256(fullPath);

    let scriptPath: string | undefined;
    let scriptSha256: string | undefined;
    if (input.acquisition?.scriptPath) {
      const normScript = normalizeWorkspaceRelPath(input.acquisition.scriptPath);
      if (normScript) {
        scriptPath = normScript;
        try {
          const fullScript = resolveSafePath(normScript);
          if (fs.existsSync(fullScript) && fs.lstatSync(fullScript).isFile()) {
            scriptSha256 = await computeFileSha256(fullScript);
          }
        } catch {
          // Ignore invalid/outside script paths when hashing optional provenance
        }
      }
    }

    const manifest = readManifest();
    const existingIdx = manifest.entries.findIndex(
      (e) => normalizeWorkspaceRelPath(e.filepath) === normalizedPath || (input.id && e.id === input.id)
    );
    const existing = existingIdx >= 0 ? manifest.entries[existingIdx] : undefined;

    let entryId = input.id || existing?.id || makeEntryId(normalizedPath);
    if (!existing && manifest.entries.some((e) => e.id === entryId)) {
      entryId = `${entryId}_${sha256.slice(0, 6)}`;
    }

    const resolveOptionalField = (incoming: string | undefined, prev: string | undefined): string | undefined => {
      if (incoming === undefined) return prev;
      const trimmed = incoming.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };

    const resolvedScriptPath = resolveOptionalField(
      input.acquisition?.scriptPath !== undefined ? normalizeWorkspaceRelPath(input.acquisition.scriptPath) : undefined,
      existing?.acquisition?.scriptPath
    );
    const resolvedCommand = resolveOptionalField(input.acquisition?.command, existing?.acquisition?.command);
    const resolvedCodeSnippet = resolveOptionalField(input.acquisition?.codeSnippet, existing?.acquisition?.codeSnippet);
    const resolvedSourceUrl = resolveOptionalField(input.acquisition?.sourceUrl, existing?.acquisition?.sourceUrl);
    const resolvedScriptSha = resolvedScriptPath
      ? (scriptSha256 ?? existing?.acquisition?.scriptSha256)
      : undefined;

    const entry: DataManifestEntry = {
      id: entryId,
      filepath: normalizedPath,
      sha256,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      acquiredAt: new Date().toISOString(),
      acquisition: {
        method: input.acquisition?.method || existing?.acquisition?.method || 'manual',
        ...(resolvedScriptPath ? { scriptPath: resolvedScriptPath } : {}),
        ...(resolvedCommand ? { command: resolvedCommand } : {}),
        ...(resolvedCodeSnippet ? { codeSnippet: resolvedCodeSnippet } : {}),
        ...(resolvedScriptSha ? { scriptSha256: resolvedScriptSha } : {}),
        ...(resolvedSourceUrl ? { sourceUrl: resolvedSourceUrl } : {})
      },
      description: input.description !== undefined ? input.description : (existing?.description || ''),
      excludeFromGit: input.excludeFromGit ?? existing?.excludeFromGit ?? true,
      excludeFromPublication: input.excludeFromPublication ?? existing?.excludeFromPublication ?? true
    };

    if (existingIdx >= 0) {
      manifest.entries[existingIdx] = entry;
    } else {
      manifest.entries.push(entry);
    }

    ensureDataGitignore();
    writeManifestSync(manifest);
    return entry;
  });
}

export async function removeManifestEntry(id: string): Promise<boolean> {
  return withWriteLock(async () => {
    const manifest = readManifest();
    const before = manifest.entries.length;
    manifest.entries = manifest.entries.filter((e) => e.id !== id);
    if (manifest.entries.length === before) return false;
    writeManifestSync(manifest);
    return true;
  });
}

/**
 * Verifies that WORKSPACE_DIR itself is the exact Git repository root before
 * executing any Git commands (prevents mutating parent repos).
 */
async function isWorkspaceOwnGitRoot(): Promise<boolean> {
  try {
    const canonicalWs = fs.realpathSync(WORKSPACE_DIR);
    const spawnOpts = getTargetSpawnOptions();
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: WORKSPACE_DIR,
      ...spawnOpts
    });
    const topLevel = fs.realpathSync(stdout.trim());
    return topLevel === canonicalWs;
  } catch {
    return false;
  }
}

async function scanWebReportLeaks(manifest: DataManifestDocument): Promise<PublicationLeak[]> {
  const webReportDir = path.join(WORKSPACE_DIR, 'web-report');
  if (!fs.existsSync(webReportDir)) return [];

  const leaks: PublicationLeak[] = [];
  const canonicalWs = fs.realpathSync(WORKSPACE_DIR);
  const canonicalRawDir = path.join(canonicalWs, 'data', 'raw');

  // Index non-empty manifest entries by sizeBytes AND realpath for symlink leak checks
  const entriesBySize = new Map<number, DataManifestEntry[]>();
  const excludedRealPaths = new Set<string>();
  for (const e of manifest.entries) {
    if (!e.excludeFromPublication) continue;
    try {
      const full = resolveSafePath(e.filepath);
      if (fs.existsSync(full)) excludedRealPaths.add(fs.realpathSync(full));
    } catch {}
    if (e.sizeBytes <= 0) continue;
    const list = entriesBySize.get(e.sizeBytes) || [];
    list.push(e);
    entriesBySize.set(e.sizeBytes, list);
  }
  const canonicalWebReport = fs.realpathSync(webReportDir);

  const walk = async (dirPath: string, relPrefix: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      const rel = `${relPrefix}/${item.name}`;
      const full = path.join(dirPath, item.name);
      let lst: fs.Stats;
      try {
        lst = fs.lstatSync(full);
      } catch {
        continue;
      }

      if (lst.isSymbolicLink()) {
        try {
          const targetReal = fs.realpathSync(full);
          const pointsIntoRaw =
            targetReal === canonicalRawDir || targetReal.startsWith(canonicalRawDir + path.sep);
          const pointsToRawAncestor =
            canonicalRawDir.startsWith(targetReal + path.sep);
          const pointsToExcludedEntry = excludedRealPaths.has(targetReal);
          const outsideWs =
            targetReal !== canonicalWs && !targetReal.startsWith(canonicalWs + path.sep);
          const leavesWebReport =
            targetReal !== canonicalWebReport && !targetReal.startsWith(canonicalWebReport + path.sep);

          if (pointsIntoRaw || pointsToRawAncestor || pointsToExcludedEntry) {
            leaks.push({ path: rel, reason: 'symlink_to_raw' });
          } else if (outsideWs || leavesWebReport) {
            leaks.push({ path: rel, reason: 'symlink_outside_workspace' });
          }
        } catch {
          leaks.push({ path: rel, reason: 'symlink_outside_workspace' });
        }
        continue;
      }

      if (lst.isDirectory()) {
        await walk(full, rel);
        continue;
      }

      if (!lst.isFile()) continue;

      // Skip metadata-only synced manifest
      if (rel === WEB_REPORT_MANIFEST_REL_PATH) continue;

      if (isRawBioFilename(item.name)) {
        leaks.push({ path: rel, reason: 'raw_extension', sizeBytes: lst.size });
        continue;
      }

      if (lst.size > 0 && entriesBySize.has(lst.size)) {
        try {
          const hash = await computeFileSha256(full);
          const match = entriesBySize.get(lst.size)!.find((e) => e.sha256 === hash);
          if (match) {
            leaks.push({
              path: rel,
              reason: 'hash_match',
              matchedEntryId: match.id,
              matchedFilepath: match.filepath,
              sizeBytes: lst.size
            });
            continue;
          }
        } catch {
          // ignore unreadable
        }
      }

      if (lst.size > WEB_REPORT_MAX_SAFE_BYTES) {
        leaks.push({ path: rel, reason: 'oversized_file', sizeBytes: lst.size });
      }
    }
  };

  await walk(webReportDir, 'web-report');
  return leaks;
}

export async function checkGitAndPublicationLeaks(manifest?: DataManifestDocument): Promise<LeakAuditResult> {
  const m = manifest ?? readManifest();
  const isGitRepo = await isWorkspaceOwnGitRoot();
  let gitTrackedRawFiles: string[] = [];

  if (isGitRepo) {
    try {
      const spawnOpts = getTargetSpawnOptions();
      const { stdout } = await execFileAsync('git', ['ls-files', '--', 'data/raw/'], {
        cwd: WORKSPACE_DIR,
        ...spawnOpts
      });
      gitTrackedRawFiles = stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.endsWith('/.gitkeep') && s !== 'data/raw/.gitkeep');
    } catch {
      gitTrackedRawFiles = [];
    }
  }

  const publicationLeaks = await scanWebReportLeaks(m);
  return {
    isGitRepo,
    gitTrackedRawFiles,
    publicationLeaks
  };
}

/**
 * Safely untracks a raw file from the workspace Git index (`git rm --cached`)
 * without deleting it on disk. Warns if the file already exists in Git commit history.
 */
export async function untrackRawFromGit(filepath: string): Promise<{
  success: boolean;
  filepath: string;
  inGitHistory: boolean;
  warning?: string;
}> {
  const normalized = normalizeWorkspaceRelPath(filepath);
  const fullTarget = resolveSafePath(normalized);
  const canonicalRel = path.relative(path.resolve(WORKSPACE_DIR), fullTarget).replace(/\\/g, '/');
  if (!canonicalRel.startsWith('data/raw/') || canonicalRel === 'data/raw/.gitkeep') {
    throw new Error('Only files inside data/raw/ can be untracked via this endpoint');
  }

  const isOwnRepo = await isWorkspaceOwnGitRoot();
  if (!isOwnRepo) {
    throw new Error('Workspace is not a standalone Git repository root; refusing to modify parent Git repository.');
  }

  const spawnOpts = getTargetSpawnOptions();
  await execFileAsync('git', ['rm', '--cached', '--ignore-unmatch', '--', canonicalRel], {
    cwd: WORKSPACE_DIR,
    ...spawnOpts
  });
  ensureDataGitignore();

  let inGitHistory = false;
  try {
    const { stdout } = await execFileAsync('git', ['log', '-n', '1', '--format=%H', '--', canonicalRel], {
      cwd: WORKSPACE_DIR,
      ...spawnOpts
    });
    inGitHistory = stdout.trim().length > 0;
  } catch {
    inGitHistory = false;
  }

  return {
    success: true,
    filepath: canonicalRel,
    inGitHistory,
    ...(inGitHistory
      ? {
          warning:
            'This file was removed from future commits, but still exists in previous Git commit history. If it contains sensitive or private data, rewrite Git history before pushing.'
        }
      : {})
  };
}

/**
 * Full streaming SHA-256 verification + leak audit behind a single-flight lock.
 */
export async function verifyManifest(): Promise<ManifestVerifyResponse> {
  if (activeVerifyPromise) {
    return activeVerifyPromise;
  }

  activeVerifyPromise = (async () => {
    try {
      const manifest = readManifest();
      const verifiedEntries: EntrySummary[] = [];

      for (const entry of manifest.entries) {
        let scriptChanged = false;
        if (entry.acquisition.scriptPath && entry.acquisition.scriptSha256) {
          try {
            const fullScript = resolveSafePath(entry.acquisition.scriptPath);
            if (fs.existsSync(fullScript) && fs.lstatSync(fullScript).isFile()) {
              const currentScriptHash = await computeFileSha256(fullScript);
              scriptChanged = currentScriptHash !== entry.acquisition.scriptSha256;
            }
          } catch {
            // ignore
          }
        }

        try {
          const fullPath = resolveEntryPath(entry.filepath);
          if (!fs.existsSync(fullPath) || !fs.lstatSync(fullPath).isFile()) {
            if (entry.storage?.syncStatus === 'remote_only' && entry.storage.uri) {
              verifiedEntries.push({ ...entry, status: 'remote_only', scriptChanged });
              continue;
            }
            verifiedEntries.push({ ...entry, status: 'missing', scriptChanged });
            continue;
          }
          const st = fs.lstatSync(fullPath);
          const actualSha256 = await computeFileSha256(fullPath);
          const status: VerifiedEntryStatus = actualSha256 === entry.sha256 ? 'verified' : 'modified';
          verifiedEntries.push({
            ...entry,
            status,
            diskSizeBytes: st.size,
            actualSha256,
            scriptChanged
          });
        } catch {
          if (entry.storage?.syncStatus === 'remote_only' && entry.storage.uri) {
            verifiedEntries.push({ ...entry, status: 'remote_only', scriptChanged });
          } else {
            verifiedEntries.push({ ...entry, status: 'missing', scriptChanged });
          }
        }
      }

      const untrackedRawFiles = scanUntrackedRawFiles(manifest);
      const leaks = await checkGitAndPublicationLeaks(manifest);
      lastVerifiedAt = new Date().toISOString();

      const hasIssues =
        untrackedRawFiles.length > 0 ||
        verifiedEntries.some((e) => e.status !== 'verified' && e.status !== 'remote_only') ||
        leaks.gitTrackedRawFiles.length > 0 ||
        leaks.publicationLeaks.length > 0;

      return {
        manifest,
        entries: verifiedEntries,
        untrackedRawFiles,
        lastVerifiedAt,
        hasIssues,
        leaks
      };
    } finally {
      activeVerifyPromise = null;
    }
  })();

  return activeVerifyPromise;
}

/**
 * Checks whether a path inside data/raw/ corresponds to a manifest entry
 * (used when renaming or deleting raw data files from File Explorer).
 */
export function findManifestEntryByPath(relPath: string): DataManifestEntry | undefined {
  const normalized = normalizeWorkspaceRelPath(relPath);
  const manifest = readManifest();
  return manifest.entries.find((e) => normalizeWorkspaceRelPath(e.filepath) === normalized);
}

/**
 * Updates the filepath of a manifest entry when a registered raw file is renamed.
 */
export async function updateManifestFilepath(oldRelPath: string, newRelPath: string): Promise<boolean> {
  return withWriteLock(async () => {
    const oldNorm = normalizeWorkspaceRelPath(oldRelPath);
    const newNorm = normalizeWorkspaceRelPath(newRelPath);
    const manifest = readManifest();
    const entry = manifest.entries.find((e) => normalizeWorkspaceRelPath(e.filepath) === oldNorm);
    if (!entry) return false;
    entry.filepath = newNorm;
    writeManifestSync(manifest);
    return true;
  });
}
