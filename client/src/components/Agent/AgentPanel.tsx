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
  Terminal
} from 'lucide-react';
import type { ChatMessage, TokenUsage } from '../../types';

interface AgentPanelProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  totalTokens: TokenUsage;
  onSendMessage: (content: string) => Promise<void>;
  provider: string;
  onChangeProvider: (provider: string) => void;
  onOpenSettings: () => void;
  hasActiveKey?: boolean;
}

export const AgentPanel: React.FC<AgentPanelProps> = ({
  messages,
  isStreaming,
  totalTokens,
  onSendMessage,
  provider,
  onChangeProvider,
  onOpenSettings,
  hasActiveKey = true
}) => {
  const [input, setInput] = useState<string>('');
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
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
    setExpandedSteps(prev => ({ ...prev, [stepId]: !prev[stepId] }));
  };

  const quickPrompts = [
    { label: 'Analyze Expression Data', text: 'Run the Python data analysis script on the raw expression dataset.' },
    { label: 'Flesh Out SPEC.md', text: 'Help flesh out the hypotheses and analysis pipeline in SPEC.md.' },
    { label: 'Generate Web Report', text: 'Create an interactive scientific visualization in web-report/index.html.' }
  ];

  return (
    <div className="flex flex-col h-full bg-[#fdfdfd] border-l border-gray-200 w-80 lg:w-96 select-none">
      {/* Header with Token Usage & Provider */}
      <div className="px-3.5 py-2.5 border-b border-gray-200 bg-white flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className="w-6 h-6 rounded-md bg-blue-50 text-blue-600 flex items-center justify-center">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-xs font-semibold text-gray-800 leading-tight">AI Scientific Agent</h3>
            <span className="text-[10px] text-gray-400">Collaborative Coding Harness</span>
          </div>
        </div>

        <div className="flex items-center space-x-1.5">
          <select
            value={provider}
            onChange={(e) => onChangeProvider(e.target.value)}
            className="text-[11px] bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5 text-gray-700 outline-none hover:bg-gray-100 font-medium"
          >
            <option value="gemini">Google Gemini</option>
            <option value="demo">Demo / Offline</option>
            <option value="openai">OpenAI (GPT-4o)</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="ollama">Local (Ollama)</option>
          </select>

          <button
            onClick={onOpenSettings}
            title="Agent API Keys & Configuration"
            className="p-1 hover:bg-gray-100 rounded text-gray-500 hover:text-gray-800"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Token Usage Bar (opencode style) */}
      <div className="px-3.5 py-1.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between text-[11px] text-gray-500">
        <div className="flex items-center space-x-1.5">
          <div className="flex items-center space-x-1 text-gray-600">
            <Coins className="w-3.5 h-3.5 text-amber-500" />
            <span>Usage:</span>
            <span className="font-semibold text-gray-700">{totalTokens.totalTokens.toLocaleString()}</span>
          </div>
          <span className="text-gray-400">|</span>
          <span className="font-mono text-gray-500">~${totalTokens.estimatedCostUsd.toFixed(4)}</span>
        </div>

        <div>
          {hasActiveKey ? (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
              ● Live Model
            </span>
          ) : (
            <button
              onClick={onOpenSettings}
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-800 border border-amber-300 hover:bg-amber-100 cursor-pointer"
            >
              ⚠ Key Needed
            </button>
          )}
        </div>
      </div>

      {/* Missing Key Banner */}
      {!hasActiveKey && provider !== 'demo' && (
        <div 
          onClick={onOpenSettings}
          className="mx-3 mt-2.5 p-2 bg-amber-50/90 border border-amber-300 rounded-lg text-amber-900 text-[11px] flex items-center justify-between cursor-pointer hover:bg-amber-100 transition shadow-2xs"
        >
          <div className="flex items-center space-x-1.5">
            <AlertCircle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
            <span><strong>{provider === 'gemini' ? 'Google Gemini' : provider} key required:</strong> Click to configure.</span>
          </div>
        </div>
      )}

      {/* Chat Messages Stream */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-3.5 text-xs select-text">
        {messages.map((msg) => (
          <div key={msg.id} className="space-y-2">
            {msg.role === 'user' ? (
              <div className="flex justify-end">
                <div className="bg-blue-600 text-white rounded-2xl rounded-tr-sm px-3.5 py-2 max-w-[85%] leading-relaxed shadow-sm">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {/* Unified Interleaved Chronological Timeline */}
                {msg.timeline && msg.timeline.length > 0 ? (
                  <div className="space-y-2">
                    {msg.timeline.map((item) => {
                      if (item.type === 'thought') {
                        return (
                          <div 
                            key={item.id} 
                            className="bg-indigo-50/70 border-l-2 border-indigo-500 rounded-r-lg px-3.5 py-2.5 text-xs text-gray-800 shadow-2xs space-y-1"
                          >
                            <div className="flex items-center space-x-1.5 text-[10px] font-semibold text-indigo-700 uppercase tracking-wider">
                              <Sparkles className="w-3 h-3" />
                              <span>Agent Plan &amp; Logic</span>
                            </div>
                            <div className="whitespace-pre-wrap leading-relaxed text-gray-800 font-sans">
                              {item.content}
                            </div>
                          </div>
                        );
                      }

                      const step = item;
                      const isError = step.status === 'error';
                      const isExpanded = expandedSteps[step.id] ?? isError;

                      return (
                        <div
                          key={step.id}
                          className={`bg-white border rounded-lg p-2.5 shadow-sm text-xs transition ${
                            isError 
                              ? 'border-red-300 bg-red-50/20' 
                              : 'border-gray-200/90 hover:border-gray-300'
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
                              <span className={`font-mono text-[11px] truncate ${
                                isError ? 'text-red-700 font-semibold' : 'text-gray-900 font-medium'
                              }`}>
                                {step.title}
                              </span>
                            </div>

                            <div className="flex items-center space-x-1 flex-shrink-0 text-gray-400">
                              {isError && (
                                <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.2 rounded font-sans font-medium mr-1">
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

                          <p className={`mt-1 pl-5.5 leading-normal ${isError ? 'text-red-600' : 'text-gray-600'}`}>
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

                              <pre className={`p-2.5 text-[11px] font-mono overflow-x-auto max-h-80 leading-relaxed whitespace-pre-wrap select-text ${
                                isError ? 'text-red-300' : 'text-gray-200'
                              }`}>
                                {step.details}
                              </pre>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <>
                    {/* Fallback legacy render if any */}
                    {msg.thoughts && msg.thoughts.map((th, idx) => (
                      <div 
                        key={idx} 
                        className="bg-indigo-50/70 border-l-2 border-indigo-500 rounded-r-lg px-3.5 py-2.5 text-xs text-gray-800 shadow-2xs space-y-1"
                      >
                        <div className="flex items-center space-x-1.5 text-[10px] font-semibold text-indigo-700 uppercase tracking-wider">
                          <Sparkles className="w-3 h-3" />
                          <span>Agent Plan &amp; Logic</span>
                        </div>
                        <div className="whitespace-pre-wrap leading-relaxed text-gray-800 font-sans">
                          {th}
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {/* Final Formatted Narrative Text */}
                {msg.content && (
                  <div className="bg-white border border-gray-200/80 rounded-2xl rounded-tl-sm px-3.5 py-2.5 text-gray-800 leading-relaxed shadow-sm space-y-1.5">
                    {msg.content.split('\n\n').map((paragraph, idx) => (
                      <p key={idx} className="whitespace-pre-wrap">{paragraph}</p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {isStreaming && (
          <div className="flex items-center space-x-2 text-xs text-blue-600 bg-blue-50/70 p-2.5 rounded-lg border border-blue-100">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Agent is analyzing workspace and executing tasks...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Quick Scientific Prompts */}
      <div className="px-3 py-1.5 bg-gray-50/50 border-t border-gray-100 flex items-center space-x-1.5 overflow-x-auto">
        {quickPrompts.map((q, idx) => (
          <button
            key={idx}
            onClick={() => onSendMessage(q.text)}
            className="flex-shrink-0 text-[11px] bg-white border border-gray-200 hover:border-blue-400 hover:text-blue-600 text-gray-600 px-2 py-1 rounded-full transition shadow-xs"
          >
            {q.label}
          </button>
        ))}
      </div>

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="p-2.5 border-t border-gray-200 bg-white">
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
            placeholder="Ask agent to plan, analyze data, or build reports..."
            className="w-full text-xs p-2.5 pr-10 border border-gray-200 rounded-lg outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none leading-normal text-gray-800 placeholder-gray-400"
          />
          <button
            type="submit"
            disabled={!input.trim() || isStreaming}
            className="absolute right-2 bottom-2.5 p-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:hover:bg-blue-600 transition"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </form>
    </div>
  );
};
