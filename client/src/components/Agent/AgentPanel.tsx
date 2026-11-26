import React, { useState, useRef, useEffect } from 'react';
import {
  Bot,
  Send,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Settings2,
  Coins,
  Copy,
  Sparkles,
  Terminal,
  Square,
  History,
  Plus,
  Trash2,
  FileDown,
  X,
  GitBranch
} from 'lucide-react';
import type { ChatMessage, TokenUsage, ChatSessionSummary, SubagentJobView, AgentTimelineItem } from '../../types';
import type { HubManagedModel } from '../../services/api';
import { MarkdownMessage } from './MarkdownMessage';
import { SubagentCard } from './SubagentCard';

interface AgentPanelProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  totalTokens: TokenUsage;
  onSendMessage: (content: string) => Promise<void>;
  provider: string;
  onChangeProvider: (provider: string) => void;
  hubManaged?: boolean;
  hubModels?: HubManagedModel[];
  selectedModel?: string;
  onChangeModel?: (modelSlug: string) => void;
  onOpenSettings: () => void;
  hasActiveKey?: boolean;
  harness?: 'opencode' | 'built-in';
  codingMode?: boolean;
  currentSessionId?: string;
  sessions?: ChatSessionSummary[];
  subagents?: SubagentJobView[];
  onCancelSubagent?: (jobId: string) => void;
  onSelectSession?: (id: string) => Promise<void>;
  onNewSession?: () => void;
  onDeleteSession?: (id: string) => Promise<void>;
  onCancelWork?: () => void;
  onExportMarkdown?: () => void;
  onOpenFile?: (path: string) => void;
  workspacePaths?: Set<string>;
}

export const AgentPanel: React.FC<AgentPanelProps> = ({
  messages,
  isStreaming,
  totalTokens,
  onSendMessage,
  provider,
  onChangeProvider,
  hubManaged = false,
  hubModels = [],
  selectedModel = '',
  onChangeModel,
  onOpenSettings,
  hasActiveKey = true,
  harness = 'built-in',
  codingMode = false,
  currentSessionId,
  sessions = [],
  subagents = [],
  onCancelSubagent,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onCancelWork,
  onExportMarkdown,
  onOpenFile,
  workspacePaths
}) => {
  const [input, setInput] = useState<string>('');
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
  const [expandedStepGroups, setExpandedStepGroups] = useState<Record<string, boolean>>({});
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [showSubagentDrawer, setShowSubagentDrawer] = useState<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    const text = input;
    setInput('');
    onSendMessage(text);
  };

  const toggleStep = (stepId: string) => {
    setExpandedSteps((prev) => ({ ...prev, [stepId]: !prev[stepId] }));
  };

  const runningSubagents = subagents.filter((j) => j.status === 'running');
  const hasSubagents = harness === 'opencode' && subagents.length > 0;

  const renderStepCard = (step: Extract<AgentTimelineItem, { type: 'step' }>) => {
    const isError = step.status === 'error';
    const isExpanded = expandedSteps[step.id] ?? isError;

    return (
      <div
        key={step.id}
        className={`bg-elevated border rounded-lg p-2.5 shadow-2xs text-xs transition ${
          isError
            ? 'border-red-300 dark:border-red-800 bg-red-50/20 dark:bg-red-950/25'
            : 'border-edge hover:border-muted/50'
        }`}
      >
        <div
          className="flex items-center justify-between cursor-pointer"
          onClick={() => toggleStep(step.id)}
        >
          <div className="flex items-center space-x-2 truncate pr-2">
            {step.status === 'running' && (
              <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin flex-shrink-0" />
            )}
            {step.status === 'done' && (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
            )}
            {isError && (
              <AlertCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
            )}
            <span
              className={`font-mono text-[11px] truncate ${
                isError ? 'text-red-700 dark:text-red-300 font-semibold' : 'text-ink font-medium'
              }`}
            >
              {step.title}
            </span>
          </div>

          <div className="flex items-center space-x-1 flex-shrink-0 text-muted">
            {isError && (
              <span className="text-[10px] bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300 px-1.5 py-0.2 rounded font-sans font-medium mr-1">
                Error
              </span>
            )}
            {step.details && (
              <div>
                {isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
              </div>
            )}
          </div>
        </div>

        <p className={`mt-1 pl-5.5 leading-normal ${isError ? 'text-red-600 dark:text-red-400' : 'text-muted'}`}>
          {step.description}
        </p>

        {step.details && isExpanded && (
          <div className="mt-2.5 rounded-md border border-gray-800 bg-[#141414] overflow-hidden">
            <div className="px-2.5 py-1 bg-[#1f1f1f] border-b border-[#2d2d2d] flex items-center justify-between text-[10px] text-gray-400 font-mono">
              <div className="flex items-center space-x-1.5">
                <Terminal className="w-3 h-3 text-gray-400" />
                <span>Output Trace</span>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(step.details || '');
                }}
                className="flex items-center space-x-1 text-gray-400 hover:text-gray-200 px-1 py-0.5 rounded hover:bg-[#2c2c2c]"
                title="Copy output to clipboard"
              >
                <Copy className="w-2.5 h-2.5" />
                <span>Copy</span>
              </button>
            </div>

            <pre
              className={`p-2.5 text-[11px] font-mono overflow-x-auto max-h-80 leading-relaxed whitespace-pre-wrap select-text ${
                isError ? 'text-red-300' : 'text-gray-200'
              }`}
            >
              {step.details}
            </pre>
          </div>
        )}
      </div>
    );
  };

  const renderTimeline = (msg: ChatMessage) => {
    const timeline = msg.timeline || [];
    if (timeline.length === 0) return null;

    // In non-coding mode, collapse routine completed tool steps into a quiet expandable group
    const regularSteps = timeline.filter((i): i is Extract<AgentTimelineItem, { type: 'step' }> => i.type === 'step');
    const nonStepItems = timeline.filter((i) => i.type !== 'step');
    const hasRunningOrErrorStep = regularSteps.some((s) => s.status === 'running' || s.status === 'error');
    const shouldCollapseSteps = !codingMode && regularSteps.length > 0 && !hasRunningOrErrorStep && Boolean(msg.content);
    const groupOpen = Boolean(expandedStepGroups[msg.id]);

    if (shouldCollapseSteps) {
      return (
        <div className="space-y-2">
          {nonStepItems.map((item) => {
            if (item.type === 'subagent') {
              return (
                <SubagentCard
                  key={item.id}
                  job={item.job}
                  onCancel={onCancelSubagent}
                  onOpenFile={onOpenFile}
                  workspacePaths={workspacePaths}
                />
              );
            }
            if (item.type === 'thought') {
              return (
                <div
                  key={item.id}
                  className="bg-indigo-50/70 dark:bg-indigo-950/30 border-l-2 border-indigo-500 rounded-r-lg px-3 py-2 text-xs text-ink space-y-1"
                >
                  <div className="flex items-center space-x-1.5 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300 uppercase tracking-wider">
                    <Sparkles className="w-3 h-3" />
                    <span>Agent Plan &amp; Logic</span>
                  </div>
                  <MarkdownMessage content={item.content} compact onOpenFile={onOpenFile} workspacePaths={workspacePaths} />
                </div>
              );
            }
            return null;
          })}

          <div className="rounded-lg border border-edge bg-panel/70 overflow-hidden">
            <button
              type="button"
              onClick={() => setExpandedStepGroups((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }))}
              className="w-full px-2.5 py-1.5 flex items-center justify-between text-[11px] text-muted hover:text-ink transition cursor-pointer"
            >
              <span className="flex items-center space-x-1.5">
                <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                <span>Completed {regularSteps.length} workspace {regularSteps.length === 1 ? 'action' : 'actions'}</span>
              </span>
              {groupOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
            {groupOpen && (
              <div className="p-2 pt-0 space-y-1.5">
                {regularSteps.map(renderStepCard)}
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {timeline.map((item) => {
          if (item.type === 'subagent') {
            return (
              <SubagentCard
                key={item.id}
                job={item.job}
                onCancel={onCancelSubagent}
                onOpenFile={onOpenFile}
                workspacePaths={workspacePaths}
              />
            );
          }

          if (item.type === 'thought') {
            return (
              <div
                key={item.id}
                className="bg-indigo-50/70 dark:bg-indigo-950/30 border-l-2 border-indigo-500 rounded-r-lg px-3.5 py-2.5 text-xs text-ink shadow-2xs space-y-1"
              >
                <div className="flex items-center space-x-1.5 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300 uppercase tracking-wider">
                  <Sparkles className="w-3 h-3" />
                  <span>Agent Plan &amp; Logic</span>
                </div>
                <div className="leading-relaxed text-ink font-sans">
                  <MarkdownMessage content={item.content} compact onOpenFile={onOpenFile} workspacePaths={workspacePaths} />
                </div>
              </div>
            );
          }

          return renderStepCard(item);
        })}
      </div>
    );
  };

  return (
    <div className="relative flex flex-col h-full w-full bg-surface text-ink select-none overflow-hidden">
      {/* Compact Header (fits cleanly down to 280px width) */}
      <div className="px-3 py-2 border-b border-edge bg-elevated flex items-center justify-between gap-1.5">
        <div className="flex items-center space-x-2 min-w-0">
          <div className="w-6 h-6 rounded-md bg-blue-50 dark:bg-blue-950/60 text-accent flex items-center justify-center flex-shrink-0">
            <Bot className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-xs font-semibold text-ink leading-tight truncate" title="AI Scientific Agent">
              AI Agent
            </h3>
          </div>
        </div>

        <div className="flex items-center space-x-1 flex-shrink-0">
          {hubManaged && hubModels.length > 0 && onChangeModel ? (
            <select
              value={provider === 'demo' ? '__demo__' : selectedModel || hubModels[0].slug}
              onChange={(e) => {
                if (e.target.value === '__demo__') {
                  onChangeProvider('demo');
                } else {
                  onChangeModel(e.target.value);
                }
              }}
              aria-label="AI Model"
              className="text-[11px] max-w-[140px] bg-panel border border-edge rounded px-1.5 py-0.5 text-ink outline-none hover:bg-surface font-medium truncate"
            >
              {hubModels.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.displayName}
                </option>
              ))}
              <option value="__demo__">Demo</option>
            </select>
          ) : (
            <select
              value={provider}
              onChange={(e) => onChangeProvider(e.target.value)}
              aria-label="AI Provider"
              className="text-[11px] max-w-[104px] bg-panel border border-edge rounded px-1.5 py-0.5 text-ink outline-none hover:bg-surface font-medium truncate"
            >
              <option value="gemini">Gemini</option>
              <option value="demo">Demo</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Claude</option>
              <option value="ollama">Ollama</option>
            </select>
          )}

          <button
            onClick={() => {
              setShowSubagentDrawer(false);
              setShowHistory(!showHistory);
            }}
            title="Past Analysis Chats"
            className={`p-1 rounded transition ${
              showHistory
                ? 'bg-blue-100 dark:bg-blue-950 text-accent'
                : 'text-muted hover:text-ink hover:bg-panel'
            }`}
          >
            <History className="w-3.5 h-3.5" />
          </button>

          {onNewSession && (
            <button
              onClick={() => {
                setShowHistory(false);
                setShowSubagentDrawer(false);
                onNewSession();
              }}
              title="Start New Chat"
              className="p-1 text-muted hover:text-ink hover:bg-panel rounded transition"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            onClick={onOpenSettings}
            title="Settings"
            className="p-1 hover:bg-panel rounded text-muted hover:text-ink transition"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Token Usage & Subtle Subagents Pill Bar */}
      <div className="px-3 py-1.5 bg-panel border-b border-edge flex items-center justify-between gap-2 text-[11px] text-muted">
        <div className="flex items-center space-x-1.5 min-w-0 truncate">
          <Coins className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
          <span className="font-semibold text-ink">{totalTokens.totalTokens.toLocaleString()}</span>
          <span className="opacity-50">|</span>
          <span className="font-mono">~${totalTokens.estimatedCostUsd.toFixed(4)}</span>
        </div>

        <div className="flex items-center space-x-1.5 flex-shrink-0">
          {hasSubagents && (
            <button
              type="button"
              onClick={() => {
                setShowHistory(false);
                setShowSubagentDrawer((v) => !v);
              }}
              className={`inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-medium border transition cursor-pointer ${
                runningSubagents.length > 0
                  ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
                  : 'bg-elevated text-muted border-edge hover:text-ink'
              }`}
              title="View background subagents in this session"
            >
              {runningSubagents.length > 0 ? (
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
              ) : (
                <GitBranch className="w-2.5 h-2.5" />
              )}
              <span>
                Subagents {runningSubagents.length > 0 ? `(${runningSubagents.length} running)` : `(${subagents.length})`}
              </span>
            </button>
          )}

          {hasActiveKey ? (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
              ● Live
            </span>
          ) : (
            <button
              onClick={onOpenSettings}
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 dark:bg-amber-950/50 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-800 hover:opacity-90 cursor-pointer"
            >
              ⚠ Key
            </button>
          )}
        </div>
      </div>

      {/* Missing Key Banner */}
      {!hasActiveKey && provider !== 'demo' && (
        <div
          onClick={onOpenSettings}
          className="mx-3 mt-2.5 p-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 rounded-lg text-amber-900 dark:text-amber-200 text-[11px] flex items-center justify-between cursor-pointer hover:opacity-90 transition"
        >
          <div className="flex items-center space-x-1.5">
            <AlertCircle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
            <span>
              <strong>{provider === 'gemini' ? 'Google Gemini' : provider} key required:</strong> Click to configure.
            </span>
          </div>
        </div>
      )}

      {/* Subtle Subagents Activity Drawer (Idea 2) */}
      {showSubagentDrawer && hasSubagents && (
        <div className="absolute inset-x-0 top-[74px] bottom-0 z-30 bg-elevated/95 backdrop-blur-sm border-b border-edge flex flex-col shadow-lg select-none">
          <div className="px-3.5 py-2.5 border-b border-edge bg-panel flex items-center justify-between">
            <div className="flex items-center space-x-1.5 text-xs font-semibold text-ink">
              <GitBranch className="w-3.5 h-3.5 text-accent" />
              <span>Session Subagents</span>
              <span className="text-[10px] bg-elevated border border-edge text-muted px-1.5 rounded-full">
                {subagents.length}
              </span>
            </div>
            <button
              onClick={() => setShowSubagentDrawer(false)}
              className="p-1 hover:bg-surface rounded text-muted hover:text-ink"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {subagents.map((job) => (
              <SubagentCard
                key={job.jobId}
                job={job}
                onCancel={onCancelSubagent}
                onOpenFile={onOpenFile}
                workspacePaths={workspacePaths}
              />
            ))}
          </div>
        </div>
      )}

      {/* Past Sessions Drawer Overlay */}
      {showHistory && (
        <div className="absolute inset-x-0 top-[74px] bottom-0 z-30 bg-elevated/95 backdrop-blur-sm border-b border-edge flex flex-col shadow-lg select-none">
          <div className="px-3.5 py-2.5 border-b border-edge bg-panel flex items-center justify-between">
            <div className="flex items-center space-x-1.5 text-xs font-semibold text-ink">
              <History className="w-3.5 h-3.5 text-accent" />
              <span>Past Analysis Chats</span>
              <span className="text-[10px] bg-elevated border border-edge text-muted px-1.5 rounded-full">
                {sessions.length}
              </span>
            </div>
            <button
              onClick={() => setShowHistory(false)}
              className="p-1 hover:bg-surface rounded text-muted hover:text-ink"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="p-2 border-b border-edge bg-elevated flex items-center space-x-2">
            {onNewSession && (
              <button
                onClick={() => {
                  setShowHistory(false);
                  onNewSession();
                }}
                className="flex-1 flex items-center justify-center space-x-1.5 bg-accent hover:opacity-90 text-white px-3 py-1.5 rounded text-xs font-medium transition"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Analysis Chat</span>
              </button>
            )}
            {onExportMarkdown && (
              <button
                onClick={onExportMarkdown}
                title="Export current session as REPORT.md"
                className="flex items-center space-x-1 px-2.5 py-1.5 bg-panel hover:bg-surface text-ink border border-edge rounded text-xs transition"
              >
                <FileDown className="w-3.5 h-3.5" />
                <span>Export</span>
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {sessions.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted">
                No past sessions saved yet. Chat history is stored automatically in <code className="font-mono">.bionic/sessions/</code>.
              </div>
            ) : (
              sessions.map((s) => {
                const isActive = currentSessionId === s.id;
                const formattedDate = new Date(s.updatedAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                });

                return (
                  <div
                    key={s.id}
                    onClick={() => {
                      if (onSelectSession) {
                        onSelectSession(s.id);
                        setShowHistory(false);
                      }
                    }}
                    className={`group flex items-center justify-between p-2.5 rounded-lg border text-xs cursor-pointer transition ${
                      isActive
                        ? 'bg-blue-50/80 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800 text-ink font-medium'
                        : 'bg-elevated border-edge hover:bg-panel text-ink'
                    }`}
                  >
                    <div className="truncate pr-2">
                      <div className="truncate font-medium">{s.title}</div>
                      <div className="text-[10px] text-muted mt-0.5 flex items-center space-x-2">
                        <span>{formattedDate}</span>
                        <span>•</span>
                        <span>{s.messageCount} messages</span>
                      </div>
                    </div>

                    {onDeleteSession && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete session "${s.title}"?`)) {
                            onDeleteSession(s.id);
                          }
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-600 text-muted rounded transition"
                        title="Delete past chat"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Chat Messages Stream */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-3.5 text-xs select-text">
        {messages.map((msg) => (
          <div key={msg.id} className="space-y-2">
            {msg.role === 'user' ? (
              <div className="flex justify-end">
                <div className="bg-accent text-white rounded-2xl rounded-tr-sm px-3.5 py-2 max-w-[85%] leading-relaxed shadow-sm">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {msg.timeline && msg.timeline.length > 0 ? (
                  renderTimeline(msg)
                ) : (
                  <>
                    {msg.thoughts &&
                      msg.thoughts.map((th, idx) => (
                        <div
                          key={idx}
                          className="bg-indigo-50/70 dark:bg-indigo-950/30 border-l-2 border-indigo-500 rounded-r-lg px-3.5 py-2.5 text-xs text-ink space-y-1"
                        >
                          <div className="flex items-center space-x-1.5 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300 uppercase tracking-wider">
                            <Sparkles className="w-3 h-3" />
                            <span>Agent Plan &amp; Logic</span>
                          </div>
                          <MarkdownMessage content={th} compact onOpenFile={onOpenFile} workspacePaths={workspacePaths} />
                        </div>
                      ))}
                    {msg.steps &&
                      msg.steps.map((s) =>
                        renderStepCard({
                          type: 'step',
                          id: s.id,
                          title: s.title,
                          description: s.description,
                          details: s.details,
                          status: s.status
                        })
                      )}
                  </>
                )}

                {msg.content && (
                  <div className="bg-elevated border border-edge rounded-2xl rounded-tl-sm px-3.5 py-2.5 text-ink leading-relaxed shadow-2xs">
                    <MarkdownMessage content={msg.content} onOpenFile={onOpenFile} workspacePaths={workspacePaths} />
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {isStreaming && (
          <div className="flex items-center justify-between text-xs text-blue-700 dark:text-blue-300 bg-blue-50/90 dark:bg-blue-950/40 p-2.5 rounded-lg border border-blue-200 dark:border-blue-800">
            <div className="flex items-center space-x-2 truncate pr-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
              <span className="truncate">Working in workspace...</span>
            </div>
            {onCancelWork && (
              <button
                onClick={onCancelWork}
                className="flex items-center space-x-1 bg-red-600 hover:bg-red-700 text-white px-2 py-0.5 rounded text-[11px] font-medium transition flex-shrink-0 cursor-pointer"
                title="Stop work"
              >
                <Square className="w-2.5 h-2.5 fill-current" />
                <span>Stop</span>
              </button>
            )}
          </div>
        )}

        {!isStreaming && runningSubagents.length > 0 && (
          <div className="flex items-center justify-between text-xs text-blue-700 dark:text-blue-300 bg-blue-50/70 dark:bg-blue-950/30 p-2 rounded-lg border border-blue-200 dark:border-blue-800">
            <div className="flex items-center space-x-2 truncate">
              <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
              <span className="truncate">
                {runningSubagents.length} background {runningSubagents.length === 1 ? 'subagent' : 'subagents'} running — chat will update when finished
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowSubagentDrawer(true)}
              className="text-[11px] font-medium underline flex-shrink-0 ml-2 cursor-pointer"
            >
              Inspect
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Clean Input Form (all canned prompt helpers removed) */}
      <form onSubmit={handleSubmit} className="p-2.5 border-t border-edge bg-elevated">
        <div className="relative flex items-center">
          <textarea
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            placeholder="Ask the agent to plan, analyze data, or update your report..."
            className="w-full text-xs p-2.5 pr-16 bg-surface border border-edge rounded-lg outline-none focus:border-accent focus:ring-1 focus:ring-accent resize-none leading-normal text-ink placeholder:text-muted"
          />

          {isStreaming ? (
            <button
              type="button"
              onClick={onCancelWork}
              className="absolute right-2 bottom-2 px-2.5 py-1.5 rounded-md bg-red-600 text-white hover:bg-red-700 shadow-xs flex items-center space-x-1 text-xs font-medium transition cursor-pointer"
              title="Stop work / Cancel execution"
            >
              <Square className="w-3 h-3 fill-current" />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="absolute right-2 bottom-2.5 p-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40 transition cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
};
