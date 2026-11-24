import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  Folder,
  FolderOpen,
  FileText,
  FileCode,
  Table,
  Image as ImageIcon,
  File,
  Plus,
  Upload,
  RefreshCw,
  Trash2,
  Edit2,
  ChevronRight,
  ChevronDown,
  Sparkles,
  LayoutDashboard,
  SlidersHorizontal,
  Database,
  ShieldCheck,
  ShieldAlert,
  Star
} from 'lucide-react';
import type { FileItem } from '../../types';
import { filterAndSortTree, type ExplorerViewPrefs } from './filterTree';

interface FileExplorerProps {
  tree: FileItem[];
  activeFilePath: string | null;
  projectRootFile: string;
  codingMode: boolean;
  dataManifestHasIssues?: boolean;
  dataManifestCount?: number;
  activeViewMode?: 'editor' | 'report' | 'manifest';
  onSelectFile: (path: string) => void;
  onOpenDataManifest: () => void;
  onSetProjectRootFile?: (path: string) => Promise<void>;
  onCreateItem: (path: string, isDirectory: boolean) => Promise<void>;
  onRenameItem: (oldPath: string, newPath: string) => Promise<void>;
  onDeleteItem: (path: string) => Promise<void>;
  onUploadFile: (file: File, targetDir: string) => Promise<void>;
  onRefresh: () => void;
  onInitTemplate: () => Promise<void>;
}

const VIEW_PREFS_STORAGE_KEY = 'bionic_explorer_view';
const PROTECTED_SYSTEM_DOT_DIRS = new Set(['.bionic', '.opencode']);

function loadSavedViewPrefs(): { showDotItems: boolean; showAuxCodingFiles: boolean; documentsFirst: boolean } {
  try {
    const raw = localStorage.getItem(VIEW_PREFS_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        showDotItems: Boolean(p.showDotItems),
        showAuxCodingFiles: Boolean(p.showAuxCodingFiles),
        documentsFirst: p.documentsFirst !== undefined ? Boolean(p.documentsFirst) : true
      };
    }
  } catch {}
  return {
    showDotItems: false,
    showAuxCodingFiles: false,
    documentsFirst: true
  };
}

export const FileExplorer: React.FC<FileExplorerProps> = ({
  tree,
  activeFilePath,
  projectRootFile,
  codingMode,
  dataManifestHasIssues = false,
  dataManifestCount = 0,
  activeViewMode = 'editor',
  onSelectFile,
  onOpenDataManifest,
  onSetProjectRootFile,
  onCreateItem,
  onRenameItem,
  onDeleteItem,
  onUploadFile,
  onRefresh,
  onInitTemplate
}) => {
  // All folders start collapsed by default (including plans/, code/, data/, figures/, web-report/)
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [creatingType, setCreatingType] = useState<'file' | 'folder' | null>(null);
  const [createParentPath, setCreateParentPath] = useState<string>('');
  const [newItemName, setNewItemName] = useState<string>('');
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string>('');
  const [showViewMenu, setShowViewMenu] = useState<boolean>(false);
  const [createdHiddenNotice, setCreatedHiddenNotice] = useState<{ text: string; kind: 'dot' | 'aux' } | null>(null);

  const [savedPrefs, setSavedPrefs] = useState(loadSavedViewPrefs);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const submittingCreateRef = useRef<boolean>(false);
  const submittingRenameRef = useRef<boolean>(false);

  useEffect(() => {
    if (!showViewMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (viewMenuRef.current && !viewMenuRef.current.contains(e.target as Node)) {
        setShowViewMenu(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowViewMenu(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [showViewMenu]);

  const updatePref = (patch: Partial<typeof savedPrefs>) => {
    setSavedPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(VIEW_PREFS_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  // Effective prefs: Coding Mode temporarily reveals aux coding files without mutating saved non-coder pref.
  // Dot-folders remain strictly controlled by the View menu toggle.
  const effectivePrefs: ExplorerViewPrefs = useMemo(
    () => ({
      showDotItems: savedPrefs.showDotItems,
      showAuxCodingFiles: codingMode ? true : savedPrefs.showAuxCodingFiles,
      documentsFirst: savedPrefs.documentsFirst,
      projectRootFile
    }),
    [savedPrefs, codingMode, projectRootFile]
  );

  const { visibleTree, hiddenCount } = useMemo(
    () => filterAndSortTree(tree, effectivePrefs),
    [tree, effectivePrefs]
  );

  const toggleFolder = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedFolders((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const startCreate = (parentPath: string, type: 'file' | 'folder', e: React.MouseEvent) => {
    e.stopPropagation();
    setCreateParentPath(parentPath);
    setCreatingType(type);
    setNewItemName('');
    if (parentPath && !expandedFolders[parentPath]) {
      setExpandedFolders((prev) => ({ ...prev, [parentPath]: true }));
    }
  };

  const submitCreate = async () => {
    if (submittingCreateRef.current || !newItemName.trim() || !creatingType) return;
    submittingCreateRef.current = true;
    const name = newItemName.trim();
    const type = creatingType;
    const target = createParentPath ? `${createParentPath}/${name}` : name;
    setCreatingType(null);
    setNewItemName('');
    try {
      await onCreateItem(target, type === 'folder');
      const isDot = name.startsWith('.');
      const lower = name.toLowerCase();
      const topDir = target.split('/')[0]?.toLowerCase() || '';
      const isAuxRoot =
        !['plans', 'code', 'src', 'data', 'figures', 'web-report'].includes(topDir) &&
        (['scripts', 'tests', 'requirements.txt', 'agents.md', 'opencode.jsonc', 'opencode.json'].includes(lower) ||
          /\.(py|r|js|ts|sh|json|jsonc|yml|yaml|toml|cfg|ini)$/i.test(lower));

      if (isDot && !effectivePrefs.showDotItems) {
        setCreatedHiddenNotice({ text: `Created "${target}" (hidden by View filter).`, kind: 'dot' });
      } else if (isAuxRoot && !effectivePrefs.showAuxCodingFiles) {
        setCreatedHiddenNotice({ text: `Created "${target}" (hidden by View filter).`, kind: 'aux' });
      }
    } catch (err: any) {
      alert(`Error creating ${type}: ${err.message}`);
    } finally {
      submittingCreateRef.current = false;
    }
  };

  const submitRename = async () => {
    if (submittingRenameRef.current || !renamingPath || !renameValue.trim()) return;
    submittingRenameRef.current = true;
    const currentPath = renamingPath;
    const nextName = renameValue.trim();
    setRenamingPath(null);
    setRenameValue('');
    const parts = currentPath.split('/');
    parts.pop();
    const newPath = parts.length > 0 ? `${parts.join('/')}/${nextName}` : nextName;
    if (newPath === currentPath) {
      submittingRenameRef.current = false;
      return;
    }
    try {
      await onRenameItem(currentPath, newPath);
    } catch (err: any) {
      alert(`Error renaming item: ${err.message}`);
    } finally {
      submittingRenameRef.current = false;
    }
  };

  const getFileIcon = (item: FileItem) => {
    if (item.path === projectRootFile) {
      return <Sparkles className="w-4 h-4 text-amber-500 mr-2 flex-shrink-0" />;
    }
    const ext = item.extension?.toLowerCase();
    if (ext === '.md') return <FileText className="w-4 h-4 text-blue-500 mr-2 flex-shrink-0" />;
    if (ext === '.py' || ext === '.r' || ext === '.js' || ext === '.ts') {
      return <FileCode className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mr-2 flex-shrink-0" />;
    }
    if (ext === '.csv' || ext === '.tsv' || ext === '.xlsx') {
      return <Table className="w-4 h-4 text-teal-600 dark:text-teal-400 mr-2 flex-shrink-0" />;
    }
    if (['.png', '.jpg', '.jpeg', '.svg', '.webp'].includes(ext || '')) {
      return <ImageIcon className="w-4 h-4 text-purple-500 mr-2 flex-shrink-0" />;
    }
    if (ext === '.html') return <LayoutDashboard className="w-4 h-4 text-orange-500 mr-2 flex-shrink-0" />;
    return <File className="w-4 h-4 text-muted mr-2 flex-shrink-0" />;
  };

  const renderTree = (items: FileItem[], depth = 0) => {
    return items.map((item) => {
      const isExpanded = Boolean(expandedFolders[item.path]);
      const isActive = activeViewMode === 'editor' && activeFilePath === item.path;
      const isRenaming = renamingPath === item.path;
      const isProtectedSystemDir = depth === 0 && item.isDirectory && PROTECTED_SYSTEM_DOT_DIRS.has(item.name);

      if (item.isDirectory) {
        return (
          <div key={item.path} className="select-none">
            <div
              className="flex items-center justify-between px-2 py-1.5 text-xs text-ink hover:bg-elevated rounded cursor-pointer group"
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              onClick={(e) => toggleFolder(item.path, e)}
            >
              <div className="flex items-center truncate">
                {isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-muted mr-1 flex-shrink-0" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-muted mr-1 flex-shrink-0" />
                )}
                {isExpanded ? (
                  <FolderOpen className="w-4 h-4 text-amber-500 mr-1.5 flex-shrink-0" />
                ) : (
                  <Folder className="w-4 h-4 text-amber-500 mr-1.5 flex-shrink-0" />
                )}
                <span className={`font-medium truncate ${item.isDotItem ? 'text-muted' : ''}`}>
                  {item.name}
                </span>
              </div>

              <div className="opacity-0 group-hover:opacity-100 flex items-center space-x-1">
                <button
                  title="New File inside"
                  className="p-0.5 text-muted hover:text-accent"
                  onClick={(e) => startCreate(item.path, 'file', e)}
                >
                  <Plus className="w-3 h-3" />
                </button>
                {!isProtectedSystemDir && (
                  <button
                    title="Delete Folder"
                    className="p-0.5 text-muted hover:text-red-600"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete folder "${item.name}" and all its contents?`)) {
                        onDeleteItem(item.path);
                      }
                    }}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            {isExpanded && (
              <div>
                {creatingType && createParentPath === item.path && (
                  <div className="flex items-center px-2 py-1" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
                    <input
                      autoFocus
                      type="text"
                      className="text-xs border border-accent bg-surface text-ink rounded px-1.5 py-0.5 w-full outline-none"
                      placeholder={`New ${creatingType} name...`}
                      value={newItemName}
                      onChange={(e) => setNewItemName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitCreate();
                        if (e.key === 'Escape') setCreatingType(null);
                      }}
                      onBlur={submitCreate}
                    />
                  </div>
                )}
                {item.children && renderTree(item.children, depth + 1)}
              </div>
            )}
          </div>
        );
      }

      const isRootFile = item.path === projectRootFile;
      const canSetAsRoot = item.extension === '.md' && !isRootFile && Boolean(onSetProjectRootFile);

      return (
        <div
          key={item.path}
          className={`flex items-center justify-between px-2 py-1.5 text-xs rounded cursor-pointer group ${
            isActive
              ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-800 dark:text-blue-200 font-medium'
              : 'text-ink hover:bg-elevated'
          }`}
          style={{ paddingLeft: `${depth * 12 + 18}px` }}
          onClick={() => onSelectFile(item.path)}
        >
          <div className="flex items-center truncate flex-1 mr-1">
            {getFileIcon(item)}
            {isRenaming ? (
              <input
                autoFocus
                type="text"
                className="text-xs border border-accent bg-surface text-ink rounded px-1 py-0.5 w-full outline-none"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitRename();
                  if (e.key === 'Escape') setRenamingPath(null);
                }}
                onBlur={submitRename}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className={`truncate ${
                  isRootFile
                    ? 'font-semibold text-amber-800 dark:text-amber-300'
                    : item.isDotItem
                      ? 'text-muted'
                      : ''
                }`}
              >
                {item.name}
              </span>
            )}
          </div>

          <div className="opacity-0 group-hover:opacity-100 flex items-center space-x-1 flex-shrink-0">
            {canSetAsRoot && (
              <button
                title="Set as Project Root File"
                className="p-0.5 text-muted hover:text-amber-500"
                onClick={(e) => {
                  e.stopPropagation();
                  onSetProjectRootFile?.(item.path);
                }}
              >
                <Star className="w-3 h-3" />
              </button>
            )}
            <button
              title="Rename"
              className="p-0.5 hover:text-accent text-muted"
              onClick={(e) => {
                e.stopPropagation();
                setRenamingPath(item.path);
                setRenameValue(item.name);
              }}
            >
              <Edit2 className="w-3 h-3" />
            </button>
            <button
              title="Delete File"
              className="p-0.5 hover:text-red-600 text-muted"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete file "${item.name}"?`)) {
                  onDeleteItem(item.path);
                }
              }}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>
      );
    });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onUploadFile(e.target.files[0], 'data/raw');
      e.target.value = '';
    }
  };

  return (
    <div className="flex flex-col h-full w-full bg-panel text-ink select-none overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-edge flex items-center justify-between relative">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">Workspace</span>

        <div className="flex items-center space-x-1 text-muted">
          <button
            title="New File in root"
            className="p-1 hover:bg-elevated rounded hover:text-ink transition"
            onClick={(e) => startCreate('', 'file', e)}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <label
            title="Upload Dataset to data/raw/"
            className="p-1 hover:bg-elevated rounded hover:text-ink cursor-pointer transition"
          >
            <Upload className="w-3.5 h-3.5" />
            <input type="file" className="hidden" onChange={handleFileUpload} />
          </label>
          <button
            title="Refresh"
            className="p-1 hover:bg-elevated rounded hover:text-ink transition"
            onClick={onRefresh}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>

          {/* View Menu Button */}
          <div className="relative" ref={viewMenuRef}>
            <button
              type="button"
              title="Explorer View Options"
              onClick={() => setShowViewMenu((v) => !v)}
              className={`relative p-1 rounded transition cursor-pointer ${
                showViewMenu ? 'bg-elevated text-accent' : 'hover:bg-elevated hover:text-ink'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              {hiddenCount > 0 && (
                <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-accent" />
              )}
            </button>

            {showViewMenu && (
              <div className="absolute right-0 mt-1.5 w-60 rounded-xl bg-elevated border border-edge shadow-xl z-40 p-2.5 space-y-2 text-xs text-ink">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted px-1">
                  Explorer View
                </div>

                <label className="flex items-start space-x-2 p-1.5 rounded-lg hover:bg-panel cursor-pointer">
                  <input
                    type="checkbox"
                    checked={savedPrefs.showDotItems}
                    onChange={(e) => updatePref({ showDotItems: e.target.checked })}
                    className="mt-0.5 accent-blue-600"
                  />
                  <div>
                    <div className="font-medium leading-tight">Show dot-folders &amp; hidden files</div>
                    <div className="text-[10px] text-muted mt-0.5">Toggle <code className="font-mono">.bionic</code>, <code className="font-mono">.opencode</code>, <code className="font-mono">.gitignore</code></div>
                  </div>
                </label>

                <label
                  className={`flex items-start space-x-2 p-1.5 rounded-lg ${
                    codingMode ? 'opacity-70 cursor-not-allowed' : 'hover:bg-panel cursor-pointer'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={codingMode ? true : savedPrefs.showAuxCodingFiles}
                    disabled={codingMode}
                    onChange={(e) => updatePref({ showAuxCodingFiles: e.target.checked })}
                    className="mt-0.5 accent-blue-600"
                  />
                  <div>
                    <div className="font-medium leading-tight">Show auxiliary coding &amp; config files</div>
                    <div className="text-[10px] text-muted mt-0.5">
                      {codingMode
                        ? 'Shown automatically in Coding Mode'
                        : 'Show scripts/, tests/, requirements.txt, configs'}
                    </div>
                  </div>
                </label>

                <label className="flex items-start space-x-2 p-1.5 rounded-lg hover:bg-panel cursor-pointer">
                  <input
                    type="checkbox"
                    checked={savedPrefs.documentsFirst}
                    onChange={(e) => updatePref({ documentsFirst: e.target.checked })}
                    className="mt-0.5 accent-blue-600"
                  />
                  <div>
                    <div className="font-medium leading-tight">Pin documents first</div>
                    <div className="text-[10px] text-muted mt-0.5">Keep Markdown plans above folders</div>
                  </div>
                </label>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quick Launch Shortcuts for Scientists */}
      <div className="p-2 border-b border-edge bg-elevated/70 space-y-1">
        <button
          onClick={() => onSelectFile(projectRootFile)}
          className={`w-full text-left px-2 py-1.5 rounded flex items-center justify-between text-xs font-medium transition cursor-pointer ${
            activeViewMode === 'editor' && activeFilePath === projectRootFile
              ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-900 dark:text-amber-200 border border-amber-300 dark:border-amber-800'
              : 'hover:bg-amber-50 dark:hover:bg-amber-950/30 text-ink'
          }`}
          title={`Open Project Root Plan (${projectRootFile})`}
        >
          <div className="flex items-center truncate pr-1">
            <Sparkles className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 mr-2 flex-shrink-0" />
            <span className="truncate">{projectRootFile}</span>
          </div>
          <span className="text-[10px] bg-amber-200/70 dark:bg-amber-900/60 text-amber-900 dark:text-amber-200 px-1.5 rounded flex-shrink-0">
            Plan
          </span>
        </button>

        <button
          onClick={onOpenDataManifest}
          className={`w-full text-left px-2 py-1.5 rounded flex items-center justify-between text-xs font-medium transition cursor-pointer ${
            activeViewMode === 'manifest'
              ? 'bg-teal-100 dark:bg-teal-950/60 text-teal-900 dark:text-teal-200 border border-teal-300 dark:border-teal-800'
              : 'hover:bg-teal-50 dark:hover:bg-teal-950/30 text-ink'
          }`}
          title="View & verify Data Provenance manifest for data/raw/"
        >
          <div className="flex items-center truncate pr-1">
            <Database className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 mr-2 flex-shrink-0" />
            <span className="truncate">Data Provenance</span>
          </div>
          {dataManifestHasIssues ? (
            <span className="inline-flex items-center space-x-0.5 text-[10px] bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 px-1.5 rounded flex-shrink-0">
              <ShieldAlert className="w-2.5 h-2.5" />
              <span>Check</span>
            </span>
          ) : (
            <span className="inline-flex items-center space-x-0.5 text-[10px] bg-emerald-100 dark:bg-emerald-950/70 text-emerald-800 dark:text-emerald-300 px-1.5 rounded flex-shrink-0">
              <ShieldCheck className="w-2.5 h-2.5" />
              <span>{dataManifestCount}</span>
            </span>
          )}
        </button>
      </div>

      {/* Created-hidden notification */}
      {createdHiddenNotice && (
        <div className="mx-2 mt-2 p-2 rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-[11px] text-blue-800 dark:text-blue-200 flex items-center justify-between gap-1">
          <span className="truncate">{createdHiddenNotice.text}</span>
          <button
            onClick={() => {
              if (createdHiddenNotice.kind === 'dot') {
                updatePref({ showDotItems: true });
              } else {
                updatePref({ showAuxCodingFiles: true });
              }
              setCreatedHiddenNotice(null);
            }}
            className="underline font-medium flex-shrink-0 cursor-pointer"
          >
            Show
          </button>
        </div>
      )}

      {/* Root creation input */}
      {creatingType && createParentPath === '' && (
        <div className="px-3 py-1.5 bg-blue-50/50 dark:bg-blue-950/30">
          <input
            autoFocus
            type="text"
            className="text-xs border border-accent bg-surface text-ink rounded px-2 py-1 w-full outline-none"
            placeholder={`New root ${creatingType} name...`}
            value={newItemName}
            onChange={(e) => setNewItemName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCreate();
              if (e.key === 'Escape') setCreatingType(null);
            }}
            onBlur={submitCreate}
          />
        </div>
      )}

      {/* File Tree View */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
        {visibleTree.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-xs text-muted mb-2">
              {tree.length === 0 ? 'No files in workspace.' : 'All items are hidden by View filters.'}
            </p>
            {tree.length === 0 ? (
              <button
                onClick={onInitTemplate}
                className="text-xs bg-accent hover:opacity-90 text-white px-2.5 py-1 rounded shadow-sm cursor-pointer"
              >
                Scaffold Scientific Template
              </button>
            ) : (
              <button
                onClick={() => setShowViewMenu(true)}
                className="text-xs border border-edge bg-elevated hover:bg-surface text-ink px-2.5 py-1 rounded cursor-pointer"
              >
                Open View Menu
              </button>
            )}
          </div>
        ) : (
          renderTree(visibleTree)
        )}
      </div>

      {/* Footer Info & Hidden Item Indicator */}
      <div className="px-2.5 py-2 border-t border-edge text-[11px] text-muted bg-panel flex items-center justify-between gap-2">
        {hiddenCount > 0 ? (
          <button
            type="button"
            onClick={() => setShowViewMenu(true)}
            className="truncate hover:text-ink transition cursor-pointer text-left"
            title="Click to adjust Explorer View filters"
          >
            {hiddenCount} hidden {hiddenCount === 1 ? 'item' : 'items'} · View
          </button>
        ) : (
          <span className="truncate">Scientific Workspace</span>
        )}
        <button
          onClick={onInitTemplate}
          title="Ensure standard scientific folders exist"
          className="hover:text-accent text-muted flex-shrink-0 cursor-pointer"
        >
          Init
        </button>
      </div>
    </div>
  );
};
