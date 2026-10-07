import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  FileExplorer 
} from './components/Explorer/FileExplorer';
import { WysiwygEditor } from './components/Editor/WysiwygEditor';
import { MonacoViewer } from './components/Editor/MonacoViewer';
import { AgentPanel } from './components/Agent/AgentPanel';
import { ReportViewer } from './components/WebReport/ReportViewer';
import { TerminalPanel } from './components/Terminal/TerminalPanel';
import { SettingsModal } from './components/SettingsModal';
import { HelpModal } from './components/HelpModal';
import type { 
  FileItem, 
  ChatMessage, 
  TokenUsage, 
  VenvStatus,
  ChatSessionSummary
} from './types';
import { 
  fetchFileTree, 
  readFile, 
  writeFile, 
  createItem, 
  renameItem, 
  deleteItem, 
  uploadFile, 
  initWorkspaceTemplate, 
  fetchVenvStatus, 
  createVenv, 
  runPython, 
  streamAgentChat,
  fetchAgentConfig,
  saveAgentConfig,
  fetchChatSessions,
  fetchChatSession,
  saveChatSession,
  deleteChatSession,
  cancelAgentExecution
} from './services/api';
import { 
  Code, 
  LayoutDashboard, 
  CheckCircle, 
  AlertCircle, 
  Loader2,
  FileText,
  FileCode,
  FlaskConical,
  HelpCircle
} from 'lucide-react';

export const App: React.FC = () => {
  const [fileTree, setFileTree] = useState<FileItem[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string>('SPEC.md');
  const [activeFileContent, setActiveFileContent] = useState<string>('');
  const [viewMode, setViewMode] = useState<'editor' | 'report'>('editor');
  
  // Coding Mode state
  const [codingMode, setCodingMode] = useState<boolean>(false);
  const [showTerminal, setShowTerminal] = useState<boolean>(false);
  
  // Venv state
  const [venvStatus, setVenvStatus] = useState<VenvStatus>({ exists: false, pythonPath: '', hasRequirements: false });
  const [isCreatingVenv, setIsCreatingVenv] = useState<boolean>(false);

  // Agent State
  const [agentProvider, setAgentProvider] = useState<string>(() => {
    return localStorage.getItem('bionic_agent_provider') || 'gemini';
  });
  const [agentConfig, setAgentConfig] = useState(() => {
    const saved = localStorage.getItem('bionic_agent_config');
    if (saved) {
      try { return JSON.parse(saved); } catch {}
    }
    return {
      geminiApiKey: '',
      openaiApiKey: '',
      anthropicApiKey: '',
      ollamaBaseUrl: 'http://localhost:11434/v1',
      selectedModel: 'gemini-2.5-flash'
    };
  });
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => {
    return localStorage.getItem('bionic_active_session_id') || `session_${Date.now()}`;
  });
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [serverKeys, setServerKeys] = useState<{ gemini: boolean; openai: boolean; anthropic: boolean }>({
    gemini: false,
    openai: false,
    anthropic: false
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isHelpOpen, setIsHelpOpen] = useState<boolean>(false);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [reportLastUpdated, setReportLastUpdated] = useState<number>(Date.now());

  const [totalTokens, setTotalTokens] = useState<TokenUsage>({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0
  });

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: `Welcome to **Bionic Editor**! 🔬\n\nI am your scientific AI assistant. You can write your experimental specifications and hypotheses in **SPEC.md** on the left, and describe what data analyses to perform. I will write and run Python scripts in your isolated virtual environment and render interactive charts in the **Web Report** panel.`,
      timestamp: Date.now()
    }
  ]);

  // Load tree and venv status
  const loadWorkspace = useCallback(async () => {
    try {
      const tree = await fetchFileTree();
      setFileTree(tree);
      const venv = await fetchVenvStatus();
      setVenvStatus(venv);
      const agCfg = await fetchAgentConfig();
      setServerKeys({
        gemini: agCfg.hasGeminiKey,
        openai: agCfg.hasOpenaiKey,
        anthropic: agCfg.hasAnthropicKey
      });

      // Load past sessions
      try {
        const sessionList = await fetchChatSessions();
        setSessions(sessionList);
        const storedId = localStorage.getItem('bionic_active_session_id');
        if (storedId && sessionList.some(s => s.id === storedId)) {
          const sessionData = await fetchChatSession(storedId);
          if (sessionData?.messages?.length > 0) {
            setMessages(sessionData.messages);
            if (sessionData.tokens) setTotalTokens(sessionData.tokens);
            setCurrentSessionId(storedId);
          }
        }
      } catch {
        // ignore session load error on first boot
      }
    } catch (e) {
      console.error('Failed to load workspace:', e);
    }
  }, []);

  // Open file
  const handleSelectFile = useCallback(async (path: string) => {
    try {
      const fileData = await readFile(path);
      setActiveFilePath(path);
      setActiveFileContent(fileData.content);
      setViewMode('editor');
    } catch (err: any) {
      alert(`Could not open file: ${err.message}`);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadWorkspace().then(() => {
      handleSelectFile('SPEC.md');
    });
  }, [loadWorkspace, handleSelectFile]);

  // WebSocket for file changes
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'file_changed') {
          loadWorkspace();
          // If active file changed externally, reload it
          if (msg.path === activeFilePath) {
            readFile(activeFilePath).then(data => {
              setActiveFileContent(data.content);
            });
          }
          // If web report updated, trigger refresh
          if (msg.path?.startsWith('web-report')) {
            setReportLastUpdated(Date.now());
          }
        }
      } catch {
        // ignore
      }
    };

    return () => {
      ws.close();
    };
  }, [activeFilePath, loadWorkspace]);

  // Save active file
  const handleSaveFile = async (path: string, content: string) => {
    await writeFile(path, content);
    setActiveFileContent(content);
  };

  // Venv creation
  const handleCreateVenv = async () => {
    setIsCreatingVenv(true);
    try {
      const res = await createVenv();
      if (res.success) {
        const venv = await fetchVenvStatus();
        setVenvStatus(venv);
      } else {
        alert(`Failed to create .venv: ${res.output}`);
      }
    } catch (err: any) {
      alert(`Error creating venv: ${err.message}`);
    } finally {
      setIsCreatingVenv(false);
    }
  };

  // Run python script from Monaco
  const handleRunPython = async (scriptPath: string) => {
    setShowTerminal(true);
    try {
      const res = await runPython(scriptPath);
      alert(`Script ${scriptPath} exited with code ${res.code}.\n\nOutput:\n${res.stdout || '(None)'}\n\nErrors:\n${res.stderr || '(None)'}`);
    } catch (err: any) {
      alert(`Error running script: ${err.message}`);
    }
  };

  // Agent message handler
  const handleSendMessage = async (text: string) => {
    if (!text.trim() || isStreaming) return;

    const hasKey = agentProvider === 'demo' || agentProvider === 'ollama' ||
      (agentProvider === 'gemini' && Boolean(agentConfig.geminiApiKey || serverKeys.gemini)) ||
      (agentProvider === 'openai' && Boolean(agentConfig.openaiApiKey || serverKeys.openai)) ||
      (agentProvider === 'anthropic' && Boolean(agentConfig.anthropicApiKey || serverKeys.anthropic));

    if (!hasKey) {
      setIsSettingsOpen(true);
      setMessages(prev => [...prev, {
        id: `warn_${Date.now()}`,
        role: 'assistant',
        content: `⚠️ **${agentProvider === 'gemini' ? 'Google Gemini' : agentProvider.toUpperCase()} API Key Required**\n\nPlease enter your API key in the Settings modal that just opened to connect to live AI models.`,
        timestamp: Date.now()
      }]);
      return;
    }

    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now()
    };

    const assistantMsgId = `asst_${Date.now()}`;
    const initialAssistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timeline: [],
      timestamp: Date.now()
    };

    setMessages(prev => [...prev, userMsg, initialAssistantMsg]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const apiMessages = [...messages, userMsg].map(m => ({
        role: m.role,
        content: m.content
      }));

      let apiKey = '';
      if (agentProvider === 'gemini') apiKey = agentConfig.geminiApiKey;
      else if (agentProvider === 'openai') apiKey = agentConfig.openaiApiKey;
      else if (agentProvider === 'anthropic') apiKey = agentConfig.anthropicApiKey;

      const activeConfig = {
        provider: agentProvider,
        apiKey,
        baseUrl: agentConfig.ollamaBaseUrl,
        model: agentConfig.selectedModel || (agentProvider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o'),
        sessionId: currentSessionId
      };

      await streamAgentChat(apiMessages, activeConfig, (event) => {
        if (event.type === 'thought') {
          setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const timeline = [
              ...(m.timeline || []),
              {
                type: 'thought' as const,
                id: `thought_${Date.now()}_${Math.random()}`,
                content: event.delta || ''
              }
            ];
            return { ...m, timeline };
          }));
        } else if (event.type === 'step_start') {
          setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const timeline = [
              ...(m.timeline || []),
              {
                type: 'step' as const,
                id: `step_${Date.now()}_${Math.random()}`,
                title: event.title || 'Step started',
                description: event.description || '',
                status: 'running' as const
              }
            ];
            return { ...m, timeline };
          }));
        } else if (event.type === 'step_progress') {
          setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const timeline = [...(m.timeline || [])];
            for (let i = timeline.length - 1; i >= 0; i--) {
              if (timeline[i].type === 'step') {
                const s = timeline[i] as any;
                s.description = event.description || s.description;
                break;
              }
            }
            return { ...m, timeline };
          }));
        } else if (event.type === 'step_done') {
          setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const timeline = [...(m.timeline || [])];
            for (let i = timeline.length - 1; i >= 0; i--) {
              if (timeline[i].type === 'step') {
                const s = timeline[i] as any;
                s.status = event.status || 'done';
                s.description = event.description || s.description;
                s.details = event.details;
                break;
              }
            }
            return { ...m, timeline };
          }));
        } else if (event.type === 'final') {
          setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            return { ...m, content: event.delta || m.content };
          }));
          if (event.tokens) {
            setTotalTokens(prev => ({
              promptTokens: prev.promptTokens + event.tokens.promptTokens,
              completionTokens: prev.completionTokens + event.tokens.completionTokens,
              totalTokens: prev.totalTokens + event.tokens.totalTokens,
              estimatedCostUsd: prev.estimatedCostUsd + event.tokens.estimatedCostUsd
            }));
          }
        }
      }, controller.signal);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setMessages(prev => prev.map(m => {
          if (m.id !== assistantMsgId) return m;
          return { ...m, content: `Error: ${err.message}` };
        }));
      }
    } finally {
      abortControllerRef.current = null;
      setIsStreaming(false);
      loadWorkspace();
      if (activeFilePath) {
        readFile(activeFilePath).then(data => setActiveFileContent(data.content));
      }

      // Auto-save session
      setMessages(currentMsgs => {
        const firstUser = currentMsgs.find(m => m.role === 'user');
        const title = firstUser ? (firstUser.content.slice(0, 42) + (firstUser.content.length > 42 ? '...' : '')) : 'Analysis Session';
        saveChatSession({
          id: currentSessionId,
          title,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: currentMsgs,
          tokens: totalTokens
        }).then(() => fetchChatSessions().then(setSessions)).catch(() => {});
        return currentMsgs;
      });
    }
  };

  const handleCancelWork = async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    try {
      await cancelAgentExecution(currentSessionId);
    } catch {}
    setIsStreaming(false);
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant') {
        const updatedTimeline = [
          ...(last.timeline || []),
          {
            type: 'step' as const,
            id: `cancel_${Date.now()}`,
            title: 'Execution Stopped',
            description: 'Work was cancelled by user.',
            status: 'error' as const
          }
        ];
        return [...prev.slice(0, -1), { ...last, timeline: updatedTimeline }];
      }
      return prev;
    });
  };

  const handleSelectSession = async (id: string) => {
    try {
      const sessionData = await fetchChatSession(id);
      if (sessionData) {
        setCurrentSessionId(id);
        localStorage.setItem('bionic_active_session_id', id);
        setMessages(sessionData.messages || []);
        if (sessionData.tokens) setTotalTokens(sessionData.tokens);
      }
    } catch (err: any) {
      alert(`Could not load session: ${err.message}`);
    }
  };

  const handleNewSession = () => {
    const newId = `session_${Date.now()}`;
    setCurrentSessionId(newId);
    localStorage.setItem('bionic_active_session_id', newId);
    setMessages([
      {
        id: 'welcome',
        role: 'assistant',
        content: `Started new analysis session. 🔬\n\nDescribe your scientific question or experimental data to begin!`,
        timestamp: Date.now()
      }
    ]);
    setTotalTokens({ promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 });
  };

  const handleDeleteSession = async (id: string) => {
    try {
      await deleteChatSession(id);
      const updated = await fetchChatSessions();
      setSessions(updated);
      if (id === currentSessionId) {
        handleNewSession();
      }
    } catch (err: any) {
      alert(`Could not delete session: ${err.message}`);
    }
  };

  const handleExportMarkdown = async () => {
    let md = `# Scientific Analysis Session Log\n\n**Session ID:** \`${currentSessionId}\`  \n**Exported:** ${new Date().toLocaleString()}\n\n---\n\n`;
    for (const msg of messages) {
      if (msg.role === 'user') {
        md += `## 🧑‍🔬 Scientist Request\n\n${msg.content}\n\n`;
      } else if (msg.role === 'assistant') {
        md += `## 🤖 Agent Output\n\n`;
        if (msg.timeline) {
          for (const item of msg.timeline) {
            if (item.type === 'thought') {
              md += `> **Plan & Reasoning**:\n> ${item.content.replace(/\n/g, '\n> ')}\n\n`;
            } else if (item.type === 'step') {
              md += `### Action: \`${item.title}\`\n*${item.description}*\n\n`;
              if (item.details) {
                md += `\`\`\`text\n${item.details}\n\`\`\`\n\n`;
              }
            }
          }
        }
        if (msg.content) {
          md += `### Summary\n\n${msg.content}\n\n`;
        }
        md += `---\n\n`;
      }
    }
    try {
      await writeFile('REPORT.md', md);
      await loadWorkspace();
      handleSelectFile('REPORT.md');
    } catch (err: any) {
      alert(`Could not export report: ${err.message}`);
    }
  };

  const isMarkdown = activeFilePath.endsWith('.md');

  const hasCurrentKey = agentProvider === 'demo' || agentProvider === 'ollama' ||
    (agentProvider === 'gemini' && Boolean(agentConfig.geminiApiKey || serverKeys.gemini)) ||
    (agentProvider === 'openai' && Boolean(agentConfig.openaiApiKey || serverKeys.openai)) ||
    (agentProvider === 'anthropic' && Boolean(agentConfig.anthropicApiKey || serverKeys.anthropic));

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-white select-none">
      {/* Top Application Header */}
      <header className="h-11 border-b border-gray-200 bg-white flex items-center justify-between px-3 z-10 flex-shrink-0">
        {/* Left: Branding & Active File */}
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-2">
            <div className="w-6 h-6 rounded bg-gradient-to-tr from-blue-600 to-indigo-500 text-white flex items-center justify-center font-bold text-xs shadow-xs">
              <FlaskConical className="w-3.5 h-3.5" />
            </div>
            <span className="font-semibold text-xs tracking-tight text-gray-900">Bionic Editor</span>
          </div>

          <div className="h-4 w-[1px] bg-gray-200" />

          {/* Active File Tab / Report Tab */}
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setViewMode('editor')}
              className={`flex items-center space-x-1.5 px-2.5 py-1 rounded text-xs transition ${
                viewMode === 'editor'
                  ? 'bg-gray-100 text-gray-900 font-medium'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800'
              }`}
            >
              {isMarkdown ? (
                <FileText className="w-3.5 h-3.5 text-blue-600" />
              ) : (
                <FileCode className="w-3.5 h-3.5 text-emerald-600" />
              )}
              <span className="truncate max-w-[140px]">{activeFilePath}</span>
            </button>

            <button
              onClick={() => setViewMode('report')}
              className={`flex items-center space-x-1.5 px-2.5 py-1 rounded text-xs transition ${
                viewMode === 'report'
                  ? 'bg-orange-50 text-orange-900 font-medium border border-orange-200'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800'
              }`}
            >
              <LayoutDashboard className="w-3.5 h-3.5 text-orange-500" />
              <span>Web Report</span>
            </button>
          </div>
        </div>

        {/* Right: Environment status, Coding mode toggle */}
        <div className="flex items-center space-x-3 text-xs">
          {/* Virtual Environment Status */}
          <div className="flex items-center">
            {venvStatus.exists ? (
              <span className="flex items-center space-x-1 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full font-medium">
                <CheckCircle className="w-3 h-3 text-emerald-600" />
                <span>Python .venv Ready</span>
              </span>
            ) : (
              <button
                onClick={handleCreateVenv}
                disabled={isCreatingVenv}
                className="flex items-center space-x-1 text-[11px] text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-300 px-2 py-0.5 rounded-full font-medium transition"
              >
                {isCreatingVenv ? (
                  <Loader2 className="w-3 h-3 animate-spin text-amber-600" />
                ) : (
                  <AlertCircle className="w-3 h-3 text-amber-600" />
                )}
                <span>{isCreatingVenv ? 'Setting up .venv...' : 'Create .venv'}</span>
              </button>
            )}
          </div>

          <div className="h-4 w-[1px] bg-gray-200" />

          {/* Coding Mode Switch (Requested in SPEC.md) */}
          <div className="flex items-center space-x-2">
            <button
              onClick={() => {
                const next = !codingMode;
                setCodingMode(next);
                if (next) setShowTerminal(true);
              }}
              className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition ${
                codingMode
                  ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                  : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
              }`}
            >
              <Code className="w-3.5 h-3.5" />
              <span>Coding Mode: {codingMode ? 'ON' : 'OFF'}</span>
            </button>
          </div>

          <div className="h-4 w-[1px] bg-gray-200" />

          {/* Help & Documentation Button */}
          <button
            onClick={() => setIsHelpOpen(true)}
            className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-medium border border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100 hover:text-gray-900 transition shadow-2xs cursor-pointer"
            title="Open Documentation & Help"
          >
            <HelpCircle className="w-3.5 h-3.5 text-blue-600" />
            <span>Help</span>
          </button>
        </div>
      </header>

      {/* Main Workspace Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: File Explorer */}
        <FileExplorer
          tree={fileTree}
          activeFilePath={activeFilePath}
          onSelectFile={handleSelectFile}
          onCreateItem={async (path, isDir) => {
            await createItem(path, isDir);
            await loadWorkspace();
            if (!isDir) handleSelectFile(path);
          }}
          onRenameItem={async (oldPath, newPath) => {
            await renameItem(oldPath, newPath);
            await loadWorkspace();
            if (activeFilePath === oldPath) setActiveFilePath(newPath);
          }}
          onDeleteItem={async (path) => {
            await deleteItem(path);
            await loadWorkspace();
            if (activeFilePath === path) handleSelectFile('SPEC.md');
          }}
          onUploadFile={async (file, dir) => {
            await uploadFile(file, dir);
            await loadWorkspace();
          }}
          onRefresh={loadWorkspace}
          onInitTemplate={async () => {
            await initWorkspaceTemplate();
            await loadWorkspace();
            handleSelectFile('SPEC.md');
          }}
        />

        {/* Center: Main Editor or Web Report */}
        <div className="flex-1 flex flex-col h-full overflow-hidden bg-white">
          <div className="flex-1 overflow-hidden">
            {viewMode === 'report' ? (
              <ReportViewer lastUpdated={reportLastUpdated} />
            ) : isMarkdown ? (
              <WysiwygEditor
                key={activeFilePath}
                filePath={activeFilePath}
                initialContent={activeFileContent}
                onSave={handleSaveFile}
                codingMode={codingMode}
              />
            ) : (
              <MonacoViewer
                key={activeFilePath}
                filePath={activeFilePath}
                initialContent={activeFileContent}
                onSave={handleSaveFile}
                onRunPython={handleRunPython}
              />
            )}
          </div>

          {/* Bottom Terminal in Coding Mode */}
          {codingMode && showTerminal && (
            <TerminalPanel onClose={() => setShowTerminal(false)} />
          )}
        </div>

        {/* Right: AI Agent Panel */}
        <AgentPanel
          messages={messages}
          isStreaming={isStreaming}
          totalTokens={totalTokens}
          onSendMessage={handleSendMessage}
          provider={agentProvider}
          onChangeProvider={(p) => {
            setAgentProvider(p);
            localStorage.setItem('bionic_agent_provider', p);
          }}
          onOpenSettings={() => setIsSettingsOpen(true)}
          hasActiveKey={hasCurrentKey}
          currentSessionId={currentSessionId}
          sessions={sessions}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
          onDeleteSession={handleDeleteSession}
          onCancelWork={handleCancelWork}
          onExportMarkdown={handleExportMarkdown}
        />
      </div>

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        config={agentConfig}
        onSaveConfig={async (newConfig) => {
          setAgentConfig(newConfig);
          localStorage.setItem('bionic_agent_config', JSON.stringify(newConfig));
          try {
            const res = await saveAgentConfig(newConfig);
            if (res.success) {
              setServerKeys(prev => ({
                ...prev,
                gemini: res.hasGeminiKey
              }));
            }
          } catch (e) {
            console.warn('Could not sync to backend:', e);
          }
        }}
      />

      {/* Documentation & Help Modal */}
      <HelpModal
        isOpen={isHelpOpen}
        onClose={() => setIsHelpOpen(false)}
      />
    </div>
  );
};

export default App;
