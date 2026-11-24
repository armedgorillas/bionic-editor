import React, { useState, useEffect, useRef, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import { Play, CheckCircle2, Clock } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';

interface MonacoViewerProps {
  filePath: string;
  initialContent: string;
  onSave: (path: string, content: string) => Promise<void>;
  onDirtyChange?: (isDirty: boolean) => void;
  onRunPython?: (path: string) => void;
}

export const MonacoViewer: React.FC<MonacoViewerProps> = ({
  filePath,
  initialContent,
  onSave,
  onDirtyChange,
  onRunPython
}) => {
  const { resolvedMode } = useTheme();
  const [content, setContent] = useState<string>(initialContent);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const saveTimeoutRef = useRef<any>(null);
  const saveStatusRef = useRef<'saved' | 'saving' | 'unsaved'>('saved');
  const lastSavedRef = useRef<string>(initialContent);
  const latestContentRef = useRef<string>(initialContent);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onSaveRef = useRef(onSave);
  const filePathRef = useRef(filePath);

  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
    onSaveRef.current = onSave;
    filePathRef.current = filePath;
  }, [onDirtyChange, onSave, filePath]);

  const updateStatus = useCallback((status: 'saved' | 'saving' | 'unsaved') => {
    saveStatusRef.current = status;
    setSaveStatus(status);
    onDirtyChangeRef.current?.(status !== 'saved');
  }, []);

  // Flush any pending unsaved code edits on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
        if (saveStatusRef.current === 'unsaved' && latestContentRef.current !== lastSavedRef.current) {
          onSaveRef.current(filePathRef.current, latestContentRef.current).catch(() => {});
        }
      }
      onDirtyChangeRef.current?.(false);
    };
  }, []);

  // Sync external updates ONLY when clean and different from our last seen initialContent
  const [prevInitial, setPrevInitial] = useState<string>(initialContent);
  if (initialContent !== prevInitial) {
    setPrevInitial(initialContent);
    if (saveStatus === 'saved') {
      setContent(initialContent);
    }
  }
  useEffect(() => {
    if (saveStatusRef.current === 'saved') {
      lastSavedRef.current = initialContent;
      latestContentRef.current = initialContent;
    }
  }, [initialContent]);

  const getLanguage = (path: string): string => {
    const ext = path.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'py': return 'python';
      case 'js': return 'javascript';
      case 'ts': return 'typescript';
      case 'json':
      case 'jsonc': return 'json';
      case 'html': return 'html';
      case 'css': return 'css';
      case 'sh': return 'shell';
      case 'r': return 'r';
      case 'csv': return 'plaintext';
      case 'yaml':
      case 'yml': return 'yaml';
      default: return 'plaintext';
    }
  };

  const handleEditorChange = (value: string | undefined) => {
    const val = value ?? '';
    latestContentRef.current = val;
    setContent(val);
    updateStatus('unsaved');

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      updateStatus('saving');
      try {
        lastSavedRef.current = val;
        await onSaveRef.current(filePathRef.current, val);
        updateStatus('saved');
      } catch {
        updateStatus('unsaved');
      }
    }, 800);
  };

  const isPython = filePath.endsWith('.py');

  return (
    <div className="flex flex-col h-full bg-surface text-ink overflow-hidden">
      {/* File Bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-panel text-ink text-xs border-b border-edge select-none">
        <div className="flex items-center space-x-2">
          <span className="font-mono text-ink">{filePath}</span>
          <span className="text-[10px] bg-elevated border border-edge text-muted px-1.5 py-0.5 rounded uppercase">
            {getLanguage(filePath)}
          </span>
        </div>

        <div className="flex items-center space-x-3">
          {isPython && onRunPython && (
            <button
              onClick={() => onRunPython(filePath)}
              className="flex items-center space-x-1.5 bg-emerald-700 hover:bg-emerald-600 text-white px-2.5 py-1 rounded shadow-sm text-xs transition cursor-pointer"
              title="Execute script in project virtual environment"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>Run in .venv</span>
            </button>
          )}

          <div className="flex items-center space-x-1 text-muted">
            {saveStatus === 'saved' && (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                <span>Saved</span>
              </>
            )}
            {saveStatus === 'saving' && (
              <>
                <Clock className="w-3.5 h-3.5 text-amber-500 animate-spin" />
                <span>Saving...</span>
              </>
            )}
            {saveStatus === 'unsaved' && (
              <>
                <div className="w-2 h-2 rounded-full bg-amber-500" />
                <span>Unsaved</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Monaco Editor Container */}
      <div className="flex-1 w-full">
        <Editor
          height="100%"
          language={getLanguage(filePath)}
          value={content}
          theme={resolvedMode === 'dark' ? 'vs-dark' : 'vs'}
          onChange={handleEditorChange}
          options={{
            fontSize: 13,
            fontFamily: '"SF Mono", Menlo, Monaco, Consolas, monospace',
            minimap: { enabled: false },
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            automaticLayout: true,
            tabSize: 4
          }}
        />
      </div>
    </div>
  );
};
