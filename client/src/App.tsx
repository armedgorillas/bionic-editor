import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { FileExplorer } from './components/Explorer/FileExplorer';
import { collectWorkspaceFilePaths } from './components/Explorer/filterTree';
import { WysiwygEditor } from './components/Editor/WysiwygEditor';
import { MonacoViewer } from './components/Editor/MonacoViewer';
import { AgentPanel } from './components/Agent/AgentPanel';
import { ReportViewer } from './components/WebReport/ReportViewer';
import { DataManifestViewer } from './components/Data/DataManifestViewer';
import { TerminalPanel } from './components/Terminal/TerminalPanel';
import { SettingsModal } from './components/SettingsModal';
import { HelpModal } from './components/HelpModal';
import { ResizeHandle } from './components/Layout/ResizeHandle';
import {
  useResizableLayout,
  MIN_LEFT_WIDTH,
  MAX_LEFT_WIDTH,
  MIN_RIGHT_WIDTH,
  MAX_RIGHT_WIDTH,
  MIN_TERMINAL_HEIGHT
} from './hooks/useResizableLayout';
import { useTheme } from './contexts/ThemeContext';
import type {
  FileItem,
  ChatMessage,
  TokenUsage,
  VenvStatus,
  ChatSessionSummary,
  SubagentJobView
} from './types';
import {
  fetchFileTree,
  fetchWorkspaceInfo,
  updateWorkspaceConfig,
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
  syncChatSession,
  saveChatSession,
  deleteChatSession,
  cancelAgentExecution,
  fetchSubagents,
  cancelSubagentJob,
  fetchDataManifest,
  getBionicConfig
} from './services/api';
import {
  Code,
  LayoutDashboard,
  CheckCircle,
  AlertCircle,
  Loader2,
  FileText,
  FileCode,
  HelpCircle,
  Sun,
  Moon,
  PanelLeft,
  PanelRight,
  Database,
  X
} from 'lucide-react';

export const App: React.FC = () => {
  const bionicConfig = getBionicConfig();
  const initialRootFile = bionicConfig.rootFile || bionicConfig.baseSpec || 'SPEC.md';
  const { resolvedMode, toggleLightDark } = useTheme();
  const {
    layout,
    isDragging,
    setIsDragging,
    setLeftWidth,
    setRightWidth,
    setTerminalHeight,
    resetLeftWidth,
    resetRightWidth,
    resetTerminalHeight,
    toggleLeftCollapsed,
    toggleRightCollapsed
  } = useResizableLayout();

  const [projectRootFile, setProjectRootFile] = useState<string>(initialRootFile);
  const [fileTree, setFileTree] = useState<FileItem[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string>(initialRootFile);
  const [activeFileContent, setActiveFileContent] = useState<string>('');
  const [viewMode, setViewMode] = useState<'editor' | 'report' | 'manifest'>('editor');

  // Coding Mode state
  const [codingMode, setCodingMode] = useState<boolean>(false);
  const [showTerminal, setShowTerminal] = useState<boolean>(false);

  // Venv state
  const [venvStatus, setVenvStatus] = useState<VenvStatus>({ exists: false, pythonPath: '', hasRequirements: false });
  const [isCreatingVenv, setIsCreatingVenv] = useState<boolean>(false);

  // Data Provenance badge state
  const [dataManifestHasIssues, setDataManifestHasIssues] = useState<boolean>(false);
  const [dataManifestCount, setDataManifestCount] = useState<number>(0);

  // Dismissible updated-doc banner (Feature 5)
  const [updatedDocBanner, setUpdatedDocBanner] = useState<string | null>(null);

  // Agent State
  const [agentHarness, setAgentHarness] = useState<'opencode' | 'built-in'>('built-in');
  const [agentProvider, setAgentProvider] = useState<string>(() => {
    try {
      return localStorage.getItem('bionic_agent_provider') || 'gemini';
    } catch {
      return 'gemini';
    }
  });
  const [agentConfig, setAgentConfig] = useState(() => {
    try {
      const saved = localStorage.getItem('bionic_agent_config');
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      geminiApiKey: '',
      openaiApiKey: '',
      anthropicApiKey: '',
      ollamaBaseUrl: 'http://localhost:11434/v1',
      selectedModel: 'gemini-2.5-flash'
    };
  });
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => {
    try {
      return localStorage.getItem('bionic_active_session_id') || `session_${Date.now()}`;
    } catch {
      return `session_${Date.now()}`;
    }
  });
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [subagents, setSubagents] = useState<SubagentJobView[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isEditorDirtyRef = useRef<boolean>(false);
  const currentSessionIdRef = useRef<string>(currentSessionId);
  const activeBgMessageIdRef = useRef<string | null>(null);
  const totalTokensRef = useRef<TokenUsage>({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0
  });

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  const [serverKeys, setServerKeys] = useState<{ gemini: boolean; openai: boolean; anthropic: boolean }>({
    gemini: false,
    openai: false,
    anthropic: false
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isHelpOpen, setIsHelpOpen] = useState<boolean>(false);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [reportLastUpdated, setReportLastUpdated] = useState<number>(() => Date.now());
  const sessionCreatedAtRef = useRef<number>(0);

  const [totalTokens, setTotalTokens] = useState<TokenUsage>({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0
  });
  useEffect(() => {
    totalTokensRef.current = totalTokens;
  }, [totalTokens]);

  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: 'welcome',
      role: 'assistant',
      content: `Welcome to **Bionic Editor**! 🔬\n\nI am your scientific AI assistant. Draft your analysis plan in **\`${initialRootFile}\`** on the left, register raw datasets in **Data Provenance**, and ask me to write reproducible code in \`code/\`, run scientific tests in \`tests/scientific/\`, and publish interactive results in **Web Report**.`,
      timestamp: Date.now()
    }
  ]);
  const messagesRef = useRef<ChatMessage[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const handleEditorDirtyChange = useCallback((dirty: boolean) => {
    isEditorDirtyRef.current = dirty;
  }, []);

  const workspacePaths = useMemo(() => collectWorkspaceFilePaths(fileTree), [fileTree]);
  const markdownFiles = useMemo(
    () => Array.from(workspacePaths).filter((p) => p.toLowerCase().endsWith('.md')).sort(),
    [workspacePaths]
  );

  // Refresh ONLY filesystem & passive provenance summary — NEVER overwrites live chat messages!
  const refreshWorkspaceFiles = useCallback(async () => {
    try {
      const [tree, venv, manifest] = await Promise.all([
        fetchFileTree(true),
        fetchVenvStatus(),
        fetchDataManifest().catch(() => null)
      ]);
      setFileTree(tree);
      setVenvStatus(venv);
      if (manifest) {
        setDataManifestHasIssues(Boolean(manifest.hasIssues));
        setDataManifestCount(manifest.entries?.length || 0);
      }
    } catch (e) {
      console.error('Failed to refresh workspace files:', e);
    }
  }, []);

  // Open file cleanly
  const handleSelectFile = useCallback(async (filePath: string) => {
    try {
      const fileData = await readFile(filePath);
      setActiveFilePath(filePath);
      setActiveFileContent(fileData.content);
      setViewMode('editor');
      setUpdatedDocBanner((curr) => (curr === filePath ? null : curr));
    } catch (err: any) {
      alert(`Could not open file: ${err.message}`);
    }
  }, []);

  // Initial mount load (runs once — loads sessions, config, rootFile, subagents)
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const [wsInfo, tree, venv, agCfg, manifest] = await Promise.all([
          fetchWorkspaceInfo().catch(() => null),
          fetchFileTree(true),
          fetchVenvStatus(),
          fetchAgentConfig(),
          fetchDataManifest().catch(() => null)
        ]);
        if (cancelled) return;

        const resolvedRoot = wsInfo?.rootFile || wsInfo?.baseSpec || initialRootFile;
        setProjectRootFile(resolvedRoot);
        setFileTree(tree);
        setVenvStatus(venv);
        setAgentHarness(agCfg.harness || 'built-in');
        setServerKeys({
          gemini: agCfg.hasGeminiKey,
          openai: agCfg.hasOpenaiKey,
          anthropic: agCfg.hasAnthropicKey
        });
        if (manifest) {
          setDataManifestHasIssues(Boolean(manifest.hasIssues));
          setDataManifestCount(manifest.entries?.length || 0);
        }

        // Open project root plan on boot
        try {
          const rootData = await readFile(resolvedRoot);
          if (!cancelled) {
            setActiveFilePath(resolvedRoot);
            setActiveFileContent(rootData.content);
          }
        } catch {
          // root file might not exist in an arbitrary workspace
        }

        // Load past sessions & active session once
        try {
          const sessionList = await fetchChatSessions();
          if (cancelled) return;
          setSessions(sessionList);
          const storedId = localStorage.getItem('bionic_active_session_id');
          if (storedId && sessionList.some((s) => s.id === storedId)) {
            const sessionData = await fetchChatSession(storedId);
            if (!cancelled && sessionData?.messages?.length > 0) {
              setMessages(sessionData.messages);
              sessionCreatedAtRef.current = sessionData.createdAt || Date.now();
              setTotalTokens(
                sessionData.tokens || { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 }
              );
              setCurrentSessionId(storedId);
            }
          }
          const activeId = storedId || currentSessionIdRef.current;
          const subRes = await fetchSubagents(activeId).catch(() => null);
          if (!cancelled && subRes?.jobs) {
            setSubagents(subRes.jobs);
          }
        } catch {
          // ignore session load error on first boot
        }
      } catch (e) {
        console.error('Failed to initialize workspace:', e);
      }
    };

    init();
    return () => {
      cancelled = true;
    };
  }, [initialRootFile]);

  // Apply an agent event to a specific assistant message ID
  const applyAgentEventToMessage = useCallback((assistantMsgId: string, event: any) => {
    if (event.type === 'thought') {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m;
          const timeline = [...(m.timeline || [])];
          const last = timeline[timeline.length - 1];
          if (last && last.type === 'thought') {
            timeline[timeline.length - 1] = { ...last, content: last.content + (event.delta || '') };
          } else {
            timeline.push({
              type: 'thought' as const,
              id: `thought_${Date.now()}_${Math.random()}`,
              content: event.delta || ''
            });
          }
          return { ...m, timeline };
        })
      );
    } else if (event.type === 'text_delta') {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m;
          return { ...m, content: (m.content || '') + (event.delta || '') };
        })
      );
    } else if (event.type === 'subagent_updated' && event.job) {
      const job: SubagentJobView = event.job;
      setSubagents((prev) => {
        const idx = prev.findIndex((j) => j.jobId === job.jobId);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = job;
          return copy;
        }
        return [job, ...prev];
      });
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m;
          const timeline = [...(m.timeline || [])];
          const existingIdx = timeline.findIndex(
            (item) => item.type === 'subagent' && item.job.jobId === job.jobId
          );
          if (existingIdx >= 0) {
            timeline[existingIdx] = { type: 'subagent', id: `sub_${job.jobId}`, job };
          } else {
            timeline.push({ type: 'subagent', id: `sub_${job.jobId}`, job });
          }
          return { ...m, timeline };
        })
      );
    } else if (event.type === 'step_start') {
      setMessages((prev) =>
        prev.map((m) => {
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
        })
      );
    } else if (event.type === 'step_progress') {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m;
          const timeline = [...(m.timeline || [])];
          for (let i = timeline.length - 1; i >= 0; i--) {
            if (timeline[i].type === 'step') {
              const s = { ...(timeline[i] as any), description: event.description || (timeline[i] as any).description };
              timeline[i] = s;
              break;
            }
          }
          return { ...m, timeline };
        })
      );
    } else if (event.type === 'step_done') {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m;
          const timeline = [...(m.timeline || [])];
          let updated = false;
          for (let i = timeline.length - 1; i >= 0; i--) {
            if (timeline[i].type === 'step') {
              const s = timeline[i] as any;
              if (s.status === 'running') {
                timeline[i] = {
                  ...s,
                  title: event.title || s.title,
                  status: event.status || 'done',
                  description: event.description || s.description,
                  details: event.details !== undefined ? event.details : s.details
                };
                updated = true;
                break;
              }
            }
          }
          if (!updated && event.title) {
            timeline.push({
              type: 'step' as const,
              id: `step_${Date.now()}_${Math.random()}`,
              title: event.title,
              description: event.description || '',
              details: event.details,
              status: (event.status || 'done') as any
            });
          }
          return { ...m, timeline };
        })
      );
    } else if (event.type === 'error') {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m;
          return { ...m, content: event.description ? `Error: ${event.description}` : m.content };
        })
      );
    } else if (event.type === 'final') {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m;
          const timeline = (m.timeline || []).map((item) => {
            if (item.type === 'step' && item.status === 'running') {
              return { ...item, status: 'done' as const };
            }
            return item;
          });
          return { ...m, content: event.delta || m.content, timeline };
        })
      );
      if (event.tokens) {
        setTotalTokens((prev) => ({
          promptTokens: prev.promptTokens + (event.tokens.promptTokens || 0),
          completionTokens: prev.completionTokens + (event.tokens.completionTokens || 0),
          totalTokens: prev.totalTokens + (event.tokens.totalTokens || 0),
          estimatedCostUsd: prev.estimatedCostUsd + (event.tokens.estimatedCostUsd || 0)
        }));
      }
    }
  }, []);

  // WebSocket for live file changes, workspace config updates, and background subagent updates
  const activeFilePathRef = useRef(activeFilePath);
  useEffect(() => {
    activeFilePathRef.current = activeFilePath;
  }, [activeFilePath]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: any = null;
    let isDisposed = false;

    let hasConnectedOnce = false;

    const connect = () => {
      if (isDisposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}${bionicConfig.baseUrl}/ws`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (hasConnectedOnce) {
          // Reconcile any subagent completions or background follow-up turns missed while disconnected
          syncChatSession(currentSessionIdRef.current)
            .then((synced) => {
              if (synced.subagents) setSubagents(synced.subagents);
              if (
                synced.session?.messages &&
                synced.session.messages.length > messagesRef.current.length &&
                !abortControllerRef.current
              ) {
                setMessages(synced.session.messages);
                if (synced.session.tokens) setTotalTokens(synced.session.tokens);
              }
            })
            .catch(() => {});
          refreshWorkspaceFiles();
        }
        hasConnectedOnce = true;
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'file_changed') {
            refreshWorkspaceFiles();
            // Reload active file ONLY if editor has no unsaved edits (prevents autosave race!)
            if (msg.path === activeFilePathRef.current && !isEditorDirtyRef.current) {
              readFile(activeFilePathRef.current)
                .then((data) => {
                  if (!isEditorDirtyRef.current) {
                    setActiveFileContent(data.content);
                  }
                })
                .catch(() => {});
            } else if (
              typeof msg.path === 'string' &&
              msg.path.toLowerCase().endsWith('.md') &&
              (msg.event === 'add' || msg.event === 'change') &&
              !msg.path.startsWith('.bionic/') &&
              msg.path !== 'data/DATA_MANIFEST.md' &&
              msg.path !== activeFilePathRef.current
            ) {
              // Gentle dismissible banner — never force-yanks the scientist away
              setUpdatedDocBanner(msg.path);
            }

            if (msg.path?.startsWith('web-report')) {
              setReportLastUpdated(Date.now());
            }
          } else if (msg.type === 'workspace_config_updated' && msg.rootFile) {
            setProjectRootFile(msg.rootFile);
          } else if (msg.type === 'subagent_updated' && msg.job) {
            if (!msg.sessionId || msg.sessionId === currentSessionIdRef.current) {
              const job: SubagentJobView = msg.job;
              setSubagents((prev) => {
                const idx = prev.findIndex((j) => j.jobId === job.jobId);
                if (idx >= 0) {
                  const copy = [...prev];
                  copy[idx] = job;
                  return copy;
                }
                return [job, ...prev];
              });

              // Also update matching SubagentCard inside messages live!
              setMessages((prev) => {
                let matched = false;
                const next = prev.map((m) => {
                  if (!m.timeline) return m;
                  const idx = m.timeline.findIndex(
                    (it) => it.type === 'subagent' && it.job.jobId === job.jobId
                  );
                  if (idx === -1) return m;
                  matched = true;
                  const timeline = [...m.timeline];
                  timeline[idx] = { type: 'subagent', id: `sub_${job.jobId}`, job };
                  return { ...m, timeline };
                });

                if (matched) return next;
                // Attach to last assistant message if not already attached
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].role === 'assistant') {
                    const m = next[i];
                    next[i] = {
                      ...m,
                      timeline: [...(m.timeline || []), { type: 'subagent', id: `sub_${job.jobId}`, job }]
                    };
                    return next;
                  }
                }
                return next;
              });
            }
          } else if (msg.type === 'agent_event' && msg.sessionId === currentSessionIdRef.current) {
            // Live push for background follow-up turns after a subagent finishes!
            const evt = msg.event;
            if (!evt) return;
            if (evt.type === 'background_turn_start') {
              const bgId = `asst_bg_${Date.now()}`;
              activeBgMessageIdRef.current = bgId;
              setMessages((prev) => [
                ...prev,
                {
                  id: bgId,
                  role: 'assistant',
                  content: '',
                  timeline: [],
                  timestamp: Date.now()
                }
              ]);
            } else {
              let targetId = activeBgMessageIdRef.current;
              if (!targetId) {
                targetId = `asst_bg_${Date.now()}`;
                activeBgMessageIdRef.current = targetId;
                setMessages((prev) => [
                  ...prev,
                  {
                    id: targetId!,
                    role: 'assistant',
                    content: '',
                    timeline: [],
                    timestamp: Date.now()
                  }
                ]);
              }
              applyAgentEventToMessage(targetId, evt);
              if (evt.type === 'final') {
                activeBgMessageIdRef.current = null;
                refreshWorkspaceFiles();
                fetchChatSessions().then(setSessions).catch(() => {});
              }
            }
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        if (!isDisposed) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        try {
          ws?.close();
        } catch {}
      };
    };

    connect();

    return () => {
      isDisposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
    };
  }, [bionicConfig.baseUrl, refreshWorkspaceFiles, applyAgentEventToMessage]);

  // Save active file
  const handleSaveFile = async (filePath: string, content: string) => {
    await writeFile(filePath, content);
    setActiveFileContent(content);
  };

  // Update Project Root File (Feature 7)
  const handleSetProjectRootFile = async (newRootFile: string, createIfMissing = false) => {
    const updated = await updateWorkspaceConfig({ rootFile: newRootFile, createIfMissing });
    setProjectRootFile(updated.rootFile);
    await refreshWorkspaceFiles();
    try {
      const fileData = await readFile(updated.rootFile);
      setActiveFilePath(updated.rootFile);
      setActiveFileContent(fileData.content);
      setViewMode('editor');
    } catch {
      // File may not exist yet if createIfMissing was false — do not alert
    }
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
      alert(
        `Script ${scriptPath} exited with code ${res.code}.\n\nOutput:\n${res.stdout || '(None)'}\n\nErrors:\n${res.stderr || '(None)'}`
      );
    } catch (err: any) {
      alert(`Error running script: ${err.message}`);
    }
  };

  // Cancel running subagent
  const handleCancelSubagent = async (jobId: string) => {
    try {
      await cancelSubagentJob(jobId);
    } catch (err: any) {
      alert(`Could not stop subagent: ${err.message}`);
    }
  };

  // Agent message handler
  const handleSendMessage = async (text: string) => {
    if (!text.trim() || isStreaming) return;

    const hasKey =
      agentProvider === 'demo' ||
      agentProvider === 'ollama' ||
      (agentProvider === 'gemini' && Boolean(agentConfig.geminiApiKey || serverKeys.gemini)) ||
      (agentProvider === 'openai' && Boolean(agentConfig.openaiApiKey || serverKeys.openai)) ||
      (agentProvider === 'anthropic' && Boolean(agentConfig.anthropicApiKey || serverKeys.anthropic));

    if (!hasKey) {
      setIsSettingsOpen(true);
      setMessages((prev) => [
        ...prev,
        {
          id: `warn_${Date.now()}`,
          role: 'assistant',
          content: `⚠️ **${agentProvider === 'gemini' ? 'Google Gemini' : agentProvider.toUpperCase()} API Key Required**\n\nPlease enter your API key in Settings → AI & Models to connect to live AI models.`,
          timestamp: Date.now()
        }
      ]);
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

    setMessages((prev) => [...prev, userMsg, initialAssistantMsg]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const apiMessages = [...messages, userMsg].map((m) => ({
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

      await streamAgentChat(
        apiMessages,
        activeConfig,
        (event) => applyAgentEventToMessage(assistantMsgId, event),
        controller.signal
      );
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantMsgId) return m;
            const timeline = (m.timeline || []).map((item) => {
              if (item.type === 'step' && item.status === 'running') {
                return { ...item, status: 'error' as const };
              }
              return item;
            });
            return { ...m, content: `Error: ${err.message}`, timeline };
          })
        );
      }
    } finally {
      abortControllerRef.current = null;
      setIsStreaming(false);
      const finalizedMessages = messagesRef.current.map((m) => {
        if (m.id !== assistantMsgId) return m;
        const timeline = (m.timeline || []).map((item) => {
          if (item.type === 'step' && item.status === 'running') {
            return { ...item, status: 'done' as const };
          }
          return item;
        });
        return { ...m, timeline };
      });
      setMessages(finalizedMessages);
      refreshWorkspaceFiles();

      // Auto-save session outside React state updater (StrictMode-safe & preserves createdAt)
      const activeId = currentSessionIdRef.current;
      const firstUser = finalizedMessages.find((m) => m.role === 'user');
      const title = firstUser
        ? firstUser.content.slice(0, 42) + (firstUser.content.length > 42 ? '...' : '')
        : 'Analysis Session';
      if (!sessionCreatedAtRef.current) {
        sessionCreatedAtRef.current = Date.now();
      }
      saveChatSession({
        id: activeId,
        title,
        createdAt: sessionCreatedAtRef.current,
        updatedAt: Date.now(),
        messages: finalizedMessages,
        tokens: totalTokensRef.current
      })
        .then(() => fetchChatSessions().then(setSessions))
        .catch(() => {});
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
    setMessages((prev) => {
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
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsStreaming(false);
    }
    activeBgMessageIdRef.current = null;
    try {
      const sessionData = await fetchChatSession(id);
      if (sessionData) {
        setCurrentSessionId(id);
        sessionCreatedAtRef.current = sessionData.createdAt || Date.now();
        try {
          localStorage.setItem('bionic_active_session_id', id);
        } catch {}
        setMessages(sessionData.messages || []);
        setTotalTokens(
          sessionData.tokens || { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 }
        );
        const subRes = await fetchSubagents(id).catch(() => null);
        setSubagents(subRes?.jobs || []);
      }
    } catch (err: any) {
      alert(`Could not load session: ${err.message}`);
    }
  };

  const handleNewSession = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsStreaming(false);
    }
    activeBgMessageIdRef.current = null;
    const newId = `session_${Date.now()}`;
    setCurrentSessionId(newId);
    sessionCreatedAtRef.current = Date.now();
    try {
      localStorage.setItem('bionic_active_session_id', newId);
    } catch {}
    setSubagents([]);
    setMessages([
      {
        id: 'welcome',
        role: 'assistant',
        content: `Started a new analysis session. 🔬\n\nDescribe your scientific question or point me to \`${projectRootFile}\` to begin!`,
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
            } else if (item.type === 'subagent') {
              md += `### Subagent (\`${item.job.agent}\`): ${item.job.description}\n*Status: ${item.job.status}*\n\n`;
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
      await refreshWorkspaceFiles();
      handleSelectFile('REPORT.md');
    } catch (err: any) {
      alert(`Could not export report: ${err.message}`);
    }
  };

  const isMarkdown = activeFilePath.toLowerCase().endsWith('.md');

  const hasCurrentKey =
    agentProvider === 'demo' ||
    agentProvider === 'ollama' ||
    (agentProvider === 'gemini' && Boolean(agentConfig.geminiApiKey || serverKeys.gemini)) ||
    (agentProvider === 'openai' && Boolean(agentConfig.openaiApiKey || serverKeys.openai)) ||
    (agentProvider === 'anthropic' && Boolean(agentConfig.anthropicApiKey || serverKeys.anthropic));

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-surface text-ink select-none">
      {/* Top Application Header */}
      <header className="h-11 border-b border-edge bg-elevated flex items-center justify-between px-3 z-10 flex-shrink-0 gap-2">
        {/* Left: Sidebar Toggle, Branding & View Tabs */}
        <div className="flex items-center space-x-2 min-w-0">
          <button
            type="button"
            onClick={toggleLeftCollapsed}
            title={layout.leftCollapsed ? 'Show File Explorer' : 'Hide File Explorer'}
            className={`p-1.5 rounded transition cursor-pointer ${
              layout.leftCollapsed ? 'text-muted hover:text-ink hover:bg-panel' : 'text-ink bg-panel'
            }`}
          >
            <PanelLeft className="w-3.5 h-3.5" />
          </button>

          <div className="flex items-center space-x-2 flex-shrink-0">
            <img
              src="favicon.png"
              alt="Bionic Editor"
              className="w-6 h-6 rounded object-contain flex-shrink-0"
            />
            <span className="font-semibold text-xs tracking-tight text-ink hidden sm:inline">Bionic Editor</span>
          </div>

          <div className="h-4 w-[1px] bg-edge flex-shrink-0" />

          {/* Active File Tab / Report Tab / Data Provenance Tab */}
          <div className="flex items-center space-x-1 min-w-0">
            <button
              onClick={() => setViewMode('editor')}
              className={`flex items-center space-x-1.5 px-2.5 py-1 rounded text-xs transition cursor-pointer ${
                viewMode === 'editor'
                  ? 'bg-panel text-ink font-medium border border-edge'
                  : 'text-muted hover:bg-panel hover:text-ink'
              }`}
            >
              {isMarkdown ? (
                <FileText className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
              ) : (
                <FileCode className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
              )}
              <span className="truncate max-w-[150px]">{activeFilePath}</span>
            </button>

            <button
              onClick={() => setViewMode('report')}
              className={`flex items-center space-x-1.5 px-2.5 py-1 rounded text-xs transition cursor-pointer flex-shrink-0 ${
                viewMode === 'report'
                  ? 'bg-orange-50 dark:bg-orange-950/50 text-orange-900 dark:text-orange-200 font-medium border border-orange-200 dark:border-orange-800'
                  : 'text-muted hover:bg-panel hover:text-ink'
              }`}
            >
              <LayoutDashboard className="w-3.5 h-3.5 text-orange-500" />
              <span>Web Report</span>
            </button>

            <button
              onClick={() => setViewMode('manifest')}
              className={`hidden md:flex items-center space-x-1.5 px-2.5 py-1 rounded text-xs transition cursor-pointer flex-shrink-0 ${
                viewMode === 'manifest'
                  ? 'bg-teal-50 dark:bg-teal-950/50 text-teal-900 dark:text-teal-200 font-medium border border-teal-200 dark:border-teal-800'
                  : 'text-muted hover:bg-panel hover:text-ink'
              }`}
            >
              <Database className="w-3.5 h-3.5 text-teal-500" />
              <span>Data</span>
            </button>
          </div>
        </div>

        {/* Right: Environment status, Coding mode toggle, Theme toggle, Help, Chat panel toggle */}
        <div className="flex items-center space-x-2 text-xs flex-shrink-0">
          <div className="hidden lg:flex items-center">
            {venvStatus.exists ? (
              <span className="flex items-center space-x-1 text-[11px] text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 px-2 py-0.5 rounded-full font-medium">
                <CheckCircle className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                <span>.venv Ready</span>
              </span>
            ) : (
              <button
                onClick={handleCreateVenv}
                disabled={isCreatingVenv}
                className="flex items-center space-x-1 text-[11px] text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/50 hover:opacity-90 border border-amber-300 dark:border-amber-800 px-2 py-0.5 rounded-full font-medium transition cursor-pointer"
              >
                {isCreatingVenv ? (
                  <Loader2 className="w-3 h-3 animate-spin text-amber-600" />
                ) : (
                  <AlertCircle className="w-3 h-3 text-amber-600 dark:text-amber-400" />
                )}
                <span>{isCreatingVenv ? 'Setting up .venv...' : 'Create .venv'}</span>
              </button>
            )}
          </div>

          <button
            onClick={() => {
              const next = !codingMode;
              setCodingMode(next);
              if (next) setShowTerminal(true);
            }}
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition cursor-pointer ${
              codingMode
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                : 'bg-panel text-muted border-edge hover:text-ink'
            }`}
          >
            <Code className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Coding Mode: {codingMode ? 'ON' : 'OFF'}</span>
          </button>

          {/* Quick Theme Toggle */}
          <button
            type="button"
            onClick={toggleLightDark}
            title={resolvedMode === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            className="p-1.5 rounded-full border border-edge bg-panel text-muted hover:text-ink transition cursor-pointer"
          >
            {resolvedMode === 'dark' ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5" />}
          </button>

          {/* Help & Documentation Button */}
          <button
            onClick={() => setIsHelpOpen(true)}
            className="flex items-center space-x-1 px-2.5 py-1 rounded-full text-xs font-medium border border-edge bg-panel text-ink hover:bg-surface transition cursor-pointer"
            title="Open Documentation & Help"
          >
            <HelpCircle className="w-3.5 h-3.5 text-accent" />
            <span className="hidden sm:inline">Help</span>
          </button>

          <button
            type="button"
            onClick={toggleRightCollapsed}
            title={layout.rightCollapsed ? 'Show AI Agent Panel' : 'Hide AI Agent Panel'}
            className={`p-1.5 rounded transition cursor-pointer ${
              layout.rightCollapsed ? 'text-muted hover:text-ink hover:bg-panel' : 'text-ink bg-panel'
            }`}
          >
            <PanelRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Main Workspace Body */}
      <div className="flex flex-1 overflow-hidden min-w-0">
        {/* Left: Resizable File Explorer */}
        {!layout.leftCollapsed && (
          <>
            <div style={{ width: `${layout.leftWidth}px` }} className="flex-shrink-0 h-full overflow-hidden">
              <FileExplorer
                tree={fileTree}
                activeFilePath={activeFilePath}
                projectRootFile={projectRootFile}
                codingMode={codingMode}
                dataManifestHasIssues={dataManifestHasIssues}
                dataManifestCount={dataManifestCount}
                activeViewMode={viewMode}
                onSelectFile={handleSelectFile}
                onOpenDataManifest={() => setViewMode('manifest')}
                onSetProjectRootFile={(p) => handleSetProjectRootFile(p, false)}
                onCreateItem={async (targetPath, isDir) => {
                  await createItem(targetPath, isDir);
                  await refreshWorkspaceFiles();
                  if (!isDir) handleSelectFile(targetPath);
                }}
                onRenameItem={async (oldPath, newPath) => {
                  await renameItem(oldPath, newPath);
                  await refreshWorkspaceFiles();
                  if (activeFilePath === oldPath) setActiveFilePath(newPath);
                }}
                onDeleteItem={async (targetPath) => {
                  const res = await deleteItem(targetPath);
                  await refreshWorkspaceFiles();
                  if (res.manifestAffected) {
                    alert(
                      `Deleted "${targetPath}". It is still listed in Data Provenance (marked Missing) — open Data Provenance if you also want to remove its manifest record.`
                    );
                  }
                  if (activeFilePath === targetPath) {
                    handleSelectFile(projectRootFile);
                  }
                }}
                onUploadFile={async (file, dir) => {
                  await uploadFile(file, dir);
                  await refreshWorkspaceFiles();
                }}
                onRefresh={refreshWorkspaceFiles}
                onInitTemplate={async () => {
                  await initWorkspaceTemplate();
                  await refreshWorkspaceFiles();
                  handleSelectFile(projectRootFile);
                }}
              />
            </div>

            <ResizeHandle
              orientation="vertical"
              currentSize={layout.leftWidth}
              minSize={MIN_LEFT_WIDTH}
              maxSize={MAX_LEFT_WIDTH}
              direction={1}
              onResize={setLeftWidth}
              onReset={resetLeftWidth}
              onDraggingChange={setIsDragging}
              ariaLabel="Resize File Explorer"
            />
          </>
        )}

        {/* Center: Main Editor, Web Report, or Data Provenance Viewer */}
        <div className="flex-1 flex flex-col h-full overflow-hidden bg-surface min-w-0">
          {/* Dismissible updated-doc banner (Feature 5) */}
          {updatedDocBanner && (
            <div className="px-4 py-1.5 bg-blue-50 dark:bg-blue-950/50 border-b border-blue-200 dark:border-blue-800 flex items-center justify-between text-xs text-blue-900 dark:text-blue-200 flex-shrink-0">
              <div className="flex items-center space-x-2 truncate">
                <FileText className="w-3.5 h-3.5 text-accent flex-shrink-0" />
                <span className="truncate">
                  Document updated: <code className="font-mono font-semibold">{updatedDocBanner}</code>
                </span>
                <button
                  type="button"
                  onClick={() => handleSelectFile(updatedDocBanner)}
                  className="px-2 py-0.5 rounded bg-accent text-white text-[11px] font-medium hover:opacity-90 cursor-pointer flex-shrink-0"
                >
                  Open
                </button>
              </div>
              <button
                type="button"
                onClick={() => setUpdatedDocBanner(null)}
                className="p-0.5 opacity-70 hover:opacity-100 cursor-pointer"
                title="Dismiss"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="flex-1 overflow-hidden min-h-0">
            {viewMode === 'report' ? (
              <ReportViewer lastUpdated={reportLastUpdated} isDragging={isDragging} />
            ) : viewMode === 'manifest' ? (
              <DataManifestViewer
                codingMode={codingMode}
                onOpenFile={handleSelectFile}
                onManifestChanged={refreshWorkspaceFiles}
              />
            ) : isMarkdown ? (
              <WysiwygEditor
                key={activeFilePath}
                filePath={activeFilePath}
                initialContent={activeFileContent}
                onSave={handleSaveFile}
                onDirtyChange={handleEditorDirtyChange}
                codingMode={codingMode}
              />
            ) : (
              <MonacoViewer
                key={activeFilePath}
                filePath={activeFilePath}
                initialContent={activeFileContent}
                onSave={handleSaveFile}
                onDirtyChange={handleEditorDirtyChange}
                onRunPython={handleRunPython}
              />
            )}
          </div>

          {/* Bottom Resizable Terminal in Coding Mode */}
          {codingMode && showTerminal && (
            <>
              <ResizeHandle
                orientation="horizontal"
                currentSize={layout.terminalHeight}
                minSize={MIN_TERMINAL_HEIGHT}
                maxSize={560}
                direction={-1}
                onResize={setTerminalHeight}
                onReset={resetTerminalHeight}
                onDraggingChange={setIsDragging}
                ariaLabel="Resize Terminal Panel"
              />
              <TerminalPanel
                projectRootFile={projectRootFile}
                height={layout.terminalHeight}
                onClose={() => setShowTerminal(false)}
              />
            </>
          )}
        </div>

        {/* Right: Resizable AI Agent Panel */}
        {!layout.rightCollapsed && (
          <>
            <ResizeHandle
              orientation="vertical"
              currentSize={layout.rightWidth}
              minSize={MIN_RIGHT_WIDTH}
              maxSize={MAX_RIGHT_WIDTH}
              direction={-1}
              onResize={setRightWidth}
              onReset={resetRightWidth}
              onDraggingChange={setIsDragging}
              ariaLabel="Resize AI Agent Panel"
            />

            <div style={{ width: `${layout.rightWidth}px` }} className="flex-shrink-0 h-full overflow-hidden">
              <AgentPanel
                messages={messages}
                isStreaming={isStreaming}
                totalTokens={totalTokens}
                onSendMessage={handleSendMessage}
                provider={agentProvider}
                onChangeProvider={(p) => {
                  setAgentProvider(p);
                  try {
                    localStorage.setItem('bionic_agent_provider', p);
                  } catch {}
                }}
                onOpenSettings={() => setIsSettingsOpen(true)}
                hasActiveKey={hasCurrentKey}
                harness={agentHarness}
                codingMode={codingMode}
                currentSessionId={currentSessionId}
                sessions={sessions}
                subagents={subagents}
                onCancelSubagent={handleCancelSubagent}
                onSelectSession={handleSelectSession}
                onNewSession={handleNewSession}
                onDeleteSession={handleDeleteSession}
                onCancelWork={handleCancelWork}
                onExportMarkdown={handleExportMarkdown}
                onOpenFile={handleSelectFile}
                workspacePaths={workspacePaths}
              />
            </div>
          </>
        )}
      </div>

      {/* Tabbed Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        config={agentConfig}
        onSaveConfig={async (newConfig) => {
          setAgentConfig(newConfig);
          try {
            localStorage.setItem('bionic_agent_config', JSON.stringify(newConfig));
          } catch {}
          try {
            const res = await saveAgentConfig(newConfig);
            if (res.success) {
              setServerKeys({
                gemini: Boolean(res.hasGeminiKey),
                openai: Boolean(res.hasOpenaiKey),
                anthropic: Boolean(res.hasAnthropicKey)
              });
            }
          } catch (e) {
            console.warn('Could not sync to backend:', e);
          }
        }}
        projectRootFile={projectRootFile}
        markdownFiles={markdownFiles}
        onSaveProjectRootFile={handleSetProjectRootFile}
      />

      {/* Documentation & Help Modal */}
      <HelpModal isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
    </div>
  );
};

export default App;
