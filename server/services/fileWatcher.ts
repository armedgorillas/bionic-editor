import chokidar from 'chokidar';
import path from 'path';
import { WORKSPACE_DIR } from '../config.js';

export type FileChangeCallback = (event: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir', relPath: string) => void;

let watcher: any = null;

const IGNORED_SEGMENTS = new Set([
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

/**
 * Chokidar v5 removed glob support in `ignored`; use a fast path predicate instead.
 */
export function shouldIgnoreWatchedPath(filePath: string): boolean {
  const rel = path.relative(WORKSPACE_DIR, filePath).replace(/\\/g, '/');
  if (!rel || rel === '.') return false;

  const segments = rel.split('/');
  for (const seg of segments) {
    if (IGNORED_SEGMENTS.has(seg)) return true;
  }

  // Ignore internal chat session logs and atomic temp files
  if (rel === '.bionic/sessions' || rel.startsWith('.bionic/sessions/')) return true;
  if (rel === '.bionic/opencode-sessions.json') return true;
  if (/\.tmp\.\d+\./.test(path.basename(rel))) return true;

  return false;
}

export function initFileWatcher(onFileChange: FileChangeCallback): void {
  if (watcher) {
    watcher.close();
  }

  watcher = chokidar.watch(WORKSPACE_DIR, {
    ignored: shouldIgnoreWatchedPath,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100
    }
  });

  const handle = (type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir') => (filePath: string) => {
    const rel = path.relative(WORKSPACE_DIR, filePath).replace(/\\/g, '/');
    if (shouldIgnoreWatchedPath(filePath)) return;
    onFileChange(type, rel);
  };

  watcher
    .on('add', handle('add'))
    .on('change', handle('change'))
    .on('unlink', handle('unlink'))
    .on('addDir', handle('addDir'))
    .on('unlinkDir', handle('unlinkDir'))
    .on('error', (err: any) => {
      console.warn('File watcher warning:', err?.message || err);
    });
}

export function closeFileWatcher(): void {
  if (watcher) {
    try {
      watcher.close();
    } catch {}
    watcher = null;
  }
}
