import React, { useRef, useState } from 'react';
import { RefreshCw, ExternalLink, LayoutDashboard, CheckCircle, UploadCloud, Save, X } from 'lucide-react';
import {
  getBionicConfig,
  publishProjectReport,
  saveProjectSnapshot,
  fetchWorkspaceMeta
} from '../../services/api';

interface ReportViewerProps {
  lastUpdated?: number;
  isDragging?: boolean;
}

const BOILERPLATE_SUMMARY_PREFIX = 'Summarize the research question, data sources, analytical workflow';

export const ReportViewer: React.FC<ReportViewerProps> = ({ lastUpdated, isDragging = false }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [pubTitle, setPubTitle] = useState('');
  const [pubSummary, setPubSummary] = useState('');
  const [pubVisibility, setPubVisibility] = useState<'private' | 'org' | 'public'>('private');
  const [publishStatus, setPublishStatus] = useState<string | null>(null);
  const [mountTs] = useState<number>(() => Date.now());
  const cfg = getBionicConfig();
  const baseUrl = cfg.baseUrl;
  const isolatedOrigin = cfg.hubMode && cfg.reportsOrigin ? cfg.reportsOrigin : '';
  const reportUrl = isolatedOrigin ? `${isolatedOrigin}/index.html` : `${baseUrl}/report/index.html`;

  const openPublishModal = async () => {
    setShowPublishModal(true);
    try {
      const meta = await fetchWorkspaceMeta();
      const rawTitle = meta?.bionicYaml?.title?.trim() || '';
      const rawSummary = (meta?.bionicYaml?.summary || meta?.bionicYaml?.description || '').trim();
      const cleanSummary = rawSummary.startsWith(BOILERPLATE_SUMMARY_PREFIX) ? '' : rawSummary;
      if (!pubTitle) {
        setPubTitle(rawTitle && rawTitle !== 'Scientific Analysis Project' ? rawTitle : 'Scientific Analysis Report');
      }
      if (!pubSummary && cleanSummary) {
        setPubSummary(cleanSummary);
      }
    } catch {
      if (!pubTitle) setPubTitle('Scientific Analysis Report');
    }
  };

  const handleSaveSnapshot = async () => {
    setIsSaving(true);
    setPublishStatus(null);
    try {
      const res = await saveProjectSnapshot();
      if (res.success) {
        const shortSha = res.gitCommitSha ? ` (commit ${res.gitCommitSha.slice(0, 8)})` : '';
        setPublishStatus(`Saved manifest, raw data, and Git snapshot${shortSha}.`);
      } else {
        setPublishStatus(`Save failed: ${res.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      setPublishStatus(`Save error: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsPublishing(true);
    setPublishStatus(null);
    try {
      const res = await publishProjectReport({
        visibility: pubVisibility,
        title: pubTitle.trim() || 'Published Report',
        summary: pubSummary.trim()
      });
      if (res.success) {
        setShowPublishModal(false);
        const verTag = res.publication?.version ? ` v${res.publication.version}` : '';
        setPublishStatus(`Published${verTag} (${pubVisibility}) — manifest, Git snapshot, raw data, and report synced to Bionic Hub.`);
      } else {
        setPublishStatus(`Publish failed: ${res.error}`);
      }
    } catch (err: any) {
      setPublishStatus(`Publish error: ${err.message}`);
    } finally {
      setIsPublishing(false);
    }
  };

  const handleRefresh = () => {
    setIsRefreshing(true);
    if (iframeRef.current) {
      iframeRef.current.src = `${reportUrl}?t=${Date.now()}`;
    }
    setTimeout(() => setIsRefreshing(false), 400);
  };

  const handleOpenExternal = () => {
    window.open(reportUrl, '_blank');
  };

  return (
    <div className="flex flex-col h-full bg-panel overflow-hidden relative">
      {/* Report Header Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-elevated border-b border-edge select-none text-xs text-ink">
        <div className="flex items-center space-x-2">
          <LayoutDashboard className="w-4 h-4 text-orange-500" />
          <span className="font-semibold text-ink">Live Web Report</span>
          <span className="text-[10px] bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 px-1.5 py-0.5 rounded flex items-center space-x-1">
            <CheckCircle className="w-2.5 h-2.5" />
            <span>Publication ({baseUrl}/report/)</span>
          </span>
        </div>

        <div className="flex items-center space-x-2">
          {cfg.hubMode && !cfg.sandboxMode && (
            <>
              <button
                onClick={handleSaveSnapshot}
                disabled={isSaving || isPublishing}
                className="flex items-center space-x-1 px-2.5 py-1 rounded bg-panel hover:bg-surface text-ink border border-edge transition cursor-pointer disabled:opacity-50"
                title="Update manifest, push raw data, commit & push Git snapshot, and sync Hub project homepage"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{isSaving ? 'Saving…' : 'Save Snapshot'}</span>
              </button>
              <button
                onClick={openPublishModal}
                disabled={isPublishing || isSaving}
                className="flex items-center space-x-1 px-2.5 py-1 rounded bg-accent text-white hover:opacity-90 transition cursor-pointer disabled:opacity-50"
                title="Verify, push raw data & Git snapshot, and publish the next report version to Bionic Hub"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                <span>{isPublishing ? 'Publishing…' : 'Publish'}</span>
              </button>
            </>
          )}
          <button
            onClick={handleRefresh}
            className="flex items-center space-x-1 px-2.5 py-1 rounded bg-panel hover:bg-surface text-ink border border-edge transition cursor-pointer"
            title="Reload report"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-accent' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={handleOpenExternal}
            className="flex items-center space-x-1 px-2.5 py-1 rounded bg-panel hover:bg-surface text-ink border border-edge transition cursor-pointer"
            title="Open in new browser tab"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>Open in Tab</span>
          </button>
        </div>
      </div>

      {publishStatus && (
        <div className="px-4 py-1.5 text-xs bg-elevated border-b border-edge text-ink flex items-center justify-between">
          <span>{publishStatus}</span>
          <button onClick={() => setPublishStatus(null)} className="text-muted hover:text-ink cursor-pointer">Dismiss</button>
        </div>
      )}

      {showPublishModal && (
        <div className="absolute inset-0 z-30 bg-black/40 flex items-center justify-center p-4">
          <form
            onSubmit={handlePublish}
            className="w-full max-w-md rounded-xl border border-edge bg-elevated p-5 shadow-2xl space-y-3 text-xs text-ink"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm">Publish New Version to Bionic Hub</h3>
              <button
                type="button"
                onClick={() => setShowPublishModal(false)}
                className="text-muted hover:text-ink cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[11px] text-muted leading-relaxed">
              Automatically updates <code className="font-mono">data/manifest.json</code> &amp; <code className="font-mono">bionic.yaml</code>, checks for raw data leaks, pushes raw datasets to storage, commits &amp; pushes your code snapshot to Git, and publishes the next immutable version of this project.
            </p>
            <div>
              <label className="block font-medium mb-1">Publication Title</label>
              <input
                type="text"
                required
                value={pubTitle}
                onChange={(e) => setPubTitle(e.target.value)}
                placeholder="e.g. Kidney Cohort RNA-seq Differential Expression"
                className="w-full rounded-lg border border-edge bg-surface px-3 py-1.5 text-ink outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Summary (saved to bionic.yaml)</label>
              <textarea
                rows={3}
                value={pubSummary}
                onChange={(e) => setPubSummary(e.target.value)}
                placeholder="Key findings, datasets, and methods…"
                className="w-full rounded-lg border border-edge bg-surface px-3 py-1.5 text-ink outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Visibility</label>
              <select
                value={pubVisibility}
                onChange={(e) => setPubVisibility(e.target.value as 'private' | 'org' | 'public')}
                className="w-full rounded-lg border border-edge bg-surface px-3 py-1.5 text-ink outline-none focus:border-accent"
              >
                <option value="private">Private (project members only)</option>
                <option value="org">Organization (all signed-in Hub users)</option>
                <option value="public">Public (published reports site)</option>
              </select>
            </div>
            <div className="flex justify-end space-x-2 pt-1">
              <button
                type="button"
                onClick={() => setShowPublishModal(false)}
                className="px-3 py-1.5 rounded-lg border border-edge text-muted hover:text-ink cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPublishing}
                className="px-3.5 py-1.5 rounded-lg bg-accent text-white font-medium hover:opacity-90 disabled:opacity-50 cursor-pointer"
              >
                {isPublishing ? 'Publishing…' : 'Publish Version'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Embedded Iframe (cross-origin isolated `<prj>.reports.<domain>` in Hub Mode; allow-same-origin lets
          multi-page report links & relative fetch() send the report origin's own host-only cookie while remaining
          strictly origin-isolated from Editor and Hub). */}
      <div className={`flex-1 w-full h-full bg-white relative ${isDragging ? 'pointer-events-none' : ''}`}>
        <iframe
          ref={iframeRef}
          key={lastUpdated}
          src={`${reportUrl}?t=${lastUpdated || mountTs}`}
          sandbox={isolatedOrigin ? 'allow-scripts allow-same-origin allow-downloads allow-popups' : undefined}
          className="w-full h-full border-none"
          title="Bionic Editor Web Report"
        />
      </div>
    </div>
  );
};
