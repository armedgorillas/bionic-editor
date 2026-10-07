import chokidar from 'chokidar';
import path from 'path';
import { WORKSPACE_DIR } from '../config.js';

export type FileChangeCallback = (event: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir', relPath: string) => void;

let watcher: any = null;

export function initFileWatcher(onFileChange: FileChangeCallback): void {
  if (watcher) {
    watcher.close();
  }

  watcher = chokidar.watch(WORKSPACE_DIR, {
    ignored: [
      /(^|[\/\\])\../, // dotfiles/dotfolders
      '**/.venv/**',
      '**/node_modules/**',
      '**/__pycache__/**',
      '**/.git/**'
    ],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100
    }
  });

  const handle = (type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir') => (filePath: string) => {
    const rel = path.relative(WORKSPACE_DIR, filePath);
    onFileChange(type, rel);
  };

  watcher
    .on('add', handle('add'))
    .on('change', handle('change'))
    .on('unlink', handle('unlink'))
    .on('addDir', handle('addDir'))
    .on('unlinkDir', handle('unlinkDir'));
}
