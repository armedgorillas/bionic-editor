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
  Database,
  ExternalLink
} from 'lucide-react';

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const HelpModal: React.FC<HelpModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<'quickstart' | 'workflow' | 'agent' | 'models' | 'faq'>('quickstart');

  if (!isOpen) return null;

  const tabClass = (tab: typeof activeTab) =>
    `py-3 px-3 border-b-2 flex items-center space-x-1.5 transition cursor-pointer ${
      activeTab === tab
        ? 'border-accent text-accent font-semibold'
        : 'border-transparent text-muted hover:text-ink'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 select-none">
      <div className="bg-elevated text-ink rounded-2xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden border border-edge">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-edge flex items-center justify-between bg-panel">
          <div className="flex items-center space-x-2.5">
            <img
              src="favicon.png"
              alt="Bionic Editor"
              className="w-7 h-7 rounded-lg object-contain flex-shrink-0"
            />
            <div>
              <h2 className="text-sm font-semibold text-ink">Bionic Editor Documentation &amp; User Guide</h2>
              <p className="text-[11px] text-muted">A scientific document editor and computational harness for analytical scientists</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-muted hover:text-ink hover:bg-surface rounded-lg transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center px-6 border-b border-edge bg-elevated text-xs font-medium space-x-2 overflow-x-auto">
          <button onClick={() => setActiveTab('quickstart')} className={tabClass('quickstart')}>
            <BookOpen className="w-3.5 h-3.5" />
            <span>Quick Start</span>
          </button>
          <button onClick={() => setActiveTab('workflow')} className={tabClass('workflow')}>
            <FolderTree className="w-3.5 h-3.5" />
            <span>Scientific Workflow</span>
          </button>
          <button onClick={() => setActiveTab('agent')} className={tabClass('agent')}>
            <Sparkles className="w-3.5 h-3.5" />
            <span>AI Agent &amp; Subagents</span>
          </button>
          <button onClick={() => setActiveTab('models')} className={tabClass('models')}>
            <Key className="w-3.5 h-3.5" />
            <span>Models &amp; API Keys</span>
          </button>
          <button onClick={() => setActiveTab('faq')} className={tabClass('faq')}>
            <HelpCircle className="w-3.5 h-3.5" />
            <span>Tips &amp; FAQ</span>
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 text-xs text-ink select-text leading-relaxed space-y-4">
          {activeTab === 'quickstart' && (
            <div className="space-y-4">
              <div className="bg-blue-50/70 dark:bg-blue-950/35 border border-blue-200 dark:border-blue-800 rounded-xl p-4 space-y-1">
                <h3 className="font-semibold text-sm text-ink">Welcome to Bionic Editor</h3>
                <p className="text-xs leading-normal text-muted">
                  Bionic Editor gives analytical scientists the power of AI coding agents while keeping work centered on readable Markdown plans, verified data provenance, and live interactive publications.
                </p>
              </div>

              <div className="space-y-3">
                <h4 className="font-semibold text-ink text-xs uppercase tracking-wider">3-Step Getting Started</h4>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="p-3 bg-surface border border-edge rounded-lg space-y-1">
                    <span className="w-5 h-5 rounded-full bg-blue-100 dark:bg-blue-950 text-accent font-bold flex items-center justify-center text-[11px]">1</span>
                    <h5 className="font-semibold text-ink">Write Your Plan</h5>
                    <p className="text-muted text-[11px]">
                      Draft your <strong>Research Question</strong>, <strong>Data Sourcing</strong>, <strong>Data Processing</strong>, <strong>Data Display</strong>, and <strong>Tests</strong> in your project root plan (default <code className="font-mono">SPEC.md</code>, customizable in Settings).
                    </p>
                  </div>

                  <div className="p-3 bg-surface border border-edge rounded-lg space-y-1">
                    <span className="w-5 h-5 rounded-full bg-blue-100 dark:bg-blue-950 text-accent font-bold flex items-center justify-center text-[11px]">2</span>
                    <h5 className="font-semibold text-ink">Register Raw Data</h5>
                    <p className="text-muted text-[11px]">
                      Upload or download datasets into <code className="font-mono">data/raw/</code>. Raw files stay out of Git and <code className="font-mono">web-report/</code> while fingerprints &amp; download scripts are tracked in <strong>Data Provenance</strong>.
                    </p>
                  </div>

                  <div className="p-3 bg-surface border border-edge rounded-lg space-y-1">
                    <span className="w-5 h-5 rounded-full bg-blue-100 dark:bg-blue-950 text-accent font-bold flex items-center justify-center text-[11px]">3</span>
                    <h5 className="font-semibold text-ink">Review Web Report</h5>
                    <p className="text-muted text-[11px]">
                      Switch to the <strong>Web Report</strong> tab to view your publication at <code className="font-mono">/report/</code>, complete with interactive charts and scientific validation results.
                    </p>
                  </div>
                </div>
              </div>

              <div className="border-t border-edge pt-3 space-y-2">
                <h4 className="font-semibold text-ink">Default Scientific Layout</h4>
                <div className="bg-gray-900 text-gray-200 font-mono text-[11px] p-3 rounded-lg overflow-x-auto leading-relaxed">
                  <div>project/</div>
                  <div>├── SPEC.md                 # Project root plan (configurable)</div>
                  <div>├── plans/                  # Additional scientific plans</div>
                  <div>├── code/                   # Reproducible Python scripts</div>
                  <div>├── data/</div>
                  <div>│   ├── raw/                # Raw datasets (ignored by Git &amp; publication)</div>
                  <div>│   ├── processed/          # Processed output tables</div>
                  <div>│   ├── manifest.json       # SHA-256 provenance registry</div>
                  <div>│   └── DATA_MANIFEST.md    # Readable provenance table</div>
                  <div>├── figures/                # Saved plots &amp; images</div>
                  <div>├── tests/scientific/       # Validation tests &amp; PASS/FAIL JSON results</div>
                  <div>├── web-report/             # Live HTML publication (/report/)</div>
                  <div>├── requirements.txt        # Python package dependencies</div>
                  <div>└── .venv/                  # Isolated virtual environment</div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'workflow' && (
            <div className="space-y-3">
              <div className="p-3 bg-panel border border-edge rounded-lg space-y-1">
                <div className="flex items-center space-x-2 text-ink font-semibold">
                  <FileText className="w-4 h-4 text-amber-500" />
                  <span>Document-First Plans</span>
                </div>
                <p className="text-muted text-[11px]">
                  The agent writes detailed plans, methods, and findings into Markdown files rather than walls of chat text. Click any file badge in chat to jump straight to that document in the WYSIWYG editor.
                </p>
              </div>

              <div className="p-3 bg-panel border border-edge rounded-lg space-y-1">
                <div className="flex items-center space-x-2 text-ink font-semibold">
                  <Database className="w-4 h-4 text-teal-500" />
                  <span>Data Provenance</span>
                </div>
                <p className="text-muted text-[11px]">
                  Click <strong>Data Provenance</strong> in the File Explorer to inspect SHA-256 fingerprints, download scripts, and run integrity &amp; publication safety checks ensuring raw data never leaks into Git or <code className="font-mono">web-report/</code>.
                </p>
              </div>

              <div className="p-3 bg-panel border border-edge rounded-lg space-y-1">
                <div className="flex items-center space-x-2 text-ink font-semibold">
                  <LayoutDashboard className="w-4 h-4 text-orange-500" />
                  <span>Live Web Report Publication</span>
                </div>
                <p className="text-muted text-[11px]">
                  The <strong>Web Report</strong> tab renders <code className="font-mono">web-report/index.html</code> live on the same port, alongside validation results from <code className="font-mono">tests/scientific/</code>.
                </p>
              </div>

              <div className="p-3 bg-panel border border-edge rounded-lg space-y-1">
                <div className="flex items-center space-x-2 text-ink font-semibold">
                  <Terminal className="w-4 h-4 text-emerald-500" />
                  <span>Isolated Python Virtual Environment (.venv)</span>
                </div>
                <p className="text-muted text-[11px]">
                  All scripts in <code className="font-mono">code/</code> execute inside the workspace&apos;s isolated <code className="font-mono">.venv</code>.
                </p>
              </div>

              <div className="p-3 bg-panel border border-edge rounded-lg space-y-1">
                <div className="flex items-center space-x-2 text-ink font-semibold">
                  <Code2 className="w-4 h-4 text-indigo-500" />
                  <span>Coding Mode &amp; Explorer View Menu</span>
                </div>
                <p className="text-muted text-[11px]">
                  Use the <strong>View</strong> icon in the File Explorer to toggle dot-folders (<code className="font-mono">.bionic</code>, <code className="font-mono">.opencode</code>, <code className="font-mono">.gitignore</code>) or auxiliary coding files. Toggle <strong>Coding Mode</strong> to open the interactive terminal and raw Markdown toggle.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'agent' && (
            <div className="space-y-3">
              <p className="text-muted">
                Powered by <strong>OpenCode</strong> under the hood, the AI Agent runs as a persistent workspace service with live background subagent updates.
              </p>

              <div className="p-3 bg-surface border border-edge rounded-lg space-y-1">
                <h4 className="font-semibold text-ink flex items-center space-x-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-blue-500" />
                  <span>Live Background Subagents</span>
                </h4>
                <p className="text-muted text-[11px]">
                  When you ask the agent to launch a subagent, a compact <strong>Subagent</strong> card tracks live status and elapsed time while you keep editing. When it finishes, the card updates automatically and the agent posts the follow-up summary in chat. Click <strong>Show details</strong> only if you want to inspect the subagent&apos;s transcript.
                </p>
              </div>

              <div className="p-3 bg-surface border border-edge rounded-lg space-y-1">
                <h4 className="font-semibold text-ink flex items-center space-x-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-red-500" />
                  <span>Stopping Work &amp; Cancelling Subagents</span>
                </h4>
                <p className="text-muted text-[11px]">
                  Click <strong>Stop</strong> in the chat box to interrupt the active run, or click <strong>Stop</strong> directly on any running subagent card.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'models' && (
            <div className="space-y-3">
              <p className="text-muted">
                Open <strong>Settings → AI &amp; Models</strong> to configure Google Gemini, OpenAI, Anthropic Claude, or local Ollama. API keys are saved in your server&apos;s <code className="font-mono">.env</code> file (git-ignored and blocked from agent reads).
              </p>
            </div>
          )}

          {activeTab === 'faq' && (
            <div className="space-y-3">
              <div className="space-y-1">
                <h4 className="font-semibold text-ink">How do I change the default project file from SPEC.md?</h4>
                <p className="text-muted">
                  Open <strong>Settings → Workspace</strong> to pick any Markdown file as your Project Root File, or click the star icon next to any <code className="font-mono">.md</code> file in the File Explorer.
                </p>
              </div>
              <div className="space-y-1">
                <h4 className="font-semibold text-ink">How do I resize panels or switch to Dark Mode / Warm Notebook?</h4>
                <p className="text-muted">
                  Drag either vertical separator between the File Explorer, Editor, and AI Agent panels (double-click to reset). Use the Sun/Moon button in the header for quick light/dark switching, or choose <strong>Warm Notebook</strong> in <strong>Settings → Appearance</strong>.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 bg-panel border-t border-edge flex items-center justify-between text-xs text-muted">
          <div className="flex items-center space-x-2">
            <span>Bionic Editor • For analytical scientists</span>
            <span className="opacity-40">•</span>
            <a
              href="https://editor.rightbionic.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center space-x-1 text-accent hover:underline font-medium"
            >
              <span>editor.rightbionic.com</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-accent hover:opacity-90 text-white rounded-lg font-medium transition cursor-pointer"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
