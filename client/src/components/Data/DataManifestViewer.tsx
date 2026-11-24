import React, { useState, useEffect, useCallback } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  Copy,
  Check,
  Plus,
  Trash2,
  FileCode,
  AlertTriangle,
  Database,
  Loader2,
  X
} from 'lucide-react';
import type { DataManifestSummary } from '../../types';
import {
  fetchDataManifest,
  verifyDataManifest,
  registerDataManifestFile,
  untrackRawFromGit,
  deleteDataManifestEntry
} from '../../services/api';

interface DataManifestViewerProps {
  codingMode: boolean;
  onOpenFile: (path: string) => void;
  onManifestChanged?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const DataManifestViewer: React.FC<DataManifestViewerProps> = ({
  codingMode,
  onOpenFile,
  onManifestChanged
}) => {
  const [summary, setSummary] = useState<DataManifestSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ type: 'info' | 'warn' | 'error'; text: string } | null>(null);

  // Register / Edit modal state
  const [registerTarget, setRegisterTarget] = useState<string | null>(null);
  const [formDescription, setFormDescription] = useState('');
  const [formScriptPath, setFormScriptPath] = useState('');
  const [formCommand, setFormCommand] = useState('');
  const [formSourceUrl, setFormSourceUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchDataManifest();
      setSummary(data);
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetchDataManifest()
      .then((data) => {
        if (active) setSummary(data);
      })
      .catch((err: any) => {
        if (active) setStatusMessage({ type: 'error', text: err.message });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleVerify = async (preserveWarning = false) => {
    setVerifying(true);
    if (!preserveWarning) setStatusMessage(null);
    try {
      const report = await verifyDataManifest();
      setSummary(report);
      onManifestChanged?.();
      if (!preserveWarning) {
        const leakCount =
          (report.leaks?.gitTrackedRawFiles.length || 0) +
          (report.leaks?.publicationLeaks.length || 0);
        if (report.hasIssues || leakCount > 0) {
          setStatusMessage({
            type: 'warn',
            text: 'Integrity or publication safety check found items that need attention below.'
          });
        } else {
          setStatusMessage({
            type: 'info',
            text: 'All registered raw datasets match their SHA-256 fingerprints and no raw data leaks were found.'
          });
        }
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message });
    } finally {
      setVerifying(false);
    }
  };

  const openRegisterModal = (filepath: string, existing?: any) => {
    setRegisterTarget(filepath);
    setFormDescription(existing?.description || '');
    setFormScriptPath(existing?.acquisition?.scriptPath || '');
    setFormCommand(existing?.acquisition?.command || '');
    setFormSourceUrl(existing?.acquisition?.sourceUrl || '');
  };

  const handleSubmitRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!registerTarget) return;
    setSubmitting(true);
    try {
      const method = formScriptPath.trim()
        ? 'script'
        : formSourceUrl.trim()
          ? 'url'
          : 'manual';
      await registerDataManifestFile({
        filepath: registerTarget,
        description: formDescription.trim(),
        acquisition: {
          method,
          scriptPath: formScriptPath.trim(),
          command: formCommand.trim(),
          sourceUrl: formSourceUrl.trim()
        }
      });
      setRegisterTarget(null);
      await loadSummary();
      onManifestChanged?.();
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleUntrackGit = async (filepath: string) => {
    try {
      const res = await untrackRawFromGit(filepath);
      if (res.warning) {
        setStatusMessage({ type: 'warn', text: res.warning });
        await handleVerify(true);
      } else {
        setStatusMessage({ type: 'info', text: `Untracked ${filepath} from Git index (file kept on disk).` });
        await handleVerify(true);
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message });
    }
  };

  const handleDeleteEntry = async (id: string, filepath: string) => {
    if (!confirm(`Remove "${filepath}" from Data Provenance manifest? (The file itself on disk will not be deleted.)`)) {
      return;
    }
    try {
      await deleteDataManifestEntry(id);
      await loadSummary();
      onManifestChanged?.();
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message });
    }
  };

  const copyHash = (id: string, hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const statusBadge = (status: string) => {
    switch (status) {
      case 'verified':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">Verified</span>;
      case 'present':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-100 dark:bg-blue-950/60 text-blue-800 dark:text-blue-300 border border-blue-200 dark:border-blue-800">Present</span>;
      case 'modified':
      case 'size_changed':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-800">Modified</span>;
      case 'missing':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-100 dark:bg-red-950/60 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800">Missing on disk</span>;
      default:
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-panel text-muted border border-edge">{status}</span>;
    }
  };

  return (
    <div className="flex flex-col h-full bg-surface text-ink overflow-hidden">
      {/* Header Toolbar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-edge bg-elevated select-none">
        <div className="flex items-center space-x-2.5">
          <div className="w-7 h-7 rounded-lg bg-teal-100 dark:bg-teal-950/60 text-teal-700 dark:text-teal-300 flex items-center justify-center">
            <Database className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-ink">Data Provenance</h2>
            <p className="text-[11px] text-muted">
              Raw files in <code className="font-mono">data/raw/</code> stay out of Git and <code className="font-mono">web-report/</code>; fingerprints &amp; download scripts are tracked here.
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          {codingMode && (
            <button
              onClick={() => onOpenFile('data/manifest.json')}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs border border-edge bg-panel hover:bg-surface text-ink transition cursor-pointer"
            >
              <FileCode className="w-3.5 h-3.5" />
              <span>View Raw JSON</span>
            </button>
          )}
          <button
            onClick={() => onOpenFile('data/DATA_MANIFEST.md')}
            className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs border border-edge bg-panel hover:bg-surface text-ink transition cursor-pointer"
          >
            <span>Open Markdown View</span>
          </button>
          <button
            onClick={() => handleVerify(false)}
            disabled={verifying}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:opacity-90 disabled:opacity-60 transition cursor-pointer"
          >
            {verifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            <span>{verifying ? 'Checking...' : 'Check Integrity & Safety'}</span>
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-5 max-w-5xl w-full mx-auto">
        {statusMessage && (
          <div
            className={`p-3 rounded-lg border text-xs flex items-center justify-between ${
              statusMessage.type === 'error'
                ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300'
                : statusMessage.type === 'warn'
                  ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-300'
                  : 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
            }`}
          >
            <span>{statusMessage.text}</span>
            <button onClick={() => setStatusMessage(null)} className="p-0.5 opacity-70 hover:opacity-100">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12 text-xs text-muted space-x-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Loading Data Provenance...</span>
          </div>
        ) : (
          <>
            {/* Unregistered raw files alert */}
            {summary && summary.untrackedRawFiles.length > 0 && (
              <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/25 p-4 space-y-2.5">
                <div className="flex items-center space-x-2 text-xs font-semibold text-amber-900 dark:text-amber-300">
                  <ShieldAlert className="w-4 h-4" />
                  <span>Unregistered Raw Files in data/raw/ ({summary.untrackedRawFiles.length})</span>
                </div>
                <p className="text-[11px] text-amber-800 dark:text-amber-300/80">
                  Register these files so their SHA-256 fingerprint, download source, and description are recorded in version control.
                </p>
                <div className="space-y-1.5">
                  {summary.untrackedRawFiles.map((f) => (
                    <div
                      key={f.filepath}
                      className="flex items-center justify-between px-3 py-2 rounded-lg bg-elevated border border-edge text-xs"
                    >
                      <div className="truncate">
                        <span className="font-mono font-medium text-ink">{f.filepath}</span>
                        <span className="ml-2 text-[11px] text-muted">{formatBytes(f.sizeBytes)}</span>
                      </div>
                      <button
                        onClick={() => openRegisterModal(f.filepath)}
                        className="flex items-center space-x-1 px-2.5 py-1 rounded bg-accent text-white text-[11px] font-medium hover:opacity-90 cursor-pointer"
                      >
                        <Plus className="w-3 h-3" />
                        <span>Register</span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Publication & Git Safety Audit Results */}
            {summary?.leaks && (summary.leaks.gitTrackedRawFiles.length > 0 || summary.leaks.publicationLeaks.length > 0) && (
              <div className="rounded-xl border border-red-300 dark:border-red-800 bg-red-50/60 dark:bg-red-950/25 p-4 space-y-3">
                <div className="flex items-center space-x-2 text-xs font-semibold text-red-800 dark:text-red-300">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Publication &amp; Version Control Safety Alerts</span>
                </div>

                {summary.leaks.gitTrackedRawFiles.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-medium text-red-700 dark:text-red-300">
                      Raw files currently tracked by Git:
                    </div>
                    {summary.leaks.gitTrackedRawFiles.map((fp) => (
                      <div
                        key={fp}
                        className="flex items-center justify-between px-3 py-1.5 rounded bg-elevated border border-edge text-xs"
                      >
                        <span className="font-mono text-ink">{fp}</span>
                        <button
                          onClick={() => handleUntrackGit(fp)}
                          className="px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white text-[11px] font-medium cursor-pointer"
                        >
                          Remove from Git index
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {summary.leaks.publicationLeaks.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-medium text-red-700 dark:text-red-300">
                      Potential raw data inside <code className="font-mono">web-report/</code> publication:
                    </div>
                    {summary.leaks.publicationLeaks.map((leak, idx) => (
                      <div
                        key={`${leak.path}_${idx}`}
                        className="px-3 py-1.5 rounded bg-elevated border border-edge text-xs flex items-center justify-between"
                      >
                        <span className="font-mono text-ink">{leak.path}</span>
                        <span className="text-[11px] text-red-600 dark:text-red-400">
                          {leak.reason === 'hash_match'
                            ? `Matches raw file ${leak.matchedFilepath}`
                            : leak.reason === 'symlink_to_raw'
                              ? 'Symlink to data/raw/'
                              : leak.reason === 'raw_extension'
                                ? 'Raw bioinformatics format'
                                : leak.reason === 'oversized_file'
                                  ? `Large file (${formatBytes(leak.sizeBytes || 0)})`
                                  : 'External symlink'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Registered Datasets Table */}
            <div className="rounded-xl border border-edge bg-elevated overflow-hidden">
              <div className="px-4 py-3 border-b border-edge bg-panel flex items-center justify-between">
                <div className="flex items-center space-x-2 text-xs font-semibold text-ink">
                  <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  <span>Registered Raw Datasets ({summary?.entries.length || 0})</span>
                </div>
                {summary?.lastVerifiedAt && (
                  <span className="text-[11px] text-muted">
                    Last verified: {new Date(summary.lastVerifiedAt).toLocaleString()}
                  </span>
                )}
              </div>

              {!summary || summary.entries.length === 0 ? (
                <div className="p-8 text-center text-xs text-muted space-y-2">
                  <p>No raw datasets registered yet.</p>
                  <p className="text-[11px]">
                    Upload files via the File Explorer into <code className="font-mono">data/raw/</code>, or ask the AI agent to download a dataset and register it here.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-edge text-xs text-left">
                    <thead className="bg-panel text-[11px] uppercase tracking-wider text-muted">
                      <tr>
                        <th className="px-4 py-2.5">Dataset</th>
                        <th className="px-4 py-2.5">Description</th>
                        <th className="px-4 py-2.5">Download Code / Source</th>
                        <th className="px-4 py-2.5">Fingerprint (SHA-256)</th>
                        <th className="px-4 py-2.5">Status</th>
                        <th className="px-4 py-2.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-edge">
                      {summary.entries.map((entry) => (
                        <tr key={entry.id} className="hover:bg-panel/60 transition">
                          <td className="px-4 py-3 align-top">
                            <div className="font-mono font-medium text-ink">{entry.filepath}</div>
                            <div className="text-[10px] text-muted mt-0.5">{formatBytes(entry.sizeBytes)}</div>
                          </td>
                          <td className="px-4 py-3 align-top max-w-xs text-ink">
                            {entry.description || <span className="italic text-muted">No description</span>}
                          </td>
                          <td className="px-4 py-3 align-top space-y-1">
                            {entry.acquisition.scriptPath ? (
                              <button
                                onClick={() => onOpenFile(entry.acquisition.scriptPath!)}
                                className="inline-flex items-center space-x-1 font-mono text-[11px] text-accent hover:underline cursor-pointer"
                              >
                                <FileCode className="w-3 h-3" />
                                <span>{entry.acquisition.scriptPath}</span>
                              </button>
                            ) : (
                              <span className="text-[11px] text-muted capitalize">{entry.acquisition.method}</span>
                            )}
                            {entry.acquisition.command && (
                              <div className="font-mono text-[10px] text-muted truncate max-w-[200px]" title={entry.acquisition.command}>
                                {entry.acquisition.command}
                              </div>
                            )}
                            {entry.scriptChanged && (
                              <div className="text-[10px] text-amber-700 dark:text-amber-400">
                                Download script modified since acquisition
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 align-top">
                            <button
                              onClick={() => copyHash(entry.id, entry.sha256)}
                              className="inline-flex items-center space-x-1 font-mono text-[11px] px-1.5 py-0.5 rounded bg-panel border border-edge text-muted hover:text-ink cursor-pointer"
                              title={`Copy full SHA-256: ${entry.sha256}`}
                            >
                              <span>{entry.sha256.slice(0, 12)}…</span>
                              {copiedId === entry.id ? (
                                <Check className="w-3 h-3 text-emerald-500" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                            </button>
                          </td>
                          <td className="px-4 py-3 align-top">{statusBadge(entry.status)}</td>
                          <td className="px-4 py-3 align-top text-right whitespace-nowrap space-x-1.5">
                            <button
                              onClick={() => openRegisterModal(entry.filepath, entry)}
                              className="text-[11px] text-accent hover:underline cursor-pointer"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleDeleteEntry(entry.id, entry.filepath)}
                              className="p-1 text-muted hover:text-red-600 rounded cursor-pointer align-middle"
                              title="Remove from manifest"
                            >
                              <Trash2 className="w-3.5 h-3.5 inline" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Register / Edit Dataset Modal */}
      {registerTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
          <form
            onSubmit={handleSubmitRegister}
            className="bg-elevated border border-edge rounded-xl shadow-2xl w-full max-w-md overflow-hidden"
          >
            <div className="px-5 py-3.5 border-b border-edge bg-panel flex items-center justify-between">
              <h3 className="text-xs font-semibold text-ink">Register Dataset Provenance</h3>
              <button type="button" onClick={() => setRegisterTarget(null)} className="text-muted hover:text-ink">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-3.5 text-xs">
              <div>
                <label className="block font-medium text-ink mb-1">Filepath</label>
                <input
                  type="text"
                  value={registerTarget}
                  readOnly
                  className="w-full px-3 py-1.5 rounded-lg border border-edge bg-panel text-muted font-mono text-[11px]"
                />
              </div>
              <div>
                <label className="block font-medium text-ink mb-1">Description</label>
                <textarea
                  rows={2}
                  required
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="Describe what this dataset contains, cohort, units, etc."
                  className="w-full px-3 py-1.5 rounded-lg border border-edge bg-surface text-ink outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="block font-medium text-ink mb-1">Download Script Path (optional)</label>
                <input
                  type="text"
                  value={formScriptPath}
                  onChange={(e) => setFormScriptPath(e.target.value)}
                  placeholder="code/download_dataset.py"
                  className="w-full px-3 py-1.5 rounded-lg border border-edge bg-surface text-ink font-mono text-[11px] outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="block font-medium text-ink mb-1">Command Used (optional)</label>
                <input
                  type="text"
                  value={formCommand}
                  onChange={(e) => setFormCommand(e.target.value)}
                  placeholder="python code/download_dataset.py --out data/raw/..."
                  className="w-full px-3 py-1.5 rounded-lg border border-edge bg-surface text-ink font-mono text-[11px] outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="block font-medium text-ink mb-1">Source URL / Accession (optional)</label>
                <input
                  type="text"
                  value={formSourceUrl}
                  onChange={(e) => setFormSourceUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full px-3 py-1.5 rounded-lg border border-edge bg-surface text-ink font-mono text-[11px] outline-none focus:border-accent"
                />
              </div>
            </div>
            <div className="px-5 py-3 border-t border-edge bg-panel flex justify-end space-x-2">
              <button
                type="button"
                onClick={() => setRegisterTarget(null)}
                className="px-3 py-1.5 text-xs text-muted hover:text-ink rounded"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-1.5 text-xs bg-accent text-white rounded-lg font-medium hover:opacity-90 disabled:opacity-60 cursor-pointer"
              >
                {submitting ? 'Hashing & Saving...' : 'Save Provenance'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
