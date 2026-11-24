import fs from 'fs';
import path from 'path';
import { WORKSPACE_DIR, TARGET_USER } from '../config.js';

const MAX_SYMLINK_HOPS = 40;

function getCanonicalWorkspaceDir(): string {
  const abs = path.resolve(WORKSPACE_DIR);
  if (fs.existsSync(abs)) {
    return fs.realpathSync(abs);
  }
  return abs;
}

/**
 * Walks path segments using lstatSync + readlinkSync so that BOTH existing AND
 * dangling symlinks are resolved faithfully without failing open.
 */
function resolvePathWithSymlinks(targetAbs: string, hops = 0): string {
  if (hops > MAX_SYMLINK_HOPS) {
    throw new Error('Access denied: Too many symbolic link levels');
  }

  const normalized = path.resolve(targetAbs);
  const parsed = path.parse(normalized);
  const segments = normalized.slice(parsed.root.length).split(path.sep).filter(Boolean);

  let current = parsed.root;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let lst: fs.Stats | null = null;
    try {
      lst = fs.lstatSync(current);
    } catch (err: any) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        // Non-existent suffix segment: append remaining segments as literal paths
        const remaining = segments.slice(i + 1);
        return remaining.length > 0 ? path.join(current, ...remaining) : current;
      }
      // Fail closed on EACCES / ELOOP / unknown errors
      throw new Error(`Access denied: Unable to inspect path (${err?.code || 'error'})`);
    }

    if (lst.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(current);
      const resolvedLink = path.resolve(path.dirname(current), linkTarget);
      const remaining = segments.slice(i + 1);
      const nextTarget = remaining.length > 0 ? path.join(resolvedLink, ...remaining) : resolvedLink;
      return resolvePathWithSymlinks(nextTarget, hops + 1);
    }
  }

  return current;
}

export function isSensitiveEnvPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = normalized.split('/').filter(Boolean);
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (lower === '.env' || (lower.startsWith('.env.') && lower !== '.env.example')) {
      return true;
    }
  }
  return false;
}

export function isPathSafe(relativePath: string): boolean {
  try {
    resolveSafePath(relativePath);
    return true;
  } catch {
    return false;
  }
}

export function resolveSafePath(relativePath: string): string {
  if (relativePath.includes('\0')) {
    throw new Error('Access denied: Invalid path');
  }
  const workspaceAbs = path.resolve(WORKSPACE_DIR);
  const resolved = path.resolve(workspaceAbs, path.normalize(relativePath));
  if (resolved !== workspaceAbs && !resolved.startsWith(workspaceAbs + path.sep)) {
    throw new Error('Access denied: Path is outside workspace');
  }

  const canonicalRoot = getCanonicalWorkspaceDir();
  const realTarget = resolvePathWithSymlinks(resolved);
  if (realTarget !== canonicalRoot && !realTarget.startsWith(canonicalRoot + path.sep)) {
    throw new Error('Access denied: Path resolves outside workspace');
  }

  return resolved;
}

export function applyTargetOwnership(targetPath: string): void {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    if (TARGET_USER.uid !== undefined && TARGET_USER.uid !== 0) {
      try {
        fs.chownSync(targetPath, TARGET_USER.uid, TARGET_USER.gid ?? TARGET_USER.uid);
      } catch {
        // ignore permission errors in restricted environments
      }
    }
  }
}

/**
 * Recursively creates a directory and applies TARGET_USER ownership to every
 * newly created directory segment inside WORKSPACE_DIR.
 */
export function ensureDirWithOwnership(dirPath: string): void {
  const absDir = path.resolve(dirPath);
  if (fs.existsSync(absDir)) return;

  const toCreate: string[] = [];
  let cursor = absDir;
  while (!fs.existsSync(cursor)) {
    toCreate.unshift(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  fs.mkdirSync(absDir, { recursive: true });
  for (const created of toCreate) {
    applyTargetOwnership(created);
  }
}

/**
 * Atomic file write (temp file + rename) with ownership preservation.
 */
export function atomicWriteFileSync(fullPath: string, content: string): void {
  const parent = path.dirname(fullPath);
  ensureDirWithOwnership(parent);
  const tmpPath = `${fullPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  applyTargetOwnership(tmpPath);
  fs.renameSync(tmpPath, fullPath);
  applyTargetOwnership(fullPath);
}
