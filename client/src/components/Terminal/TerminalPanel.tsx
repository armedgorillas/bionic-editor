import React, { useState, useEffect, useRef } from 'react';
import { Terminal as TerminalIcon, Play, Trash2, X } from 'lucide-react';

interface TerminalPanelProps {
  onClose?: () => void;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({ onClose }) => {
  const [output, setOutput] = useState<string[]>([
    '🔬 Bionic Editor Virtual Environment Shell',
    'Working directory: workspace/',
    'Active Python: .venv/bin/python\n'
  ]);
  const [input, setInput] = useState<string>('');
  const wsRef = useRef<WebSocket | null>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'terminal_start' }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'terminal_output') {
          setOutput(prev => [...prev, msg.data]);
        }
      } catch {
        // ignore
      }
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'terminal_stop' }));
        ws.close();
      }
    };
  }, []);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [output]);

  const sendCommand = (cmd: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'terminal_input',
      data: `${cmd}\n`
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    sendCommand(input);
    setInput('');
  };

  const clearTerminal = () => {
    setOutput(['Terminal cleared. Ready.\n']);
  };

  const quickActions = [
    { label: 'Run analyze.py', cmd: 'python src/analyze.py' },
    { label: 'Check pip packages', cmd: 'pip list' },
    { label: 'List raw datasets', cmd: 'ls -l data/raw/' },
    { label: 'View SPEC.md', cmd: 'head -n 20 SPEC.md' }
  ];

  return (
    <div className="flex flex-col h-64 bg-[#181818] border-t border-[#333333] text-gray-200 select-none">
      {/* Terminal Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#222222] border-b border-[#333333] text-xs">
        <div className="flex items-center space-x-2">
          <TerminalIcon className="w-3.5 h-3.5 text-blue-400" />
          <span className="font-mono text-gray-300 font-semibold">Terminal (Coding Mode)</span>
          <span className="text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-800 px-1.5 py-0.2 rounded font-mono">
            .venv active
          </span>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={clearTerminal}
            className="p-1 hover:bg-[#333333] text-gray-400 hover:text-gray-200 rounded"
            title="Clear Terminal"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 hover:bg-[#333333] text-gray-400 hover:text-gray-200 rounded"
              title="Close Terminal"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Quick Shell Commands */}
      <div className="px-3 py-1 bg-[#1e1e1e] border-b border-[#2d2d2d] flex items-center space-x-2 overflow-x-auto text-[11px]">
        <span className="text-gray-500 font-mono text-[10px]">Quick:</span>
        {quickActions.map((qa, i) => (
          <button
            key={i}
            onClick={() => sendCommand(qa.cmd)}
            className="flex-shrink-0 flex items-center space-x-1 px-2 py-0.5 rounded bg-[#2a2a2a] hover:bg-[#383838] text-gray-300 border border-[#3a3a3a] transition font-mono"
          >
            <Play className="w-2.5 h-2.5 text-emerald-400" />
            <span>{qa.label}</span>
          </button>
        ))}
      </div>

      {/* Console Output Area */}
      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs text-gray-300 leading-relaxed select-text space-y-0.5">
        {output.map((line, index) => (
          <pre key={index} className="whitespace-pre-wrap font-mono inline leading-snug">
            {line}
          </pre>
        ))}
        <div ref={terminalEndRef} />
      </div>

      {/* Input Prompt */}
      <form onSubmit={handleSubmit} className="px-3 py-1.5 bg-[#202020] border-t border-[#303030] flex items-center">
        <span className="text-emerald-400 font-mono text-xs mr-2">$</span>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Enter command (e.g. python -V, pip install ...)"
          className="flex-1 bg-transparent text-gray-200 font-mono text-xs outline-none placeholder-gray-500"
        />
      </form>
    </div>
  );
};
