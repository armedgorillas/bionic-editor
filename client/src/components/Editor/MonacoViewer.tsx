import React, { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { Play, CheckCircle2, Clock } from 'lucide-react';

interface MonacoViewerProps {
  filePath: string;
  initialContent: string;
  onSave: (path: string, content: string) => Promise<void>;
  onRunPython?: (path: string) => void;
}

export const MonacoViewer: React.FC<MonacoViewerProps> = ({
  filePath,
  initialContent,
  onSave,
  onRunPython
}) => {
  const [content, setContent] = useState<string>(initialContent);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const saveTimeoutRef = useRef<any>(null);

  useEffect(() => {
    setContent(initialContent);
    setSaveStatus('saved');
  }, [initialContent, filePath]);

  const getLanguage = (path: string): string => {
    const ext = path.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'py': return 'python';
      case 'js': return 'javascript';
      case 'ts': return 'typescript';
      case 'json': return 'json';
      case 'html': return 'html';
      case 'css': return 'css';
      case 'sh': return 'shell';
      case 'csv': return 'plaintext';
      case 'yaml':
      case 'yml': return 'yaml';
      default: return 'plaintext';
    }
  };

  const handleEditorChange = (value: string | undefined) => {
    const val = value ?? '';
    setContent(val);
    setSaveStatus('unsaved');

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      setSaveStatus('saving');
      try {
        await onSave(filePath, val);
        setSaveStatus('saved');
      } catch {
        setSaveStatus('unsaved');
      }
    }, 800);
  };

  const isPython = filePath.endsWith('.py');

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] overflow-hidden">
      {/* File Bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-[#252526] text-gray-300 text-xs border-b border-[#333333] select-none">
        <div className="flex items-center space-x-2">
          <span className="font-mono text-gray-200">{filePath}</span>
          <span className="text-[10px] bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded uppercase">
            {getLanguage(filePath)}
          </span>
        </div>

        <div className="flex items-center space-x-3">
          {isPython && onRunPython && (
            <button
              onClick={() => onRunPython(filePath)}
              className="flex items-center space-x-1.5 bg-emerald-700 hover:bg-emerald-600 text-white px-2.5 py-1 rounded shadow-sm text-xs transition"
              title="Execute script in project virtual environment"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>Run in .venv</span>
            </button>
          )}

          <div className="flex items-center space-x-1 text-gray-400">
            {saveStatus === 'saved' && (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Saved</span>
              </>
            )}
            {saveStatus === 'saving' && (
              <>
                <Clock className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                <span>Saving...</span>
              </>
            )}
            {saveStatus === 'unsaved' && (
              <>
                <div className="w-2 h-2 rounded-full bg-amber-400" />
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
          theme="vs-dark"
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
