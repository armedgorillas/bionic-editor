import React, { useState, useEffect } from 'react';
import {
  X,
  Key,
  ShieldCheck,
  Palette,
  FolderCog,
  FileText,
  Monitor,
  Sun,
  Moon,
  BookOpen
} from 'lucide-react';
import { useTheme, type ThemePreference } from '../contexts/ThemeContext';
import { fetchAgentInstructions, saveAgentInstructions } from '../services/api';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: {
    geminiApiKey: string;
    openaiApiKey: string;
    anthropicApiKey: string;
    ollamaBaseUrl: string;
    selectedModel: string;
  };
  onSaveConfig: (newConfig: any) => void;
  projectRootFile: string;
  markdownFiles: string[];
  onSaveProjectRootFile: (rootFile: string, createIfMissing: boolean) => Promise<void>;
}

type SettingsTab = 'workspace' | 'appearance' | 'models' | 'instructions';

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  config,
  onSaveConfig,
  projectRootFile,
  markdownFiles,
  onSaveProjectRootFile
}) => {
  const { themePreference, setThemePreference } = useTheme();
  const [activeTab, setActiveTab] = useState<SettingsTab>('models');

  // Models state
  const [geminiKey, setGeminiKey] = useState(config.geminiApiKey || '');
  const [openaiKey, setOpenaiKey] = useState(config.openaiApiKey || '');
  const [anthropicKey, setAnthropicKey] = useState(config.anthropicApiKey || '');
  const [ollamaUrl, setOllamaUrl] = useState(config.ollamaBaseUrl || 'http://localhost:11434/v1');
  const [model, setModel] = useState(config.selectedModel || 'gemini-2.5-flash');

  // Workspace Root File state
  const [rootFileInput, setRootFileInput] = useState(projectRootFile);
  const [createIfMissing, setCreateIfMissing] = useState(true);
  const [rootFileError, setRootFileError] = useState<string | null>(null);

  const [saveError, setSaveError] = useState<string | null>(null);
  const [userInstructions, setUserInstructions] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    fetchAgentInstructions()
      .then((res) => {
        if (active) setUserInstructions(res.userInstructions || '');
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isOpen]);

  // Resync modal form fields cleanly when reopened (using state, not refs during render)
  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setGeminiKey(config.geminiApiKey || '');
      setOpenaiKey(config.openaiApiKey || '');
      setAnthropicKey(config.anthropicApiKey || '');
      setOllamaUrl(config.ollamaBaseUrl || 'http://localhost:11434/v1');
      setModel(config.selectedModel || 'gemini-2.5-flash');
      setRootFileInput(projectRootFile);
      setRootFileError(null);
      setSaveError(null);
    }
  }

  if (!isOpen) return null;

  const handleSaveAll = async () => {
    setSaving(true);
    setRootFileError(null);
    setSaveError(null);
    try {
      await Promise.resolve(
        onSaveConfig({
          geminiApiKey: geminiKey,
          openaiApiKey: openaiKey,
          anthropicApiKey: anthropicKey,
          ollamaBaseUrl: ollamaUrl,
          selectedModel: model
        })
      );

      const trimmedRoot = rootFileInput.trim();
      if (trimmedRoot && trimmedRoot !== projectRootFile) {
        try {
          await onSaveProjectRootFile(trimmedRoot, createIfMissing);
        } catch (err: any) {
          setRootFileError(err.message || 'Could not update project root file');
          setActiveTab('workspace');
          return;
        }
      }

      try {
        await saveAgentInstructions(userInstructions);
      } catch (err: any) {
        setSaveError(err.message || 'Could not save agent instructions');
        setActiveTab('instructions');
        return;
      }

      onClose();
    } catch (err: any) {
      setSaveError(err.message || 'Could not save settings');
    } finally {
      setSaving(false);
    }
  };

  const skins: Array<{
    id: ThemePreference;
    label: string;
    description: string;
    icon: React.ReactNode;
    swatch: string;
  }> = [
    {
      id: 'system',
      label: 'System',
      description: 'Automatically matches your OS light/dark preference',
      icon: <Monitor className="w-4 h-4" />,
      swatch: 'bg-gradient-to-br from-white to-slate-900'
    },
    {
      id: 'light',
      label: 'Lab Paper',
      description: 'Clean crisp white canvas with high-contrast ink',
      icon: <Sun className="w-4 h-4" />,
      swatch: 'bg-white border border-gray-300'
    },
    {
      id: 'dark',
      label: 'Midnight Lab',
      description: 'Low-glare charcoal theme for comfortable dark reading',
      icon: <Moon className="w-4 h-4" />,
      swatch: 'bg-[#0f1117] border border-slate-700'
    },
    {
      id: 'warm',
      label: 'Warm Notebook',
      description: 'Soft cream paper tones tailored for long scientific plans',
      icon: <BookOpen className="w-4 h-4" />,
      swatch: 'bg-[#faf7f2] border border-[#d6c5ad]'
    }
  ];

  const tabClass = (tab: SettingsTab) =>
    `py-3 px-3 border-b-2 flex items-center space-x-1.5 transition cursor-pointer ${
      activeTab === tab
        ? 'border-accent text-accent font-semibold'
        : 'border-transparent text-muted hover:text-ink'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 select-none">
      <div className="bg-elevated text-ink rounded-2xl shadow-2xl w-full max-w-2xl max-h-[86vh] flex flex-col overflow-hidden border border-edge">
        {/* Header */}
        <div className="px-6 py-4 border-b border-edge bg-panel flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-ink">Settings</h2>
            <p className="text-[11px] text-muted">Configure workspace defaults, theme skin, AI models, and agent instructions</p>
          </div>
          <button onClick={onClose} className="p-1.5 text-muted hover:text-ink hover:bg-surface rounded-lg transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center px-6 border-b border-edge bg-elevated text-xs font-medium space-x-2 overflow-x-auto">
          <button type="button" onClick={() => setActiveTab('workspace')} className={tabClass('workspace')}>
            <FolderCog className="w-3.5 h-3.5" />
            <span>Workspace</span>
          </button>
          <button type="button" onClick={() => setActiveTab('appearance')} className={tabClass('appearance')}>
            <Palette className="w-3.5 h-3.5" />
            <span>Appearance</span>
          </button>
          <button type="button" onClick={() => setActiveTab('models')} className={tabClass('models')}>
            <Key className="w-3.5 h-3.5" />
            <span>AI &amp; Models</span>
          </button>
          <button type="button" onClick={() => setActiveTab('instructions')} className={tabClass('instructions')}>
            <FileText className="w-3.5 h-3.5" />
            <span>Agent Instructions</span>
          </button>
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 text-xs">
          {activeTab === 'workspace' && (
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold text-ink mb-1">Project Root File</h3>
                <p className="text-[11px] text-muted">
                  Choose the default Markdown plan file that opens on launch, appears pinned in the File Explorer, and serves as the primary document in the agent&apos;s instructions (defaults to <code className="font-mono">SPEC.md</code>).
                </p>
              </div>

              {markdownFiles.length > 0 && (
                <div>
                  <label className="block font-medium text-ink mb-1">Choose Existing Markdown File</label>
                  <select
                    value={markdownFiles.includes(rootFileInput) ? rootFileInput : ''}
                    onChange={(e) => {
                      if (e.target.value) setRootFileInput(e.target.value);
                    }}
                    className="w-full border border-edge bg-surface text-ink rounded-lg px-3 py-1.5 outline-none focus:border-accent"
                  >
                    <option value="">-- Select a workspace .md file --</option>
                    {markdownFiles.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block font-medium text-ink mb-1">Or Enter Custom Relative Path</label>
                <input
                  type="text"
                  value={rootFileInput}
                  onChange={(e) => setRootFileInput(e.target.value)}
                  placeholder="PLAN.md or plans/main_plan.md"
                  className="w-full border border-edge bg-surface text-ink rounded-lg px-3 py-1.5 outline-none focus:border-accent font-mono"
                />
                <label className="mt-2 inline-flex items-center space-x-2 text-[11px] text-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createIfMissing}
                    onChange={(e) => setCreateIfMissing(e.target.checked)}
                    className="accent-blue-600"
                  />
                  <span>Create file with the 5-section scientific Plan template if it doesn&apos;t exist yet</span>
                </label>
              </div>

              {rootFileError && (
                <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-[11px]">
                  {rootFileError}
                </div>
              )}

              <div className="p-3 rounded-lg bg-panel border border-edge text-[11px] text-muted">
                Saved to <code className="font-mono">.bionic/config.json</code> inside this workspace—applies immediately without restarting the server.
              </div>
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold text-ink mb-1">Theme &amp; Reading Skin</h3>
                <p className="text-[11px] text-muted">
                  Applies across the editor, File Explorer, AI chat, and code viewer. Your <code className="font-mono">web-report/</code> publication keeps its own styling.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {skins.map((skin) => {
                  const selected = themePreference === skin.id;
                  return (
                    <button
                      key={skin.id}
                      type="button"
                      onClick={() => setThemePreference(skin.id)}
                      className={`text-left p-3.5 rounded-xl border transition flex items-start space-x-3 cursor-pointer ${
                        selected
                          ? 'border-accent bg-blue-50/50 dark:bg-blue-950/40 ring-1 ring-accent'
                          : 'border-edge bg-surface hover:bg-panel'
                      }`}
                    >
                      <div className={`w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center ${skin.swatch}`}>
                        <span className={skin.id === 'dark' ? 'text-blue-300' : 'text-slate-700'}>{skin.icon}</span>
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-ink">{skin.label}</div>
                        <p className="text-[11px] text-muted mt-0.5 leading-snug">{skin.description}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === 'models' && (
            <div className="space-y-4">
              <div>
                <label className="block font-medium text-ink mb-1">Google Gemini API Key</label>
                <input
                  type="password"
                  value={geminiKey}
                  onChange={(e) => setGeminiKey(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full border border-edge bg-surface text-ink rounded-lg px-3 py-1.5 outline-none focus:border-accent font-mono"
                />
                <p className="text-[11px] text-muted mt-1">Used for Gemini Flash / Pro models.</p>
              </div>

              <div>
                <label className="block font-medium text-ink mb-1">OpenAI API Key</label>
                <input
                  type="password"
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full border border-edge bg-surface text-ink rounded-lg px-3 py-1.5 outline-none focus:border-accent font-mono"
                />
                <p className="text-[11px] text-muted mt-1">Used for GPT-4o and GPT-4o-mini models.</p>
              </div>

              <div>
                <label className="block font-medium text-ink mb-1">Anthropic API Key</label>
                <input
                  type="password"
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)}
                  placeholder="sk-ant-..."
                  className="w-full border border-edge bg-surface text-ink rounded-lg px-3 py-1.5 outline-none focus:border-accent font-mono"
                />
                <p className="text-[11px] text-muted mt-1">Used for Claude Sonnet / Haiku.</p>
              </div>

              <div>
                <label className="block font-medium text-ink mb-1">Ollama / OpenAI-Compatible Endpoint</label>
                <input
                  type="text"
                  value={ollamaUrl}
                  onChange={(e) => setOllamaUrl(e.target.value)}
                  placeholder="http://localhost:11434/v1"
                  className="w-full border border-edge bg-surface text-ink rounded-lg px-3 py-1.5 outline-none focus:border-accent font-mono"
                />
                <p className="text-[11px] text-muted mt-1">Local endpoint for Ollama, vLLM, or self-hosted models.</p>
              </div>

              <div>
                <label className="block font-medium text-ink mb-1">Model Name</label>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="gemini-2.5-flash, gpt-4o, or claude-3-5-sonnet-20241022"
                  className="w-full border border-edge bg-surface text-ink rounded-lg px-3 py-1.5 outline-none focus:border-accent font-mono"
                />
              </div>

              <div className="p-3 bg-blue-50/70 dark:bg-blue-950/35 rounded-lg border border-blue-200 dark:border-blue-800 flex items-start space-x-2">
                <ShieldCheck className="w-4 h-4 text-accent flex-shrink-0 mt-0.5" />
                <p className="text-[11px] text-ink leading-normal">
                  Keys are stored locally on your Bionic Editor server and never committed to Git (<code className="font-mono">.env</code> is ignored and read-denied to agents).
                </p>
              </div>
            </div>
          )}

          {activeTab === 'instructions' && (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-panel border border-edge space-y-1">
                <div className="font-semibold text-ink">Document-First Default Workflow (Active)</div>
                <p className="text-[11px] text-muted leading-relaxed">
                  The AI agent is instructed to write detailed plans, interpretations, and tables into workspace Markdown documents (<code className="font-mono">{projectRootFile}</code>, <code className="font-mono">plans/*.md</code>, <code className="font-mono">RESULTS.md</code>) using the 5-section Plan Format, keep chat responses brief with file pointers, register raw datasets in <code className="font-mono">data/manifest.json</code>, and ask before organizing plans into <code className="font-mono">plans/</code> when more than 3 Markdown files are in the workspace root.
                </p>
              </div>

              <div>
                <label className="block font-medium text-ink mb-1">
                  Additional Lab / Workspace Instructions (optional)
                </label>
                <textarea
                  rows={6}
                  value={userInstructions}
                  onChange={(e) => setUserInstructions(e.target.value)}
                  placeholder="e.g., Always use Benjamini-Hochberg FDR < 0.05; prefer colorblind-safe Okabe-Ito palettes for figures..."
                  className="w-full border border-edge bg-surface text-ink rounded-lg px-3 py-2 outline-none focus:border-accent font-mono text-[11px]"
                />
                <p className="text-[11px] text-muted mt-1">
                  Saved to <code className="font-mono">.bionic/USER_INSTRUCTIONS.md</code> and automatically appended to the agent&apos;s instructions.
                </p>
              </div>

              {saveError && (
                <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-[11px]">
                  {saveError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-panel border-t border-edge flex justify-end space-x-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-muted hover:text-ink rounded"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={handleSaveAll}
            className="px-4 py-1.5 text-xs bg-accent hover:opacity-90 disabled:opacity-60 text-white rounded-lg font-medium shadow-xs cursor-pointer"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  );
};
