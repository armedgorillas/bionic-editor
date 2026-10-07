import React, { useState } from 'react';
import { X, Key, ShieldCheck } from 'lucide-react';

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
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  config,
  onSaveConfig
}) => {
  const [geminiKey, setGeminiKey] = useState(config.geminiApiKey || '');
  const [openaiKey, setOpenaiKey] = useState(config.openaiApiKey);
  const [anthropicKey, setAnthropicKey] = useState(config.anthropicApiKey);
  const [ollamaUrl, setOllamaUrl] = useState(config.ollamaBaseUrl || 'http://localhost:11434/v1');
  const [model, setModel] = useState(config.selectedModel || 'gemini-2.5-flash');

  if (!isOpen) return null;

  const handleSave = () => {
    onSaveConfig({
      geminiApiKey: geminiKey,
      openaiApiKey: openaiKey,
      anthropicApiKey: anthropicKey,
      ollamaBaseUrl: ollamaUrl,
      selectedModel: model
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden border border-gray-200">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Key className="w-4 h-4 text-blue-600" />
            <h2 className="text-sm font-semibold text-gray-800">Agent Configuration & Keys</h2>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-xs text-gray-700">
          <div>
            <label className="block font-medium text-gray-700 mb-1">Google Gemini API Key</label>
            <input
              type="password"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              placeholder="AIzaSy..."
              className="w-full border border-gray-200 rounded-lg px-3 py-1.5 outline-none focus:border-blue-500 font-mono"
            />
            <p className="text-[11px] text-gray-400 mt-1">Used for Gemini 2.5 Flash / Pro models.</p>
          </div>

          <div>
            <label className="block font-medium text-gray-700 mb-1">OpenAI API Key</label>
            <input
              type="password"
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder="sk-..."
              className="w-full border border-gray-200 rounded-lg px-3 py-1.5 outline-none focus:border-blue-500 font-mono"
            />
            <p className="text-[11px] text-gray-400 mt-1">Used for GPT-4o and GPT-4o-mini models.</p>
          </div>

          <div>
            <label className="block font-medium text-gray-700 mb-1">Anthropic API Key</label>
            <input
              type="password"
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              placeholder="sk-ant-..."
              className="w-full border border-gray-200 rounded-lg px-3 py-1.5 outline-none focus:border-blue-500 font-mono"
            />
            <p className="text-[11px] text-gray-400 mt-1">Used for Claude 3.5 Sonnet / Haiku.</p>
          </div>

          <div>
            <label className="block font-medium text-gray-700 mb-1">Ollama / OpenAI-Compatible Endpoint</label>
            <input
              type="text"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              placeholder="http://localhost:11434/v1"
              className="w-full border border-gray-200 rounded-lg px-3 py-1.5 outline-none focus:border-blue-500 font-mono"
            />
            <p className="text-[11px] text-gray-400 mt-1">Local endpoint for Ollama, vLLM, or self-hosted models.</p>
          </div>

          <div>
            <label className="block font-medium text-gray-700 mb-1">Model Name</label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o, claude-3-5-sonnet-20241022, or llama3"
              className="w-full border border-gray-200 rounded-lg px-3 py-1.5 outline-none focus:border-blue-500 font-mono"
            />
          </div>

          <div className="p-3 bg-blue-50 rounded-lg border border-blue-100 flex items-start space-x-2">
            <ShieldCheck className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-blue-800 leading-normal">
              Keys are kept in your local browser session and sent securely to the single-port server. If no keys are provided, the Built-in Scientific Demo Assistant is available offline.
            </p>
          </div>
        </div>

        <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 flex justify-end space-x-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-800 rounded"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded font-medium shadow-xs"
          >
            Save Configuration
          </button>
        </div>
      </div>
    </div>
  );
};
