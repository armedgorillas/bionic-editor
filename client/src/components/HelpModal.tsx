import React, { useState } from 'react';
import { 
  X, 
  HelpCircle, 
  BookOpen, 
  Sparkles, 
  FileText, 
  Terminal, 
  LayoutDashboard, 
  Key, 
  CheckCircle2, 
  Code2,
  FolderTree,
  FlaskConical
} from 'lucide-react';

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const HelpModal: React.FC<HelpModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<'quickstart' | 'workflow' | 'agent' | 'models' | 'faq'>('quickstart');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 select-none">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden border border-gray-200">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/70">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 rounded-lg bg-blue-600 text-white flex items-center justify-center shadow-xs">
              <FlaskConical className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Bionic Editor Documentation &amp; User Guide</h2>
              <p className="text-[11px] text-gray-500">A scientific document editor and computational harness for biologists</p>
            </div>
          </div>
          <button 
            onClick={onClose} 
            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded-lg transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center px-6 border-b border-gray-200 bg-white text-xs font-medium space-x-2 overflow-x-auto">
          <button
            onClick={() => setActiveTab('quickstart')}
            className={`py-3 px-3 border-b-2 flex items-center space-x-1.5 transition ${
              activeTab === 'quickstart'
                ? 'border-blue-600 text-blue-600 font-semibold'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>Quick Start</span>
          </button>

          <button
            onClick={() => setActiveTab('workflow')}
            className={`py-3 px-3 border-b-2 flex items-center space-x-1.5 transition ${
              activeTab === 'workflow'
                ? 'border-blue-600 text-blue-600 font-semibold'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            <FolderTree className="w-3.5 h-3.5" />
            <span>Scientific Workflow</span>
          </button>

          <button
            onClick={() => setActiveTab('agent')}
            className={`py-3 px-3 border-b-2 flex items-center space-x-1.5 transition ${
              activeTab === 'agent'
                ? 'border-blue-600 text-blue-600 font-semibold'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>AI Agent Harness</span>
          </button>

          <button
            onClick={() => setActiveTab('models')}
            className={`py-3 px-3 border-b-2 flex items-center space-x-1.5 transition ${
              activeTab === 'models'
                ? 'border-blue-600 text-blue-600 font-semibold'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            <Key className="w-3.5 h-3.5" />
            <span>Models &amp; API Keys</span>
          </button>

          <button
            onClick={() => setActiveTab('faq')}
            className={`py-3 px-3 border-b-2 flex items-center space-x-1.5 transition ${
              activeTab === 'faq'
                ? 'border-blue-600 text-blue-600 font-semibold'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            <HelpCircle className="w-3.5 h-3.5" />
            <span>Tips &amp; FAQ</span>
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 text-xs text-gray-700 select-text leading-relaxed space-y-4">
          {activeTab === 'quickstart' && (
            <div className="space-y-4">
              <div className="bg-blue-50/70 border border-blue-200 rounded-xl p-4 text-blue-900 space-y-1">
                <h3 className="font-semibold text-sm flex items-center space-x-1.5">
                  <span>Welcome to Bionic Editor</span>
                </h3>
                <p className="text-xs leading-normal">
                  Bionic Editor gives non-coder analytical scientists access to the power of AI coding harnesses without the overwhelming developer interfaces of traditional IDEs.
                </p>
              </div>

              <div className="space-y-3">
                <h4 className="font-semibold text-gray-900 text-xs uppercase tracking-wider">3-Step Getting Started</h4>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="p-3 bg-white border border-gray-200 rounded-lg shadow-2xs space-y-1">
                    <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 font-bold flex items-center justify-center text-[11px]">1</span>
                    <h5 className="font-semibold text-gray-900">Define in SPEC.md</h5>
                    <p className="text-gray-500 text-[11px]">
                      Open <code>SPEC.md</code> in the WYSIWYG editor. Write your scientific hypotheses, variables, and analysis goals in plain English.
                    </p>
                  </div>

                  <div className="p-3 bg-white border border-gray-200 rounded-lg shadow-2xs space-y-1">
                    <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 font-bold flex items-center justify-center text-[11px]">2</span>
                    <h5 className="font-semibold text-gray-900">Instruct the Agent</h5>
                    <p className="text-gray-500 text-[11px]">
                      Tell the AI Agent: <em>"Analyze the dataset in data/raw/ and compute log fold changes"</em>. Watch it plan, write code, and run scripts.
                    </p>
                  </div>

                  <div className="p-3 bg-white border border-gray-200 rounded-lg shadow-2xs space-y-1">
                    <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 font-bold flex items-center justify-center text-[11px]">3</span>
                    <h5 className="font-semibold text-gray-900">Review Web Report</h5>
                    <p className="text-gray-500 text-[11px]">
                      Switch to the <strong>Web Report</strong> tab to inspect interactive charts and summaries automatically rendered at <code>/report/</code>.
                    </p>
                  </div>
                </div>
              </div>

              <div className="border-t border-gray-100 pt-3 space-y-2">
                <h4 className="font-semibold text-gray-900">Default Scientific Layout</h4>
                <p className="text-gray-600">
                  Inspired by Cookiecutter Data Science, every project is organized cleanly:
                </p>
                <div className="bg-gray-900 text-gray-200 font-mono text-[11px] p-3 rounded-lg overflow-x-auto leading-relaxed">
                  <div>project/</div>
                  <div>├── SPEC.md &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; # Core scientific plan &amp; instructions</div>
                  <div>├── data/raw/ &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; # Original input datasets (CSV, FASTQ)</div>
                  <div>├── data/processed/ &nbsp; &nbsp; &nbsp; &nbsp;# Output tables &amp; cleaned results</div>
                  <div>├── src/ &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp;# Python analysis pipelines</div>
                  <div>├── figures/ &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp;# Saved visualization plots</div>
                  <div>├── web-report/ &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; # Interactive HTML dashboard</div>
                  <div>├── requirements.txt &nbsp; &nbsp; &nbsp;# Python package dependencies</div>
                  <div>└── .venv/ &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; # Isolated virtual environment</div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'workflow' && (
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold text-gray-900 mb-1">How Collaborative Science Works in Bionic</h3>
                <p className="text-gray-600">
                  Instead of chaotic back-and-forth chat that gets lost, all scientific instructions are developed and recorded into <code>SPEC.md</code>.
                </p>
              </div>

              <div className="space-y-3">
                <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg space-y-1">
                  <div className="flex items-center space-x-2 text-gray-900 font-semibold">
                    <FileText className="w-4 h-4 text-amber-600" />
                    <span>WYSIWYG Document Editor</span>
                  </div>
                  <p className="text-gray-600 text-[11px]">
                    Markdown files are presented in clean, proportional typography without syntax markers cluttering your screen. You can add headers, bullet lists, bold text, and inline figures like <code>![Volcano Plot](figures/volcano_plot.png)</code>. The underlying file remains pure Markdown so agents can inspect and update it.
                  </p>
                </div>

                <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg space-y-1">
                  <div className="flex items-center space-x-2 text-gray-900 font-semibold">
                    <LayoutDashboard className="w-4 h-4 text-orange-600" />
                    <span>Live Web Report (web-report/)</span>
                  </div>
                  <p className="text-gray-600 text-[11px]">
                    The <strong>Web Report</strong> tab renders <code>web-report/index.html</code> directly inside the editor over the same server port. When your AI agent writes interactive charts (using Plotly, Chart.js, or HTML tables), the preview updates live.
                  </p>
                </div>

                <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg space-y-1">
                  <div className="flex items-center space-x-2 text-gray-900 font-semibold">
                    <Terminal className="w-4 h-4 text-emerald-600" />
                    <span>Isolated Python Virtual Environment (.venv)</span>
                  </div>
                  <p className="text-gray-600 text-[11px]">
                    All analysis scripts and bash commands run inside an isolated virtual environment in your workspace. You do not need to manage system Python installations. Click the <strong>Create .venv</strong> badge in the top bar to set up dependencies automatically.
                  </p>
                </div>

                <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg space-y-1">
                  <div className="flex items-center space-x-2 text-gray-900 font-semibold">
                    <Code2 className="w-4 h-4 text-indigo-600" />
                    <span>Coding Mode Switch</span>
                  </div>
                  <p className="text-gray-600 text-[11px]">
                    By default, developer interfaces are hidden. When you toggle <strong>Coding Mode: ON</strong> in the top header, an interactive terminal session and raw code editors are unhidden at the bottom of the window.
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'agent' && (
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold text-gray-900 mb-1">AI Scientific Agent &amp; Coding Harness</h3>
                <p className="text-gray-600">
                  The AI Agent acts as your computational research assistant. It can read datasets, write Python scripts, run commands, and generate reports.
                </p>
              </div>

              <div className="space-y-3">
                <div className="p-3 bg-white border border-gray-200 rounded-lg space-y-1.5 shadow-2xs">
                  <h4 className="font-semibold text-gray-900 flex items-center space-x-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-indigo-600" />
                    <span>Transparent Plan &amp; Logic Stream</span>
                  </h4>
                  <p className="text-gray-600 text-[11px]">
                    Before taking actions, the agent explains its rationale in <strong>Agent Plan &amp; Logic</strong> cards, interleaved chronologically before each command.
                  </p>
                </div>

                <div className="p-3 bg-white border border-gray-200 rounded-lg space-y-1.5 shadow-2xs">
                  <h4 className="font-semibold text-gray-900 flex items-center space-x-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-indigo-600" />
                    <span>Unabridged Command Traces</span>
                  </h4>
                  <p className="text-gray-600 text-[11px]">
                    When a script or command runs (e.g. <code>$ python src/analyze.py</code>), the card captures the full output without truncation. If an error occurs, the card expands in red with complete Python stack traces and a <strong>Copy</strong> button.
                  </p>
                </div>

                <div className="p-3 bg-white border border-gray-200 rounded-lg space-y-1.5 shadow-2xs">
                  <h4 className="font-semibold text-gray-900 flex items-center space-x-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-red-600" />
                    <span>Stopping Work &amp; Cancellation</span>
                  </h4>
                  <p className="text-gray-600 text-[11px]">
                    If the agent is running a long computation or taking an unwanted path, click the red <strong>Stop (■)</strong> button in the chat box. It immediately interrupts the LLM and terminates active child processes.
                  </p>
                </div>

                <div className="p-3 bg-white border border-gray-200 rounded-lg space-y-1.5 shadow-2xs">
                  <h4 className="font-semibold text-gray-900 flex items-center space-x-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-blue-600" />
                    <span>Past Analysis Chats Drawer &amp; Export</span>
                  </h4>
                  <p className="text-gray-600 text-[11px]">
                    Click the <strong>History</strong> icon in the agent header to browse, switch between, or delete previous analysis sessions. Chats are saved to <code>workspace/.bionic/sessions/</code> and can be exported directly to <code>REPORT.md</code>.
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'models' && (
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold text-gray-900 mb-1">Configuring AI Models &amp; API Keys</h3>
                <p className="text-gray-600">
                  Bionic Editor supports Google Gemini, OpenAI, Anthropic Claude, local Ollama, and an offline demo assistant.
                </p>
              </div>

              <div className="space-y-3">
                <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg space-y-1">
                  <div className="font-semibold text-gray-900 flex items-center justify-between">
                    <span>Google Gemini (Recommended)</span>
                    <span className="text-[10px] bg-emerald-100 text-emerald-800 px-1.5 rounded">Fast &amp; Cost-Effective</span>
                  </div>
                  <p className="text-gray-600 text-[11px]">
                    Click the <strong>⚙ (Gear)</strong> icon in the Agent panel and paste your Gemini API key (starts with <code>AIzaSy...</code>). Supports <code>gemini-2.5-flash</code> ($0.075 / 1M tokens) and <code>gemini-2.5-pro</code>.
                  </p>
                </div>

                <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg space-y-1">
                  <div className="font-semibold text-gray-900">OpenAI (GPT-4o)</div>
                  <p className="text-gray-600 text-[11px]">
                    Enter your OpenAI key (<code>sk-...</code>) in Settings. Defaults to <code>gpt-4o</code> and <code>gpt-4o-mini</code>.
                  </p>
                </div>

                <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg space-y-1">
                  <div className="font-semibold text-gray-900">Anthropic (Claude 3.5 Sonnet)</div>
                  <p className="text-gray-600 text-[11px]">
                    Enter your Anthropic key (<code>sk-ant-...</code>) in Settings. Defaults to <code>claude-3-5-sonnet-20241022</code>.
                  </p>
                </div>

                <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg space-y-1">
                  <div className="font-semibold text-gray-900">Local Ollama / Self-Hosted</div>
                  <p className="text-gray-600 text-[11px]">
                    For offline air-gapped research, select <strong>Local (Ollama)</strong> and point the endpoint to <code>http://localhost:11434/v1</code> with models like <code>llama3</code> or <code>qwen2.5-coder</code>.
                  </p>
                </div>
              </div>

              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 text-[11px]">
                <strong>Persistent Storage:</strong> Saving your API key in the Settings modal writes it to your server's <code>.env</code> file and remembers it across browser reloads.
              </div>
            </div>
          )}

          {activeTab === 'faq' && (
            <div className="space-y-3">
              <div className="space-y-1">
                <h4 className="font-semibold text-gray-900">How do I load my own datasets?</h4>
                <p className="text-gray-600">
                  Click the <strong>Upload</strong> button (arrow up icon) in the Workspace file explorer on the left, or drop CSV/Excel files directly into <code>workspace/data/raw/</code>.
                </p>
              </div>

              <div className="space-y-1">
                <h4 className="font-semibold text-gray-900">How do local images render in the document editor?</h4>
                <p className="text-gray-600">
                  Any markdown image tag referencing local files like <code>![Plot](figures/volcano_plot.png)</code> is automatically resolved to <code>/api/files/raw/figures/volcano_plot.png</code> and displayed inline.
                </p>
              </div>

              <div className="space-y-1">
                <h4 className="font-semibold text-gray-900">What if a Python package is missing?</h4>
                <p className="text-gray-600">
                  You can tell the AI Agent: <em>"Install seaborn in requirements.txt and install it into .venv"</em>, or switch to <strong>Coding Mode: ON</strong> and run <code>pip install package_name</code> directly in the terminal panel.
                </p>
              </div>

              <div className="space-y-1">
                <h4 className="font-semibold text-gray-900">How do I deploy this to a web server?</h4>
                <p className="text-gray-600">
                  Run <code>npm run build && npm start</code>. Bionic Editor multiplexes the application UI, WebSockets, API endpoints, and live reports over a <strong>single port</strong> (default 3000), making it ready for any reverse proxy (Nginx, Traefik, Caddy).
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 bg-gray-50 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
          <span>Bionic Editor v1.0 • For non-coder analytical scientists</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium shadow-2xs transition"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
