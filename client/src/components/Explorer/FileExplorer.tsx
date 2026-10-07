import React, { useState } from 'react';
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
  LayoutDashboard
} from 'lucide-react';
import type { FileItem } from '../../types';

interface FileExplorerProps {
  tree: FileItem[];
  activeFilePath: string | null;
  onSelectFile: (path: string) => void;
  onCreateItem: (path: string, isDirectory: boolean) => Promise<void>;
  onRenameItem: (oldPath: string, newPath: string) => Promise<void>;
  onDeleteItem: (path: string) => Promise<void>;
  onUploadFile: (file: File, targetDir: string) => Promise<void>;
  onRefresh: () => void;
  onInitTemplate: () => Promise<void>;
}

export const FileExplorer: React.FC<FileExplorerProps> = ({
  tree,
  activeFilePath,
  onSelectFile,
  onCreateItem,
  onRenameItem,
  onDeleteItem,
  onUploadFile,
  onRefresh,
  onInitTemplate
}) => {
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    'data': true,
    'data/raw': true,
    'src': true,
    'web-report': true
  });
  const [creatingType, setCreatingType] = useState<'file' | 'folder' | null>(null);
  const [createParentPath, setCreateParentPath] = useState<string>('');
  const [newItemName, setNewItemName] = useState<string>('');
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string>('');

  const toggleFolder = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedFolders(prev => ({ ...prev, [path]: !prev[path] }));
  };

  const startCreate = (parentPath: string, type: 'file' | 'folder', e: React.MouseEvent) => {
    e.stopPropagation();
    setCreateParentPath(parentPath);
    setCreatingType(type);
    setNewItemName('');
    if (parentPath && !expandedFolders[parentPath]) {
      setExpandedFolders(prev => ({ ...prev, [parentPath]: true }));
    }
  };

  const submitCreate = async () => {
    if (!newItemName.trim() || !creatingType) return;
    const target = createParentPath ? `${createParentPath}/${newItemName.trim()}` : newItemName.trim();
    try {
      await onCreateItem(target, creatingType === 'folder');
      setCreatingType(null);
      setNewItemName('');
    } catch (err: any) {
      alert(`Error creating ${creatingType}: ${err.message}`);
    }
  };

  const submitRename = async () => {
    if (!renamingPath || !renameValue.trim()) return;
    const parts = renamingPath.split('/');
    parts.pop();
    const newPath = parts.length > 0 ? `${parts.join('/')}/${renameValue.trim()}` : renameValue.trim();
    try {
      await onRenameItem(renamingPath, newPath);
      setRenamingPath(null);
      setRenameValue('');
    } catch (err: any) {
      alert(`Error renaming item: ${err.message}`);
    }
  };

  const getFileIcon = (item: FileItem) => {
    if (item.name === 'SPEC.md') {
      return <Sparkles className="w-4 h-4 text-amber-500 mr-2 flex-shrink-0" />;
    }
    const ext = item.extension?.toLowerCase();
    if (ext === '.md') return <FileText className="w-4 h-4 text-blue-500 mr-2 flex-shrink-0" />;
    if (ext === '.py') return <FileCode className="w-4 h-4 text-emerald-600 mr-2 flex-shrink-0" />;
    if (ext === '.csv' || ext === '.tsv' || ext === '.xlsx') return <Table className="w-4 h-4 text-teal-600 mr-2 flex-shrink-0" />;
    if (['.png', '.jpg', '.jpeg', '.svg'].includes(ext || '')) return <ImageIcon className="w-4 h-4 text-purple-500 mr-2 flex-shrink-0" />;
    if (ext === '.html') return <LayoutDashboard className="w-4 h-4 text-orange-500 mr-2 flex-shrink-0" />;
    return <File className="w-4 h-4 text-gray-400 mr-2 flex-shrink-0" />;
  };

  const renderTree = (items: FileItem[], depth = 0) => {
    return items.map(item => {
      const isExpanded = Boolean(expandedFolders[item.path]);
      const isActive = activeFilePath === item.path;
      const isRenaming = renamingPath === item.path;

      if (item.isDirectory) {
        return (
          <div key={item.path} className="select-none">
            <div
              className={`flex items-center justify-between px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100 rounded cursor-pointer group`}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              onClick={(e) => toggleFolder(item.path, e)}
            >
              <div className="flex items-center truncate">
                {isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-gray-400 mr-1 flex-shrink-0" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-gray-400 mr-1 flex-shrink-0" />
                )}
                {isExpanded ? (
                  <FolderOpen className="w-4 h-4 text-amber-500 mr-1.5 flex-shrink-0" />
                ) : (
                  <Folder className="w-4 h-4 text-amber-500 mr-1.5 flex-shrink-0" />
                )}
                <span className="font-medium truncate">{item.name}</span>
              </div>

              <div className="opacity-0 group-hover:opacity-100 flex items-center space-x-1">
                <button
                  title="New File inside"
                  className="p-0.5 hover:text-blue-600"
                  onClick={(e) => startCreate(item.path, 'file', e)}
                >
                  <Plus className="w-3 h-3" />
                </button>
                <button
                  title="Delete Folder"
                  className="p-0.5 hover:text-red-600"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete folder "${item.name}" and all its contents?`)) {
                      onDeleteItem(item.path);
                    }
                  }}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>

            {isExpanded && (
              <div>
                {creatingType && createParentPath === item.path && (
                  <div className="flex items-center px-2 py-1" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
                    <input
                      autoFocus
                      type="text"
                      className="text-xs border border-blue-400 rounded px-1.5 py-0.5 w-full outline-none"
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

      return (
        <div
          key={item.path}
          className={`flex items-center justify-between px-2 py-1.5 text-xs rounded cursor-pointer group ${
            isActive ? 'bg-blue-50 text-blue-800 font-medium' : 'text-gray-700 hover:bg-gray-100'
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
                className="text-xs border border-blue-400 rounded px-1 py-0.5 w-full outline-none"
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
              <span className={`truncate ${item.name === 'SPEC.md' ? 'font-semibold text-amber-900' : ''}`}>
                {item.name}
              </span>
            )}
          </div>

          <div className="opacity-0 group-hover:opacity-100 flex items-center space-x-1 flex-shrink-0">
            <button
              title="Rename"
              className="p-0.5 hover:text-blue-600 text-gray-400"
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
              className="p-0.5 hover:text-red-600 text-gray-400"
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
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#f8f9fa] border-r border-gray-200 w-64 select-none">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center space-x-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">Workspace</span>
        </div>
        <div className="flex items-center space-x-1 text-gray-500">
          <button
            title="New File in root"
            className="p-1 hover:bg-gray-200 rounded hover:text-gray-800"
            onClick={(e) => startCreate('', 'file', e)}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <label title="Upload Dataset/File" className="p-1 hover:bg-gray-200 rounded hover:text-gray-800 cursor-pointer">
            <Upload className="w-3.5 h-3.5" />
            <input type="file" className="hidden" onChange={handleFileUpload} />
          </label>
          <button
            title="Refresh"
            className="p-1 hover:bg-gray-200 rounded hover:text-gray-800"
            onClick={onRefresh}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Quick Launch Buttons for Scientists */}
      <div className="p-2 border-b border-gray-100 bg-white/60 space-y-1">
        <button
          onClick={() => onSelectFile('SPEC.md')}
          className={`w-full text-left px-2 py-1.5 rounded flex items-center justify-between text-xs font-medium transition ${
            activeFilePath === 'SPEC.md' 
              ? 'bg-amber-100 text-amber-900 border border-amber-300' 
              : 'hover:bg-amber-50 text-gray-700'
          }`}
        >
          <div className="flex items-center">
            <Sparkles className="w-3.5 h-3.5 text-amber-600 mr-2" />
            <span>SPEC.md (Analysis Plan)</span>
          </div>
          <span className="text-[10px] bg-amber-200/60 text-amber-800 px-1.5 rounded">Core</span>
        </button>
      </div>

      {/* Root creation input */}
      {creatingType && createParentPath === '' && (
        <div className="px-3 py-1.5 bg-blue-50/50">
          <input
            autoFocus
            type="text"
            className="text-xs border border-blue-400 rounded px-2 py-1 w-full outline-none"
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
        {tree.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-xs text-gray-500 mb-2">No files in workspace.</p>
            <button
              onClick={onInitTemplate}
              className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1 rounded shadow-sm"
            >
              Scaffold Scientific Template
            </button>
          </div>
        ) : (
          renderTree(tree)
        )}
      </div>

      {/* Footer Info */}
      <div className="p-2 border-t border-gray-200 text-[11px] text-gray-500 bg-gray-50 flex items-center justify-between">
        <span className="truncate">Cookiecutter Data Sci Layout</span>
        <button
          onClick={onInitTemplate}
          title="Reset / ensure standard template folders exist"
          className="hover:text-blue-600 text-gray-400"
        >
          Reset
        </button>
      </div>
    </div>
  );
};
