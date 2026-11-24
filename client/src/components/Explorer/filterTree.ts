import type { FileItem } from '../../types';

export interface ExplorerViewPrefs {
  showDotItems: boolean;
  showAuxCodingFiles: boolean;
  documentsFirst: boolean;
  projectRootFile?: string;
}

const ALWAYS_VISIBLE_TOP_DIRS = new Set(['plans', 'code', 'src', 'data', 'figures', 'web-report']);

function countNodes(items: FileItem[]): number {
  let count = 0;
  for (const item of items) {
    count += 1;
    if (item.children) {
      count += countNodes(item.children);
    }
  }
  return count;
}

function isHiddenByAuxCodingFilter(item: FileItem, depth: number, insideDotTree: boolean): boolean {
  const lowerPath = item.path.toLowerCase();
  const topDir = lowerPath.split('/')[0] || '';

  // Dot-items (and files inside dot-folders) are governed by the dot-folder toggle, not aux coding
  if (insideDotTree || item.isDotItem || item.name.startsWith('.')) {
    return false;
  }

  // Keep `data/manifest.json` hidden in Scientist View (opened via Data Provenance button)
  if (lowerPath === 'data/manifest.json') {
    return true;
  }

  // Always preserve core top-level directories and everything inside them (except dotfiles handled separately)
  if (depth === 0 && item.isDirectory && ALWAYS_VISIBLE_TOP_DIRS.has(item.name.toLowerCase())) {
    return false;
  }
  if (ALWAYS_VISIBLE_TOP_DIRS.has(topDir)) {
    return false;
  }

  if (item.category === 'aux-code' || item.category === 'config') {
    return true;
  }

  return false;
}

function sortItems(items: FileItem[], documentsFirst: boolean, projectRootFile?: string): FileItem[] {
  const sorted = [...items];
  sorted.sort((a, b) => {
    if (documentsFirst) {
      const aIsRoot = projectRootFile ? a.path === projectRootFile : false;
      const bIsRoot = projectRootFile ? b.path === projectRootFile : false;
      if (aIsRoot !== bIsRoot) return aIsRoot ? -1 : 1;

      const aIsDoc = !a.isDirectory && a.extension === '.md';
      const bIsDoc = !b.isDirectory && b.extension === '.md';
      if (aIsDoc !== bIsDoc) return aIsDoc ? -1 : 1;
    }

    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return sorted;
}

export function filterAndSortTree(
  tree: FileItem[],
  prefs: ExplorerViewPrefs
): { visibleTree: FileItem[]; hiddenCount: number } {
  let hiddenCount = 0;

  const visit = (items: FileItem[], depth: number, insideDotTree: boolean): FileItem[] => {
    const kept: FileItem[] = [];

    for (const item of items) {
      const isDot = item.isDotItem ?? item.name.startsWith('.');

      if (isDot && !prefs.showDotItems) {
        hiddenCount += 1 + (item.children ? countNodes(item.children) : 0);
        continue;
      }

      const inDot = insideDotTree || isDot;
      if (!prefs.showAuxCodingFiles && isHiddenByAuxCodingFilter(item, depth, inDot)) {
        hiddenCount += 1 + (item.children ? countNodes(item.children) : 0);
        continue;
      }

      if (item.isDirectory) {
        const nextChildren = item.children ? visit(item.children, depth + 1, inDot) : [];
        kept.push({ ...item, children: nextChildren });
      } else {
        kept.push(item);
      }
    }

    return sortItems(kept, prefs.documentsFirst, prefs.projectRootFile);
  };

  const visibleTree = visit(tree, 0, false);
  return { visibleTree, hiddenCount };
}

export function collectWorkspaceFilePaths(tree: FileItem[]): Set<string> {
  const paths = new Set<string>();
  const walk = (items: FileItem[]) => {
    for (const item of items) {
      if (!item.isDirectory) {
        paths.add(item.path);
      }
      if (item.children) walk(item.children);
    }
  };
  walk(tree);
  return paths;
}
